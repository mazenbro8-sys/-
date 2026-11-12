import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getCaptainVisualState } from '../public/live-state.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-live-transfer-'));
const dbPath = path.join(tmpDir, 'live.db');
const port = 4300 + Math.floor(Math.random() * 300);
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
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111199',
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
  throw new Error('live-transfer server did not start');
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('Live map operations: searching->free, busy 2-order transfer, picked_up/arrived/offline/zone_admin guards, & multi-order location WS loop', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111199', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', {
      role,
      phone,
      name: `${role}-${phone}`,
      password: 'Passw0rdX',
      zone_id: 1,
      ...extra,
    }, adm);
    assert.equal(r.status, 201);
    return { ...r.data, tok: await login(phone) };
  };

  // Create second zone + zone_admin
  const z2 = (await call('/admin/zones', 'POST', { name: 'المالكي الغربي' }, adm)).data;
  const za1 = await reg('zone_admin', '0961111101', { zone_id: 1 });

  // Zone 1 actors: two merchants + three captains (one stays offline)
  const m1 = await reg('merchant', '0921111101', { business_name: 'مطعم الياسمين', address: 'المزة 1', lat: 33.501, lng: 36.251, zone_id: 1 });
  const m2 = await reg('merchant', '0921111102', { business_name: 'مطعم القلعة', address: 'المزة 2', lat: 33.512, lng: 36.262, zone_id: 1 });
  const cFree = await reg('captain', '0931111101', { zone_id: 1 });
  const cBusy = await reg('captain', '0931111102', { zone_id: 1 });
  const cOff = await reg('captain', '0931111103', { zone_id: 1 });

  // Zone 2 actors
  const mZ2 = await reg('merchant', '0922222201', { business_name: 'منشأة المالكي', address: 'المالكي', lat: 33.52, lng: 36.27, zone_id: z2.id });
  const cZ2 = await reg('captain', '0932222201', { zone_id: z2.id });

  // Server-enforced zone isolation on GET /admin/live
  const zaLive = await call('/admin/live', 'GET', null, za1.tok);
  assert.equal(zaLive.status, 200);
  assert.ok(zaLive.data.merchants.every((x) => x.zone_id === 1));
  assert.ok(zaLive.data.captains.every((x) => x.zone_id === 1));
  assert.ok(!zaLive.data.merchants.some((x) => x.id === mZ2.id));
  assert.ok(!zaLive.data.captains.some((x) => x.id === cZ2.id));

  const admLive = await call('/admin/live', 'GET', null, adm);
  assert.ok(admLive.data.merchants.some((x) => x.id === mZ2.id));
  assert.ok(admLive.data.captains.some((x) => x.id === cZ2.id));

  // Turn online only cFree, cBusy, cZ2 (keep cOff offline!)
  await call('/captain/online', 'POST', { online: true }, cFree.tok);
  await call('/captain/online', 'POST', { online: true }, cZ2.tok);
  // Set initial location for cOff before keeping it offline? Keep cOff offline (online=false)

  // 1. Offline captain rejection
  const ordSearch = (await call('/merchant/orders', 'POST', { customer_address: 'هدف أول', customer_lat: 33.505, customer_lng: 36.255 }, m1.tok)).data;
  assert.equal(['searching', 'offered'].includes(ordSearch.status), true);

  const offRes = await call(`/admin/orders/${ordSearch.id}/assign-captain`, 'POST', { captain_id: cOff.id }, adm);
  assert.equal(offRes.status, 400);
  assert.equal((await call(`/admin/orders/${ordSearch.id}`, 'GET', null, adm)).data.captain_id, null);

  // Also test check_warning two-step flow (default 25 pts cost vs 0 pts balance -> returns warning without committing yet)
  const warnPreview = await call(`/admin/orders/${ordSearch.id}/assign-captain`, 'POST', { captain_id: cFree.id, check_warning: true }, adm);
  assert.equal(warnPreview.status, 200);
  assert.equal(warnPreview.data.needs_confirm, true);
  assert.ok(warnPreview.data.warning);
  // Order still NOT committed yet!
  assert.equal((await call(`/admin/orders/${ordSearch.id}`, 'GET', null, adm)).data.captain_id, null);

  // 2. Confirm transfer from searching/offered order to free captain
  const trFree = await call(`/admin/orders/${ordSearch.id}/assign-captain`, 'POST', { captain_id: cFree.id, confirm_warning: true }, adm);
  assert.equal(trFree.status, 200);
  assert.equal(trFree.data.status, 'accepted');
  assert.equal(trFree.data.captain_id, cFree.id);
  assert.ok(trFree.data.warning);

  // Put cBusy online as well, verify cFree now has 1 active order (busy), and create a second order for m2
  await call('/captain/online', 'POST', { online: true }, cBusy.tok);
  const ord2 = (await call('/merchant/orders', 'POST', { customer_address: 'هدف ثاني', customer_lat: 33.516, customer_lng: 36.266 }, m2.tok)).data;
  assert.equal(['searching', 'offered'].includes(ord2.status), true);

  // 3. Transfer to a busy captain (cFree already holds ordSearch, now receives ord2 too -> holds 2 active orders!)
  const trBusy = await call(`/admin/orders/${ord2.id}/assign-captain`, 'POST', { captain_id: cFree.id }, adm);
  assert.equal(trBusy.status, 200);
  assert.equal(trBusy.data.status, 'accepted');
  assert.equal(trBusy.data.captain_id, cFree.id);

  const liveAfterBusy = (await call('/admin/live', 'GET', null, adm)).data;
  const cFreeLive = liveAfterBusy.captains.find((c) => c.id === cFree.id);
  const cBusyLive = liveAfterBusy.captains.find((c) => c.id === cBusy.id);
  const cOffLive = liveAfterBusy.captains.find((c) => c.id === cOff.id);
  assert.equal(cFreeLive.busy, true);
  assert.equal(cFreeLive.active_orders.length, 2);
  assert.equal(getCaptainVisualState(cFreeLive, liveAfterBusy.orders).stateKey, 'blue', 'accepted-only captain must be blue');
  assert.equal(getCaptainVisualState(cBusyLive, liveAfterBusy.orders).stateKey, 'yellow', 'free online captain must be yellow');
  assert.equal(getCaptainVisualState(cOffLive, liveAfterBusy.orders).stateKey, 'gray', 'offline captain must be gray');

  // 4. Multi-order captain location & ETA fix: connect WS for BOTH m1 and m2 and post 1 captain location ping
  const m1Ws = await connectWsClient(m1.tok);
  const m2Ws = await connectWsClient(m2.tok);
  try {
    const locRes = await call('/captain/location', 'POST', { lat: 33.503, lng: 36.253, vis: 'visible' }, cFree.tok);
    assert.equal(locRes.status, 204);

    const hit1 = await waitForMsg(m1Ws.msgs, (x) => x.type === 'loc' && x.order_id === ordSearch.id);
    const hit2 = await waitForMsg(m2Ws.msgs, (x) => x.type === 'loc' && x.order_id === ord2.id);
    assert.ok(hit1, 'First merchant received loc WS update');
    assert.ok(hit2, 'Second merchant received loc WS update');
    assert.equal(hit1.lat, 33.503);
    assert.equal(hit2.lat, 33.503);
    assert.ok(Number.isFinite(hit1.eta_minutes) && hit1.eta_minutes >= 1);
    assert.ok(Number.isFinite(hit2.eta_minutes) && hit2.eta_minutes >= 1);
  } finally {
    m1Ws.ws.close();
    m2Ws.ws.close();
  }

  // 5. Rejection for picked_up and arrived orders
  await call('/captain/location', 'POST', { lat: 33.501, lng: 36.251, vis: 'visible' }, cFree.tok); // at m1 pickup radius
  const pUp = await call(`/captain/orders/${ordSearch.id}/status`, 'POST', { status: 'picked_up', lat: 33.501, lng: 36.251, accuracy: 10 }, cFree.tok);
  assert.equal(pUp.status, 200);
  const liveMixed = (await call('/admin/live', 'GET', null, adm)).data;
  const cFreeMixed = liveMixed.captains.find((c) => c.id === cFree.id);
  assert.equal(getCaptainVisualState(cFreeMixed, liveMixed.orders).stateKey, 'green', 'picked_up must win over accepted in multi-order live data');
  const rejPickedUp = await call(`/admin/orders/${ordSearch.id}/assign-captain`, 'POST', { captain_id: cBusy.id }, adm);
  assert.equal(rejPickedUp.status, 400);
  assert.equal((await call(`/admin/orders/${ordSearch.id}`, 'GET', null, adm)).data.captain_id, cFree.id);

  const arr = await call(`/captain/orders/${ordSearch.id}/status`, 'POST', { status: 'arrived' }, cFree.tok);
  assert.equal(arr.status, 200);
  const rejArrived = await call(`/admin/orders/${ordSearch.id}/assign-captain`, 'POST', { captain_id: cBusy.id }, adm);
  assert.equal(rejArrived.status, 400);
  assert.equal((await call(`/admin/orders/${ordSearch.id}`, 'GET', null, adm)).data.captain_id, cFree.id);

  // 6. zone_admin cross-zone rejection with 403
  const ordZ2 = (await call('/merchant/orders', 'POST', { customer_address: 'هدف مالكي' }, mZ2.tok)).data;
  // Cross-zone order -> 403
  const crossOrd = await call(`/admin/orders/${ordZ2.id}/assign-captain`, 'POST', { captain_id: cBusy.id }, za1.tok);
  assert.equal(crossOrd.status, 403);
  // Own-zone order to cross-zone captain -> 403
  const ordZ1Free = (await call('/merchant/orders', 'POST', { customer_address: 'هدف مزة 3' }, m1.tok)).data;
  const crossCap = await call(`/admin/orders/${ordZ1Free.id}/assign-captain`, 'POST', { captain_id: cZ2.id }, za1.tok);
  assert.equal(crossCap.status, 403);
});

test('Captain marker color classification covers every stage & green priority over blue', () => {
  // Online free -> yellow pulsing
  const freeSt = getCaptainVisualState({ id: 1, online: true, active_orders: [] }, []);
  assert.equal(freeSt.stateKey, 'yellow');
  assert.equal(freeSt.stateClass, 'ops-state-yellow ops-pulsing');
  assert.equal(freeSt.pulsing, true);

  // Online accepted-only -> blue pulsing
  const accSt = getCaptainVisualState({ id: 2, online: true, active_orders: [{ id: 10, status: 'accepted' }] }, []);
  assert.equal(accSt.stateKey, 'blue');
  assert.equal(accSt.stateClass, 'ops-state-blue ops-pulsing');
  assert.equal(accSt.pulsing, true);

  // Online picked_up -> green pulsing
  const puSt = getCaptainVisualState({ id: 3, online: true, active_orders: [{ id: 11, status: 'picked_up' }] }, []);
  assert.equal(puSt.stateKey, 'green');
  assert.equal(puSt.stateClass, 'ops-state-green ops-pulsing');
  assert.equal(puSt.pulsing, true);

  // Online arrived -> green pulsing
  const arrSt = getCaptainVisualState({ id: 4, online: true, active_orders: [{ id: 12, status: 'arrived' }] }, []);
  assert.equal(arrSt.stateKey, 'green');
  assert.equal(arrSt.stateClass, 'ops-state-green ops-pulsing');
  assert.equal(arrSt.pulsing, true);

  // Multiple active orders: accepted + picked_up -> green priority
  const mixPu = getCaptainVisualState(
    { id: 5, online: true, active_orders: [{ id: 13, status: 'accepted' }, { id: 14, status: 'picked_up' }] },
    []
  );
  assert.equal(mixPu.stateKey, 'green');

  // Multiple active orders derived via liveOrders fallback (accepted + arrived -> green priority)
  const mixArr = getCaptainVisualState(
    { id: 6, online: true },
    [
      { id: 15, captain_id: 6, status: 'accepted' },
      { id: 16, captain_id: 6, status: 'arrived' },
    ]
  );
  assert.equal(mixArr.stateKey, 'green');
  assert.equal(mixArr.activeCount, 2);

  // Offline -> gray non-pulsing even if active_orders contains data
  const offSt = getCaptainVisualState({ id: 7, online: false, active_orders: [{ id: 17, status: 'picked_up' }] }, []);
  assert.equal(offSt.stateKey, 'gray');
  assert.equal(offSt.stateClass, 'ops-state-gray ops-offline');
  assert.equal(offSt.pulsing, false);
});
