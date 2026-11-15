import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createClient } from '@libsql/client';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-support-retention-'));
const dbPath = path.join(tmpDir, 'sr.db');
const port = 5900 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}/api`;
let proc = null;
let directClient = null;

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

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111188',
      ADMIN_PASSWORD: 'Admin12345',
      JWT_SECRET: 'panther-support-retention-secret-32-chars!!',
      NOTIFY_RATE_LIMIT: '60',
      ...extraEnv,
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/zones`);
      if (r.ok) return child;
    } catch {}
    await sleep(120);
  }
  child.kill();
  throw new Error('support-and-retention test server did not start');
}

async function stopServer(child) {
  if (!child || child.killed) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([done, sleep(2000)]);
}

let adm, z2, za1, m1, m2, c1;

before(async () => {
  proc = await startServer();
  directClient = createClient({ url: pathToFileURL(path.resolve(dbPath)).href });

  adm = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'Admin12345' })).data.token;
  assert.ok(adm, 'admin login token');

  z2 = (await call('/admin/zones', 'POST', { name: 'منطقة الدعم الثانية' }, adm)).data;
  assert.ok(z2?.id, 'second zone created');

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

  za1 = await reg('zone_admin', '0963000001', { zone_id: 1 });
  m1 = await reg('merchant', '0923000001', { business_name: 'متجر المزة', address: 'المزة 1', lat: 33.51, lng: 36.26, zone_id: 1 });
  m2 = await reg('merchant', '0923000002', { business_name: 'متجر الثانية', address: 'الثانية 1', lat: 33.52, lng: 36.27, zone_id: z2.id });
  c1 = await reg('captain', '0933000001', { zone_id: 1 });
});

after(async () => {
  try { directClient?.close(); } catch {}
  await stopServer(proc);
  await sleep(150);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('zone support phone: admin sets it, zone_admin is blocked (403), merchant reads it and unset zone returns disabled payload', async () => {
  // Merchant in zone with no phone initially gets null support_phone (disabled state payload)
  const emptySupport = await call('/merchant/support', 'GET', null, m2.tok);
  assert.equal(emptySupport.status, 200);
  assert.deepEqual(emptySupport.data, { zone_name: 'منطقة الدعم الثانية', support_phone: null });

  // zone_admin can view zone in /admin/zones, but cannot modify support_phone (403)
  const zaZones = await call('/admin/zones', 'GET', null, za1.tok);
  assert.equal(zaZones.status, 200);
  assert.equal(zaZones.data.length, 1);
  assert.equal(zaZones.data[0].support_phone, null);

  const zaPatch = await call('/admin/zones/1', 'PATCH', { support_phone: '0991234567' }, za1.tok);
  assert.equal(zaPatch.status, 403);
  const zaPut = await call('/admin/zones/1/support-phone', 'PUT', { support_phone: '0991234567' }, za1.tok);
  assert.equal(zaPut.status, 403);

  // Validation: > 20 characters rejected with 400
  const tooLong = await call('/admin/zones/1', 'PATCH', { support_phone: '0'.repeat(21) }, adm);
  assert.equal(tooLong.status, 400);

  // Admin sets zone 1 support phone
  const setOk = await call('/admin/zones/1', 'PATCH', { support_phone: '+963 991 222 333' }, adm);
  assert.equal(setOk.status, 200);
  assert.equal(setOk.data.support_phone, '+963 991 222 333');

  // zone_admin sees own zone value
  const zaZonesAfter = await call('/admin/zones', 'GET', null, za1.tok);
  assert.equal(zaZonesAfter.status, 200);
  assert.equal(zaZonesAfter.data[0].support_phone, '+963 991 222 333');

  // Merchant in zone 1 reads zone_name and support_phone
  const m1Support = await call('/merchant/support', 'GET', null, m1.tok);
  assert.equal(m1Support.status, 200);
  assert.deepEqual(m1Support.data, { zone_name: 'المزة', support_phone: '+963 991 222 333' });

  // Merchant in zone 2 still gets null support_phone
  const m2Support = await call('/merchant/support', 'GET', null, m2.tok);
  assert.equal(m2Support.status, 200);
  assert.deepEqual(m2Support.data, { zone_name: 'منطقة الدعم الثانية', support_phone: null });

  // Role guard: non-merchant cannot access /api/merchant/support
  assert.equal((await call('/merchant/support', 'GET', null, c1.tok)).status, 403);
  assert.equal((await call('/merchant/support', 'GET', null, adm)).status, 403);
  assert.equal((await call('/merchant/support')).status, 401);
});

test('captain summary includes zone_name and balance_points', async () => {
  const topup = await call(`/admin/captains/${c1.id}/topup`, 'POST', { points: 250, note: 'رصيد اختبار' }, adm);
  assert.equal(topup.status, 200);

  const summary = await call('/captain/summary', 'GET', null, c1.tok);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.zone_name, 'المزة');
  assert.equal(summary.data.balance_points, 250);
});

test('notifications older than 24 hours are hard-deleted with their reads, while newer ones are kept', async () => {
  // Send two notifications to c1 (and mark both read so notification_reads rows exist)
  const oldRes = await call('/admin/notifications', 'POST', {
    target_type: 'user',
    target_user_id: c1.id,
    title: 'إشعار قديم',
    body: 'محتوى أقدم من 24 ساعة',
  }, adm);
  assert.equal(oldRes.status, 201);
  const oldId = oldRes.data.id;

  const freshRes = await call('/admin/notifications', 'POST', {
    target_type: 'user',
    target_user_id: c1.id,
    title: 'إشعار حديث',
    body: 'محتوى أحدث من 24 ساعة',
  }, adm);
  assert.equal(freshRes.status, 201);
  const freshId = freshRes.data.id;

  const unreadExtra = await call('/admin/notifications', 'POST', {
    target_type: 'user',
    target_user_id: m1.id,
    title: 'غير مقروء قديم',
    body: 'لاختبار عداد غير المقروءة',
  }, adm);
  assert.equal(unreadExtra.status, 201);
  const unreadExtraId = unreadExtra.data.id;

  assert.equal((await call(`/notifications/${oldId}/read`, 'POST', null, c1.tok)).status, 200);
  assert.equal((await call(`/notifications/${freshId}/read`, 'POST', null, c1.tok)).status, 200);

  // Backdate oldId and unreadExtraId to 25 hours ago; keep freshId at 2 hours ago
  const expiredTs = Date.now() - 25 * 60 * 60 * 1000;
  const freshTs = Date.now() - 2 * 60 * 60 * 1000;
  await directClient.execute({ sql: 'UPDATE notifications SET created_at=? WHERE id IN (?, ?)', args: [expiredTs, oldId, unreadExtraId] });
  await directClient.execute({ sql: 'UPDATE notifications SET created_at=? WHERE id=?', args: [freshTs, freshId] });

  // Safety guard check on inbox & unread count before cleanup restart
  const inboxBefore = await call('/notifications/inbox', 'GET', null, c1.tok);
  assert.equal(inboxBefore.status, 200);
  assert.ok(!inboxBefore.data.some((n) => n.id === oldId), 'expired notification must be filtered by query guard');
  assert.ok(inboxBefore.data.some((n) => n.id === freshId), 'fresh notification must stay in inbox');
  const m1UnreadBefore = await call('/notifications/unread-count', 'GET', null, m1.tok);
  assert.equal(m1UnreadBefore.data.unread_count, 0);

  // Restart server to exercise startup cleanup
  await stopServer(proc);
  proc = await startServer({ NOTIFICATION_CLEANUP_INTERVAL_MS: '250' });

  // Verify oldId and unreadExtraId rows AND their notification_reads rows are hard-deleted, while freshId is kept
  const oldRow = await directClient.execute({ sql: 'SELECT id FROM notifications WHERE id=?', args: [oldId] });
  assert.equal(oldRow.rows.length, 0, 'expired notification must be deleted on startup');
  const oldReads = await directClient.execute({ sql: 'SELECT * FROM notification_reads WHERE notification_id=?', args: [oldId] });
  assert.equal(oldReads.rows.length, 0, 'notification_reads for expired notification must be deleted');
  const extraRow = await directClient.execute({ sql: 'SELECT id FROM notifications WHERE id=?', args: [unreadExtraId] });
  assert.equal(extraRow.rows.length, 0);

  const freshRow = await directClient.execute({ sql: 'SELECT id FROM notifications WHERE id=?', args: [freshId] });
  assert.equal(freshRow.rows.length, 1, 'newer notification (< 24h) must be kept');
  const freshReads = await directClient.execute({ sql: 'SELECT * FROM notification_reads WHERE notification_id=?', args: [freshId] });
  assert.equal(freshReads.rows.length, 1, 'reads for newer notification must be kept');

  // Verify periodic interval cleanup also removes newly expired notifications & reads
  const intervalNotif = await call('/admin/notifications', 'POST', {
    target_type: 'user',
    target_user_id: m1.id,
    title: 'إشعار مجدول للحذف',
    body: 'سيُحذف عبر المؤقت الدوري',
  }, adm);
  assert.equal(intervalNotif.status, 201);
  const intId = intervalNotif.data.id;
  assert.equal((await call(`/notifications/${intId}/read`, 'POST', null, m1.tok)).status, 200);
  await directClient.execute({ sql: 'UPDATE notifications SET created_at=? WHERE id=?', args: [Date.now() - 25 * 60 * 60 * 1000, intId] });

  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await sleep(150);
    const rs = await directClient.execute({ sql: 'SELECT id FROM notifications WHERE id=?', args: [intId] });
    if (rs.rows.length === 0) gone = true;
  }
  assert.equal(gone, true, 'periodic cleanup interval must delete expired notification');
  const intReads = await directClient.execute({ sql: 'SELECT * FROM notification_reads WHERE notification_id=?', args: [intId] });
  assert.equal(intReads.rows.length, 0, 'periodic cleanup must remove notification_reads too');
});
