import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-notif-targeting-'));
const dbPath = path.join(tmpDir, 'targeting.db');
const port = 5700 + Math.floor(Math.random() * 200);
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

async function waitFor(msgs, pred, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

let adm, adm2, z2, za1, za2, c1, c2, cZ2, m1, mZ2;
const inboxIds = async (tok) => (await call('/notifications/inbox', 'GET', null, tok)).data.map((n) => n.id);
const send = (tok, body) => call('/admin/notifications', 'POST', { title: 'استهداف', body: 'رسالة تجريبية', ...body }, tok);

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111166',
      ADMIN_PASSWORD: 'Admin12345',
      NOTIFY_RATE_LIMIT: '60',
    },
    stdio: 'pipe',
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/zones`)).ok; } catch {}
    if (!up) await sleep(120);
  }
  if (!up) throw new Error('notification-targeting test server did not start');

  adm = (await call('/auth/login', 'POST', { phone: '0911111166', password: 'Admin12345' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', {
      role,
      phone,
      name: `${role}-${phone}`,
      password: 'Passw0rdX',
      zone_id: 1,
      ...extra,
    }, adm);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const tok = (await call('/auth/login', 'POST', { phone, password: 'Passw0rdX' })).data.token;
    return { ...r.data, tok };
  };

  z2 = (await call('/admin/zones', 'POST', { name: 'منطقة دمشق ب' }, adm)).data;
  adm2 = await reg('admin', '0911000012', { zone_id: null });
  za1 = await reg('zone_admin', '0961000011', { zone_id: 1 });
  za2 = await reg('zone_admin', '0962000011', { zone_id: z2.id });
  c1 = await reg('captain', '0931000011', { zone_id: 1 });
  c2 = await reg('captain', '0931000012', { zone_id: 1 });
  cZ2 = await reg('captain', '0932000011', { zone_id: z2.id });
  m1 = await reg('merchant', '0921000011', { business_name: 'متجر ١', address: 'المزة', lat: 33.5, lng: 36.25, zone_id: 1 });
  mZ2 = await reg('merchant', '0922000011', { business_name: 'متجر ٢', address: 'الثانية', lat: 33.52, lng: 36.27, zone_id: z2.id });
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('admin sends to captains in one zone (only that zone’s captains receive it)', async () => {
  const wsC1 = await connectWs(c1.tok);
  const wsCZ2 = await connectWs(cZ2.tok);
  const wsM1 = await connectWs(m1.tok);

  const res = await send(adm, { zone_id: 1, category: 'captain', body: 'كباتن المزة فقط' });
  assert.equal(res.status, 201);
  assert.equal(res.data.zone_id, 1);
  assert.equal(res.data.target_type, 'role');
  assert.equal(res.data.target_role, 'captain');
  assert.equal(res.data.category, 'captain');
  assert.equal(res.data.recipients_count, 2);

  assert.ok((await inboxIds(c1.tok)).includes(res.data.id));
  assert.ok((await inboxIds(c2.tok)).includes(res.data.id));
  for (const u of [cZ2, m1, mZ2, za1, za2, adm2]) {
    assert.ok(!(await inboxIds(u.tok)).includes(res.data.id), `non-target user ${u.id} must not receive zone-1 captain message`);
  }

  assert.ok(await waitFor(wsC1.msgs, (m) => m.type === 'notification' && m.notification.id === res.data.id));
  await sleep(200);
  assert.ok(!wsCZ2.msgs.some((m) => m.type === 'notification' && m.notification.id === res.data.id));
  assert.ok(!wsM1.msgs.some((m) => m.type === 'notification' && m.notification.id === res.data.id));
  [wsC1, wsCZ2, wsM1].forEach((x) => x.ws.close());
});

test('admin sends to all zones with category "الكل" (every user receives it) and "مديرون" reaches admins and zone_admins', async () => {
  const res = await send(adm, { zone_id: null, category: 'الكل', body: 'إعلان لكل المنصة' });
  assert.equal(res.status, 201);
  assert.equal(res.data.target_type, 'all');
  assert.equal(res.data.zone_id, null);
  assert.equal(res.data.category, 'all');
  assert.equal(res.data.recipients_count, 8);
  for (const u of [adm2, za1, za2, c1, c2, cZ2, m1, mZ2]) {
    assert.ok((await inboxIds(u.tok)).includes(res.data.id), `user ${u.id} should receive all-zones all-category broadcast`);
  }
  assert.ok(!(await inboxIds(adm)).includes(res.data.id));

  const admRes = await send(adm, { zone_id: null, category: 'admin', body: 'تنبيه للمديرين' });
  assert.equal(admRes.status, 201);
  assert.equal(admRes.data.target_type, 'role');
  assert.equal(admRes.data.target_role, 'admin');
  for (const u of [adm2, za1, za2]) {
    assert.ok((await inboxIds(u.tok)).includes(admRes.data.id), `admin/zone_admin ${u.id} should receive admin category`);
  }
  for (const u of [c1, cZ2, m1, mZ2]) {
    assert.ok(!(await inboxIds(u.tok)).includes(admRes.data.id), `non-admin ${u.id} must not receive admin category`);
  }
});

test('zone_admin cannot choose another zone (403) or all zones (403)', async () => {
  const beforeCount = (await call('/admin/notifications', 'GET', null, adm)).data.length;
  const otherZone = await send(za1.tok, { zone_id: z2.id, category: 'captain', body: 'خارج منطقتي' });
  assert.equal(otherZone.status, 403);
  const allZonesNull = await send(za1.tok, { zone_id: null, category: 'captain', body: 'لكل المناطق' });
  assert.equal(allZonesNull.status, 403);
  const allZonesEmpty = await send(za1.tok, { zone_id: '', category: 'captain', body: 'لكل المناطق' });
  assert.equal(allZonesEmpty.status, 403);
  assert.equal((await call('/admin/notifications', 'GET', null, adm)).data.length, beforeCount);
});

test('zone_admin cannot send to admin category (403) or all category (403)', async () => {
  const beforeCount = (await call('/admin/notifications', 'GET', null, adm)).data.length;
  const toAdmins = await send(za1.tok, { zone_id: 1, category: 'admin', body: 'للمديرين' });
  assert.equal(toAdmins.status, 403);
  const toAdminsAr = await send(za1.tok, { zone_id: 1, category: 'مديرون', body: 'للمديرين' });
  assert.equal(toAdminsAr.status, 403);
  const toAll = await send(za1.tok, { zone_id: 1, category: 'all', body: 'الكل' });
  assert.equal(toAll.status, 403);
  assert.equal((await call('/admin/notifications', 'GET', null, adm)).data.length, beforeCount);
});

test('zone_admin category "كباتن" reaches only captains in their zone', async () => {
  const res = await send(za1.tok, { zone_id: 1, category: 'كباتن', body: 'تنبيه من مدير المنطقة للكباتن' });
  assert.equal(res.status, 201);
  assert.equal(res.data.zone_id, 1);
  assert.equal(res.data.target_type, 'role');
  assert.equal(res.data.target_role, 'captain');
  assert.equal(res.data.recipients_count, 2);
  assert.ok((await inboxIds(c1.tok)).includes(res.data.id));
  assert.ok((await inboxIds(c2.tok)).includes(res.data.id));
  for (const u of [cZ2, m1, mZ2, za2, { id: 'adm', tok: adm }, adm2]) {
    assert.ok(!(await inboxIds(u.tok)).includes(res.data.id), `user ${u.id} must not receive za1 captain message`);
  }
});

test('an invalid category returns 400', async () => {
  const badAdm = await send(adm, { zone_id: 1, category: 'customer', body: 'فئة غير صالحة' });
  assert.equal(badAdm.status, 400);
  const emptyCat = await send(adm, { zone_id: null, category: '', body: 'فارغة' });
  assert.equal(emptyCat.status, 400);
  const nonStrCat = await send(za1.tok, { zone_id: 1, category: 123, body: 'رقم' });
  assert.equal(nonStrCat.status, 400);
});

test('merchants do not receive a captain-only message and captains do not receive merchant-only message', async () => {
  const capOnly = await send(adm, { zone_id: null, category: 'captain', body: 'للكباتن في كل المناطق' });
  assert.equal(capOnly.status, 201);
  for (const c of [c1, c2, cZ2]) assert.ok((await inboxIds(c.tok)).includes(capOnly.data.id));
  for (const m of [m1, mZ2]) assert.ok(!(await inboxIds(m.tok)).includes(capOnly.data.id));

  const merchOnly = await send(za2.tok, { zone_id: z2.id, category: 'منشآت', body: 'لمنشآت المنطقة الثانية فقط' });
  assert.equal(merchOnly.status, 201);
  assert.ok((await inboxIds(mZ2.tok)).includes(merchOnly.data.id));
  for (const u of [m1, c1, cZ2]) assert.ok(!(await inboxIds(u.tok)).includes(merchOnly.data.id));
});
