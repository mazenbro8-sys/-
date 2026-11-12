import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-f1d-'));
const dbPath = path.join(tmpDir, 'dispatch.db');
const port = 3400 + Math.floor(Math.random() * 400);
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
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars-long',
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
  throw new Error('Server failed to start');
});

after(() => {
  if (proc && !proc.killed) proc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F1 regression: 3-captain round-robin, silent redispatch, zone isolation, and offer timeout', async () => {
  const admLogin = await call('/auth/login', 'POST', { phone: '0911111111', password: 'Admin12345' });
  assert.equal(admLogin.status, 200);
  const adm = admLogin.data.token;

  const zA = (await call('/admin/zones', 'POST', { name: 'منطقة-التناوب-F1' }, adm)).data;
  const zB = (await call('/admin/zones', 'POST', { name: 'منطقة-العزل-F1' }, adm)).data;
  assert.ok(zA?.id && zB?.id);

  const merch = await call('/admin/users', 'POST', {
    name: 'صاحب مطعم الفحص',
    business_name: 'مطعم التناوب',
    phone: '0971000001',
    password: 'Passw0rdX',
    role: 'merchant',
    zone_id: zA.id,
    address: 'شارع التناوب ١',
    lat: 33.511,
    lng: 36.271,
  }, adm);
  assert.equal(merch.status, 201, JSON.stringify(merch.data));
  const mTok = (await call('/auth/login', 'POST', { phone: '0971000001', password: 'Passw0rdX' })).data.token;

  const capsA = [];
  for (let i = 1; i <= 3; i++) {
    const cr = await call('/admin/users', 'POST', {
      name: `كابتن تناوب ${i}`,
      phone: `097100001${i}`,
      password: 'Passw0rdX',
      role: 'captain',
      zone_id: zA.id,
    }, adm);
    assert.equal(cr.status, 201);
    const tok = (await call('/auth/login', 'POST', { phone: `097100001${i}`, password: 'Passw0rdX' })).data.token;
    assert.equal((await call('/captain/online', 'POST', { online: true }, tok)).status, 200);
    capsA.push({ id: cr.data.id, tok });
  }

  const capBRes = await call('/admin/users', 'POST', {
    name: 'كابتن معزول',
    phone: '0971000020',
    password: 'Passw0rdX',
    role: 'captain',
    zone_id: zB.id,
  }, adm);
  assert.equal(capBRes.status, 201);
  const capBTok = (await call('/auth/login', 'POST', { phone: '0971000020', password: 'Passw0rdX' })).data.token;
  assert.equal((await call('/captain/online', 'POST', { online: true }, capBTok)).status, 200);

  const ord1Res = await call('/merchant/orders', 'POST', {
    customer_address: 'المزة شارع الجلاء قرب الحديقة العامة بناء رقم 12',
    customer_phone: '0988111222',
  }, mTok);
  assert.equal(ord1Res.status, 201, JSON.stringify(ord1Res.data));
  const ord1Id = ord1Res.data.id;

  const findOffer = async (tok) => (await call('/captain/state', 'GET', null, tok)).data.offer;
  assert.equal((await findOffer(capsA[0].tok))?.id, ord1Id);
  assert.equal((await findOffer(capsA[1].tok)), null);
  assert.equal((await findOffer(capBTok)), null);

  // Silent reject by capsA[0] moves offer to capsA[1]
  assert.equal((await call(`/captain/offers/${ord1Id}/reject`, 'POST', {}, capsA[0].tok)).status, 200);
  assert.equal((await findOffer(capsA[1].tok))?.id, ord1Id);

  // Remaining rejects -> zone B isolated captain never receives zone A offer
  assert.equal((await call(`/captain/offers/${ord1Id}/reject`, 'POST', {}, capsA[1].tok)).status, 200);
  assert.equal((await findOffer(capsA[2].tok))?.id, ord1Id);
  assert.equal((await call(`/captain/offers/${ord1Id}/reject`, 'POST', {}, capsA[2].tok)).status, 200);
  assert.equal((await findOffer(capBTok)), null);

  assert.equal((await call(`/merchant/orders/${ord1Id}/cancel`, 'POST', {}, mTok)).status, 200);

  // Offer timeout (OFFER_TIMEOUT_MS=500): let offer expire without rejection -> silently moves to next captain
  const ordT = (await call('/merchant/orders', 'POST', {
    customer_address: 'المزة فيلات غربية بناء رقم 45 الطابق الثالث',
    customer_phone: '0988999000',
  }, mTok)).data;
  const firstTimedIdx = (await Promise.all(capsA.map((c) => findOffer(c.tok)))).findIndex((o) => o?.id === ordT.id);
  assert.ok(firstTimedIdx >= 0, 'Timed order should be offered initially');
  let movedOnTimeout = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const st = await Promise.all(capsA.map((c) => findOffer(c.tok)));
    const nextIdx = st.findIndex((o) => o?.id === ordT.id);
    if (nextIdx >= 0 && nextIdx !== firstTimedIdx) {
      movedOnTimeout = true;
      break;
    }
  }
  assert.ok(movedOnTimeout, 'Expired offer must silently redispatch to another eligible captain');
  assert.equal((await call(`/merchant/orders/${ordT.id}/cancel`, 'POST', {}, mTok)).status, 200);

  // Round-robin & busy fallback
  const ord2 = (await call('/merchant/orders', 'POST', {
    customer_address: 'المزة شارع الفارابي البناء الثاني شقة 4',
    customer_phone: '0988333444',
  }, mTok)).data;
  const states2 = await Promise.all(capsA.map((c) => findOffer(c.tok)));
  const offeredIdx = states2.findIndex((o) => o?.id === ord2.id);
  assert.ok(offeredIdx >= 0, 'Order 2 must be offered to one of the 3 zone-A captains');
  assert.equal((await call(`/captain/offers/${ord2.id}/accept`, 'POST', {}, capsA[offeredIdx].tok)).status, 200);

  const ord3 = (await call('/merchant/orders', 'POST', {
    customer_address: 'المزة اوتستراد المزة الطابق الرابع بناء 9',
    customer_phone: '0988555666',
  }, mTok)).data;
  const states3 = await Promise.all(capsA.map((c) => findOffer(c.tok)));
  const offered3Idx = states3.findIndex((o) => o?.id === ord3.id);
  assert.ok(offered3Idx >= 0 && offered3Idx !== offeredIdx, 'Free captain must be picked before busy captain');
  assert.equal((await call(`/merchant/orders/${ord3.id}/cancel`, 'POST', {}, mTok)).status, 200);

  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'picked_up' }, capsA[offeredIdx].tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'arrived' }, capsA[offeredIdx].tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'delivered' }, capsA[offeredIdx].tok)).status, 200);
});
