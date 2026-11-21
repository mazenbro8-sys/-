import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-perf-phase1-'));
const dbFile = path.join(tmpDir, 'phase1.db');
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = dbFile;
process.env.ADMIN_PHONE = '0911111166';
process.env.ADMIN_PASSWORD = 'Admin12345';

const { client, db, tx, withDbTimeout } = await import('../src/db.js');
const { api } = await import('../src/routes.js');
const { dispatchOrder, runDispatcherTick, viewOrder, viewOrdersBatch } = await import('../src/dispatch.js');
const { makeRoute, makeRouteCacheKey, clearRouteCache } = await import('../public/shared.js');

const app = express();
app.use('/api', express.json({ limit: '16kb' }), api);
const server = http.createServer(app);

let base;
let adminToken;
let merchantToken;
let captainToken;
let merchId;
let capId;

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
  adminToken = (await call('/auth/login', 'POST', { phone: '0911111166', password: 'Admin12345' })).data.token;

  const mRes = await call('/admin/users', 'POST', {
    role: 'merchant',
    phone: '0927770001',
    name: 'صاحب منشأة',
    business_name: 'مطعم التجربة',
    address: 'المزة 10',
    lat: 33.505,
    lng: 36.255,
    password: 'Passw0rd1',
    zone_id: 1,
  }, adminToken);
  assert.equal(mRes.status, 201);
  merchId = mRes.data.id;
  merchantToken = (await call('/auth/login', 'POST', { phone: '0927770001', password: 'Passw0rd1' })).data.token;

  const cRes = await call('/admin/users', 'POST', {
    role: 'captain',
    phone: '0937770001',
    name: 'كابتن 1',
    password: 'Passw0rd1',
    zone_id: 1,
  }, adminToken);
  assert.equal(cRes.status, 201);
  capId = cRes.data.id;
  captainToken = (await call('/auth/login', 'POST', { phone: '0937770001', password: 'Passw0rd1' })).data.token;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  client.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('(a) dispatchOrder and runDispatcherTick open zero write transactions when no captain is available, then dispatch in one tx when available', async () => {
  const now = Date.now();
  const searchingIds = [];
  await tx(async () => {
    await db.run('UPDATE users SET online=0 WHERE id=?', capId);
    for (let i = 0; i < 5; i++) {
      const r = await db.run(
        "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,created_at) VALUES(?,?,?,?,?,?,?,'searching',?)",
        merchId, 1, `عميل ${i}`, '0941000001', `عنوان ${i}`, 33.51, 36.26, now - 10_000
      );
      searchingIds.push(r.lastInsertRowid);
    }
  });

  // Spy on client.transaction('write')
  let writeTxCount = 0;
  const origTransaction = client.transaction.bind(client);
  client.transaction = async (...args) => {
    writeTxCount++;
    return origTransaction(...args);
  };

  try {
    // Direct dispatchOrder on one searching order -> 0 write transactions
    const res1 = await dispatchOrder(searchingIds[0]);
    assert.equal(res1, false);
    assert.equal(writeTxCount, 0, 'dispatchOrder must open 0 write transactions when no captain is available');

    // Full 5-second dispatcher tick across all 5 searching orders -> 0 write transactions
    const alerted = new Set();
    await runDispatcherTick(alerted);
    await runDispatcherTick(alerted);
    assert.equal(writeTxCount, 0, 'runDispatcherTick must open 0 write transactions when no captain is available');

    // Bring captain online with recent location signal and run dispatcher once -> exactly 1 write transaction assigns first order
    await db.run('UPDATE users SET online=1, last_loc_at=? WHERE id=?', Date.now(), capId);
    writeTxCount = 0;
    const dispatched = await dispatchOrder(searchingIds[0]);
    assert.equal(dispatched, true);
    assert.equal(writeTxCount, 1, 'dispatchOrder opens exactly 1 write transaction when a captain is found');
    const updated = await db.get('SELECT status, offered_captain_id FROM orders WHERE id=?', searchingIds[0]);
    assert.equal(updated.status, 'offered');
    assert.equal(updated.offered_captain_id, capId);
  } finally {
    client.transaction = origTransaction;
    // Clean up searching orders so subsequent tests have a clean state
    await db.run(`DELETE FROM offers WHERE order_id IN (${searchingIds.map(() => '?').join(',')})`, ...searchingIds);
    await db.run(`DELETE FROM order_events WHERE order_id IN (${searchingIds.map(() => '?').join(',')})`, ...searchingIds);
    await db.run(`DELETE FROM orders WHERE id IN (${searchingIds.map(() => '?').join(',')})`, ...searchingIds);
  }
});

test('(b) viewOrdersBatch matches viewOrder identically across admin, merchant, and captain perspectives', async () => {
  const now = Date.now();
  const orderIds = [];
  await tx(async () => {
    await db.run('UPDATE users SET online=1, last_lat=33.507, last_lng=36.257, last_loc_at=?, last_loc_vis=? WHERE id=?', now - 5_000, 'visible', capId);
    const ins1 = await db.run(
      "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,product_amount,delivery_fee,notes,status,captain_id,cost_points,cost_source,created_at,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?,25,'default',?,?)",
      merchId, 1, 'علي', '0944000001', 'عنوان مقبول', 33.515, 36.265, 5000, 1500, 'ملاحظة 1', capId, now - 60_000, now - 45_000
    );
    const ins2 = await db.run(
      "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,offered_captain_id,offer_expires_at,created_at) VALUES(?,?,?,?,?,?,?,'offered',?,?,?)",
      merchId, 1, 'سارة', '0944000002', 'عنوان معروض', 33.518, 36.268, capId, now + 20_000, now - 20_000
    );
    const ins3 = await db.run(
      "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,status,captain_id,cost_points,cost_source,day,created_at,closed_at) VALUES(?,?,?,?,?,'delivered',?,25,'default','2026-11-16',?,?)",
      merchId, 1, 'كريم', '0944000003', 'عنوان مسلّم', capId, now - 120_000, now - 10_000
    );
    orderIds.push(ins1.lastInsertRowid, ins2.lastInsertRowid, ins3.lastInsertRowid);
  });

  const rows = await db.all(`SELECT * FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id ASC`, ...orderIds);
  for (const perspective of ['admin', 'merchant', 'captain']) {
    const expected = await Promise.all(rows.map((o) => viewOrder(o, perspective)));
    const actual = await viewOrdersBatch(rows, perspective);
    assert.deepEqual(actual, expected, `viewOrdersBatch must match viewOrder for ${perspective}`);
  }

  await db.run(`DELETE FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`, ...orderIds);
});

test('(c) order list routes execute a bounded 3 SQL statements for 100 orders (including auth lookup)', async () => {
  const now = Date.now();
  await tx(async () => {
    for (let i = 0; i < 100; i++) {
      await db.run(
        "INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,status,captain_id,cost_points,cost_source,day,created_at,closed_at) VALUES(?,?,?,?,?,?,?,'delivered',?,25,'default','2026-11-16',?,?)",
        merchId, 1, `طلب مئوي ${i}`, '0945000001', `شارع ${i}`, 33.51, 36.26, capId, now - (100 - i) * 1000, now - i * 500
      );
    }
  });

  let sqlCount = 0;
  const origGet = db.get.bind(db);
  const origAll = db.all.bind(db);
  const origRun = db.run.bind(db);
  db.get = async (...args) => { sqlCount++; return origGet(...args); };
  db.all = async (...args) => { sqlCount++; return origAll(...args); };
  db.run = async (...args) => { sqlCount++; return origRun(...args); };

  try {
    sqlCount = 0;
    const admRes = await call('/admin/orders', 'GET', null, adminToken);
    assert.equal(admRes.status, 200);
    assert.equal(admRes.data.length, 100);
    assert.ok(sqlCount <= 4, `GET /admin/orders expected <= 4 SQL queries for 100 orders, got ${sqlCount}`);
    assert.equal(sqlCount, 3, '1 auth + 1 orders + 1 batched users query');

    sqlCount = 0;
    const merchRes = await call('/merchant/orders', 'GET', null, merchantToken);
    assert.equal(merchRes.status, 200);
    assert.equal(merchRes.data.length, 100);
    assert.equal(sqlCount, 3, `GET /merchant/orders expected 3 SQL queries for 100 orders, got ${sqlCount}`);

    sqlCount = 0;
    const capRes = await call('/captain/history', 'GET', null, captainToken);
    assert.equal(capRes.status, 200);
    assert.equal(capRes.data.length, 100);
    assert.equal(sqlCount, 3, `GET /captain/history expected 3 SQL queries for 100 orders, got ${sqlCount}`);
  } finally {
    db.get = origGet;
    db.all = origAll;
    db.run = origRun;
  }
});

test('withDbTimeout rejects slow DB promises and makeRoute caches OSRM responses for 60s with 1 fallback only', async () => {
  await assert.rejects(
    withDbTimeout(new Promise(() => {}), 25),
    (err) => err.code === 'DB_TIMEOUT' && err.message.includes('25ms')
  );

  // Verify makeRoute caching and single-fallback behavior in shared.js
  clearRouteCache();
  const added = [];
  const prevWindow = globalThis.window;
  const prevLocation = globalThis.location;
  globalThis.window = { PANTHER_DEFAULT_SERVER: '' };
  globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: '3000', pathname: '/admin' };
  globalThis.L = {
    polyline: (coords, opts) => {
      const layer = { coords, opts, addTo: (m) => { added.push({ m, layer }); return layer; } };
      return layer;
    },
  };
  const fakeMap = { id: 'map1' };
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      fetchCalls++;
      assert.ok(init?.signal, 'external OSRM request must include AbortSignal timeout');
      if (String(url).includes('router.project-osrm.org')) {
        return {
          ok: true,
          json: async () => ({
            code: 'Ok',
            routes: [{ geometry: { coordinates: [[36.25, 33.50], [36.26, 33.51]] } }],
          }),
        };
      }
      return { ok: false };
    };

    assert.equal(makeRouteCacheKey([33.501234, 36.251234], [33.512345, 36.262345], 'driving'), 'driving:33.5012,36.2512->33.5123,36.2623');
    const l1 = await makeRoute(fakeMap, [33.501234, 36.251234], [33.512345, 36.262345]);
    const l2 = await makeRoute(fakeMap, [33.501211, 36.251211], [33.512349, 36.262349]);
    assert.equal(fetchCalls, 1, 'second call with same 4-decimal rounded coords hits cache');
    assert.deepEqual(l1.coords, l2.coords);

    // Fallback test: failed external OSRM triggers at most 1 fallback request (total 2 fetches)
    clearRouteCache();
    fetchCalls = 0;
    const seenUrls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls++;
      seenUrls.push(String(url));
      assert.ok(init?.signal, 'fallback request also has timeout AbortSignal');
      throw new Error('network error');
    };
    const fallbackLine = await makeRoute(fakeMap, [33.55, 36.28], [33.56, 36.29]);
    assert.equal(fetchCalls, 2, '1 external OSRM + 1 /api/route fallback only');
    assert.ok(seenUrls[0].startsWith('https://router.project-osrm.org/'));
    assert.ok(seenUrls[1].includes('/api/route?'));
    assert.equal(fallbackLine.opts.dashArray, '10 8');
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.L;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevLocation === undefined) delete globalThis.location;
    else globalThis.location = prevLocation;
    clearRouteCache();
  }
});
