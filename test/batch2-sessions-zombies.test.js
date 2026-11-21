import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-batch2-'));
const dbFile = path.join(tmpDir, 'batch2.db');
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = dbFile;
process.env.ADMIN_PHONE = '0911111188';
process.env.ADMIN_PASSWORD = 'TestPass99';
process.env.JWT_SECRET = 'batch2-test-jwt-secret-minimum-32-chars!!';

const { client, db } = await import('../src/db.js');
const { api } = await import('../src/routes.js');
const { attachWs, isConnected, disconnectUser, signToken } = await import('../src/realtime.js');
const {
  computeShortage, dispatchOrder, sweepStaleCaptains,
  isCaptainReachable, clearCaptainSeen, touchCaptainSeen,
} = await import('../src/dispatch.js');
const { config } = await import('../src/config.js');

const app = express();
app.use('/api', express.json({ limit: '16kb' }), api);
const server = http.createServer(app);
attachWs(server);

let base;
let wsBase;
let admTok;
let za1Tok;
let merchId;
let merchTok;
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
    let closedInfo = null;
    const waitClose = new Promise((resClose) => {
      ws.addEventListener('close', (ev) => {
        closedInfo = { code: ev.code, reason: ev.reason };
        resClose(closedInfo);
      });
    });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'ready') {
        resolve({ ws, msgs, waitClose, getClosed: () => closedInfo });
      } else {
        msgs.push(m);
      }
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
  admTok = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'TestPass99' })).data.token;
  za1Tok = (await createUser({ role: 'zone_admin', phone: '0968880001', name: 'مشرف 1', password: 'Passw0rd1', zone_id: 1 })).tok;
  const m = await createUser({
    role: 'merchant', phone: '0928880001', name: 'تاجر ب2', business_name: 'مطعم ب2',
    address: 'المزة 1', lat: 33.505, lng: 36.255, password: 'Passw0rd1', zone_id: 1,
  });
  merchId = m.id;
  merchTok = m.tok;
});

after(() => {
  for (const ws of openSockets) {
    try { ws.close(); } catch {}
  }
  server.closeAllConnections?.();
  server.close();
  client.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F-05: logout-all as idle captain sets online=0, closes WS, releases offer; active-order logout keeps online=1 & closes WS', async () => {
  const admWs = await connectTestWs(admTok);
  const cIdle = await createUser({ role: 'captain', phone: '0938881001', name: 'كابتن خامل', password: 'Passw0rd1', zone_id: 1 });
  const cBusy = await createUser({ role: 'captain', phone: '0938881002', name: 'كابتن بنشاط', password: 'Passw0rd1', zone_id: 1 });
  await call('/captain/online', 'POST', { online: true }, cIdle.tok);
  await call('/captain/online', 'POST', { online: true }, cBusy.tok);

  // Give cBusy an active order so cIdle receives the merchant order offer cleanly
  const ordBusy = (await call('/admin/orders', 'POST', {
    merchant_id: merchId, captain_id: cBusy.id, customer_address: 'طلب نشط 1',
  }, admTok)).data;
  assert.equal(ordBusy.status, 'accepted');

  const idleWs = await connectTestWs(cIdle.tok);
  const busyWs = await connectTestWs(cBusy.tok);
  assert.equal(isConnected(cIdle.id), true);
  assert.equal(isConnected(cBusy.id), true);

  // Create merchant order -> offered to cIdle
  const ordOffer = (await call('/merchant/orders', 'POST', { customer_address: 'طلب معلق لإطلاق العرض' }, merchTok)).data;
  assert.equal(ordOffer.status, 'offered');
  assert.equal((await call('/captain/state', 'GET', null, cIdle.tok)).data.offer?.id, ordOffer.id);

  // 1) logout-all on idle captain -> closes WS (4003), sets online=0, releases pending offer (moves to busy cBusy), notifies admins
  assert.equal((await call('/auth/logout-all', 'POST', null, cIdle.tok)).status, 200);
  const idleClosed = await Promise.race([idleWs.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed')), 2000))]);
  assert.equal(idleClosed.code, 4003);
  assert.equal(isConnected(cIdle.id), false);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cIdle.id)).online, 0);
  assert.equal((await call('/captain/state', 'GET', null, cIdle.tok)).status, 401);

  // Offer must have rotated away from cIdle (picked up by live connected cBusy)
  const ordAfter = await db.get('SELECT status, offered_captain_id FROM orders WHERE id=?', ordOffer.id);
  assert.notEqual(ordAfter.offered_captain_id, cIdle.id);
  assert.equal(ordAfter.offered_captain_id, cBusy.id);

  await new Promise((r) => setTimeout(r, 80));
  assert.ok(admWs.msgs.some((m) => m.type === 'captain' && m.id === cIdle.id && m.online === false));

  // 2) logout-all on captain WITH active order -> closes WS + revokes token, but keeps online=1!
  assert.equal((await call('/auth/logout-all', 'POST', null, cBusy.tok)).status, 200);
  const busyClosed = await Promise.race([busyWs.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('Busy WS not closed')), 2000))]);
  assert.equal(busyClosed.code, 4003);
  assert.equal(isConnected(cBusy.id), false);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cBusy.id)).online, 1, 'captain with active order must stay online=1');
  assert.equal((await call('/captain/state', 'GET', null, cBusy.tok)).status, 401);

  // Cleanup active order & orders before next tests
  await call(`/admin/orders/${ordBusy.id}/cancel`, 'POST', {}, admTok);
  await call(`/admin/orders/${ordOffer.id}/cancel`, 'POST', {}, admTok);
  await db.run('UPDATE users SET online=0 WHERE id=?', cBusy.id);
  clearCaptainSeen(cBusy.id);
  admWs.ws.close();
});

test('F-05: /auth/password and /admin/users/:id/reset-password immediately disconnect open WebSockets', async () => {
  const u1 = await createUser({ role: 'merchant', phone: '0928881002', name: 'تاجر ب2-2', business_name: 'متجر 2', address: 'المزة 2', lat: 33.51, lng: 36.26, password: 'Passw0rd1', zone_id: 1 });
  const ws1 = await connectTestWs(u1.tok);
  assert.equal(isConnected(u1.id), true);

  assert.equal((await call('/auth/password', 'POST', { old_password: 'Passw0rd1', new_password: 'NewPass99' }, u1.tok)).status, 200);
  const closed1 = await Promise.race([ws1.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed after /auth/password')), 2000))]);
  assert.equal(closed1.code, 4003);
  assert.equal(isConnected(u1.id), false);

  const reLogin = (await call('/auth/login', 'POST', { phone: '0928881002', password: 'NewPass99' })).data.token;
  const ws2 = await connectTestWs(reLogin);
  assert.equal(isConnected(u1.id), true);

  assert.equal((await call(`/admin/users/${u1.id}/reset-password`, 'POST', { password: 'ResetPass2' }, admTok)).status, 200);
  const closed2 = await Promise.race([ws2.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed after reset-password')), 2000))]);
  assert.equal(closed2.code, 4003);
  assert.equal(isConnected(u1.id), false);
});

test('F-02: pickCaptain and computeShortage ignore unreachable online=1 captains and prefer connected over recent unconnected', async () => {
  const zTest = (await call('/admin/zones', 'POST', { name: 'منطقة-وصول-2' }, admTok)).data.id;
  const mZ = await createUser({
    role: 'merchant', phone: '0928882001', name: 'تاجر وصول', business_name: 'مطعم وصول',
    address: 'منطقة 2', lat: 33.52, lng: 36.27, password: 'Passw0rd1', zone_id: zTest,
  });
  const cZombie = await createUser({ role: 'captain', phone: '0938882001', name: 'كابتن زومبي', password: 'Passw0rd1', zone_id: zTest });
  const cRecent = await createUser({ role: 'captain', phone: '0938882002', name: 'كابتن قريب', password: 'Passw0rd1', zone_id: zTest });
  const cConnBusy = await createUser({ role: 'captain', phone: '0938882003', name: 'كابتن متصل مشغول', password: 'Passw0rd1', zone_id: zTest });

  const now = Date.now();
  // cZombie has online=1 and last_loc_at 10 minutes ago (> 5m captainReachableMs), no WS, no lastSeen
  await db.run('UPDATE users SET online=1, last_loc_at=? WHERE id=?', now - (config.captainReachableMs + 120_000), cZombie.id);
  clearCaptainSeen(cZombie.id);

  assert.equal(isCaptainReachable({ id: cZombie.id, last_loc_at: now - (config.captainReachableMs + 120_000) }, now), false);

  // Creating an order with ONLY cZombie online=1 must stay searching and raise computeShortage alert!
  const ordZombie = (await call('/merchant/orders', 'POST', { customer_address: 'طلب منطقة الزومبي' }, mZ.tok)).data;
  assert.equal(ordZombie.status, 'searching');
  assert.equal(ordZombie.offered_captain_id ?? null, null);
  const shortOnlyZombie = await computeShortage(zTest);
  assert.equal(shortOnlyZombie.alert, true);
  assert.equal(shortOnlyZombie.onlineCaptains, 0);

  // Give cRecent online=1 + /captain/state heartbeat (no GPS, no WS) -> reachable!
  await db.run('UPDATE users SET online=1, last_loc_at=NULL WHERE id=?', cRecent.id);
  const stCall = await call('/captain/state', 'GET', null, cRecent.tok);
  assert.equal(stCall.status, 200);
  assert.equal(isCaptainReachable({ id: cRecent.id, last_loc_at: null }), true);

  assert.equal(await dispatchOrder(ordZombie.id), true);
  const afterDispatch1 = await db.get('SELECT status, offered_captain_id FROM orders WHERE id=?', ordZombie.id);
  assert.equal(afterDispatch1.status, 'offered');
  assert.equal(afterDispatch1.offered_captain_id, cRecent.id, 'must skip zombie and offer to reachable heartbeat captain');
  const shortWithRecent = await computeShortage(zTest);
  assert.equal(shortWithRecent.onlineCaptains, 1);

  // Cancel ordZombie; now test connected Pass 2 captain preferred over unconnected-but-recent Pass 1 captain
  await call(`/admin/orders/${ordZombie.id}/cancel`, 'POST', {}, admTok);
  await db.run('UPDATE users SET online=1, last_loc_at=? WHERE id=?', now - 10_000, cConnBusy.id);
  const activeForBusy = (await call('/admin/orders', 'POST', {
    merchant_id: mZ.id, captain_id: cConnBusy.id, customer_address: 'طلب نشط لمتصل',
  }, admTok)).data;
  const connBusyWs = await connectTestWs(cConnBusy.tok);
  touchCaptainSeen(cRecent.id, now); // free, recent, no WS

  const ordPreferConn = (await call('/merchant/orders', 'POST', { customer_address: 'تفضيل المتصل' }, mZ.tok)).data;
  assert.equal(ordPreferConn.status, 'offered');
  const rowPrefer = await db.get('SELECT offered_captain_id FROM orders WHERE id=?', ordPreferConn.id);
  assert.equal(rowPrefer.offered_captain_id, cConnBusy.id, 'connected captain across both passes beats unconnected recent captain');

  await call(`/admin/orders/${ordPreferConn.id}/cancel`, 'POST', {}, admTok);
  await call(`/admin/orders/${activeForBusy.id}/cancel`, 'POST', {}, admTok);
  connBusyWs.ws.close();
  await db.run('UPDATE users SET online=0 WHERE id IN (?,?,?)', cZombie.id, cRecent.id, cConnBusy.id);
  clearCaptainSeen(cRecent.id);
  clearCaptainSeen(cConnBusy.id);
});

test('F-02: sweepStaleCaptains only sweeps idle stale (>30m) captains without WS/heartbeat/active/offered', async () => {
  const admWs = await connectTestWs(admTok);
  const zSweep = (await call('/admin/zones', 'POST', { name: 'منطقة-كنس-2' }, admTok)).data.id;
  const mSw = await createUser({
    role: 'merchant', phone: '0928883001', name: 'تاجر كنس', business_name: 'مطعم كنس',
    address: 'كنس 1', lat: 33.53, lng: 36.28, password: 'Passw0rd1', zone_id: zSweep,
  });
  const now = Date.now();
  const staleAt = now - (config.captainSweepStaleMs + 60_000);

  const cStale = await createUser({ role: 'captain', phone: '0938883001', name: 'كابتن متوقف قديم', password: 'Passw0rd1', zone_id: zSweep });
  const cBrandNew = await createUser({ role: 'captain', phone: '0938883002', name: 'كابتن جديد', password: 'Passw0rd1', zone_id: zSweep });
  const cWithWs = await createUser({ role: 'captain', phone: '0938883003', name: 'كابتن بويب سوكت', password: 'Passw0rd1', zone_id: zSweep });
  const cHeartbeat = await createUser({ role: 'captain', phone: '0938883004', name: 'كابتن نبض بدون GPS', password: 'Passw0rd1', zone_id: zSweep });
  const cActive = await createUser({ role: 'captain', phone: '0938883005', name: 'كابتن بطلب نشط', password: 'Passw0rd1', zone_id: zSweep });
  const cOffered = await createUser({ role: 'captain', phone: '0938883006', name: 'كابتن بعرض معلق', password: 'Passw0rd1', zone_id: zSweep });

  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cStale.id);
  clearCaptainSeen(cStale.id);

  // Brand-new captain: online=1, last_loc_at=NULL, created_at=now -> spared by safe fallback
  await db.run('UPDATE users SET online=1, last_loc_at=NULL, created_at=? WHERE id=?', now - 60_000, cBrandNew.id);
  clearCaptainSeen(cBrandNew.id);

  // Stale DB loc, but live WebSocket
  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cWithWs.id);
  clearCaptainSeen(cWithWs.id);
  const wsAlive = await connectTestWs(cWithWs.tok);

  // Stale DB loc, no WS, but recent GET /captain/state heartbeat
  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cHeartbeat.id);
  await call('/captain/state', 'GET', null, cHeartbeat.tok);

  // Stale DB loc, no WS, no heartbeat, but has active order
  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cActive.id);
  clearCaptainSeen(cActive.id);
  const oAct = (await call('/admin/orders', 'POST', { merchant_id: mSw.id, captain_id: cActive.id, customer_address: 'نشط محمي' }, admTok)).data;

  // Stale DB loc, no WS, no heartbeat, but has pending offered order
  await db.run('UPDATE users SET online=1, last_loc_at=?, created_at=? WHERE id=?', staleAt, staleAt, cOffered.id);
  clearCaptainSeen(cOffered.id);
  await db.run(
    "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,status,offered_captain_id,offer_expires_at,created_at) VALUES(?,?,?,?,?,'offered',?,?,?)",
    mSw.id, zSweep, '—', '', 'معروض محمي', cOffered.id, now + 60_000, now
  );

  const swept = await sweepStaleCaptains(now);
  assert.deepEqual(swept.map((x) => x.id), [cStale.id], 'only the idle stale captain without WS or heartbeat must be swept');

  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cStale.id)).online, 0);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cBrandNew.id)).online, 1);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cWithWs.id)).online, 1);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cHeartbeat.id)).online, 1);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cActive.id)).online, 1);
  assert.equal((await db.get('SELECT online FROM users WHERE id=?', cOffered.id)).online, 1);

  await new Promise((r) => setTimeout(r, 80));
  assert.ok(admWs.msgs.some((m) => m.type === 'captain' && m.id === cStale.id && m.online === false));
  assert.ok(!admWs.msgs.some((m) => m.type === 'captain' && m.id === cBrandNew.id && m.online === false));

  await call(`/admin/orders/${oAct.id}/cancel`, 'POST', {}, admTok);
  await db.run("UPDATE users SET online=0 WHERE zone_id=?", zSweep);
  await db.run("UPDATE orders SET status='cancelled', offered_captain_id=NULL WHERE zone_id=?", zSweep);
  wsAlive.ws.close();
  admWs.ws.close();
});

test('F-11 & F-17: role/zone hygiene, password policy, /track role guard, admin create forced null zone_id', async () => {
  // zone_admin cannot change user role (403)
  const capZ1 = await createUser({ role: 'captain', phone: '0938884001', name: 'كابتن دور 1', password: 'Passw0rd1', zone_id: 1 });
  assert.equal((await call(`/admin/users/${capZ1.id}`, 'PATCH', { role: 'merchant' }, za1Tok)).status, 403);

  // super admin changing captain role when active/offered order exists -> 409
  const capBusyRole = await createUser({ role: 'captain', phone: '0938884002', name: 'كابتن بدور معلق', password: 'Passw0rd1', zone_id: 1 });
  await call('/captain/online', 'POST', { online: true }, capBusyRole.tok);
  const activeRoleOrd = (await call('/admin/orders', 'POST', { merchant_id: merchId, captain_id: capBusyRole.id, customer_address: 'طلب يمنع تغيير الدور' }, admTok)).data;
  assert.equal((await call(`/admin/users/${capBusyRole.id}`, 'PATCH', { role: 'merchant' }, admTok)).status, 409);
  await call(`/admin/orders/${activeRoleOrd.id}/cancel`, 'POST', {}, admTok);

  // super admin captain -> merchant sets online=0, bumps token_version, closes WS
  const capWs = await connectTestWs(capBusyRole.tok);
  assert.equal((await call(`/admin/users/${capBusyRole.id}`, 'PATCH', { role: 'merchant', business_name: 'متجر محول', address: 'دمشق المزة' }, admTok)).status, 200);
  const closedRole = await Promise.race([capWs.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed on role change')), 2000))]);
  assert.equal(closedRole.code, 4003);
  assert.equal((await db.get('SELECT online, role FROM users WHERE id=?', capBusyRole.id)).online, 0);
  assert.equal((await call('/me', 'GET', null, capBusyRole.tok)).status, 401);

  // super admin merchant -> captain generates tag and disconnects WS
  const merchConv = await createUser({ role: 'merchant', phone: '0928884009', name: 'محول لكابتن', business_name: 'محل', address: 'المزة 9', lat: 33.51, lng: 36.26, password: 'Passw0rd1', zone_id: 1 });
  const mWs = await connectTestWs(merchConv.tok);
  assert.equal((await call(`/admin/users/${merchConv.id}`, 'PATCH', { role: 'captain' }, admTok)).status, 200);
  const closedM = await Promise.race([mWs.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed on merchant->captain')), 2000))]);
  assert.equal(closedM.code, 4003);
  const promoted = await db.get('SELECT role, tag FROM users WHERE id=?', merchConv.id);
  assert.equal(promoted.role, 'captain');
  assert.match(promoted.tag, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);

  // zone_id change bumps token_version, disconnects WS, and fresh reconnect refreshes zoneOf cleanly
  const z2 = (await call('/admin/zones', 'POST', { name: 'منطقة-نقل-2' }, admTok)).data.id;
  const zaMove = await createUser({ role: 'zone_admin', phone: '0968884010', name: 'مشرف متحرك', password: 'Passw0rd1', zone_id: 1 });
  const zaWs = await connectTestWs(zaMove.tok);
  assert.equal((await call(`/admin/users/${zaMove.id}`, 'PATCH', { zone_id: z2 }, admTok)).status, 200);
  const closedZone = await Promise.race([zaWs.waitClose, new Promise((_, rej) => setTimeout(() => rej(new Error('WS not closed on zone_id change')), 2000))]);
  assert.equal(closedZone.code, 4003);
  assert.equal((await call('/admin/zones', 'GET', null, zaMove.tok)).status, 401);
  const zaRelogin = (await call('/auth/login', 'POST', { phone: '0968884010', password: 'Passw0rd1' })).data;
  assert.equal(zaRelogin.user.zone_id, z2);
  const zaWsFresh = await connectTestWs(zaRelogin.token);
  assert.equal(isConnected(zaMove.id), true);
  zaWsFresh.ws.close();

  // F-17: reset-password enforces complexity; /track rejects non-captain id; role admin ignores zone_id
  assert.equal((await call(`/admin/users/${capZ1.id}/reset-password`, 'POST', { password: 'onlyletters' }, admTok)).status, 400);
  assert.equal((await call(`/admin/users/${capZ1.id}/reset-password`, 'POST', { password: '1234567' }, admTok)).status, 400);
  assert.equal((await call(`/admin/captains/${merchId}/track`, 'GET', null, admTok)).status, 404);

  const superAdmCreated = await createUser({ role: 'admin', phone: '0918884011', name: 'مدير عام 2', password: 'Passw0rd1', zone_id: 1 });
  assert.equal((await db.get('SELECT zone_id FROM users WHERE id=?', superAdmCreated.id)).zone_id, null);
});

test('F-14a: concurrent failed logins increment atomically in SQL and trigger lockout at 5 attempts', async () => {
  await createUser({ role: 'captain', phone: '0938885001', name: 'كابتن قفل متزامن', password: 'Passw0rd1', zone_id: 1 });
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => call('/auth/login', 'POST', { phone: '0938885001', password: 'WrongPass9' }))
  );
  assert.ok(attempts.every((r) => r.status === 401));
  const rowAfter5 = await db.get('SELECT failed_logins, locked_until FROM users WHERE phone=?', '0938885001');
  assert.equal(rowAfter5.failed_logins, 0, '5 atomic failures reset failed_logins and lock the account');
  assert.ok(rowAfter5.locked_until > Date.now(), 'account must be locked after 5 concurrent failures');

  const lockedRes = await call('/auth/login', 'POST', { phone: '0938885001', password: 'Passw0rd1' });
  assert.equal(lockedRes.status, 429);
});
