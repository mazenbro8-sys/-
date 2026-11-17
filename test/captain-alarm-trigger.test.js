import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createCaptainAlarmGate, CAPTAIN_TONES, normalizeCaptainTone } from '../public/shared.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-alarm-trig-'));
const dbPath = path.join(tmpDir, 'alarm-trig.db');
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

let adm, merch, cap;

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDir,
      DB_FILE: dbPath,
      ADMIN_PHONE: '0911111199',
      ADMIN_PASSWORD: 'Admin12345',
      JWT_SECRET: 'test-alarm-trigger-jwt-secret-32chars',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${base}/zones`)).ok; } catch {}
    if (!up) await sleep(120);
  }
  if (!up) throw new Error('alarm-trigger test server did not start');

  adm = (await call('/auth/login', 'POST', { phone: '0911111199', password: 'Admin12345' })).data.token;
  const login = async (p) => (await call('/auth/login', 'POST', { phone: p, password: 'Passw0rdX' })).data.token;
  const reg = async (role, phone, extra = {}) => {
    const r = await call('/admin/users', 'POST', { role, phone, name: `${role}-${phone}`, password: 'Passw0rdX', zone_id: 1, ...extra }, adm);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...r.data, tok: await login(phone) };
  };

  merch = await reg('merchant', '0929000001', { business_name: 'متجر المنبه', address: 'المالكي', lat: 33.51, lng: 36.27 });
  cap = await reg('captain', '0939000001', { name: 'الكابتن منبه' });
});

after(() => {
  if (proc && !proc.killed) proc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('createCaptainAlarmGate starts only once per new offer ID, ignores refreshes, and stops when cleared', () => {
  let alarmStartCount = 0;
  let alarmStopCount = 0;
  const startedOfferIds = [];

  const gate = createCaptainAlarmGate({
    onStart(o) {
      alarmStartCount += 1;
      startedOfferIds.push(o.id);
    },
    onStop() {
      alarmStopCount += 1;
    },
  });

  // 1. New offer arrives -> alarm starts once
  const r1 = gate.syncOffer({ id: 501, status: 'offered' }, { online: true });
  assert.equal(r1.started, true);
  assert.equal(alarmStartCount, 1);
  assert.equal(gate.getLastOfferId(), 501);

  // 2. Same offer on refresh -> no new alarm
  const r2 = gate.syncOffer({ id: 501, status: 'offered' }, { online: true });
  assert.equal(r2.started, false);
  assert.equal(r2.stopped, false);
  assert.equal(alarmStartCount, 1);

  // 3. Offer cleared (accepted / picked_up status update / expired) -> stops alarm & resets gate
  const r3 = gate.syncOffer(null, { online: true });
  assert.equal(r3.started, false);
  assert.equal(r3.stopped, true);
  assert.equal(alarmStartCount, 1);
  assert.equal(alarmStopCount, 1);
  assert.equal(gate.getLastOfferId(), null);

  // Non-'offered' status also never starts alarm
  const rPicked = gate.syncOffer({ id: 501, status: 'picked_up' }, { online: true });
  assert.equal(rPicked.started, false);
  assert.equal(alarmStartCount, 1);

  // 4. Second new offer arrives -> alarm starts again
  const r4 = gate.syncOffer({ id: 502, status: 'offered' }, { online: true });
  assert.equal(r4.started, true);
  assert.equal(alarmStartCount, 2);
  assert.deepEqual(startedOfferIds, [501, 502]);

  // Going offline stops alarm and resets gate
  const rOff = gate.syncOffer({ id: 502, status: 'offered' }, { online: false });
  assert.equal(rOff.stopped, true);
  assert.equal(gate.getLastOfferId(), null);
});

test('captain web & Android alarm triggers stay silent on status presses and repeat polls, and sound only on new offers', async () => {
  // Static guards against regression in connectWs / fixed melody / CaptainService.java / MainActivity.java
  assert.deepEqual(CAPTAIN_TONES.map((t) => t.id), ['order_melody']);
  assert.equal(normalizeCaptainTone('triple'), 'order_melody');
  assert.equal(normalizeCaptainTone('order_melody'), 'order_melody');

  const captainJs = fs.readFileSync(path.join(process.cwd(), 'public', 'captain.js'), 'utf8');
  assert.equal(/toneSelect|panther_tone/.test(captainJs), false, 'captain.js must not include #toneSelect or read panther_tone');
  assert.equal(captainJs.includes('نغمة التنبيه: نغمة الطلب الجديد (ثابتة)'), true, 'captain.js settings must display fixed tone label');
  const wsSectionMatch = captainJs.match(/connectWs\(\(m\)\s*=>\s*\{[\s\S]*?\}\);/);
  assert.ok(wsSectionMatch, 'connectWs handler must exist in public/captain.js');
  assert.equal(/testSound\s*\(/.test(wsSectionMatch[0]), false, 'connectWs must never call testSound()');

  const javaSvc = fs.readFileSync(
    path.join(process.cwd(), 'android-captain', 'app', 'src', 'main', 'java', 'sy', 'panther', 'captain', 'CaptainService.java'),
    'utf8'
  );
  assert.match(javaSvc, /normalizeCaptainTone[\s\S]*?return\s+"order_melody";/, 'CaptainService must normalize every tone to order_melody');
  assert.match(javaSvc, /880\.0,\s*1100\.0,\s*1320\.0,\s*1760\.0/, 'CaptainService must synthesize the 4 approved note frequencies');
  assert.match(javaSvc, /0\.16,\s*0\.16,\s*0\.16,\s*0\.32/, 'CaptainService must synthesize the 4 approved note durations');
  assert.match(javaSvc, /0\.00,\s*0\.20,\s*0\.40,\s*0\.60/, 'CaptainService must use 40 ms gaps between notes');
  assert.match(javaSvc, /includePause\s*\?\s*2\.72\s*:\s*0\.92/, 'CaptainService must include 1800 ms silence after note 4');

  const javaMain = fs.readFileSync(
    path.join(process.cwd(), 'android-captain', 'app', 'src', 'main', 'java', 'sy', 'panther', 'captain', 'MainActivity.java'),
    'utf8'
  );
  assert.match(javaMain, /public void setTone\(String tone\)\s*\{\s*(?:\/\/[^\n]*\s*)*\}/, 'MainActivity.setTone must be a safe no-op');

  const checkStateMatch = javaSvc.match(/private void checkCaptainState\([\s\S]*?public synchronized void startSiren/);
  assert.ok(checkStateMatch, 'checkCaptainState must exist in CaptainService.java');
  assert.equal(
    /playShortBeep\s*\(/.test(checkStateMatch[0]),
    false,
    'CaptainService checkCaptainState activeOrders block must not call playShortBeep()'
  );
  assert.match(
    checkStateMatch[0],
    /if\s*\(offerId\s*!=\s*lastNotifiedOfferId\)[\s\S]*?startSiren\(60000\);/,
    'CaptainService startSiren must be gated inside offerId != lastNotifiedOfferId'
  );

  // Admin message background delivery assertions in CaptainService.java & bumped APK version (1.4.4 / versionCode 10+)
  assert.match(javaSvc, /CHANNEL_MSG\s*=\s*"panther_messages"/, 'CaptainService must define CHANNEL_MSG');
  assert.match(javaSvc, /"PANTHER Messages"/, 'CaptainService must create PANTHER Messages notification channel');
  assert.match(javaSvc, /PREF_ALERTED_NOTIF_IDS\s*=\s*"alerted_notif_ids"/, 'CaptainService must track alerted_notif_ids');
  assert.match(javaSvc, /MAX_ALERTED_NOTIF_IDS\s*=\s*50\b/, 'CaptainService must retain up to 50 alerted notification IDs');
  assert.match(javaSvc, /INBOX_POLL_INTERVAL_MS\s*=\s*15_000L/, 'CaptainService must poll /api/notifications/inbox every 15s');
  assert.match(javaSvc, /MSG_CHIME_COOLDOWN_MS\s*=\s*10_000L/, 'CaptainService must rate-limit message chime to every 10s');
  assert.match(javaSvc, /\/api\/notifications\/inbox/, 'CaptainService must fetch /api/notifications/inbox');
  assert.match(javaSvc, /if\s*\(!offerRinging\s*&&\s*\(nowMs\s*-\s*lastInboxCheckAt\)\s*>=\s*INBOX_POLL_INTERVAL_MS\)/, 'CaptainService must skip inbox check when offer is ringing');
  assert.match(javaSvc, /addTonePulse\(mix,\s*sampleRate,\s*true,\s*660\.0,\s*660\.0,\s*660\.0,\s*0\.00,\s*0\.18,\s*0\.36,\s*0\.008,\s*0\.008\)/, 'Message chime note 1 must be 660Hz triangle 180ms at 0.36 peak');
  assert.match(javaSvc, /addTonePulse\(mix,\s*sampleRate,\s*true,\s*880\.0,\s*880\.0,\s*880\.0,\s*0\.22,\s*0\.18,\s*0\.36,\s*0\.008,\s*0\.008\)/, 'Message chime note 2 must be 880Hz triangle 180ms at 0.36 peak');
  assert.match(javaSvc, /vibrateBrief\(prefs,\s*200\)/, 'Message alert must vibrate for 200ms');
  assert.match(javaSvc, /POST_NOTIFICATIONS/, 'CaptainService must check POST_NOTIFICATIONS on Android 13+');
  assert.match(javaSvc, /"لديك "\s*\+[\s\S]*?" رسائل جديدة"/, 'CaptainService must summarize queued unread messages');

  const manifestXml = fs.readFileSync(
    path.join(process.cwd(), 'android-captain', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8'
  );
  assert.match(manifestXml, /android:versionCode="10"/, 'AndroidManifest versionCode must be 10');
  assert.match(manifestXml, /android:versionName="1\.4\.4"/, 'AndroidManifest versionName must be 1.4.4');

  const buildGradle = fs.readFileSync(
    path.join(process.cwd(), 'android-captain', 'app', 'build.gradle'),
    'utf8'
  );
  assert.match(buildGradle, /versionCode\s+10\b/, 'build.gradle versionCode must be 10');
  assert.match(buildGradle, /versionName\s+"1\.4\.4"/, 'build.gradle versionName must be 1.4.4');

  // End-to-end server flow
  let alarmStartCount = 0;
  let alarmStopCount = 0;
  const gate = createCaptainAlarmGate({
    onStart() { alarmStartCount += 1; },
    onStop() { alarmStopCount += 1; },
  });

  const { ws: capWs, msgs: capMsgs } = await connectWs(cap.tok);
  try {
    assert.equal((await call('/captain/online', 'POST', { online: true }, cap.tok)).status, 200);

    // 1. New order offer arrives -> alarm starts once
    const ord1 = (await call('/merchant/orders', 'POST', { customer_address: 'شارع الثورة - دمشق' }, merch.tok)).data;
    assert.ok(ord1?.id);

    const state1 = (await call('/captain/state', 'GET', null, cap.tok)).data;
    assert.equal(state1.offer?.id, ord1.id);
    gate.syncOffer(state1.offer, { online: state1.online });
    assert.equal(alarmStartCount, 1);

    // 2. Refresh while same offer is active -> no new alarm
    const state1Refresh = (await call('/captain/state', 'GET', null, cap.tok)).data;
    assert.equal(state1Refresh.offer?.id, ord1.id);
    gate.syncOffer(state1Refresh.offer, { online: state1Refresh.online });
    assert.equal(alarmStartCount, 1);

    // Accept offer 1 -> offer clears -> alarm stops
    assert.equal((await call(`/captain/offers/${ord1.id}/accept`, 'POST', {}, cap.tok)).status, 200);
    const stateAfterAcc = (await call('/captain/state', 'GET', null, cap.tok)).data;
    gate.syncOffer(stateAfterAcc.offer, { online: stateAfterAcc.online });
    assert.equal(alarmStartCount, 1);
    assert.ok(alarmStopCount >= 1);

    // 3. Status updates picked_up -> arrived -> delivered must never start alarm (even with WS order events + state refresh)
    capMsgs.length = 0;
    for (const nextStatus of ['picked_up', 'arrived', 'delivered']) {
      const stRes = await call(`/captain/orders/${ord1.id}/status`, 'POST', { status: nextStatus }, cap.tok);
      assert.equal(stRes.status, 200, JSON.stringify(stRes.data));
      const wsOrder = await waitFor(capMsgs, (m) => m.type === 'order' && m.order?.id === ord1.id && m.order?.status === nextStatus);
      assert.ok(wsOrder, `Expected WS order update for ${nextStatus}`);
      const stAfter = (await call('/captain/state', 'GET', null, cap.tok)).data;
      gate.syncOffer(stAfter.offer, { online: stAfter.online });
      assert.equal(alarmStartCount, 1, `Alarm must stay silent on status=${nextStatus}`);
    }

    // 4. Second new offer arrives -> alarm starts again
    const ord2 = (await call('/merchant/orders', 'POST', { customer_address: 'المزة فيلات غربية' }, merch.tok)).data;
    assert.ok(ord2?.id && ord2.id !== ord1.id);
    const state2 = (await call('/captain/state', 'GET', null, cap.tok)).data;
    assert.equal(state2.offer?.id, ord2.id);
    gate.syncOffer(state2.offer, { online: state2.online });
    assert.equal(alarmStartCount, 2);

    // Pass 2 check: accept offer 2, then create offer 3 (queued offer while ord2 is accepted),
    // start alarm once for offer 3, then press picked_up on ord2 -> alarm must NOT restart!
    assert.equal((await call(`/captain/offers/${ord2.id}/accept`, 'POST', {}, cap.tok)).status, 200);
    const s2Acc = (await call('/captain/state', 'GET', null, cap.tok)).data;
    gate.syncOffer(s2Acc.offer, { online: s2Acc.online });

    const ord3 = (await call('/merchant/orders', 'POST', { customer_address: 'أبو رمانة' }, merch.tok)).data;
    const s3 = (await call('/captain/state', 'GET', null, cap.tok)).data;
    assert.equal(s3.offer?.id, ord3.id);
    gate.syncOffer(s3.offer, { online: s3.online });
    assert.equal(alarmStartCount, 3);

    assert.equal((await call(`/captain/orders/${ord2.id}/status`, 'POST', { status: 'picked_up' }, cap.tok)).status, 200);
    const s2PickedWhileOrd3Offered = (await call('/captain/state', 'GET', null, cap.tok)).data;
    assert.equal(s2PickedWhileOrd3Offered.offer?.id, ord3.id);
    gate.syncOffer(s2PickedWhileOrd3Offered.offer, { online: s2PickedWhileOrd3Offered.online });
    assert.equal(alarmStartCount, 3, 'Pressing picked_up while another offer is open must not restart alarm');
  } finally {
    try { capWs.close(); } catch {}
  }
});
