import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-dsp-'));
const dbFile = path.join(tmpDir, 'dsp.db');
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = dbFile;
process.env.ADMIN_PHONE = '0911111155';
process.env.ADMIN_PASSWORD = 'TestPass99';
process.env.JWT_SECRET = 'dispatch-simplify-test-jwt-secret-32c!!';
delete process.env.OFFER_TIMEOUT_MS;
delete process.env.SHORTAGE_TIMEOUT_MS;
delete process.env.SEARCH_MAX_MS;
delete process.env.CAPTAIN_SWEEP_ENABLED;

const { client, db } = await import('../src/db.js');
const { api } = await import('../src/routes.js');
const { attachWs, isConnected, signToken } = await import('../src/realtime.js');
const {
  computeShortage, dispatchOrder, releaseOffer, runDispatcherTick,
  sweepStaleCaptains, startDispatcher, isCaptainReachable, clearCaptainSeen, touchCaptainSeen,
} = await import('../src/dispatch.js');
const { config } = await import('../src/config.js');

const app = express();
app.use('/api', express.json({ limit: '16kb' }), api);
const server = http.createServer(app);
attachWs(server);

let base;
let wsBase;
let admTok;
const openSockets = new Set();

async function call(p, method = 'GET', body = null, token = null) {
  const headers = {};
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function connectTestWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    openSockets.add(ws);
    const msgs = [];
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'ready') resolve({ ws, msgs });
      else msgs.push(m);
    });
    ws.addEventListener('error', (err) => reject(err));
  });
}

async function createUser(body) {
  const r = await call('/admin/users', 'POST', body, admTok);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = await db.get('SELECT * FROM users WHERE id=?', r.data.id);
  return { id: r.data.id, tag: r.data.tag, tok: signToken(row) };
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}/api`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
  admTok = (await call('/auth/login', 'POST', { phone: '0911111155', password: 'TestPass99' })).data.token;
});

after(async () => {
  for (const ws of openSockets) { try { ws.close(); } catch {} }
  await new Promise((resolve) => server.close(resolve));
  try { client.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Dispatch defaults: sweep off, 60s offer, 8m shortage, 20m max search', () => {
  assert.equal(config.captainSweepEnabled, false);
  assert.equal(config.offerTimeoutMs, 60_000);
  assert.equal(config.shortageTimeoutMs, 8 * 60_000);
  assert.equal(config.searchMaxMs, 20 * 60_000);
  assert.equal(config.captainSweepStaleMs, 30 * 60_000);
  assert.equal(config.captainSweepIntervalMs, 60_000);
});

test('Online captain with stale signal & no WS is offered order and does not trigger computeShortage', async () => {
  const zId = (await call('/admin/zones', 'POST', { name: 'منطقة-بسيطة-1' }, admTok)).data.id;
  const merch = await createUser({
    role: 'merchant', phone: '0929001001', name: 'تاجر بسيط 1', business_name: 'متجر بسيط 1',
    address: 'شارع 1', lat: 33.51, lng: 36.26, password: 'Passw0rd1', zone_id: zId,
  });
  const capStale = await createUser({ role: 'captain', phone: '0939001001', name: 'كابتن إشارة قديمة', password: 'Passw0rd1', zone_id: zId });

  const now = Date.now();
  await db.run('UPDATE users SET online=1, last_loc_at=? WHERE id=?', now - 3 * 3_600_000, capStale.id);
  clearCaptainSeen(capStale.id);
  assert.equal(isConnected(capStale.id), false);
  assert.equal(isCaptainReachable({ id: capStale.id, last_loc_at: now - 3 * 3_600_000 }, now), false);

  const shortBefore = await computeShortage(zId);
  assert.equal(shortBefore.onlineCaptains, 1);
  assert.equal(shortBefore.freeOnlineCaptains, 1);
  assert.equal(shortBefore.shortageTimeoutMs, 8 * 60_000);

  const ordRes = await call('/merchant/orders', 'POST', { customer_address: 'عنوان اختبار الإشارة القديمة' }, merch.tok);
  assert.equal(ordRes.status, 201);
  assert.equal(ordRes.data.status, 'offered');
  const dbOrd = await db.get('SELECT status, offered_captain_id, offer_expires_at, created_at FROM orders WHERE id=?', ordRes.data.id);
  assert.equal(dbOrd.offered_captain_id, capStale.id);
  assert.ok(dbOrd.offer_expires_at - dbOrd.created_at >= 58_000 && dbOrd.offer_expires_at - dbOrd.created_at <= 62_000);

  // Also check shortage alert stays false when an unreachable online captain is waiting
  const ordSearch = (await call('/merchant/orders', 'POST', { customer_address: 'طلب منتظر بدون عجز' }, merch.tok)).data;
  const capOtherStale = await createUser({ role: 'captain', phone: '0939001002', name: 'كابتن قديم 2', password: 'Passw0rd1', zone_id: zId });
  await db.run('UPDATE users SET online=1, last_loc_at=? WHERE id=?', now - 2 * 3_600_000, capOtherStale.id);
  clearCaptainSeen(capOtherStale.id);
  const shortWithStale = await computeShortage(zId);
  assert.equal(shortWithStale.alert, false, 'unreachable online captain must not cause shortage alert');

  await call(`/admin/orders/${ordRes.data.id}/cancel`, 'POST', {}, admTok);
  await call(`/admin/orders/${ordSearch.id}/cancel`, 'POST', {}, admTok);
  await db.run('UPDATE users SET online=0 WHERE zone_id=?', zId);
});

test('Reachable-first ordering and round-robin inside each group across free/busy passes', async () => {
  const zId = (await call('/admin/zones', 'POST', { name: 'منطقة-ترتيب-2' }, admTok)).data.id;
  const merch = await createUser({
    role: 'merchant', phone: '0929002001', name: 'تاجر ترتيب', business_name: 'متجر ترتيب',
    address: 'شارع 2', lat: 33.52, lng: 36.27, password: 'Passw0rd1', zone_id: zId,
  });
  const cUnreachOldest = await createUser({ role: 'captain', phone: '0939002001', name: 'قديم أقدم', password: 'Passw0rd1', zone_id: zId });
  const cUnreachNewer = await createUser({ role: 'captain', phone: '0939002002', name: 'قديم أحدث', password: 'Passw0rd1', zone_id: zId });
  const cReach1 = await createUser({ role: 'captain', phone: '0939002003', name: 'متاح 1', password: 'Passw0rd1', zone_id: zId });
  const cReach2 = await createUser({ role: 'captain', phone: '0939002004', name: 'متاح 2', password: 'Passw0rd1', zone_id: zId });

  const now = Date.now();
  await db.run('UPDATE users SET online=1, last_loc_at=?, last_assigned_at=? WHERE id=?', now - 60 * 60_000, now - 10_000, cUnreachOldest.id);
  await db.run('UPDATE users SET online=1, last_loc_at=?, last_assigned_at=? WHERE id=?', now - 60 * 60_000, now - 5_000, cUnreachNewer.id);
  await db.run('UPDATE users SET online=1, last_loc_at=?, last_assigned_at=? WHERE id=?', now - 10_000, now - 2_000, cReach1.id);
  await db.run('UPDATE users SET online=1, last_loc_at=?, last_assigned_at=? WHERE id=?', now - 10_000, now - 1_000, cReach2.id);
  clearCaptainSeen(cUnreachOldest.id);
  clearCaptainSeen(cUnreachNewer.id);
  touchCaptainSeen(cReach1.id, now);
  touchCaptainSeen(cReach2.id, now);

  const ord = (await call('/merchant/orders', 'POST', { customer_address: 'ترتيب المجموعات' }, merch.tok)).data;
  const pick1 = await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ord.id);
  assert.equal(pick1.offered_captain_id, cReach1.id, 'reachable earlier round-robin picked first');

  await call(`/captain/offers/${ord.id}/reject`, 'POST', {}, cReach1.tok);
  const pick2 = await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ord.id);
  assert.equal(pick2.offered_captain_id, cReach2.id, 'next reachable round-robin picked second');

  await call(`/captain/offers/${ord.id}/reject`, 'POST', {}, cReach2.tok);
  const pick3 = await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ord.id);
  assert.equal(pick3.offered_captain_id, cUnreachOldest.id, 'unreachable older round-robin picked after all reachable captains');

  await call(`/captain/offers/${ord.id}/reject`, 'POST', {}, cUnreachOldest.tok);
  const pick4 = await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ord.id);
  assert.equal(pick4.offered_captain_id, cUnreachNewer.id, 'final unreachable captain picked before shortage');

  await call(`/admin/orders/${ord.id}/cancel`, 'POST', {}, admTok);
  await db.run('UPDATE users SET online=0 WHERE zone_id=?', zId);
});

test('Sweep disabled by default leaves stale online captains intact and starts no sweep timer', async () => {
  const zId = (await call('/admin/zones', 'POST', { name: 'منطقة-بدون-كنس' }, admTok)).data.id;
  const cap = await createUser({ role: 'captain', phone: '0939003001', name: 'كابتن باقٍ أونلاين', password: 'Passw0rd1', zone_id: zId });
  const staleAt = Date.now() - (config.captainSweepStaleMs + 3_600_000);
  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cap.id);
  clearCaptainSeen(cap.id);

  assert.equal(config.captainSweepEnabled, false);
  const swept = await sweepStaleCaptains();
  assert.deepEqual(swept, []);
  await runDispatcherTick();
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cap.id)).online, 1);

  // Verify startDispatcher only registers the 5s dispatcher interval (no 10s setTimeout / 60s sweep interval)
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const createdTimers = [];
  const timeoutDelays = [];
  const intervalDelays = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    timeoutDelays.push(ms);
    const t = origSetTimeout(() => {}, 60_000);
    createdTimers.push({ type: 'timeout', handle: t });
    return t;
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    intervalDelays.push(ms);
    const t = origSetInterval(() => {}, 60_000);
    createdTimers.push({ type: 'interval', handle: t });
    return t;
  };
  try {
    startDispatcher();
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    for (const item of createdTimers) {
      if (item.type === 'timeout') clearTimeout(item.handle);
      else clearInterval(item.handle);
    }
  }
  assert.deepEqual(intervalDelays, [5_000], 'must only schedule the 5s dispatcher tick when sweep is disabled');
  assert.deepEqual(timeoutDelays, [], 'must not schedule the 10s initial sweep timeout when sweep is disabled');

  await db.run('UPDATE users SET online=0 WHERE id=?', cap.id);
});

test('Offer expires after 60s (injected time), shortage alerts at 8m, search closes at 20m, and manual assign works mid-offer', async () => {
  const zId = (await call('/admin/zones', 'POST', { name: 'منطقة-مهل-3' }, admTok)).data.id;
  const merch = await createUser({
    role: 'merchant', phone: '0929004001', name: 'تاجر مهل', business_name: 'متجر مهل',
    address: 'شارع المهل', lat: 33.51, lng: 36.26, password: 'Passw0rd1', zone_id: zId,
  });
  const c1 = await createUser({ role: 'captain', phone: '0939004001', name: 'كابتن مهل 1', password: 'Passw0rd1', zone_id: zId });
  const c2 = await createUser({ role: 'captain', phone: '0939004002', name: 'كابتن مهل 2', password: 'Passw0rd1', zone_id: zId });
  const c3 = await createUser({ role: 'captain', phone: '0939004003', name: 'كابتن تعيين يدوي', password: 'Passw0rd1', zone_id: zId });

  await db.run('UPDATE users SET online=1 WHERE id IN (?,?)', c1.id, c2.id);
  const ws2 = await connectTestWs(c2.tok);

  const ord = (await call('/merchant/orders', 'POST', { customer_address: 'اختبار 60 ثانية' }, merch.tok)).data;
  assert.equal(ord.status, 'offered');
  const row0 = await db.get('SELECT offered_captain_id, offer_expires_at, created_at FROM orders WHERE id=?', ord.id);
  const firstId = row0.offered_captain_id;
  const secondId = firstId === c1.id ? c2.id : c1.id;
  const capTokFirst = firstId === c1.id ? c1.tok : c2.tok;

  // Captain state exposes server_now and 60s offerTimeoutMs and live offer_expires_at
  const capSt = (await call('/captain/state', 'GET', null, capTokFirst)).data;
  assert.ok(Number.isFinite(capSt.server_now));
  assert.equal(capSt.intervals.offerTimeoutMs, 60_000);
  assert.equal(capSt.offer?.offer_expires_at, row0.offer_expires_at);

  // Admin live exposes full timeout intervals
  const admLive = (await call('/admin/live', 'GET', null, admTok)).data;
  assert.equal(admLive.intervals.offerTimeoutMs, 60_000);
  assert.equal(admLive.intervals.shortageTimeoutMs, 8 * 60_000);
  assert.equal(admLive.intervals.searchMaxMs, 20 * 60_000);

  // At expiry - 5s: must remain offered to first captain!
  const alerted = new Set();
  await runDispatcherTick(alerted, row0.offer_expires_at - 5_000);
  assert.equal((await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ord.id)).offered_captain_id, firstId);

  // After 60s expiry (+1s): moves cleanly to second captain!
  await runDispatcherTick(alerted, row0.offer_expires_at + 1_000);
  const row1 = await db.get('SELECT status, offered_captain_id FROM orders WHERE id=?', ord.id);
  assert.equal(row1.status, 'offered');
  assert.equal(row1.offered_captain_id, secondId);

  // Manual admin assign during 'offered' state succeeds, clears offer, notifies old offered captain
  await db.run('UPDATE users SET online=1 WHERE id=?', c3.id);
  const assignRes = await call(`/admin/orders/${ord.id}/assign-captain`, 'POST', { captain_id: c3.id }, admTok);
  assert.equal(assignRes.status, 200);
  assert.equal(assignRes.data.status, 'accepted');
  assert.equal(assignRes.data.captain_id, c3.id);
  await new Promise((r) => setTimeout(r, 50));
  if (secondId === c2.id) {
    assert.ok(ws2.msgs.some((m) => m.type === 'offer_end' && m.order_id === ord.id && m.reason === 'admin_reassigned'));
  }
  assert.equal(await releaseOffer(ord.id, 'timeout'), false, 'releaseOffer after manual assign is a safe no-op');
  assert.equal((await db.get('SELECT status, captain_id FROM orders WHERE id=?', ord.id)).status, 'accepted');

  // 8-minute shortage alert & 20-minute max search expiration
  await call(`/admin/orders/${ord.id}/cancel`, 'POST', {}, admTok);
  await db.run('UPDATE users SET online=0 WHERE zone_id=?', zId);

  const ordWait = (await call('/merchant/orders', 'POST', { customer_address: 'اختبار 8 و 20 دقيقة' }, merch.tok)).data;
  assert.equal(ordWait.status, 'searching');
  const tCreate = (await db.get('SELECT created_at FROM orders WHERE id=?', ordWait.id)).created_at;

  await runDispatcherTick(alerted, tCreate + 7 * 60_000);
  assert.equal(alerted.has(ordWait.id), false, 'shortage timeout alert must not trigger at 7m (< 8m)');
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', ordWait.id)).status, 'searching');

  await runDispatcherTick(alerted, tCreate + 8 * 60_000 + 1_000);
  assert.equal(alerted.has(ordWait.id), true, 'shortage timeout alert must trigger at 8m');
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', ordWait.id)).status, 'searching');

  await runDispatcherTick(alerted, tCreate + 19 * 60_000);
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', ordWait.id)).status, 'searching', 'order must stay alive at 19m (< 20m)');

  await runDispatcherTick(alerted, tCreate + 20 * 60_000 + 1_000);
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', ordWait.id)).status, 'expired', 'order closes expired after 20m');

  ws2.ws.close();
});

test('UI texts & cache busting reflect dynamic 8m shortage, server offer_expires_at countdown, and panther2026v35', () => {
  const adminJs = fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
  const captainJs = fs.readFileSync(new URL('../public/captain.js', import.meta.url), 'utf8');
  const sharedJs = fs.readFileSync(new URL('../public/shared.js', import.meta.url), 'utf8');

  assert.doesNotMatch(adminJs, /تجاوز الانتظار\s*5\s*دقائق/);
  assert.match(adminJs, /shortage\.shortageTimeoutMs\s*\|\|\s*locIntervals\.shortageTimeoutMs\s*\|\|\s*8\s*\*\s*60_000/);
  assert.match(captainJs, /getOfferRemainingSecs/);
  assert.match(captainJs, /serverClockOffsetMs/);
  assert.match(sharedJs, /clockOffsetMs/);
});
