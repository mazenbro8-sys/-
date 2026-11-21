import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-batch1-'));
const dbFile = path.join(tmpDir, 'batch1.db');
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = dbFile;
process.env.ADMIN_PHONE = '0911111177';
process.env.ADMIN_PASSWORD = 'TestPass99';
process.env.JWT_SECRET = 'batch1-test-jwt-secret-minimum-32-chars!!';

const { client, db } = await import('../src/db.js');
const { api } = await import('../src/routes.js');
const { closeOrder, runDispatcherTick } = await import('../src/dispatch.js');

const app = express();
app.use('/api', express.json({ limit: '16kb' }), api);
const server = http.createServer(app);

let base;
let admTok;
let z2Id;
let za1Tok;
let m1Id;
let m1Tok;
let capId;
let capTok;

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

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  admTok = (await call('/auth/login', 'POST', { phone: '0911111177', password: 'TestPass99' })).data.token;

  z2Id = (await call('/admin/zones', 'POST', { name: 'منطقة-اختبار-ثانية' }, admTok)).data.id;
  assert.equal((await call('/admin/users', 'POST', {
    role: 'zone_admin', phone: '0967770001', name: 'مدير منطقة 1', password: 'Passw0rd1', zone_id: 1,
  }, admTok)).status, 201);
  za1Tok = (await call('/auth/login', 'POST', { phone: '0967770001', password: 'Passw0rd1' })).data.token;

  const m1 = await call('/admin/users', 'POST', {
    role: 'merchant', phone: '0927770002', name: 'تاجر الدفعة 1', business_name: 'مطعم الدفعة',
    address: 'المزة', lat: 33.505, lng: 36.255, password: 'Passw0rd1', zone_id: 1,
  }, admTok);
  assert.equal(m1.status, 201);
  m1Id = m1.data.id;
  m1Tok = (await call('/auth/login', 'POST', { phone: '0927770002', password: 'Passw0rd1' })).data.token;

  const c1 = await call('/admin/users', 'POST', {
    role: 'captain', phone: '0937770002', name: 'كابتن الدفعة 1', password: 'Passw0rd1', zone_id: 1,
  }, admTok);
  assert.equal(c1.status, 201);
  capId = c1.data.id;
  capTok = (await call('/auth/login', 'POST', { phone: '0937770002', password: 'Passw0rd1' })).data.token;
  assert.equal((await call(`/admin/captains/${capId}/topup`, 'POST', { points: 500 }, admTok)).status, 200);
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  client.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F-01: closeOrder on already-cancelled or missing order returns false and never deducts points or writes events', async () => {
  const ord = (await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capId, customer_address: 'اختبار إغلاق مكرر',
  }, admTok)).data;
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'picked_up' }, capTok)).status, 200);
  assert.equal((await call(`/admin/orders/${ord.id}/cancel`, 'POST', { reason: 'إلغاء أول' }, admTok)).status, 200);

  const balBefore = (await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points;
  const evBefore = (await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n;

  const resDup = await closeOrder(ord.id, 'delivered', { actor: capId });
  assert.equal(resDup, false, 'closeOrder on cancelled order must return false');
  assert.equal(await closeOrder(999999, 'cancelled', { reason: 'missing' }), false, 'closeOrder on missing order must return false');

  const ordRow = await db.get('SELECT status, close_reason FROM orders WHERE id=?', ord.id);
  assert.equal(ordRow.status, 'cancelled');
  assert.equal(ordRow.close_reason, 'إلغاء أول');
  assert.equal((await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points, balBefore);
  assert.equal((await db.get("SELECT COUNT(*) n FROM points_ledger WHERE order_id=? AND kind='deduction'", ord.id)).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n, evBefore);

  // Sequential duplicate HTTP cancel -> 409
  assert.equal((await call(`/admin/orders/${ord.id}/cancel`, 'POST', {}, admTok)).status, 409);

  // Merchant cancel on already-cancelled order -> 409
  const sOrd = (await call('/merchant/orders', 'POST', { customer_address: 'ملغي تاجر' }, m1Tok)).data;
  assert.equal((await call(`/merchant/orders/${sOrd.id}/cancel`, 'POST', {}, m1Tok)).status, 200);
  assert.equal((await call(`/merchant/orders/${sOrd.id}/cancel`, 'POST', {}, m1Tok)).status, 409);

  // Dispatcher tick expiry on stale searching row works cleanly and returns without crashing even if raced
  const old = Date.now() - 20 * 60_000;
  const r = await db.run(
    "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,status,created_at) VALUES(?,?,?, '', ?, 'searching', ?)",
    m1Id, 1, '—', 'منتهي مهلة', old
  );
  await runDispatcherTick(new Set());
  assert.equal((await db.get('SELECT status FROM orders WHERE id=?', r.lastInsertRowid)).status, 'expired');
  assert.equal(await closeOrder(r.lastInsertRowid, 'delivered', { actor: capId }), false);
});

test('F-01: concurrent delivered vs cancelled race produces exact 200+409 and consistent final state & ledger', async () => {
  let balExpected = (await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points;
  for (let i = 0; i < 6; i++) {
    const ord = (await call('/admin/orders', 'POST', {
      merchant_id: m1Id, captain_id: capId, customer_address: `سباق الإغلاق ${i}`,
    }, admTok)).data;
    assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'picked_up' }, capTok)).status, 200);
    assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'arrived' }, capTok)).status, 200);

    const [delRes, canRes] = await Promise.all([
      call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'delivered' }, capTok),
      call(`/admin/orders/${ord.id}/cancel`, 'POST', { reason: `سباق إلغاء ${i}` }, admTok),
    ]);
    const statuses = [delRes.status, canRes.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409], `Race ${i} must have exactly one 200 and one 409, got ${statuses}`);

    const ordRow = await db.get('SELECT status FROM orders WHERE id=?', ord.id);
    const dedCount = (await db.get("SELECT COUNT(*) n FROM points_ledger WHERE order_id=? AND kind='deduction'", ord.id)).n;
    if (delRes.status === 200) {
      assert.equal(ordRow.status, 'delivered');
      assert.equal(dedCount, 1);
      balExpected -= 25;
    } else {
      assert.equal(ordRow.status, 'cancelled');
      assert.equal(dedCount, 0, 'cancelled winner must never leave a points deduction');
    }
    assert.equal((await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points, balExpected);
  }
});

test('F-08a: captain status update with stale previous status returns 409 and emits no duplicate events', async () => {
  const ord = (await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capId, customer_address: 'اختبار حالة قديمة',
  }, admTok)).data;

  // Forward skip still 400
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'delivered' }, capTok)).status, 400);

  // Admin force-pickup advances order to picked_up -> stale picked_up from captain returns 409 without adding picked_up event
  assert.equal((await call(`/admin/orders/${ord.id}/force-pickup`, 'POST', { reason: 'تجاوز' }, admTok)).status, 200);
  const evAfterForce = (await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n;
  const stalePickup = await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'picked_up' }, capTok);
  assert.equal(stalePickup.status, 409);
  assert.equal((await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n, evAfterForce);

  // Advance to arrived, then concurrent / stale arrived & expected_status mismatch -> 409
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'arrived' }, capTok)).status, 200);
  const evBeforeStaleArr = (await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n;
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'arrived' }, capTok)).status, 409);
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'delivered', expected_status: 'picked_up' }, capTok)).status, 409);
  assert.equal((await db.get('SELECT COUNT(*) n FROM order_events WHERE order_id=?', ord.id)).n, evBeforeStaleArr);

  // Concurrent double picked_up race -> one 200, one 409, one picked_up event
  const ordRace = (await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capId, customer_address: 'سباق استلام متزامن',
  }, admTok)).data;
  const [r1, r2] = await Promise.all([
    call(`/captain/orders/${ordRace.id}/status`, 'POST', { status: 'picked_up' }, capTok),
    call(`/captain/orders/${ordRace.id}/status`, 'POST', { status: 'picked_up' }, capTok),
  ]);
  assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 409]);
  assert.equal((await db.get("SELECT COUNT(*) n FROM order_events WHERE order_id=? AND type='picked_up'", ordRace.id)).n, 1);

  // Cancel ord, then stale failed_customer -> 409
  assert.equal((await call(`/admin/orders/${ord.id}/cancel`, 'POST', {}, admTok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'failed_customer' }, capTok)).status, 409);
  assert.equal((await call(`/admin/orders/${ordRace.id}/cancel`, 'POST', {}, admTok)).status, 200);
});

test('F-08b: liability double submit with same client_ref is idempotent and duplicate without confirm is 409', async () => {
  const ord = (await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capId, customer_address: 'اختبار تكرار التعويض',
  }, admTok)).data;
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'picked_up' }, capTok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'arrived' }, capTok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'delivered' }, capTok)).status, 200);

  const balStart = (await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points;
  const first = await call(`/admin/orders/${ord.id}/liability`, 'POST', {
    points: 20, reason: 'تلف جزئي في الطلب', client_ref: 'liab-ref-001',
  }, admTok);
  assert.equal(first.status, 200);
  assert.equal(first.data.duplicate, false);
  assert.equal(first.data.balance_points, balStart - 20);

  // Replay with same client_ref -> 200 idempotent, single ledger deduction, liability stays 20
  const replay = await call(`/admin/orders/${ord.id}/liability`, 'POST', {
    points: 20, reason: 'تلف جزئي في الطلب', client_ref: 'liab-ref-001',
  }, admTok);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.ledger_id, first.data.ledger_id);
  assert.equal(replay.data.balance_points, balStart - 20);
  assert.equal((await db.get('SELECT liability FROM orders WHERE id=?', ord.id)).liability, 20);
  assert.equal((await db.get("SELECT COUNT(*) n FROM points_ledger WHERE order_id=? AND kind='adjustment'", ord.id)).n, 1);

  // Second adjustment without confirm -> 409
  const blocked = await call(`/admin/orders/${ord.id}/liability`, 'POST', {
    points: 10, reason: 'خصم ثانٍ بدون تأكيد', client_ref: 'liab-ref-002',
  }, admTok);
  assert.equal(blocked.status, 409);
  assert.equal((await db.get('SELECT balance_points FROM users WHERE id=?', capId)).balance_points, balStart - 20);

  // Explicit confirm: true -> succeeds (200)
  const confirmed = await call(`/admin/orders/${ord.id}/liability`, 'POST', {
    points: 10, reason: 'خصم ثانٍ مؤكد', client_ref: 'liab-ref-002', confirm: true,
  }, admTok);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.duplicate, false);
  assert.equal(confirmed.data.balance_points, balStart - 30);
  assert.equal((await db.get('SELECT liability FROM orders WHERE id=?', ord.id)).liability, 30);
});

test('F-03: GET /captain/summary and /captain/state expose effective_cost_points and exempt across default, override, and exempt', async () => {
  // Default (25 pts)
  let st = (await call('/captain/state', 'GET', null, capTok)).data;
  let sm = (await call('/captain/summary', 'GET', null, capTok)).data;
  assert.equal(st.required_cost, 25);
  assert.equal(st.effective_cost_points, 25);
  assert.equal(st.exempt, false);
  assert.equal(sm.required_cost, 25);
  assert.equal(sm.effective_cost_points, 25);
  assert.equal(sm.exempt, false);

  // Custom override (40 pts)
  assert.equal((await call(`/admin/users/${capId}`, 'PATCH', { cost_override: 40 }, admTok)).status, 200);
  st = (await call('/captain/state', 'GET', null, capTok)).data;
  sm = (await call('/captain/summary', 'GET', null, capTok)).data;
  assert.equal(st.required_cost, 40);
  assert.equal(st.effective_cost_points, 40);
  assert.equal(st.exempt, false);
  assert.equal(sm.required_cost, 40);
  assert.equal(sm.effective_cost_points, 40);
  assert.equal(sm.exempt, false);

  // Permanent exempt (cost_override = 0)
  assert.equal((await call(`/admin/users/${capId}`, 'PATCH', { cost_override: 0 }, admTok)).status, 200);
  st = (await call('/captain/state', 'GET', null, capTok)).data;
  sm = (await call('/captain/summary', 'GET', null, capTok)).data;
  assert.equal(st.required_cost, 0);
  assert.equal(st.effective_cost_points, 0);
  assert.equal(st.exempt, true);
  assert.equal(sm.required_cost, 0);
  assert.equal(sm.effective_cost_points, 0);
  assert.equal(sm.exempt, true);

  // Clear override + temporary exemption active
  const now = Date.now();
  assert.equal((await call(`/admin/users/${capId}`, 'PATCH', { cost_override: null, exempt_from: now - 60_000, exempt_until: now + 60_000 }, admTok)).status, 200);
  st = (await call('/captain/state', 'GET', null, capTok)).data;
  sm = (await call('/captain/summary', 'GET', null, capTok)).data;
  assert.equal(st.effective_cost_points, 0);
  assert.equal(st.exempt, true);
  assert.equal(sm.effective_cost_points, 0);
  assert.equal(sm.exempt, true);

  // Reset exemptions back
  assert.equal((await call(`/admin/users/${capId}`, 'PATCH', { exempt_from: null, exempt_until: null }, admTok)).status, 200);
});

test('F-04: POST /admin/orders rejects suspended/pending/cross-zone captains and does not mutate online or status', async () => {
  const susp = await call('/admin/users', 'POST', {
    role: 'captain', phone: '0937770003', name: 'كابتن موقوف', password: 'Passw0rd1', zone_id: 1,
  }, admTok);
  assert.equal(susp.status, 201);
  const suspId = susp.data.id;
  assert.equal((await call(`/admin/users/${suspId}`, 'PATCH', { status: 'suspended' }, admTok)).status, 200);

  const ordRes = await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: suspId, customer_address: 'طلب لكابتن موقوف',
  }, admTok);
  assert.equal(ordRes.status, 400);
  const suspDb = await db.get('SELECT status, online FROM users WHERE id=?', suspId);
  assert.equal(suspDb.status, 'suspended');
  assert.equal(suspDb.online, 0);

  // Zone 2 captain rejected for zone 1 merchant (both super admin 400 and zone_admin 403)
  const capZ2 = await call('/admin/users', 'POST', {
    role: 'captain', phone: '0937770004', name: 'كابتن منطقة 2', password: 'Passw0rd1', zone_id: z2Id,
  }, admTok);
  assert.equal(capZ2.status, 201);
  const capZ2Id = capZ2.data.id;
  assert.equal((await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capZ2Id, customer_address: 'كابتن من منطقة ثانية',
  }, admTok)).status, 400);
  assert.equal((await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: capZ2Id, customer_address: 'محاولة مشرف منطقة',
  }, za1Tok)).status, 403);

  // Active offline same-zone captain with low balance -> succeeds WITH warning and remains online=0
  const offLow = await call('/admin/users', 'POST', {
    role: 'captain', phone: '0937770005', name: 'كابتن أوفلاين نشط', password: 'Passw0rd1', zone_id: 1,
  }, admTok);
  assert.equal(offLow.status, 201);
  const offLowId = offLow.data.id;
  const okOff = await call('/admin/orders', 'POST', {
    merchant_id: m1Id, captain_id: offLowId, customer_address: 'طلب لكابتن أوفلاين نشط',
  }, admTok);
  assert.equal(okOff.status, 201);
  assert.ok(okOff.data.warning, 'low-balance warning must still be returned');
  const offLowDb = await db.get('SELECT status, online FROM users WHERE id=?', offLowId);
  assert.equal(offLowDb.status, 'active');
  assert.equal(offLowDb.online, 0, 'POST /admin/orders must NOT flip offline captain to online=1 automatically');
});
