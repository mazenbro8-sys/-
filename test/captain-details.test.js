import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createClient } from '@libsql/client';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-cap-details-'));
const dbPath = path.join(tmpDir, 'cap-details.db');
const port = 5500 + Math.floor(Math.random() * 300);
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

async function withDb(fn) {
  const client = createClient({ url: pathToFileURL(dbPath).href });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function collectKeysDeep(val, out = new Set()) {
  if (!val || typeof val !== 'object') return out;
  if (Array.isArray(val)) {
    for (const item of val) collectKeysDeep(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(val)) {
    out.add(k);
    collectKeysDeep(v, out);
  }
  return out;
}

const SECRET_KEYS = ['pass_hash', 'password', 'token_version', 'failed_logins', 'locked_until'];

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111177',
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
  throw new Error('captain-details server did not start');
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('captain details & paginated order history: full details, zone RBAC, pagination, limit<=50 validation, and zero secret fields', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111177', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rd1' })).data.token;

  const z2Res = await call('/admin/zones', 'POST', { name: 'المالكي' }, adm);
  assert.equal(z2Res.status, 201);
  const z2Id = z2Res.data.id;

  const createAcc = async (body) => {
    const r = await call('/admin/users', 'POST', body, adm);
    assert.equal(r.status, 201);
    return r.data;
  };

  const zaZ1 = await createAcc({ role: 'zone_admin', phone: '0965550001', name: 'مدير منطقة 1', password: 'Passw0rd1', zone_id: 1 });
  const zaZ2 = await createAcc({ role: 'zone_admin', phone: '0965550002', name: 'مدير منطقة 2', password: 'Passw0rd1', zone_id: z2Id });
  const m1 = await createAcc({ role: 'merchant', phone: '0925550001', name: 'تاجر 1', business_name: 'مطعم الشام', address: 'المزة', lat: 33.505, lng: 36.265, password: 'Passw0rd1', zone_id: 1 });
  const c1 = await createAcc({ role: 'captain', phone: '0935550001', name: 'كابتن حسام', password: 'Passw0rd1', zone_id: 1 });
  const c2 = await createAcc({ role: 'captain', phone: '0935550002', name: 'كابتن مالكي', password: 'Passw0rd1', zone_id: z2Id });

  const zaZ1Tok = await login('0965550001');
  const zaZ2Tok = await login('0965550002');
  const m1Tok = await login('0925550001');
  const c1Tok = await login('0935550001');

  // Top up balance + configure custom override on c1, and permanent exemption on c2
  const topupRes = await call(`/admin/captains/${c1.id}/topup`, 'POST', { points: 500, note: 'رصيد اختبار' }, adm);
  assert.equal(topupRes.status, 200);
  const exemptUntil = Date.now() + 3 * 24 * 3600_000;
  assert.equal((await call(`/admin/users/${c1.id}`, 'PATCH', { cost_override: 40 }, adm)).status, 200);
  assert.equal((await call(`/admin/users/${c2.id}`, 'PATCH', { cost_override: 0 }, adm)).status, 200);

  // Set c1 online & location
  assert.equal((await call('/captain/online', 'POST', { online: true }, c1Tok)).status, 200);
  assert.equal((await call('/captain/location', 'POST', { lat: 33.506, lng: 36.266, vis: 'visible' }, c1Tok)).status, 204);

  // Seed 25 historical orders (newest first -> last 2 delivered today with ledger deductions, 1 active order)
  const now = Date.now();
  const todayStr = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
  const yestStr = new Date(now - 2 * 24 * 3600_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });

  const histIds = [];
  let activeId;
  await withDb(async (client) => {
    const mig = await client.execute("SELECT id FROM schema_migrations WHERE id='2026_11_captain_orders_index'");
    assert.equal(mig.rows.length, 1, 'captain orders index migration should be recorded');

    for (let i = 1; i <= 25; i++) {
      const isToday = i >= 24;
      const day = isToday ? todayStr : yestStr;
      const created = isToday ? (now - (26 - i) * 120_000) : (now - (30 - i) * 3600_000);
      const closed = created + 60_000;
      const status = i === 10 ? 'failed' : 'delivered';
      const costPts = status === 'delivered' ? 40 : 0;
      const r = await client.execute({
        sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,status,captain_id,cost_points,cost_source,day,created_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [m1.id, 1, `زبون ${i}`, '0940000001', `شارع رقم ${i}`, status, c1.id, costPts, 'override', day, created, closed],
      });
      const oid = Number(r.lastInsertRowid);
      histIds.push(oid);
      if (isToday && status === 'delivered') {
        await client.execute({
          sql: "INSERT INTO points_ledger(captain_id,kind,amount,balance_after,order_id,actor_id,note,at) VALUES(?,'deduction',-40,?,?,?,?,?)",
          args: [c1.id, 500 - (i - 23) * 40, oid, c1.id, `خصم #${oid}`, closed],
        });
      }
    }

    const actR = await client.execute({
      sql: "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,captain_id,cost_points,cost_source,created_at,accepted_at) VALUES(?,?,?,?,?,?,?,'accepted',?,40,'override',?,?)",
      args: [m1.id, 1, 'زبون نشط', '0940000002', 'عنوان قيد التوصيل', 33.511, 36.271, c1.id, now - 30_000, now - 20_000],
    });
    activeId = Number(actR.lastInsertRowid);
  });

  // 1. Admin gets full details (custom override initially)
  const admDet = await call(`/admin/captains/${c1.id}/details`, 'GET', null, adm);
  assert.equal(admDet.status, 200);
  const d = admDet.data;
  assert.equal(d.profile.id, c1.id);
  assert.equal(d.profile.name, 'كابتن حسام');
  assert.equal(d.profile.phone, '0935550001');
  assert.equal(d.profile.tag, c1.tag);
  assert.equal(d.profile.hashtag, `#${c1.tag}`);
  assert.ok(d.profile.zone_name);
  assert.equal(d.profile.online, true);
  assert.equal(d.profile.busy, true);
  assert.ok(d.profile.last_loc_at);

  assert.equal(d.wallet.balance_points, 500);
  assert.equal(d.wallet.effective_cost_points, 40);
  assert.equal(d.wallet.cost_override, 40);
  assert.equal(d.wallet.cost_source, 'override');
  assert.equal(d.wallet.exemption_status, 'none');

  assert.equal(d.today.delivered_count, 2);
  assert.equal(d.today.points_deducted, 80);

  assert.equal(d.active_orders.length, 1);
  assert.equal(d.active_orders[0].id, activeId);
  assert.equal(d.active_orders[0].status, 'accepted');
  assert.equal(d.active_orders[0].merchant.name, 'مطعم الشام');
  assert.equal(d.active_orders[0].customer_address, 'عنوان قيد التوصيل');

  assert.equal(d.history.total, 25);
  assert.equal(d.history.orders.length, 20);
  assert.equal(d.history.has_more, true);
  assert.equal(d.history.orders[0].id, histIds[24], 'newest history order first');
  assert.equal(d.history.orders[19].id, histIds[5], '20th item matches slice');
  assert.equal(d.history.orders[0].merchant.name, 'مطعم الشام');

  // Verify temporary exemption reflects in wallet section when enabled
  assert.equal((await call(`/admin/users/${c1.id}`, 'PATCH', { exempt_until: exemptUntil }, adm)).status, 200);
  const admDetExempt = await call(`/admin/captains/${c1.id}/details`, 'GET', null, adm);
  assert.equal(admDetExempt.status, 200);
  assert.equal(admDetExempt.data.wallet.effective_cost_points, 0);
  assert.equal(admDetExempt.data.wallet.exemption_status, 'temporary');
  assert.equal(admDetExempt.data.wallet.exempt_until, exemptUntil);

  // Verify permanent exemption reflects on c2
  const c2Det = await call(`/admin/captains/${c2.id}/details`, 'GET', null, adm);
  assert.equal(c2Det.status, 200);
  assert.equal(c2Det.data.wallet.effective_cost_points, 0);
  assert.equal(c2Det.data.wallet.exemption_status, 'permanent');

  // 2. zone_admin receives 403 for captain in another zone
  assert.equal((await call(`/admin/captains/${c1.id}/details`, 'GET', null, zaZ2Tok)).status, 403);
  assert.equal((await call(`/admin/captains/${c1.id}/orders?offset=0&limit=20`, 'GET', null, zaZ2Tok)).status, 403);
  assert.equal((await call(`/admin/captains/${c2.id}/details`, 'GET', null, zaZ1Tok)).status, 403);
  assert.equal((await call(`/admin/captains/${c2.id}/orders`, 'GET', null, zaZ1Tok)).status, 403);

  // Non-admin roles blocked (403) and unauthenticated blocked (401)
  assert.equal((await call(`/admin/captains/${c1.id}/details`, 'GET', null, c1Tok)).status, 403);
  assert.equal((await call(`/admin/captains/${c1.id}/details`, 'GET', null, m1Tok)).status, 403);
  assert.equal((await call(`/admin/captains/${c1.id}/details`, 'GET', null, null)).status, 401);

  // 3. zone_admin gets full details & orders for captain in their own zone
  const zaOwnDet = await call(`/admin/captains/${c1.id}/details`, 'GET', null, zaZ1Tok);
  assert.equal(zaOwnDet.status, 200);
  assert.equal(zaOwnDet.data.profile.id, c1.id);
  assert.equal(zaOwnDet.data.history.total, 25);

  const zaOwnOrders = await call(`/admin/captains/${c1.id}/orders?offset=0&limit=20`, 'GET', null, zaZ1Tok);
  assert.equal(zaOwnOrders.status, 200);
  assert.equal(zaOwnOrders.data.orders.length, 20);
  assert.equal(zaOwnOrders.data.total, 25);

  // 4. History pagination returns exact slices and total
  const page2 = await call(`/admin/captains/${c1.id}/orders?offset=20&limit=20`, 'GET', null, adm);
  assert.equal(page2.status, 200);
  assert.equal(page2.data.total, 25);
  assert.equal(page2.data.offset, 20);
  assert.equal(page2.data.limit, 20);
  assert.equal(page2.data.has_more, false);
  assert.deepEqual(
    page2.data.orders.map((o) => o.id),
    [histIds[4], histIds[3], histIds[2], histIds[1], histIds[0]]
  );

  // 5. Validation rejects limit > 50, limit < 1, negative offset, non-integer params
  assert.equal((await call(`/admin/captains/${c1.id}/orders?offset=0&limit=51`, 'GET', null, adm)).status, 400);
  assert.equal((await call(`/admin/captains/${c1.id}/orders?offset=0&limit=0`, 'GET', null, adm)).status, 400);
  assert.equal((await call(`/admin/captains/${c1.id}/orders?offset=0&limit=10.5`, 'GET', null, adm)).status, 400);
  assert.equal((await call(`/admin/captains/${c1.id}/orders?offset=-1&limit=20`, 'GET', null, adm)).status, 400);
  assert.equal((await call(`/admin/captains/999999/details`, 'GET', null, adm)).status, 404);

  // 6. Security: zero secret or auth-internal fields anywhere in responses
  const detailsKeys = collectKeysDeep(admDet.data);
  const pageKeys = collectKeysDeep(page2.data);
  for (const k of SECRET_KEYS) {
    assert.equal(detailsKeys.has(k), false, `/details leaked forbidden key: ${k}`);
    assert.equal(pageKeys.has(k), false, `/orders leaked forbidden key: ${k}`);
  }
});
