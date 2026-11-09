import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3991, BASE = `http://localhost:${PORT}/api`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mashwar-'));
let proc;
const call = async (p, method = 'GET', body, token) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
};

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, DB_FILE: path.join(dir, 't.db'), ADMIN_PHONE: '0911111111', ADMIN_PASSWORD: 'Admin12345', OFFER_TIMEOUT_MS: '1500' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/zones'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('server did not start');
});
after(() => { proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}; });

test('full delivery cycle with round-robin, privacy, settlement', async () => {
  const admin = (await call('/auth/login', 'POST', { phone: '0911111111', password: 'Admin12345' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', { role, phone, name: 'اسم ' + phone, password: 'Passw0rdX', zone_id: 1, ...extra }, admin);
    assert.equal(r.status, 201);
    return r;
  };
  await reg('merchant', '0922222222', { business_name: 'مطعم أبو أحمد', address: 'المزة', lat: 33.5, lng: 36.25 });
  await reg('captain', '0933333331'); await reg('captain', '0933333332');
  // public self-registration is closed; only admin can create accounts
  assert.equal((await call('/auth/register', 'POST', { role: 'captain', phone: '0955555555', name: 'x', password: 'Passw0rdX', zone_id: 1 })).status, 403);
  assert.equal((await call('/admin/users', 'POST', { role: 'captain', phone: '0955555555', name: 'x', password: 'Passw0rdX', zone_id: 1 }, null)).status, 401);
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const [m, c1, c2] = [await login('0922222222'), await login('0933333331'), await login('0933333332')];

  // role isolation
  assert.equal((await call('/admin/stats', 'GET', null, m)).status, 403);
  assert.equal((await call('/merchant/orders', 'GET', null, c1)).status, 403);
  assert.equal((await call('/merchant/orders')).status, 401);

  for (const c of [c1, c2]) await call('/captain/online', 'POST', { online: true }, c);
  // Single-field order creation (only customer_address required)
  const simpleRes = await call('/merchant/orders', 'POST', { customer_address: 'المزة - شارع الجلاء' }, m);
  assert.equal(simpleRes.status, 201);
  assert.equal(simpleRes.data.customer_address, 'المزة - شارع الجلاء');
  await call(`/merchant/orders/${simpleRes.data.id}/cancel`, 'POST', null, m);

  const ord = { customer_name: 'زبون', customer_phone: '0944444444', customer_address: 'شارع 1', product_amount: 50000, delivery_fee: 5000, customer_lat: 33.51, customer_lng: 36.26 };
  assert.equal((await call('/merchant/orders', 'POST', { ...ord, product_amount: -5 }, m)).status, 400);
  const o1 = (await call('/merchant/orders', 'POST', ord, m)).data;
  assert.equal(o1.status, 'offered');

  const s1 = (await call('/captain/state', 'GET', null, c1)).data, s2 = (await call('/captain/state', 'GET', null, c2)).data;
  const [first, other] = s1.offer ? [c1, c2] : [c2, c1];
  assert.ok(s1.offer || s2.offer);
  // customer phone hidden from captain before accepting, but delivery address is visible
  const offer = (s1.offer || s2.offer);
  assert.equal(offer.customer_phone, undefined);
  assert.equal(offer.customer_address, 'شارع 1');
  // other captain cannot accept it
  assert.equal((await call(`/captain/offers/${o1.id}/accept`, 'POST', null, other)).status, 409);
  // timeout → passes to the other captain (round-robin)
  let st;
  for (let i = 0; i < 100 && !(st = (await call('/captain/state', 'GET', null, other)).data).offer; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(st.offer?.id, o1.id);
  const acc = await call(`/captain/offers/${o1.id}/accept`, 'POST', null, other);
  assert.equal(acc.status, 200);
  assert.equal(acc.data.customer_phone, '0944444444');
  // invalid transition
  assert.equal((await call(`/captain/orders/${o1.id}/status`, 'POST', { status: 'delivered' }, other)).status, 400);
  await call('/captain/location', 'POST', { lat: 33.505, lng: 36.255 }, other);
  const trk = (await call(`/merchant/orders/${o1.id}`, 'GET', null, m)).data;
  assert.ok(trk.eta_minutes >= 1);
  for (const s of ['picked_up', 'arrived', 'delivered']) assert.equal((await call(`/captain/orders/${o1.id}/status`, 'POST', { status: s }, other)).status, 200);
  const day = (await call('/admin/settlements', 'GET', null, admin)).data;
  assert.equal(day.rows[0].commission_total, 2000);
  assert.equal((await call('/admin/settlements/collect', 'POST', { day: day.day, captain_id: day.rows[0].captain_id }, admin)).status, 200);

  // Admin: add order for a captain, unassign captain, and reassign captain
  const liveData = (await call('/admin/live', 'GET', null, admin)).data;
  const capId = liveData.captains[0].id;
  const admOrd = await call('/admin/orders', 'POST', { customer_address: 'أبو رمانة - الجاحظ', captain_id: capId }, admin);
  assert.equal(admOrd.status, 201);
  assert.equal(admOrd.data.status, 'accepted');
  assert.equal(admOrd.data.captain_id, capId);

  const unass = await call(`/admin/orders/${admOrd.data.id}/unassign-captain`, 'POST', null, admin);
  assert.equal(unass.status, 200);
  assert.equal(unass.data.status, 'searching');
  assert.equal(unass.data.captain_id, null);

  const reass = await call(`/admin/orders/${admOrd.data.id}/assign-captain`, 'POST', { captain_id: capId }, admin);
  assert.equal(reass.status, 200);
  assert.equal(reass.data.status, 'accepted');
  assert.equal(reass.data.captain_id, capId);

  // Assign a second order to the other captain so BOTH captains are now busy
  const capId2 = liveData.captains[1].id;
  await call('/admin/orders', 'POST', { customer_address: 'المالكي', captain_id: capId2 }, admin);

  // Now create a new merchant order while all captains are busy:
  // It must cycle through busy captains first before escalating to admin!
  const oBusy = (await call('/merchant/orders', 'POST', { customer_address: 'كفرسوسة - شام سنتر' }, m)).data;
  assert.equal(oBusy.status, 'offered');
  assert.equal((await call('/admin/live', 'GET', null, admin)).data.shortage.alert, false);

  // First busy captain rejects → passes to second busy captain, still NOT escalated to admin
  const bState1 = (await call('/captain/state', 'GET', null, c1)).data;
  const [bFirst, bSecond] = bState1.offer?.id === oBusy.id ? [c1, c2] : [c2, c1];
  await call(`/captain/offers/${oBusy.id}/reject`, 'POST', null, bFirst);
  const bState2 = (await call('/captain/state', 'GET', null, bSecond)).data;
  assert.equal(bState2.offer?.id, oBusy.id);
  assert.equal((await call('/admin/live', 'GET', null, admin)).data.shortage.alert, false);

  // Second busy captain rejects → all captains tried, NOW it escalates to admin (shortage.alert === true)!
  await call(`/captain/offers/${oBusy.id}/reject`, 'POST', null, bSecond);
  const afterAllRej = (await call('/admin/live', 'GET', null, admin)).data;
  assert.equal(afterAllRej.shortage.alert, true);
  assert.ok(afterAllRej.shortage.orders.some((x) => x.id === oBusy.id));

  // Zone Admin RBAC & multi-tenancy isolation
  const z2 = await call('/admin/zones', 'POST', { name: 'المالكي' }, admin);
  assert.equal(z2.status, 201);
  const z2Id = z2.data.id;
  assert.equal((await call('/admin/users', 'POST', { role: 'zone_admin', phone: '0966666666', name: 'مدير المالكي', password: 'Passw0rdX', zone_id: z2Id }, admin)).status, 201);
  const zaToken = await login('0966666666');
  const zaPayload = JSON.parse(Buffer.from(zaToken.split('.')[1], 'base64url').toString());
  assert.equal(zaPayload.role, 'zone_admin');
  assert.equal(zaPayload.zone_id, z2Id);
  assert.equal((await call('/admin/orders', 'GET', null, zaToken)).data.length, 0);
  assert.equal((await call(`/admin/orders/${o1.id}`, 'GET', null, zaToken)).status, 404);
  assert.equal((await call('/admin/zones', 'POST', { name: 'كفرسوسة' }, zaToken)).status, 403);
  assert.equal((await call('/admin/users', 'POST', { role: 'admin', phone: '0966666667', name: 'x', password: 'Passw0rdX', zone_id: z2Id }, zaToken)).status, 403);
  assert.equal((await call('/admin/users', 'POST', { role: 'zone_admin', phone: '0966666668', name: 'x', password: 'Passw0rdX', zone_id: z2Id }, zaToken)).status, 403);
  assert.equal((await call('/admin/users', 'POST', { role: 'captain', phone: '0966666669', name: 'كابتن المالكي', password: 'Passw0rdX', zone_id: 1 }, zaToken)).status, 201);
  const zaUsers = (await call('/admin/users', 'GET', null, zaToken)).data;
  assert.equal(zaUsers.length, 1);
  assert.equal(zaUsers[0].zone_id, z2Id);
  const z2CapId = zaUsers[0].id;

  // Segmented Users Tabs & Zone Filter API checks + Zone Injection Exploit Tests
  assert.equal((await call('/admin/users?role=admin', 'GET', null, zaToken)).status, 403);
  const zaInjectedQuery = (await call('/admin/users?zone_id=1', 'GET', null, zaToken)).data;
  assert.equal(zaInjectedQuery.length, 1);
  assert.equal(zaInjectedQuery[0].zone_id, z2Id);
  const allAdmins = (await call('/admin/users?role=admin', 'GET', null, admin)).data;
  assert.ok(allAdmins.some((u) => u.role === 'admin') && allAdmins.some((u) => u.role === 'zone_admin'));
  const z1Caps = (await call('/admin/users?role=captain&zone_id=1', 'GET', null, admin)).data;
  assert.ok(z1Caps.length >= 2 && z1Caps.every((u) => u.role === 'captain' && u.zone_id === 1));
  const z2Caps = (await call(`/admin/users?role=captain&zone_id=${z2Id}`, 'GET', null, admin)).data;
  assert.equal(z2Caps.length, 1);
  assert.equal(z2Caps[0].id, z2CapId);

  // Full user edit via PATCH /admin/users/:id + Cross-Zone PATCH exploit checks
  assert.equal((await call(`/admin/users/${z1Caps[0].id}`, 'PATCH', { name: 'اختراق' }, zaToken)).status, 404);
  assert.equal((await call(`/admin/users/${z2CapId}`, 'PATCH', { zone_id: 1 }, zaToken)).status, 403);
  assert.equal((await call(`/admin/users/${z2CapId}`, 'PATCH', { name: 'كابتن المالكي المعدّل' }, zaToken)).status, 200);
  assert.equal((await call('/admin/users?role=captain', 'GET', null, zaToken)).data[0].name, 'كابتن المالكي المعدّل');

  // Delete permissions + Soft Delete + Order History preservation
  const zaUserRow = allAdmins.find((u) => u.phone === '0966666666');
  const superAdminRow = allAdmins.find((u) => u.role === 'admin');
  assert.equal((await call(`/admin/users/${superAdminRow.id}`, 'DELETE', null, zaToken)).status, 403);
  assert.equal((await call(`/admin/users/${zaUserRow.id}`, 'DELETE', null, zaToken)).status, 403);
  assert.equal((await call(`/admin/users/${z1Caps[0].id}`, 'DELETE', null, zaToken)).status, 403);
  assert.equal((await call(`/admin/users/${superAdminRow.id}`, 'DELETE', null, admin)).status, 400); // self delete blocked

  // Zone Admin can soft-delete a captain in their own zone & existing JWT is immediately invalidated
  const z2CapToken = await login('0966666669');
  assert.equal((await call('/me', 'GET', null, z2CapToken)).status, 200);
  assert.equal((await call(`/admin/users/${z2CapId}`, 'DELETE', null, zaToken)).status, 200);
  assert.equal((await call('/me', 'GET', null, z2CapToken)).status, 401);
  assert.equal((await call('/captain/state', 'GET', null, z2CapToken)).status, 401);
  assert.equal((await call('/admin/users?role=captain', 'GET', null, zaToken)).data.length, 0);
  assert.equal((await call('/auth/login', 'POST', { phone: '0966666669', password: 'Passw0rdX' })).status, 403);

  // Super Admin soft-deletes a Zone 1 captain who already delivered orders -> disappears from list, order history stays intact!
  const ordersBeforeDel = (await call('/admin/orders', 'GET', null, admin)).data.length;
  const delCap = z1Caps[0];
  assert.equal((await call(`/admin/users/${delCap.id}`, 'DELETE', null, admin)).status, 200);
  assert.ok(!(await call('/admin/users?role=captain', 'GET', null, admin)).data.some((u) => u.id === delCap.id));
  assert.ok((await call('/admin/users?role=captain&include_deleted=true', 'GET', null, admin)).data.some((u) => u.id === delCap.id && u.status === 'deleted'));
  assert.equal((await call('/auth/login', 'POST', { phone: delCap.phone, password: 'Passw0rdX' })).status, 403);
  assert.equal((await call('/admin/orders', 'GET', null, admin)).data.length, ordersBeforeDel);
});

test('login rate / lockout and bad input', async () => {
  for (let i = 0; i < 5; i++) await call('/auth/login', 'POST', { phone: '0911111111', password: 'wrong-pass' });
  assert.equal((await call('/auth/login', 'POST', { phone: '0911111111', password: 'Admin12345' })).status, 429);
  assert.equal((await call('/auth/login', 'POST', { phone: "' OR 1=1 --", password: 'x' })).status, 400);
});


