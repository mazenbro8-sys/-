import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-notifications-'));
const dbPath = path.join(tmpDir, 'notif.db');
const port = 5600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}/api`;
let proc;

async function call(p, method = 'GET', body = null, token = null) {
  const headers = {};
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(msgs, pred, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

// Shared fixtures (created once in before())
let adm, z2, za1, za2, c1, c2, cZ2, m1, mZ2, adm2;
const inboxIds = async (tok) => (await call('/notifications/inbox', 'GET', null, tok)).data.map((n) => n.id);
const unread = async (tok) => (await call('/notifications/unread-count', 'GET', null, tok)).data.unread_count;
const send = (tok, body) => call('/admin/notifications', 'POST', { title: 'تنبيه', body: 'رسالة اختبار', ...body }, tok);

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111177',
      ADMIN_PASSWORD: 'Admin12345',
      NOTIFY_RATE_LIMIT: '30',
    },
    stdio: 'pipe',
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/zones`)).ok; } catch {}
    if (!up) await sleep(150);
  }
  if (!up) throw new Error('notifications test server did not start');

  adm = (await call('/auth/login', 'POST', { phone: '0911111177', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', { role, phone, name: `${role}-${phone}`, password: 'Passw0rdX', zone_id: 1, ...extra }, adm);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...r.data, tok: await login(phone) };
  };
  z2 = (await call('/admin/zones', 'POST', { name: 'منطقة الإشعارات الثانية' }, adm)).data;
  za1 = await reg('zone_admin', '0961000001', { zone_id: 1 });
  za2 = await reg('zone_admin', '0962000001', { zone_id: z2.id });
  c1 = await reg('captain', '0931000001', { zone_id: 1 });
  c2 = await reg('captain', '0931000002', { zone_id: 1 });
  cZ2 = await reg('captain', '0932000001', { zone_id: z2.id });
  m1 = await reg('merchant', '0921000001', { business_name: 'مطعم الإشعار', address: 'المزة', lat: 33.5, lng: 36.25, zone_id: 1 });
  mZ2 = await reg('merchant', '0922000001', { business_name: 'منشأة الثانية', address: 'الثانية', lat: 33.52, lng: 36.27, zone_id: z2.id });
  adm2 = await reg('admin', '0911000002', { zone_id: null });
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('admin sends to all: every active user sees it, sender does not, WS reaches connected recipients', async () => {
  const wsC1 = await connectWs(c1.tok);
  const wsMZ2 = await connectWs(mZ2.tok);
  const r = await send(adm, { target_type: 'all', title: 'إعلان عام', body: 'مرحباً بالجميع' });
  assert.equal(r.status, 201);
  assert.equal(r.data.target_type, 'all');
  assert.equal(r.data.zone_id, null);
  assert.equal(r.data.title, 'إعلان عام');
  assert.equal(r.data.recipients_count, 8, 'za1, za2, c1, c2, cZ2, m1, mZ2, adm2 (sender excluded)');
  for (const u of [za1, za2, c1, c2, cZ2, m1, mZ2, adm2]) {
    assert.ok((await inboxIds(u.tok)).includes(r.data.id), `user ${u.id} should see broadcast`);
  }
  assert.ok(!(await inboxIds(adm)).includes(r.data.id), 'sender must not receive own notification');
  const push = await waitFor(wsC1.msgs, (m) => m.type === 'notification' && m.notification.id === r.data.id);
  assert.ok(push, 'captain WS should receive notification');
  assert.equal(push.notification.body, 'مرحباً بالجميع');
  assert.ok(await waitFor(wsMZ2.msgs, (m) => m.type === 'notification' && m.notification.id === r.data.id));
  wsC1.ws.close(); wsMZ2.ws.close();
});

test('admin sends to a role: only that role receives, optional zone narrows it; WS is targeted, not broadcast', async () => {
  const wsC1 = await connectWs(c1.tok);
  const wsCZ2 = await connectWs(cZ2.tok);
  const wsM1 = await connectWs(m1.tok);
  const wsZa1 = await connectWs(za1.tok);

  const all = await send(adm, { target_type: 'role', target_role: 'captain', body: 'لكل الكباتن' });
  assert.equal(all.status, 201);
  for (const u of [c1, c2, cZ2]) assert.ok((await inboxIds(u.tok)).includes(all.data.id));
  for (const u of [m1, mZ2, za1, adm2]) assert.ok(!(await inboxIds(u.tok)).includes(all.data.id));

  const zoned = await send(adm, { target_type: 'role', target_role: 'captain', zone_id: z2.id, body: 'كباتن المنطقة الثانية' });
  assert.equal(zoned.status, 201);
  assert.equal(zoned.data.zone_id, z2.id);
  assert.ok((await inboxIds(cZ2.tok)).includes(zoned.data.id));
  assert.ok(!(await inboxIds(c1.tok)).includes(zoned.data.id));

  assert.ok(await waitFor(wsCZ2.msgs, (m) => m.type === 'notification' && m.notification.id === zoned.data.id));
  await sleep(300);
  assert.ok(!wsC1.msgs.some((m) => m.type === 'notification' && m.notification.id === zoned.data.id), 'zone-1 captain must not get zone-2 push');
  assert.ok(!wsM1.msgs.some((m) => m.type === 'notification'), 'merchant must not get captain-role pushes');
  assert.ok(!wsZa1.msgs.some((m) => m.type === 'notification'), 'zone_admin must not get captain-role pushes');

  const badRole = await send(adm, { target_type: 'role', target_role: 'customer' });
  assert.equal(badRole.status, 400);
  [wsC1, wsCZ2, wsM1, wsZa1].forEach((x) => x.ws.close());
});

test('admin sends to one user: only that user receives it; unknown user is 404', async () => {
  const r = await send(adm, { target_type: 'user', target_user_id: m1.id, body: 'رسالة خاصة للمنشأة' });
  assert.equal(r.status, 201);
  assert.equal(r.data.target_user_id, m1.id);
  assert.equal(r.data.recipients_count, 1);
  assert.ok((await inboxIds(m1.tok)).includes(r.data.id));
  for (const u of [c1, mZ2, za1, adm2]) assert.ok(!(await inboxIds(u.tok)).includes(r.data.id));

  const toAdmin = await send(adm, { target_type: 'user', target_user_id: adm2.id, body: 'إلى مدير آخر' });
  assert.equal(toAdmin.status, 201);
  assert.ok((await inboxIds(adm2.tok)).includes(toAdmin.data.id));

  assert.equal((await send(adm, { target_type: 'user', target_user_id: 999999 })).status, 404);
});

test('zone_admin sends inside own zone (allowed) and is stamped with its zone', async () => {
  const toUser = await send(za1.tok, { target_type: 'user', target_user_id: c1.id, body: 'من مدير المنطقة' });
  assert.equal(toUser.status, 201);
  assert.equal(toUser.data.zone_id, 1);
  assert.ok((await inboxIds(c1.tok)).includes(toUser.data.id));

  const toZone = await send(za1.tok, { target_type: 'zone', body: 'لكل المنطقة الأولى' });
  assert.equal(toZone.status, 201);
  assert.equal(toZone.data.zone_id, 1);
  for (const u of [c1, c2, m1]) assert.ok((await inboxIds(u.tok)).includes(toZone.data.id));
  for (const u of [cZ2, mZ2, za2]) assert.ok(!(await inboxIds(u.tok)).includes(toZone.data.id));

  const toRole = await send(za1.tok, { target_type: 'role', target_role: 'merchant', body: 'لمنشآت المنطقة' });
  assert.equal(toRole.status, 201);
  assert.equal(toRole.data.zone_id, 1);
  assert.ok((await inboxIds(m1.tok)).includes(toRole.data.id));
  assert.ok(!(await inboxIds(mZ2.tok)).includes(toRole.data.id));

  // zone_admin list is limited to its own zone; super admin sees everything
  const zaList = await call('/admin/notifications', 'GET', null, za1.tok);
  assert.equal(zaList.status, 200);
  assert.ok(zaList.data.length >= 3);
  assert.ok(zaList.data.every((n) => n.zone_id === 1));
  const za2List = await call('/admin/notifications', 'GET', null, za2.tok);
  assert.ok(!za2List.data.some((n) => n.id === toZone.data.id));
  const admList = await call('/admin/notifications', 'GET', null, adm);
  assert.ok(admList.data.some((n) => n.id === toZone.data.id));
  assert.ok(admList.data.some((n) => n.target_type === 'all'));
});

test('zone_admin sends outside its zone: 403 for every out-of-scope target', async () => {
  const before = (await call('/admin/notifications', 'GET', null, adm)).data.length;
  assert.equal((await send(za1.tok, { target_type: 'user', target_user_id: cZ2.id })).status, 403);
  assert.equal((await send(za1.tok, { target_type: 'user', target_user_id: adm2.id })).status, 403);
  assert.equal((await send(za1.tok, { target_type: 'zone', zone_id: z2.id })).status, 403);
  assert.equal((await send(za1.tok, { target_type: 'role', target_role: 'captain', zone_id: z2.id })).status, 403);
  assert.equal((await send(za1.tok, { target_type: 'role', target_role: 'admin' })).status, 403);
  assert.equal((await send(za1.tok, { target_type: 'all' })).status, 403);
  assert.equal((await call('/admin/notifications', 'GET', null, adm)).data.length, before, 'rejected sends must not be stored');
});

test('captain and merchant cannot send or list (403); missing token is 401', async () => {
  assert.equal((await send(c1.tok, { target_type: 'all' })).status, 403);
  assert.equal((await send(m1.tok, { target_type: 'user', target_user_id: c1.id })).status, 403);
  assert.equal((await call('/admin/notifications', 'GET', null, c1.tok)).status, 403);
  assert.equal((await call('/admin/notifications', 'POST', { target_type: 'all', title: 'x', body: 'y' })).status, 401);
  assert.equal((await call('/notifications/inbox')).status, 401);
  assert.equal((await call('/notifications/unread-count')).status, 401);
  assert.equal((await call('/notifications/1/read', 'POST')).status, 401);
});

test('inbox filtering by role and zone across all target types', async () => {
  const roleZa = await send(adm, { target_type: 'role', target_role: 'zone_admin', body: 'لمدراء المناطق' });
  const zone2 = await send(adm, { target_type: 'zone', zone_id: z2.id, body: 'للمنطقة الثانية فقط' });
  assert.equal(roleZa.status, 201);
  assert.equal(zone2.status, 201);

  const za1Inbox = await inboxIds(za1.tok);
  assert.ok(za1Inbox.includes(roleZa.data.id));
  assert.ok(!za1Inbox.includes(zone2.data.id));
  const za2Inbox = await inboxIds(za2.tok);
  assert.ok(za2Inbox.includes(roleZa.data.id));
  assert.ok(za2Inbox.includes(zone2.data.id));
  assert.ok((await inboxIds(cZ2.tok)).includes(zone2.data.id));
  assert.ok((await inboxIds(mZ2.tok)).includes(zone2.data.id));
  assert.ok(!(await inboxIds(c1.tok)).includes(zone2.data.id));
  assert.ok(!(await inboxIds(c1.tok)).includes(roleZa.data.id));

  const item = (await call('/notifications/inbox', 'GET', null, cZ2.tok)).data.find((n) => n.id === zone2.data.id);
  assert.equal(item.read, false);
  assert.equal(item.read_at, null);
  assert.equal(item.body, 'للمنطقة الثانية فقط');
  assert.equal(typeof item.sender_name, 'string');
  assert.ok(!('target_user_id' in item), 'inbox does not expose targeting internals');
});

test('read marking is idempotent and only allowed for visible notifications', async () => {
  const r = await send(adm, { target_type: 'user', target_user_id: c2.id, body: 'اقرأني' });
  const first = await call(`/notifications/${r.data.id}/read`, 'POST', null, c2.tok);
  assert.equal(first.status, 200);
  assert.equal(first.data.read, true);
  await sleep(20);
  const second = await call(`/notifications/${r.data.id}/read`, 'POST', null, c2.tok);
  assert.equal(second.status, 200);
  assert.equal(second.data.read_at, first.data.read_at, 'read_at must not change on repeat');
  const item = (await call('/notifications/inbox', 'GET', null, c2.tok)).data.find((n) => n.id === r.data.id);
  assert.equal(item.read, true);
  assert.equal(item.read_at, first.data.read_at);

  assert.equal((await call(`/notifications/${r.data.id}/read`, 'POST', null, c1.tok)).status, 404, 'non-recipient cannot mark');
  assert.equal((await call('/notifications/999999/read', 'POST', null, c2.tok)).status, 404);

  const list = (await call('/admin/notifications', 'GET', null, adm)).data.find((n) => n.id === r.data.id);
  assert.equal(list.read_count, 1);
});

test('unread count is correct and drops as items are read', async () => {
  const start = await unread(mZ2.tok);
  const inbox = (await call('/notifications/inbox', 'GET', null, mZ2.tok)).data;
  assert.equal(start, inbox.filter((n) => !n.read).length);

  const a = await send(adm, { target_type: 'user', target_user_id: mZ2.id, body: 'أولى' });
  const b = await send(za2.tok, { target_type: 'role', target_role: 'merchant', body: 'ثانية' });
  await send(adm, { target_type: 'user', target_user_id: m1.id, body: 'لغيري' });
  assert.equal(await unread(mZ2.tok), start + 2);

  await call(`/notifications/${a.data.id}/read`, 'POST', null, mZ2.tok);
  await call(`/notifications/${a.data.id}/read`, 'POST', null, mZ2.tok);
  assert.equal(await unread(mZ2.tok), start + 1);
  await call(`/notifications/${b.data.id}/read`, 'POST', null, mZ2.tok);
  assert.equal(await unread(mZ2.tok), start);

  for (const n of (await call('/notifications/inbox', 'GET', null, mZ2.tok)).data) {
    await call(`/notifications/${n.id}/read`, 'POST', null, mZ2.tok);
  }
  assert.equal(await unread(mZ2.tok), 0);
});

test('HTML is stripped from title and body; length limits are enforced after stripping', async () => {
  const r = await send(adm, {
    target_type: 'user',
    target_user_id: c1.id,
    title: '<b>عاجل</b> <img src=x onerror=alert(1)>',
    body: '<script>alert("x")</script><p>استلم <a href="http://evil">الطلب</a> الآن</p><!-- c -->',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.title, 'عاجل');
  assert.equal(r.data.body, 'استلم الطلب الآن');
  const item = (await call('/notifications/inbox', 'GET', null, c1.tok)).data.find((n) => n.id === r.data.id);
  assert.equal(item.title, 'عاجل');
  assert.equal(item.body, 'استلم الطلب الآن');
  assert.ok(!/[<>]/.test(item.title + item.body));

  assert.equal((await send(adm, { target_type: 'all', title: '<p></p>' })).status, 400, 'empty after stripping');
  assert.equal((await send(adm, { target_type: 'all', title: 'ع'.repeat(81) })).status, 400);
  assert.equal((await send(adm, { target_type: 'all', body: 'ع'.repeat(501) })).status, 400);
  assert.equal((await send(adm, { target_type: 'all', body: { html: 1 } })).status, 400);
  assert.equal((await send(adm, { target_type: 'everyone' })).status, 400);
  const maxOk = await send(adm, { target_type: 'user', target_user_id: c1.id, title: 'ع'.repeat(80), body: 'ع'.repeat(500) });
  assert.equal(maxOk.status, 201);
});

test('POST /admin/notifications is rate-limited per sender', async () => {
  let last;
  for (let i = 0; i < 30; i++) {
    last = await send(za2.tok, { target_type: 'user', target_user_id: cZ2.id, body: `رسالة ${i}` });
    if (last.status !== 201) break;
  }
  // za2 already sent 1 notification in an earlier test, so the limit is reached within this loop
  assert.equal(last.status, 429);
  // A different sender is not affected
  assert.equal((await send(za1.tok, { target_type: 'user', target_user_id: c1.id, body: 'ما زال مسموحاً' })).status, 201);
});
