import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  TRANSFER_HINT_TEXT,
  CAPTAIN_OFFLINE_TEXT,
  getTransferableOrder,
  decideMerchantTap,
  decideCaptainTap,
  transferOnCaptainTap,
} from '../public/live-transfer.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-fast-transfer-'));
const dbPath = path.join(tmpDir, 'fast-transfer.db');
const port = 4900 + Math.floor(Math.random() * 250);
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

function makeClientApi(token, log = []) {
  return async (p, method = 'GET', body = null) => {
    log.push({ p, method, body });
    const r = await call(p, method, body, token);
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(r.data?.error || 'حدث خطأ');
      err.status = r.status;
      throw err;
    }
    return r.data;
  };
}

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111198',
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
  throw new Error('live-transfer-fast server did not start');
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('fast live-map transfer (merchant -> captain): one-request assign, warning passthrough, 403 zone guard, offline client guard, and picked_up unselectable', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111198', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', {
      role,
      phone,
      name: extra.name || `${role}-${phone}`,
      password: 'Passw0rdX',
      zone_id: 1,
      ...extra,
    }, adm);
    assert.equal(r.status, 201);
    return { ...r.data, name: extra.name || `${role}-${phone}`, tok: await login(phone) };
  };

  const z2 = (await call('/admin/zones', 'POST', { name: 'المالكي الجنوبي' }, adm)).data;
  const za1 = await reg('zone_admin', '0969990001', { zone_id: 1 });

  const m1 = await reg('merchant', '0929990001', { business_name: 'مطعم الرشيد', address: 'المزة', lat: 33.501, lng: 36.251, zone_id: 1 });
  const m2 = await reg('merchant', '0929990002', { business_name: 'مطعم النور', address: 'المزة 2', lat: 33.507, lng: 36.257, zone_id: 1 });
  const cRich = await reg('captain', '0939990001', { name: 'كابتن كريم', zone_id: 1 });
  const cLowBal = await reg('captain', '0939990002', { name: 'كابتن رصيد قليل', zone_id: 1 });
  const cOff = await reg('captain', '0939990003', { name: 'كابتن غير متصل', zone_id: 1 });

  const mZ2 = await reg('merchant', '0929990011', { business_name: 'منشأة منطقة 2', address: 'المالكي', lat: 33.52, lng: 36.27, zone_id: z2.id });
  const cZ2 = await reg('captain', '0939990011', { name: 'كابتن مالكي', zone_id: z2.id });

  // Fund cRich so normal assignment succeeds without low-balance warning; leave cLowBal at 0 pts
  assert.equal((await call(`/admin/captains/${cRich.id}/topup`, 'POST', { points: 500 }, adm)).status, 200);
  await call('/captain/online', 'POST', { online: true }, cRich.tok);
  await call('/captain/online', 'POST', { online: true }, cLowBal.tok);
  await call('/captain/online', 'POST', { online: true }, cZ2.tok);

  // Create two waiting orders (m1 & m2); mark Zone 2 order for cross-zone test
  const ord1 = (await call('/merchant/orders', 'POST', { customer_address: 'هدف أول', customer_lat: 33.503, customer_lng: 36.253 }, m1.tok)).data;
  assert.equal(['searching', 'offered'].includes(ord1.status), true);

  let live = (await call('/admin/live', 'GET', null, adm)).data;
  const m1Live = live.merchants.find((x) => x.id === m1.id);
  const cRichLive = live.captains.find((x) => x.id === cRich.id);
  const cLowLive = live.captains.find((x) => x.id === cLowBal.id);
  const cOffLive = live.captains.find((x) => x.id === cOff.id);
  const cZ2Live = live.captains.find((x) => x.id === cZ2.id);

  // Tapping captain with NO merchant selected opens details card instead of transfer
  assert.equal(decideCaptainTap(cRichLive, null, live.orders).action, 'details');
  assert.equal(TRANSFER_HINT_TEXT, 'اضغط على كابتن لنقل الطلب إليه');

  // 1. Selecting yellow merchant + tapping online captain completes transfer with ONE request
  const selDec = decideMerchantTap(m1Live, live.orders, null);
  assert.equal(selDec.action, 'select');
  assert.equal(selDec.orderId, ord1.id);
  const selection1 = { kind: 'merchant', merchantId: m1.id, orderId: selDec.orderId };

  // Re-tapping the same selected merchant clears selection
  assert.equal(decideMerchantTap(m1Live, live.orders, selection1).action, 'clear');

  const reqs1 = [];
  const res1 = await transferOnCaptainTap({
    captain: cRichLive,
    selection: selection1,
    orders: live.orders,
    api: makeClientApi(adm, reqs1),
  });
  assert.equal(reqs1.length, 1, 'must send exactly 1 POST assign-captain request');
  assert.equal(reqs1[0].method, 'POST');
  assert.equal(reqs1[0].p, `/admin/orders/${ord1.id}/assign-captain`);
  assert.deepEqual(reqs1[0].body, { captain_id: cRich.id });
  assert.equal(res1.action, 'assign');
  assert.equal(res1.result.ok, true);
  assert.equal(res1.result.warning, null);
  assert.equal(res1.result.message, `تم نقل الطلب إلى ${cRich.name}`);
  assert.equal(res1.result.order.status, 'accepted');
  assert.equal(res1.result.order.captain_id, cRich.id);

  // 2. Server warning (low balance) is shown in toast message AND completes the transfer anyway
  const ord2 = (await call('/merchant/orders', 'POST', { customer_address: 'هدف ثاني رصيد قليل', customer_lat: 33.509, customer_lng: 36.259 }, m2.tok)).data;
  live = (await call('/admin/live', 'GET', null, adm)).data;
  const m2Live = live.merchants.find((x) => x.id === m2.id);
  const selDec2 = decideMerchantTap(m2Live, live.orders, null);
  assert.equal(selDec2.action, 'select');
  const selection2 = { kind: 'merchant', merchantId: m2.id, orderId: selDec2.orderId };

  // 4. Offline captain is rejected strictly by the client guard and NEVER sent to server
  const offlineReqs = [];
  const offRes = await transferOnCaptainTap({
    captain: cOffLive,
    selection: selection2,
    orders: live.orders,
    api: makeClientApi(adm, offlineReqs),
  });
  assert.equal(offRes.action, 'offline');
  assert.equal(offlineReqs.length, 0, 'offline captain must not send any server request');
  assert.equal(CAPTAIN_OFFLINE_TEXT, 'الكابتن غير متصل');

  // Now tap online low-balance captain on the same still-selected merchant order
  const reqs2 = [];
  const res2 = await transferOnCaptainTap({
    captain: cLowLive,
    selection: selection2,
    orders: live.orders,
    api: makeClientApi(adm, reqs2),
  });
  assert.equal(reqs2.length, 1);
  assert.equal(res2.action, 'assign');
  assert.equal(res2.result.ok, true, 'warning must not block completion');
  assert.ok(res2.result.warning && res2.result.warning.includes('تنبيه'));
  assert.ok(res2.result.message.includes(`تم نقل الطلب إلى ${cLowBal.name}`));
  assert.ok(res2.result.message.includes(res2.result.warning));
  const checkOrd2 = (await call(`/admin/orders/${ord2.id}`, 'GET', null, adm)).data;
  assert.equal(checkOrd2.status, 'accepted');
  assert.equal(checkOrd2.captain_id, cLowBal.id);

  // 3. Cross-zone zone_admin attempt returns 403 from the server
  const ordZ2 = (await call('/merchant/orders', 'POST', { customer_address: 'هدف مالكي 2' }, mZ2.tok)).data;
  live = (await call('/admin/live', 'GET', null, adm)).data;
  const mZ2Live = live.merchants.find((x) => x.id === mZ2.id);
  const crossReqs = [];
  const crossRes = await transferOnCaptainTap({
    captain: cZ2Live,
    selection: { kind: 'merchant', merchantId: mZ2Live.id, orderId: ordZ2.id },
    orders: live.orders,
    api: makeClientApi(za1.tok, crossReqs),
  });
  assert.equal(crossReqs.length, 1);
  assert.equal(crossRes.action, 'assign');
  assert.equal(crossRes.result.ok, false);
  assert.equal(crossRes.result.status, 403);
  assert.ok(crossRes.result.error);
  assert.equal((await call(`/admin/orders/${ordZ2.id}`, 'GET', null, adm)).data.captain_id, null);

  // 5. A picked_up order on a merchant is NOT selectable
  await call('/captain/location', 'POST', { lat: 33.501, lng: 36.251, vis: 'visible' }, cRich.tok);
  const puRes = await call(`/captain/orders/${ord1.id}/status`, 'POST', { status: 'picked_up', lat: 33.501, lng: 36.251, accuracy: 10 }, cRich.tok);
  assert.equal(puRes.status, 200);
  live = (await call('/admin/live', 'GET', null, adm)).data;
  const m1AfterPickup = live.merchants.find((x) => x.id === m1.id);
  assert.equal(getTransferableOrder(m1AfterPickup, live.orders), null);
  assert.equal(decideMerchantTap(m1AfterPickup, live.orders, null).action, 'locked');
});
