import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveAndParseGoogleMapsLink, GeoParseError } from '../src/geo.js';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-merchant-loc-'));
const dbPath = path.join(tmpDir, 'loc.db');
const port = 4600 + Math.floor(Math.random() * 250);
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

before(async () => {
  proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbPath,
      JWT_SECRET: 'merchant-loc-test-secret-32-chars-min!!',
      ADMIN_PHONE: '0911111188',
      ADMIN_PASSWORD: 'Admin12345',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/zones`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant-location server did not start');
});

after(() => {
  proc?.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('Google Maps short-link resolution follows <= 3 google.com hops and rejects non-Google redirects', async () => {
  // 1. Short link maps.app.goo.gl -> 302 -> www.google.com/maps/...
  let calls = 0;
  const okRes = await resolveAndParseGoogleMapsLink('https://maps.app.goo.gl/abc123', {
    fetchImpl: async () => {
      calls++;
      return {
        status: 302,
        headers: new Headers({ location: 'https://www.google.com/maps/place/Test/@33.5142,36.2789,17z' }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(okRes.lat, 33.5142);
  assert.equal(okRes.lng, 36.2789);
  assert.equal(okRes.source, 'short_link');

  // 2. goo.gl/maps chained hops <= 3 ending on google.com with !3d!4d pin
  let step = 0;
  const chainRes = await resolveAndParseGoogleMapsLink('https://goo.gl/maps/chain1', {
    fetchImpl: async () => {
      step++;
      if (step === 1) {
        return { status: 302, headers: new Headers({ location: 'https://maps.google.com/?cid=999' }) };
      }
      return {
        status: 302,
        headers: new Headers({ location: 'https://www.google.com/maps/place/Cafe/@33.50,36.20,15z/data=!8m2!3d33.5211!4d36.2904' }),
      };
    },
  });
  assert.equal(step, 2);
  assert.equal(chainRes.lat, 33.5211);
  assert.equal(chainRes.lng, 36.2904);
  assert.equal(chainRes.source, 'short_link');

  // 3. Short link redirecting to non-Google host -> rejected before fetching target
  const visitedUrls = [];
  await assert.rejects(
    () => resolveAndParseGoogleMapsLink('https://maps.app.goo.gl/evil', {
      fetchImpl: async (u) => {
        visitedUrls.push(u);
        return {
          status: 302,
          headers: new Headers({ location: 'https://evil-tracker.example/maps/@33.5,36.2' }),
        };
      },
    }),
    (err) => err instanceof GeoParseError && err.message.includes('google.com')
  );
  assert.deepEqual(visitedUrls, ['https://maps.app.goo.gl/evil']);

  // 4. Lookalike evilgoogle.com host rejected
  await assert.rejects(
    () => resolveAndParseGoogleMapsLink('https://maps.app.goo.gl/fake', {
      fetchImpl: async () => ({
        status: 302,
        headers: new Headers({ location: 'https://evilgoogle.com/maps/@33.5,36.2' }),
      }),
    }),
    GeoParseError
  );

  // 5. > 3 redirects rejected
  await assert.rejects(
    () => resolveAndParseGoogleMapsLink('https://maps.app.goo.gl/loop', {
      fetchImpl: async () => ({
        status: 302,
        headers: new Headers({ location: 'https://www.google.com/maps/preview/nopins' }),
      }),
    }),
    GeoParseError
  );
});

test('Admin geo link parser endpoint, validation, zone_admin 403 enforcement, and merchant location edits', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111188', password: 'Admin12345' })).data.token;
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

  const z2 = (await call('/admin/zones', 'POST', { name: 'ركن الدين' }, adm)).data;
  const za1 = await reg('zone_admin', '0963333301', { zone_id: 1 });
  const mZ1 = await reg('merchant', '0923333301', { business_name: 'متجر المزة', address: 'أوتوستراد المزة', lat: 33.501, lng: 36.251, zone_id: 1 });
  const mZ2 = await reg('merchant', '0923333302', { business_name: 'متجر ركن الدين', address: 'ساحة شمدين', lat: 33.541, lng: 36.301, zone_id: z2.id });

  // Non-admin blocked from parse-link (403)
  assert.equal((await call('/admin/geo/parse-link', 'POST', { link: 'https://www.google.com/maps/@33.5,36.2,15z' }, mZ1.tok)).status, 403);

  // Format 1: @lat,lng in path
  const fAt = await call('/admin/geo/parse-link', 'POST', {
    link: 'https://www.google.com/maps/place/Test/@33.5138,-36.2765,17z',
  }, adm);
  assert.equal(fAt.status, 200);
  assert.equal(fAt.data.lat, 33.5138);
  assert.equal(fAt.data.lng, -36.2765);
  assert.equal(fAt.data.source, 'at');

  // Format 2a: ?q=lat,lng
  const fQ = await call('/admin/geo/parse-link', 'POST', {
    link: 'https://maps.google.com/?q=33.5201,36.2802',
  }, za1.tok);
  assert.equal(fQ.status, 200);
  assert.equal(fQ.data.lat, 33.5201);
  assert.equal(fQ.data.lng, 36.2802);
  assert.equal(fQ.data.source, 'q');

  // Format 2b: ?ll=lat,lng
  const fLl = await call('/admin/geo/parse-link', 'POST', {
    link: 'https://maps.google.com/maps?ll=33.4955,36.2455&z=16',
  }, adm);
  assert.equal(fLl.status, 200);
  assert.equal(fLl.data.lat, 33.4955);
  assert.equal(fLl.data.lng, 36.2455);
  assert.equal(fLl.data.source, 'll');

  // Format 3: !3dLAT!4dLNG data segments take precedence over viewport @lat,lng
  const fData = await call('/admin/geo/parse-link', 'POST', {
    link: 'https://www.google.com/maps/place/Shop/@33.5000,36.2000,15z/data=!4m6!3m5!1s0x1!8m2!3d33.5188!4d36.2712!16s%2Fg',
  }, adm);
  assert.equal(fData.status, 200);
  assert.equal(fData.data.lat, 33.5188);
  assert.equal(fData.data.lng, 36.2712);
  assert.equal(fData.data.source, 'data');

  // Reject out-of-range, 0,0, no-coords, and non-Google domain on parse-link
  assert.equal((await call('/admin/geo/parse-link', 'POST', { link: 'https://www.google.com/maps/@95.1,36.2,15z' }, adm)).status, 400);
  assert.equal((await call('/admin/geo/parse-link', 'POST', { link: 'https://maps.google.com/?q=33.5,190.2' }, adm)).status, 400);
  assert.equal((await call('/admin/geo/parse-link', 'POST', { link: 'https://maps.google.com/?q=0,0' }, adm)).status, 400);
  assert.equal((await call('/admin/geo/parse-link', 'POST', { link: 'https://evil.example/maps/@33.5,36.2' }, adm)).status, 400);

  const noCoord = await call('/admin/geo/parse-link', 'POST', {
    link: 'https://www.google.com/maps/place/Damascus+Syria',
  }, adm);
  assert.equal(noCoord.status, 400);
  assert.ok(noCoord.data.error.includes('يدوياً') || noCoord.data.error.includes('إحداثيات'));

  // Reject out-of-range & 0,0 on PATCH /admin/users/:id too
  assert.equal((await call(`/admin/users/${mZ1.id}`, 'PATCH', { lat: 91, lng: 36.2 }, adm)).status, 400);
  assert.equal((await call(`/admin/users/${mZ1.id}`, 'PATCH', { lat: 33.5, lng: -181 }, adm)).status, 400);
  assert.equal((await call(`/admin/users/${mZ1.id}`, 'PATCH', { lat: 0, lng: 0 }, adm)).status, 400);
  assert.equal((await call(`/admin/users/${mZ1.id}`, 'PATCH', { lat: 33.5, lng: null }, adm)).status, 400);

  // zone_admin out-of-zone location edit MUST return 403
  const crossEdit = await call(`/admin/users/${mZ2.id}`, 'PATCH', {
    lat: 33.55,
    lng: 36.31,
    location_source: 'link',
  }, za1.tok);
  assert.equal(crossEdit.status, 403);
  // zone_admin out-of-zone merchant creation MUST return 403
  const crossCreate = await call('/admin/users', 'POST', {
    role: 'merchant',
    phone: '0929998887',
    name: 'حساب مرفوض',
    password: 'Passw0rdX',
    zone_id: z2.id,
    business_name: 'متجر آخر',
    address: 'عنوان آخر',
    lat: 33.55,
    lng: 36.31,
  }, za1.tok);
  assert.equal(crossCreate.status, 403);

  // Create active open order for mZ1 so editing mZ1's coordinates triggers active-order warning without touching order
  const ordOpen = (await call('/merchant/orders', 'POST', { customer_address: 'شارع الثورة' }, mZ1.tok)).data;
  assert.ok(ordOpen.id);

  // zone_admin CAN edit own-zone merchant location; returns warning when open order exists
  const editZ1 = await call(`/admin/users/${mZ1.id}`, 'PATCH', {
    lat: 33.5111,
    lng: 36.2611,
    location_source: 'link',
  }, za1.tok);
  assert.equal(editZ1.status, 200);
  assert.equal(editZ1.data.ok, true);
  assert.equal(editZ1.data.warning, 'تغيير الموقع لا يؤثر على الطلبات الحالية');

  // Verify updated coordinates & active_orders_count returned by GET /admin/users
  const z1Merchants = (await call('/admin/users?role=merchant', 'GET', null, za1.tok)).data;
  const updatedMZ1 = z1Merchants.find((x) => x.id === mZ1.id);
  assert.equal(updatedMZ1.lat, 33.5111);
  assert.equal(updatedMZ1.lng, 36.2611);
  assert.equal(updatedMZ1.active_orders_count, 1);

  // Super admin CAN edit any zone merchant's location
  const editZ2 = await call(`/admin/users/${mZ2.id}`, 'PATCH', {
    lat: 33.5444,
    lng: 36.3044,
    location_source: 'manual',
  }, adm);
  assert.equal(editZ2.status, 200);
  assert.equal(editZ2.data.warning, undefined);

  // Verify no share URL is ever persisted in users or audit table, while location_source IS recorded in audit
  const client = createClient({ url: `file:${dbPath}` });
  const colsRes = await client.execute('PRAGMA table_info(users)');
  const colNames = colsRes.rows.map((r) => r.name);
  assert.equal(colNames.includes('map_link'), false);
  const auditRes = await client.execute("SELECT data FROM audit WHERE action='user_update' ORDER BY id DESC LIMIT 2");
  const joinedAudit = auditRes.rows.map((r) => r.data).join('\n');
  assert.ok(joinedAudit.includes('"location_source":"manual"') || joinedAudit.includes('"location_source":"link"'));
  assert.equal(joinedAudit.includes('google.com'), false);
  client.close();
});
