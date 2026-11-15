import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-cancel-acc-'));
const dbPath = path.join(tmpDir, 'cancel.db');
const port = 6100 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}/api`;
let proc;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function connectWs(token) {
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

async function waitFor(msgs, pred, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

let adm, merch, otherMerch, cap1, cap2;

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111188',
      ADMIN_PASSWORD: 'Admin12345',
      JWT_SECRET: 'test-cancel-accepted-jwt-secret-32-chars',
      CANCEL_ACCEPTED_RATE_LIMIT: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/zones`)).ok; } catch {}
    if (!up) await sleep(120);
  }
  if (!up) throw new Error('cancel-accepted test server did not start');

  adm = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', { role, phone, name: `${role}-${phone}`, password: 'Passw0rdX', zone_id: 1, ...extra }, adm);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...r.data, tok: await login(phone) };
  };

  merch = await reg('merchant', '0928000001', { business_name: 'مطعم الشهباء', address: 'المالكي', lat: 33.51, lng: 36.27 });
  otherMerch = await reg('merchant', '0928000002', { business_name: 'متجر آخر', address: 'أبو رمانة', lat: 33.515, lng: 36.275 });
  cap1 = await reg('captain', '0938000001', { name: 'الكابتن خالد' });
  cap2 = await reg('captain', '0938000002', { name: 'كابتن غير معني' });

  // Top up cap1 so points deduction absence can be clearly verified
  assert.equal((await call(`/admin/captains/${cap1.id}/topup`, 'POST', { points: 200, note: 'رصيد اختبار' }, adm)).status, 200);
});

after(() => {
  if (proc && !proc.killed) proc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function createAcceptedOrder(merchantTok = merch.tok) {
  await call('/captain/online', 'POST', { online: false }, cap2.tok);
  assert.equal((await call('/captain/online', 'POST', { online: true }, cap1.tok)).status, 200);
  const ordRes = await call('/merchant/orders', 'POST', { customer_address: 'شارع بغداد مقابل الحديقة' }, merchantTok);
  assert.equal(ordRes.status, 201, JSON.stringify(ordRes.data));
  const ord = ordRes.data;
  const capSt = (await call('/captain/state', 'GET', null, cap1.tok)).data;
  assert.equal(capSt.offer?.id, ord.id);
  const accRes = await call(`/captain/offers/${ord.id}/accept`, 'POST', {}, cap1.tok);
  assert.equal(accRes.status, 200);
  return ord;
}

test('merchant cancel-accepted: succeeds on accepted order, records event, pushes requires_ack=1 notif, leaves captain balance untouched, and acks cleanly', async () => {
  const { ws: capWs, msgs: capMsgs } = await connectWs(cap1.tok);
  const { ws: otherCapWs, msgs: otherCapMsgs } = await connectWs(cap2.tok);

  const balBefore = (await call('/captain/wallet', 'GET', null, cap1.tok)).data.balance_points;
  assert.equal(balBefore, 200);

  const ord = await createAcceptedOrder();
  capMsgs.length = 0;
  otherCapMsgs.length = 0;

  // Cross-merchant authorization check -> 404
  const cross = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'unavailable' }, otherMerch.tok);
  assert.equal(cross.status, 404);

  // Valid cancel-accepted with preset reason
  const res = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'customer_cancelled' }, merch.tok);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true);
  assert.equal(res.data.order.status, 'cancelled');
  assert.ok(Number.isInteger(res.data.notification_id));

  // Order detail & order_events include cancelled + reason_code + reason_text
  const det = await call(`/merchant/orders/${ord.id}`, 'GET', null, merch.tok);
  assert.equal(det.status, 200);
  assert.equal(det.data.status, 'cancelled');
  const cancelEv = det.data.events.find((e) => e.type === 'cancelled');
  assert.ok(cancelEv, 'cancelled event must exist');
  const evData = JSON.parse(cancelEv.data);
  assert.equal(evData.reason, 'merchant_cancelled_accepted');
  assert.equal(evData.reason_code, 'customer_cancelled');
  assert.equal(evData.reason_text, 'الزبون ألغى الطلب');

  // Captain active order cleared immediately
  const stAfter = (await call('/captain/state', 'GET', null, cap1.tok)).data;
  assert.equal(stAfter.active, null);
  assert.equal(stAfter.activeOrders.length, 0);

  // No points deducted on cancellation
  const walletAfter = (await call('/captain/wallet', 'GET', null, cap1.tok)).data;
  assert.equal(walletAfter.balance_points, 200);
  assert.equal(walletAfter.entries.filter((e) => e.kind === 'deduction').length, 0);

  // Captain receives WS notification with requires_ack = 1 and unread inbox entry
  const wsNotif = await waitFor(capMsgs, (m) => m.type === 'notification' && m.notification?.id === res.data.notification_id);
  assert.ok(wsNotif, 'captain should receive WS notification');
  assert.equal(wsNotif.notification.requires_ack, 1);
  assert.equal(wsNotif.notification.title, 'تم إلغاء الطلب');
  assert.ok(wsNotif.notification.body.includes(`#${String(ord.id).padStart(4, '0')}`));
  assert.ok(wsNotif.notification.body.includes('مطعم الشهباء'));
  assert.ok(wsNotif.notification.body.includes('الزبون ألغى الطلب'));

  const inboxBeforeAck = (await call('/notifications/inbox', 'GET', null, cap1.tok)).data;
  const item = inboxBeforeAck.find((n) => n.id === res.data.notification_id);
  assert.ok(item);
  assert.equal(item.requires_ack, 1);
  assert.equal(item.read, false);

  // Other captain does NOT receive the notification
  await sleep(100);
  assert.equal(otherCapMsgs.some((m) => m.type === 'notification' && m.notification?.id === res.data.notification_id), false);
  const otherInbox = (await call('/notifications/inbox', 'GET', null, cap2.tok)).data;
  assert.equal(otherInbox.some((n) => n.id === res.data.notification_id), false);

  // Acknowledgement via /api/notifications/:id/read marks it read
  const ackRes = await call(`/notifications/${item.id}/read`, 'POST', {}, cap1.tok);
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.data.read, true);
  assert.ok(ackRes.data.read_at > 0);

  const inboxAfterAck = (await call('/notifications/inbox', 'GET', null, cap1.tok)).data;
  const ackedItem = inboxAfterAck.find((n) => n.id === item.id);
  assert.equal(ackedItem.read, true);
  assert.ok(ackedItem.read_at > 0);

  // Cancelling an already-cancelled order returns 409
  const dup = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'unavailable' }, merch.tok);
  assert.equal(dup.status, 409);

  capWs.close();
  otherCapWs.close();
});

test('merchant cancel-accepted: returns 409 for searching, offered, picked_up, arrived, and delivered', async () => {
  // searching (captain offline)
  await call('/captain/online', 'POST', { online: false }, cap1.tok);
  const searchingOrd = (await call('/merchant/orders', 'POST', { customer_address: 'عنوان قيد البحث' }, merch.tok)).data;
  assert.equal(searchingOrd.status, 'searching');
  assert.equal((await call(`/merchant/orders/${searchingOrd.id}/cancel-accepted`, 'POST', { reason_code: 'unavailable' }, merch.tok)).status, 409);
  await call(`/merchant/orders/${searchingOrd.id}/cancel`, 'POST', {}, merch.tok);

  // offered (captain online, not accepted yet)
  await call('/captain/online', 'POST', { online: true }, cap1.tok);
  const offeredOrd = (await call('/merchant/orders', 'POST', { customer_address: 'عنوان معروض' }, merch.tok)).data;
  assert.equal((await call('/captain/state', 'GET', null, cap1.tok)).data.offer?.id, offeredOrd.id);
  assert.equal((await call(`/merchant/orders/${offeredOrd.id}/cancel-accepted`, 'POST', { reason_code: 'unavailable' }, merch.tok)).status, 409);
  await call(`/merchant/orders/${offeredOrd.id}/cancel`, 'POST', {}, merch.tok);

  // picked_up, arrived, delivered -> all 409
  const ord = await createAcceptedOrder();
  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'picked_up' }, cap1.tok)).status, 200);
  const resPickedUp = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'order_error' }, merch.tok);
  assert.equal(resPickedUp.status, 409);

  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'arrived' }, cap1.tok)).status, 200);
  const resArrived = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'order_error' }, merch.tok);
  assert.equal(resArrived.status, 409);

  assert.equal((await call(`/captain/orders/${ord.id}/status`, 'POST', { status: 'delivered' }, cap1.tok)).status, 200);
  const resDelivered = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'order_error' }, merch.tok);
  assert.equal(resDelivered.status, 409);
});

test('merchant cancel-accepted: reason_code validation, required other reason_text, 200-char limit, and HTML stripping', async () => {
  const ord = await createAcceptedOrder();

  // Unknown reason_code -> 400
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'invalid_reason' }, merch.tok)).status, 400);
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', {}, merch.tok)).status, 400);

  // 'other' requires reason_text
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'other' }, merch.tok)).status, 400);
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'other', reason_text: '   ' }, merch.tok)).status, 400);
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'other', reason_text: '<b>   </b>' }, merch.tok)).status, 400);

  // Over 200 characters -> 400
  const over200 = 'أ'.repeat(201);
  assert.equal((await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'other', reason_text: over200 }, merch.tok)).status, 400);

  // HTML is stripped and sanitized reason up to 200 chars is saved cleanly
  const htmlReason = '<script>alert(1)</script><b>إلغاء طارئ</b> بسبب نقص المادة';
  const okHtml = await call(`/merchant/orders/${ord.id}/cancel-accepted`, 'POST', { reason_code: 'other', reason_text: htmlReason }, merch.tok);
  assert.equal(okHtml.status, 200, JSON.stringify(okHtml.data));

  const det = await call(`/merchant/orders/${ord.id}`, 'GET', null, merch.tok);
  const evData = JSON.parse(det.data.events.find((e) => e.type === 'cancelled').data);
  assert.equal(evData.reason_code, 'other');
  assert.equal(evData.reason_text, 'إلغاء طارئ بسبب نقص المادة');
  assert.equal(evData.reason_text.includes('<'), false);

  const inbox = (await call('/notifications/inbox', 'GET', null, cap1.tok)).data;
  const n = inbox.find((x) => x.id === okHtml.data.notification_id);
  assert.ok(n);
  assert.equal(n.requires_ack, 1);
  assert.ok(n.body.includes('إلغاء طارئ بسبب نقص المادة'));
  assert.equal(n.body.includes('<script>'), false);
  assert.equal(n.body.includes('<b>'), false);

  // Clean ack & test exact 200 characters accepted
  await call(`/notifications/${n.id}/read`, 'POST', {}, cap1.tok);

  const ord2 = await createAcceptedOrder();
  const exact200 = 'س'.repeat(200);
  const ok200 = await call(`/merchant/orders/${ord2.id}/cancel-accepted`, 'POST', { reason_code: 'other', reason_text: exact200 }, merch.tok);
  assert.equal(ok200.status, 200, JSON.stringify(ok200.data));
});
