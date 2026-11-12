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

  // F5 & F6: Global order cost, wallet enforcement toggle, per-captain overrides, temporary exemptions & RBAC
  assert.equal((await call('/admin/settings/order-cost', 'PUT', { value: 30 }, za1)).status, 403);
  assert.equal((await call('/admin/settings/wallet-enforcement', 'PUT', { enabled: true }, za1)).status, 403);
  assert.equal((await call('/admin/settings/order-cost', 'PUT', { value: 12.5 }, adm)).status, 400);
  assert.equal((await call('/admin/settings/order-cost', 'PUT', { value: -5 }, adm)).status, 400);

  const ocRes = await call('/admin/settings/order-cost', 'PUT', { value: 30 }, adm);
  assert.equal(ocRes.status, 200);
  assert.equal(ocRes.data.order_cost_points, 30);

  const statsRes = (await call('/admin/stats', 'GET', null, adm)).data;
  assert.equal(statsRes.order_cost_points, 30);
  assert.equal(statsRes.wallet_enforcement, 'off');

  // zone_admin cannot modify cost_override or exemptions on their zone captain (nor partially update name)
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { name: 'محاولة تغيير', cost_override: 0 }, za1)).status, 403);
  assert.equal((await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm)).data.name, 'كابتن كود معدل');

  // Super admin sets custom override -> permanent 0 -> inverted window (400) -> temporary window -> clear
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { cost_override: 15 }, adm)).status, 200);
  let c1View = (await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm)).data;
  assert.equal(c1View.effective_cost_points, 15);
  assert.equal(c1View.cost_source, 'override');

  const now = Date.now();
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { exempt_from: now + 5000, exempt_until: now + 1000 }, adm)).status, 400);
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { exempt_from: now - 60000, exempt_until: now + 60000 }, adm)).status, 200);
  c1View = (await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm)).data;
  assert.equal(c1View.effective_cost_points, 0);
  assert.equal(c1View.cost_source, 'exempt_temporary');

  // Permanent exemption when temp window is cleared
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { cost_override: 0, exempt_from: null, exempt_until: null }, adm)).status, 200);
  c1View = (await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm)).data;
  assert.equal(c1View.effective_cost_points, 0);
  assert.equal(c1View.cost_source, 'exempt_permanent');

  // Reset override -> uses global 30
  assert.equal((await call(`/admin/users/${cap1.data.id}`, 'PATCH', { cost_override: null }, adm)).status, 200);
  c1View = (await call(`/admin/captains/by-tag/${cap1.data.tag}`, 'GET', null, adm)).data;
  assert.equal(c1View.effective_cost_points, 30);
  assert.equal(c1View.cost_source, 'default');

  // F4: Manual top-up, client_ref idempotency, zone_admin cross-zone isolation, ledger & captain wallet API
  assert.equal((await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: 0 }, adm)).status, 400);
  assert.equal((await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: -10 }, adm)).status, 400);
  assert.equal((await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: 10.5 }, adm)).status, 400);

  const tu1 = await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: 100, note: 'حوالة أولى', client_ref: 'e2e-ref-1' }, adm);
  assert.equal(tu1.status, 200);
  assert.equal(tu1.data.duplicate, false);
  assert.equal(tu1.data.balance_points, 100);

  const tu1Dup = await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: 100, note: 'حوالة أولى', client_ref: 'e2e-ref-1' }, adm);
  assert.equal(tu1Dup.status, 200);
  assert.equal(tu1Dup.data.duplicate, true);
  assert.equal(tu1Dup.data.balance_points, 100);

  // zone_admin can top up z1 captain, blocked (404) from z2 captain
  const tuZa = await call(`/admin/captains/${cap1.data.id}/topup`, 'POST', { points: 50, note: 'شحن منطقة 1' }, za1);
  assert.equal(tuZa.status, 200);
  assert.equal(tuZa.data.balance_points, 150);
  assert.equal((await call(`/admin/captains/${cap2.data.id}/topup`, 'POST', { points: 50 }, za1)).status, 404);
  assert.equal((await call(`/admin/captains/${cap2.data.id}/ledger`, 'GET', null, za1)).status, 404);

  const admLedger = await call(`/admin/captains/${cap1.data.id}/ledger`, 'GET', null, adm);
  assert.equal(admLedger.status, 200);
  assert.equal(admLedger.data.captain.balance_points, 150);
  assert.equal(admLedger.data.entries.length, 2);

  const capWallet = await call('/captain/wallet', 'GET', null, cap1Login.data.token);
  assert.equal(capWallet.status, 200);
  assert.equal(capWallet.data.balance_points, 150);
  assert.equal(capWallet.data.required_cost, 30);
  assert.equal(capWallet.data.entries.length, 2);

  const capState = await call('/captain/state', 'GET', null, cap1Login.data.token);
  assert.equal(capState.status, 200);
  assert.equal(capState.data.balance_points, 150);
  assert.equal(capState.data.required_cost, 30);
  assert.equal(capState.data.low_balance, false);

  // F7: Deduction on delivery, dispatch blocking with wallet_enforcement='on', Pass 2 reservation, shortage, accept 409, admin low-bal warning
  assert.equal((await call('/admin/settings/order-cost', 'PUT', { value: 25 }, adm)).status, 200);
  assert.equal((await call('/admin/settings/wallet-enforcement', 'PUT', { enabled: true }, adm)).status, 200);

  const zEnf = (await call('/admin/zones', 'POST', { name: 'منطقة-التحصيل-F7' }, adm)).data;
  const zaEnfRes = await call('/admin/users', 'POST', {
    name: 'مسؤول F7', phone: '0973000090', password: 'Passw0rdX', role: 'zone_admin', zone_id: zEnf.id,
  }, adm);
  assert.equal(zaEnfRes.status, 201);
  const zaEnf = (await call('/auth/login', 'POST', { phone: '0973000090', password: 'Passw0rdX' })).data.token;

  const merchEnf = await call('/admin/users', 'POST', {
    name: 'صاحب مطعم F7', business_name: 'مطعم المحفظة', phone: '0973000001',
    password: 'Passw0rdX', role: 'merchant', zone_id: zEnf.id, address: 'شارع النقاط', lat: 33.515, lng: 36.275,
  }, adm);
  assert.equal(merchEnf.status, 201);
  const mEnfTok = (await call('/auth/login', 'POST', { phone: '0973000001', password: 'Passw0rdX' })).data.token;

  const mkCap = async (name, phoneNum) => {
    const cr = await call('/admin/users', 'POST', {
      name, phone: phoneNum, password: 'Passw0rdX', role: 'captain', zone_id: zEnf.id,
    }, adm);
    assert.equal(cr.status, 201);
    const tok = (await call('/auth/login', 'POST', { phone: phoneNum, password: 'Passw0rdX' })).data.token;
    return { id: cr.data.id, tok };
  };
  const capRich = await mkCap('كابتن غني', '0973000011');
  const capBroke = await mkCap('كابتن صفر', '0973000012');
  const capExempt = await mkCap('كابتن معفى', '0973000013');

  await call(`/admin/captains/${capRich.id}/topup`, 'POST', { points: 30, note: 'شحن 30 نقطة' }, adm);
  await call(`/admin/users/${capExempt.id}`, 'PATCH', { cost_override: 0 }, adm);

  // All 3 captains can go online even with 0 balance (Q7)
  assert.equal((await call('/captain/online', 'POST', { online: true }, capBroke.tok)).status, 200);
  const brokeSt = (await call('/captain/state', 'GET', null, capBroke.tok)).data;
  assert.equal(brokeSt.low_balance, true);

  assert.equal((await call('/captain/online', 'POST', { online: true }, capRich.tok)).status, 200);
  assert.equal((await call('/captain/online', 'POST', { online: true }, capExempt.tok)).status, 200);
  const exemptSt = (await call('/captain/state', 'GET', null, capExempt.tok)).data;
  assert.equal(exemptSt.low_balance, false);
  assert.equal(exemptSt.required_cost, 0);

  // Turn capExempt offline briefly so only capBroke (0 pts) & capRich (30 pts) are online -> Order 1 goes strictly to capRich!
  await call('/captain/online', 'POST', { online: false }, capExempt.tok);
  const ord1 = (await call('/merchant/orders', 'POST', { customer_address: 'شارع النقاط ١ بناء ٥' }, mEnfTok)).data;
  assert.equal((await call('/captain/state', 'GET', null, capBroke.tok)).data.offer, null);
  assert.equal((await call('/captain/state', 'GET', null, capRich.tok)).data.offer?.id, ord1.id);
  assert.equal((await call(`/captain/offers/${ord1.id}/accept`, 'POST', {}, capRich.tok)).status, 200);

  // Now capRich holds 1 open 25-pt order (available = 30 - 25 = 5 < 25) -> low_balance === true!
  const richMid = (await call('/captain/state', 'GET', null, capRich.tok)).data;
  assert.equal(richMid.reserved_points, 25);
  assert.equal(richMid.available_points, 5);
  assert.equal(richMid.low_balance, true);

  // Bring capExempt (0 balance, exempt) back online -> Order 2 skips capBroke AND skips Pass 2 capRich (reservation) -> goes to capExempt!
  await call('/captain/online', 'POST', { online: true }, capExempt.tok);
  const ord2 = (await call('/merchant/orders', 'POST', { customer_address: 'شارع النقاط ٢ بناء ٨' }, mEnfTok)).data;
  assert.equal((await call('/captain/state', 'GET', null, capExempt.tok)).data.offer?.id, ord2.id);
  assert.equal((await call(`/captain/offers/${ord2.id}/accept`, 'POST', {}, capExempt.tok)).status, 200);

  // Deliver exempt ord2 -> stays 0, freeing capExempt so capExempt can go offline cleanly
  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'picked_up' }, capExempt.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'arrived' }, capExempt.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'delivered' }, capExempt.tok)).status, 200);
  assert.equal((await call('/captain/wallet', 'GET', null, capExempt.tok)).data.balance_points, 0);

  // Turn capExempt offline -> only capBroke (0 pts) free and capRich busy/reserved (5 avail pts < 25) -> Order 3 triggers shortage immediately!
  assert.equal((await call('/captain/online', 'POST', { online: false }, capExempt.tok)).status, 200);
  const ord3 = (await call('/merchant/orders', 'POST', { customer_address: 'شارع النقاط ٣ العجز' }, mEnfTok)).data;
  assert.equal((await call('/captain/state', 'GET', null, capBroke.tok)).data.offer, null);
  const zaLive = (await call('/admin/live', 'GET', null, zaEnf)).data;
  assert.equal(zaLive.shortage.alert, true);
  assert.equal(zaLive.shortage.onlineCaptains, 0);
  await call(`/merchant/orders/${ord3.id}/cancel`, 'POST', {}, mEnfTok);

  // Accept-time race check: top up capBroke with 25, receive Offer 4, raise global cost to 40 before accept -> 409!
  await call(`/admin/captains/${capBroke.id}/topup`, 'POST', { points: 25 }, adm);
  const ord4 = (await call('/merchant/orders', 'POST', { customer_address: 'شارع النقاط ٤ السباق' }, mEnfTok)).data;
  assert.equal((await call('/captain/state', 'GET', null, capBroke.tok)).data.offer?.id, ord4.id);
  await call('/admin/settings/order-cost', 'PUT', { value: 40 }, adm);
  const acceptFail = await call(`/captain/offers/${ord4.id}/accept`, 'POST', {}, capBroke.tok);
  assert.equal(acceptFail.status, 409);
  await call('/admin/settings/order-cost', 'PUT', { value: 25 }, adm);
  await call(`/merchant/orders/${ord4.id}/cancel`, 'POST', {}, mEnfTok);

  // Deliver ord1 (capRich: 30 - 25 = 5) & verify zero deduction on ord2 (capExempt: cost 0) & failed order (capBroke keeps 25)
  assert.equal((await call(`/captain/orders/${ord1.id}/status`, 'POST', { status: 'picked_up' }, capRich.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord1.id}/status`, 'POST', { status: 'arrived' }, capRich.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${ord1.id}/status`, 'POST', { status: 'delivered' }, capRich.tok)).status, 200);
  assert.equal((await call('/captain/wallet', 'GET', null, capRich.tok)).data.balance_points, 5);

  // Admin direct assignment to low-balance capRich (5 pts < 25 cost) -> succeeds WITH warning, delivery brings balance to -20!
  const admAssignOrd = await call('/admin/orders', 'POST', {
    merchant_id: merchEnf.data.id,
    captain_id: capRich.id,
    customer_address: 'تعيين إداري رصيد سالب',
  }, adm);
  assert.equal(admAssignOrd.status, 201);
  assert.ok(admAssignOrd.data.warning, 'Admin direct assign to low-balance captain must return warning');
  assert.equal(admAssignOrd.data.cost_points, 25);
  assert.equal((await call(`/captain/orders/${admAssignOrd.data.id}/status`, 'POST', { status: 'picked_up' }, capRich.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${admAssignOrd.data.id}/status`, 'POST', { status: 'arrived' }, capRich.tok)).status, 200);
  assert.equal((await call(`/captain/orders/${admAssignOrd.data.id}/status`, 'POST', { status: 'delivered' }, capRich.tok)).status, 200);
  assert.equal((await call('/captain/wallet', 'GET', null, capRich.tok)).data.balance_points, -20);

  // Failed order on capBroke does NOT deduct points (keeps 25)
  const ord5 = (await call('/merchant/orders', 'POST', { customer_address: 'طلب فاشل بدون خصم' }, mEnfTok)).data;
  assert.equal((await call('/captain/state', 'GET', null, capBroke.tok)).data.offer?.id, ord5.id);
  assert.equal((await call(`/captain/offers/${ord5.id}/accept`, 'POST', {}, capBroke.tok)).status, 200);
  await call(`/captain/orders/${ord5.id}/status`, 'POST', { status: 'picked_up' }, capBroke.tok);
  await call(`/captain/orders/${ord5.id}/status`, 'POST', { status: 'failed_customer', reason: 'الزبون لم يرد' }, capBroke.tok);
  assert.equal((await call('/captain/wallet', 'GET', null, capBroke.tok)).data.balance_points, 25);
});
