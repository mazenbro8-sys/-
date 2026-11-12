import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-wallet-e2e-'));
const dbPath = path.join(tmpDir, 'wallet.db');
const port = 3900 + Math.floor(Math.random() * 400);
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
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111111',
      ADMIN_PASSWORD: 'Admin12345',
      JWT_SECRET: 'test-wallet-jwt-secret-at-least-32-chars',
      OFFER_TIMEOUT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/zones`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Wallet E2E server failed to start');
});

after(() => {
  if (proc && !proc.killed) proc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F2: immutable captain hashtag codes, uniqueness, normalization, zone-scoped lookup', async () => {
  const adm = (await call('/auth/login', 'POST', { phone: '0911111111', password: 'Admin12345' })).data.token;
  const z1 = (await call('/admin/zones', 'POST', { name: 'منطقة-اكواد-1' }, adm)).data;
  const z2 = (await call('/admin/zones', 'POST', { name: 'منطقة-اكواد-2' }, adm)).data;

  // Create zone_admin for z1
  assert.equal((await call('/admin/users', 'POST', {
    name: 'مسؤول منطقة 1',
    phone: '0972000091',
    password: 'Passw0rdX',
    role: 'zone_admin',
    zone_id: z1.id,
  }, adm)).status, 201);
  const za1 = (await call('/auth/login', 'POST', { phone: '0972000091', password: 'Passw0rdX' })).data.token;

  // Create merchant (must NOT get tag)
  const merch = await call('/admin/users', 'POST', {
    name: 'صاحب منشأة',
    business_name: 'مطعم الأكواد',
    phone: '0972000001',
    password: 'Passw0rdX',
    role: 'merchant',
    zone_id: z1.id,
    address: 'شارع الأكواد',
    lat: 33.51,
    lng: 36.27,
  }, adm);
  assert.equal(merch.status, 201);
  assert.equal(merch.data.tag, undefined);

  // Create captains in z1 and z2
  const cap1 = await call('/admin/users', 'POST', {
    name: 'كابتن كود 1',
    phone: '0972000011',
    password: 'Passw0rdX',
    role: 'captain',
    zone_id: z1.id,
  }, adm);
  assert.equal(cap1.status, 201);
  assert.match(cap1.data.tag, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);

  const cap2 = await call('/admin/users', 'POST', {
    name: 'كابتن كود 2',
    phone: '0972000012',
    password: 'Passw0rdX',
    role: 'captain',
    zone_id: z2.id,
  }, adm);
  assert.equal(cap2.status, 201);
  assert.match(cap2.data.tag, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  assert.notEqual(cap1.data.tag, cap2.data.tag);

  // Captain sees tag via /auth/login & /me
  const cap1Login = await call('/auth/login', 'POST', { phone: '0972000011', password: 'Passw0rdX' });
  assert.equal(cap1Login.data.user.tag, cap1.data.tag);
  const cap1Me = await call('/me', 'GET', null, cap1Login.data.token);
  assert.equal(cap1Me.data.tag, cap1.data.tag);

  // Admin lookup by tag (with lowercase and URL-encoded '#')
  const byLower = await call(`/admin/captains/by-tag/${cap1.data.tag.toLowerCase()}`, 'GET', null, adm);
  assert.equal(byLower.status, 200);
  assert.equal(byLower.data.id, cap1.data.id);
  const byHash = await call(`/admin/captains/by-tag/${encodeURIComponent('#' + cap1.data.tag)}`, 'GET', null, adm);
  assert.equal(byHash.status, 200);
  assert.equal(byHash.data.id, cap1.data.id);

  // Zone admin sees z1 captain, receives 404 for z2 captain
  assert.equal((await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, za1)).status, 200);
  assert.equal((await call(`/admin/captains/by-tag/${cap2.data.tag}`, 'GET', null, za1)).status, 404);

  // Tag is immutable via PATCH
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { name: 'كابتن كود معدل', tag: 'AAAAA' }, adm)).status, 200);
  const afterPatch = await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm);
  assert.equal(afterPatch.status, 200);
  assert.equal(afterPatch.data.name, 'كابتن كود معدل');
  assert.equal(afterPatch.data.tag, cap1.data.tag);
});
