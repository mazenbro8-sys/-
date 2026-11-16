import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createClient } from '@libsql/client';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-live-perf-'));
const dbPath = path.join(tmpDir, 'perf.db');
const port = 5200 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}/api`;
let proc;

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

function connectWsClient(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') resolve({ ws, msgs });
      else msgs.push(msg);
    });
    ws.addEventListener('error', reject);
  });
}

async function waitForMsg(msgs, pred, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

async function withDb(fn) {
  const client = createClient({ url: pathToFileURL(dbPath).href });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111188',
      ADMIN_PASSWORD: 'Admin12345',
      OFFER_TIMEOUT_MS: '60000',
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/zones`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('admin-live-perf server did not start');
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('GET /api/admin/live preserves exact shape/counts and limits recentOrders to 20, while GET /api/admin/stats stays accurate and settings cache invalidates', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'Admin12345' })).data.token;
  const z2 = (await call('/admin/zones', 'POST', { name: 'المزة الجديدة' }, adm)).data;

  const merchIds = [];
  const capIds = [];
  for (let i = 1; i <= 3; i++) {
    const m = await call('/admin/users', 'POST', {
      role: 'merchant',
      phone: `092888000${i}`,
      name: `م ${i}`,
      business_name: `مطعم ${i}`,
      address: `المزة ${i}`,
      lat: 33.5 + i * 0.002,
      lng: 36.26 + i * 0.002,
      password: 'Passw0rd1',
      zone_id: i <= 2 ? 1 : z2.id,
    }, adm);
    assert.equal(m.status, 201);
    merchIds.push(m.data.id);
  }
  for (let i = 1; i <= 4; i++) {
    const c = await call('/admin/users', 'POST', {
      role: 'captain',
      phone: `093888000${i}`,
      name: `كابتن ${i}`,
      password: 'Passw0rd1',
      zone_id: i <= 3 ? 1 : z2.id,
    }, adm);
    assert.equal(c.status, 201);
    capIds.push(c.data.id);
  }

  const now = Date.now();
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
  await withDb(async (client) => {
    await client.execute({
      sql: 'UPDATE users SET online=1, last_lat=33.505, last_lng=36.265, last_loc_at=? WHERE id IN (?,?)',
      args: [now, capIds[0], capIds[1]],
    });
    for (let i = 0; i < 25; i++) {
      await client.execute({
        sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,status,captain_id,cost_points,cost_source,day,created_at,closed_at) VALUES(?,?,?,?,?,'delivered',?,25,'default',?,?,?)",
        args: [merchIds[0], 1, `قديم ${i}`, '0940000001', `عنوان ${i}`, capIds[0], day, now - (30 - i) * 60_000, now - (29 - i) * 60_000],
      });
    }
    await client.execute({
      sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,captain_id,cost_points,cost_source,created_at,accepted_at) VALUES(?,?,?,?,?,?,?,'accepted',?,25,'default',?,?)",
      args: [merchIds[0], 1, 'نشط 1', '0940000002', 'موقع 1', 33.51, 36.27, capIds[0], now - 10_000, now - 5_000],
    });
    await client.execute({
      sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,captain_id,cost_points,cost_source,created_at,accepted_at) VALUES(?,?,?,?,?,?,?,'picked_up',?,25,'default',?,?)",
      args: [merchIds[1], 1, 'نشط 2', '0940000003', 'موقع 2', 33.515, 36.275, capIds[0], now - 20_000, now - 15_000],
    });
    await client.execute({
      sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,created_at) VALUES(?,?,?,?,?,?,?,'searching',?)",
      args: [merchIds[2], z2.id, 'منتظر', '0940000004', 'موقع 3', 33.52, 36.28, now - 5_000],
    });
  });

  const liveRes = await call('/admin/live', 'GET', null, adm);
  assert.equal(liveRes.status, 200);
  const d = liveRes.data;
  assert.deepEqual(
    Object.keys(d).sort(),
    ['captains', 'intervals', 'merchants', 'order_cost_points', 'orders', 'recentOrders', 'shortage', 'wallet_enforcement'].sort()
  );
  assert.equal(d.orders.length, 3, 'exactly 3 live orders');
  assert.equal(d.recentOrders.length, 20, 'recentOrders must be capped at 20');
  assert.equal(d.captains.length, 4, 'all 4 captains returned');
  assert.equal(d.merchants.length, 3, 'all 3 merchants returned');

  const cap0 = d.captains.find((c) => c.id === capIds[0]);
  assert.equal(cap0.busy, true);
  assert.equal(cap0.active_orders.length, 2);
  assert.ok(cap0.active_orders[0].id < cap0.active_orders[1].id, 'active_orders sorted ascending by id');

  const statsRes = await call('/admin/stats', 'GET', null, adm);
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.data.merchants, 3);
  assert.equal(statsRes.data.captains, 4);
  assert.equal(statsRes.data.online, 2);
  assert.equal(statsRes.data.live, 3);
  assert.equal(statsRes.data.deliveredToday, 25);

  const putCost = await call('/admin/settings/order-cost', 'PUT', { value: 42 }, adm);
  assert.equal(putCost.status, 200);
  const liveAfterCost = await call('/admin/live', 'GET', null, adm);
  assert.equal(liveAfterCost.data.order_cost_points, 42);
});

test('POST /api/captain/location rejects >200 km/h jump within 120s without consuming lastPing, and accepts coarse-to-precise jump after >120s', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'Admin12345' })).data.token;
  const regCap = await call('/admin/users', 'POST', {
    role: 'captain',
    phone: '0939990001',
    name: 'كابتن GPS',
    password: 'Passw0rd1',
    zone_id: 1,
  }, adm);
  assert.equal(regCap.status, 201);
  const capId = regCap.data.id;
  const capTok = (await call('/auth/login', 'POST', { phone: '0939990001', password: 'Passw0rd1' })).data.token;

  await call('/captain/online', 'POST', { online: true }, capTok);

  const fiveSecAgo = Date.now() - 5_000;
  await withDb((client) =>
    client.execute({ sql: 'UPDATE users SET last_lat=?, last_lng=?, last_loc_at=? WHERE id=?', args: [33.50, 36.26, fiveSecAgo, capId] })
  );

  // >200 km/h jump within 120s -> rejected silently (204)
  const badJump = await call('/captain/location', 'POST', { lat: 34.00, lng: 36.26, vis: 'visible' }, capTok);
  assert.equal(badJump.status, 204);
  let row = await withDb(async (client) => (await client.execute({ sql: 'SELECT last_lat, last_lng, last_loc_at FROM users WHERE id=?', args: [capId] })).rows[0]);
  assert.equal(row.last_lat, 33.50, 'rejected jump must not overwrite stored lat');
  assert.equal(row.last_loc_at, fiveSecAgo, 'rejected jump must not overwrite last_loc_at');

  // Because lastPing was NOT updated by the rejected jump, a realistic nearby fix succeeds immediately
  const goodFix = await call('/captain/location', 'POST', { lat: 33.5001, lng: 36.2601, vis: 'visible' }, capTok);
  assert.equal(goodFix.status, 204);
  row = await withDb(async (client) => (await client.execute({ sql: 'SELECT last_lat, last_lng, last_loc_at FROM users WHERE id=?', args: [capId] })).rows[0]);
  assert.equal(row.last_lat, 33.5001, 'valid nearby ping right after rejected jump must be accepted');

  // Second captain with >120s old coarse fix -> accepts >200 km/h coarse-to-precise jump and notifies admin WS
  const regCap2 = await call('/admin/users', 'POST', {
    role: 'captain',
    phone: '0939990002',
    name: 'كابتن قفزة 120',
    password: 'Passw0rd1',
    zone_id: 1,
  }, adm);
  assert.equal(regCap2.status, 201);
  const cap2Id = regCap2.data.id;
  const cap2Tok = (await call('/auth/login', 'POST', { phone: '0939990002', password: 'Passw0rd1' })).data.token;
  await call('/captain/online', 'POST', { online: true }, cap2Tok);

  const staleTs = Date.now() - 125_000;
  await withDb((client) =>
    client.execute({ sql: 'UPDATE users SET last_lat=?, last_lng=?, last_loc_at=? WHERE id=?', args: [33.41, 36.26, staleTs, cap2Id] })
  );

  const admWs = await connectWsClient(adm);
  try {
    const preciseFix = await call('/captain/location', 'POST', { lat: 33.50, lng: 36.26, vis: 'visible' }, cap2Tok);
    assert.equal(preciseFix.status, 204);
    const updatedRow = await withDb(async (client) => (await client.execute({ sql: 'SELECT last_lat, last_lng, last_loc_at FROM users WHERE id=?', args: [cap2Id] })).rows[0]);
    assert.equal(updatedRow.last_lat, 33.50, 'coarse-to-precise jump after >120s must be accepted even at >200 km/h');
    assert.ok(updatedRow.last_loc_at > staleTs);

    const locMsg = await waitForMsg(admWs.msgs, (m) => m.type === 'loc' && m.captain_id === cap2Id);
    assert.ok(locMsg, 'admin WS received live loc event after >120s recovery');
    assert.equal(locMsg.lat, 33.50);
  } finally {
    admWs.ws.close();
  }
});
