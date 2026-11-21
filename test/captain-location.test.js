import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  normalizeGpsReading,
  shouldAcceptGpsReading,
  evaluateCaptainLocationSend,
  evaluateStaleRecovery,
  shouldSkipWebLocationPost,
  STALE_RECOVERY_BACKOFF_MS,
  animateMarker,
} from '../public/shared.js';
import { CAPTAIN_NO_LOCATION_MS, captainLegendBucket, getCaptainVisualState } from '../public/live-state.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createClient } = require('@libsql/client');

test('captain.js location helpers: accuracy filtering, >30s receivedAt staleness, and 15s idle-moved vs 10s active gap', () => {
  const now = 1_795_000_000_000;

  // 1. Accuracy filter: ignore >100m while good fix <=60s exists, allow first fix and >60s fallback (using receivedAt)
  const firstCoarse = normalizeGpsReading({ coords: { latitude: 33.5, longitude: 36.26, accuracy: 250 }, timestamp: now }, now);
  assert.equal(shouldAcceptGpsReading(firstCoarse, null, 0, now), true, 'accept first coarse fix when pos is empty');

  const recentGood = { lat: 33.5, lng: 36.26, accuracy: 12, receivedAt: now - 5_000, initialAge: 0 };
  const badGlitch = { lat: 33.52, lng: 36.28, accuracy: 350, receivedAt: now, initialAge: 0 };
  assert.equal(shouldAcceptGpsReading(badGlitch, recentGood, recentGood.receivedAt, now), false, 'ignore >100m glitch while recent good fix <=60s');
  assert.equal(shouldAcceptGpsReading(badGlitch, recentGood, now - 65_000, now), true, 'allow fallback >100m when no good fix for >60s');

  // 2. Stale fix >30s never re-sends frozen pos
  const staleRes = evaluateCaptainLocationSend({
    pos: { lat: 33.5, lng: 36.26, accuracy: 10, receivedAt: now - 35_000, initialAge: 0 },
    st: { online: true, active: { id: 1 }, intervals: { active: 10_000, idle: 60_000 } },
    lastSent: now - 15_000,
    lastSentPos: { lat: 33.5, lng: 36.26 },
    now,
  });
  assert.equal(staleRes.action, 'refresh_stale');

  // 3. Moved >=50m in idle mode: waits at 12s, sends at 15s (not 8s or 60s)
  const movedPos = { lat: 33.501, lng: 36.26, accuracy: 12, receivedAt: now - 1_000, initialAge: 500 }; // ~111m moved
  const stIdle = { online: true, active: null, intervals: { active: 10_000, idle: 60_000 } };
  const idle12s = evaluateCaptainLocationSend({
    pos: movedPos,
    st: stIdle,
    lastSent: now - 12_000,
    lastSentPos: { lat: 33.500, lng: 36.26 },
    now,
  });
  assert.equal(idle12s.action, 'wait');
  assert.equal(idle12s.targetGap, 15_000);

  const idle15s = evaluateCaptainLocationSend({
    pos: movedPos,
    st: stIdle,
    lastSent: now - 15_000,
    lastSentPos: { lat: 33.500, lng: 36.26 },
    now,
  });
  assert.equal(idle15s.action, 'send');
  assert.equal(idle15s.reason, 'moved');
  assert.equal(idle15s.payload.accuracy, 12);
  assert.equal(idle15s.payload.fix_age_ms, 1500);
  assert.equal('fix_at' in idle15s.payload, false);

  // Active order stays on 10s cadence (waits at 9s, sends at 10s)
  const stActive = { online: true, active: { id: 7 }, intervals: { active: 10_000, idle: 60_000 } };
  assert.equal(
    evaluateCaptainLocationSend({ pos: movedPos, st: stActive, lastSent: now - 9_000, lastSentPos: { lat: 33.500, lng: 36.26 }, now }).action,
    'wait'
  );
  assert.equal(
    evaluateCaptainLocationSend({ pos: movedPos, st: stActive, lastSent: now - 10_000, lastSentPos: { lat: 33.500, lng: 36.26 }, now }).action,
    'send'
  );

  // Stationary idle captain waits full 60s
  const idleStationary = evaluateCaptainLocationSend({
    pos: { lat: 33.50005, lng: 36.26, accuracy: 12, receivedAt: now - 1_000, initialAge: 0 }, // ~5.5m
    st: stIdle,
    lastSent: now - 20_000,
    lastSentPos: { lat: 33.500, lng: 36.26 },
    now,
  });
  assert.equal(idleStationary.action, 'wait');
  assert.equal(idleStationary.targetGap, 60_000);
});

test('captain.js clock-skew safety & stale recovery backoff: +90s/-10min skewed clocks send cleanly and backoff is 30s -> 60s -> 120s -> 180s cap', () => {
  // Phone clock +90s ahead (p.timestamp appears 90s behind phone Date.now())
  const phoneAheadNow = 1_795_000_090_000;
  const readingAhead = normalizeGpsReading({
    coords: { latitude: 33.502, longitude: 36.262, accuracy: 14 },
    timestamp: phoneAheadNow - 90_000,
  }, phoneAheadNow);
  assert.equal(readingAhead.receivedAt, phoneAheadNow);
  assert.equal(readingAhead.initialAge, 0, 'skewed delta >60s clamps initialAge safely to 0');

  const sendAhead = evaluateCaptainLocationSend({
    pos: readingAhead,
    st: { online: true, active: { id: 1 }, intervals: { active: 10_000, idle: 60_000 } },
    lastSent: phoneAheadNow - 11_000,
    lastSentPos: null,
    now: phoneAheadNow + 2_000,
  });
  assert.equal(sendAhead.action, 'send', '+90s skewed phone clock still sends without stale loop');
  assert.equal(sendAhead.payload.fix_age_ms, 2_000);

  // Phone clock -10min behind (p.timestamp appears 10min in the future of phone Date.now())
  const phoneBehindNow = 1_795_000_000_000;
  const readingBehind = normalizeGpsReading({
    coords: { latitude: 33.503, longitude: 36.263, accuracy: 16 },
    timestamp: phoneBehindNow + 600_000,
  }, phoneBehindNow);
  assert.equal(readingBehind.receivedAt, phoneBehindNow);
  assert.equal(readingBehind.initialAge, 0, 'negative delta clamps initialAge safely to 0');

  const sendBehind = evaluateCaptainLocationSend({
    pos: readingBehind,
    st: { online: true, active: { id: 1 }, intervals: { active: 10_000, idle: 60_000 } },
    lastSent: 0,
    lastSentPos: null,
    now: phoneBehindNow + 1_500,
  });
  assert.equal(sendBehind.action, 'send', '-10min skewed phone clock still sends');
  assert.equal(sendBehind.payload.fix_age_ms, 1_500);

  // Recovery backoff schedule (visible & online only)
  assert.deepEqual(STALE_RECOVERY_BACKOFF_MS, [60_000, 120_000, 180_000]);
  const staleDecision = { action: 'refresh_stale', fixAgeMs: 31_000 };
  const t0 = 1_795_000_000_000;

  // Never recover when hidden or offline
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: false, now: t0, attempts: 0 }).shouldRecover, false);
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: false, visible: true, now: t0, attempts: 0 }).shouldRecover, false);

  // Attempt 1 immediately after >30s without a fix
  const r1 = evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t0, lastRecoveryAt: 0, attempts: 0 });
  assert.equal(r1.shouldRecover, true);
  assert.equal(r1.nextAttempts, 1);

  // Blocked at +10s and +59s (never restarts every 10s)
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t0 + 10_000, lastRecoveryAt: t0, attempts: 1 }).shouldRecover, false);
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t0 + 59_000, lastRecoveryAt: t0, attempts: 1 }).shouldRecover, false);

  // Attempt 2 at +60s
  const t1 = t0 + 60_000;
  const r2 = evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t1, lastRecoveryAt: t0, attempts: 1 });
  assert.equal(r2.shouldRecover, true);
  assert.equal(r2.nextAttempts, 2);

  // Blocked at +119s, allowed at +120s (Attempt 3)
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t1 + 119_000, lastRecoveryAt: t1, attempts: 2 }).shouldRecover, false);
  const t2 = t1 + 120_000;
  const r3 = evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t2, lastRecoveryAt: t1, attempts: 2 });
  assert.equal(r3.shouldRecover, true);
  assert.equal(r3.nextAttempts, 3);

  // Blocked at +179s, allowed at +180s cap (Attempt 4 and subsequent)
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t2 + 179_000, lastRecoveryAt: t2, attempts: 3 }).shouldRecover, false);
  const t3 = t2 + 180_000;
  const r4 = evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t3, lastRecoveryAt: t2, attempts: 3 });
  assert.equal(r4.shouldRecover, true);
  assert.equal(r4.nextAttempts, 4);
  assert.equal(r4.cooldownMs, 180_000);

  // Subsequent attempt remains capped at 180s
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t3 + 179_000, lastRecoveryAt: t3, attempts: 4 }).shouldRecover, false);
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t3 + 180_000, lastRecoveryAt: t3, attempts: 4 }).cooldownMs, 180_000);

  // Reset attempts -> immediate recovery on next stale >30s
  assert.equal(evaluateStaleRecovery({ decision: staleDecision, online: true, visible: true, now: t3 + 35_000, lastRecoveryAt: 0, attempts: 0 }).shouldRecover, true);
});

test('live-state: idle online captain >10 min old location switches to no_loc ("أونلاين بدون موقع") and maps consistently to gray filter bucket', () => {
  const now = Date.now();
  const freshCap = getCaptainVisualState({ id: 1, online: true, last_loc_at: now - 60_000 }, [], now);
  assert.equal(freshCap.stateKey, 'yellow');
  assert.equal(freshCap.label, 'أونلاين متاح');
  assert.equal(captainLegendBucket(freshCap.stateKey), 'yellow');

  const staleCap = getCaptainVisualState({ id: 2, online: true, last_loc_at: now - CAPTAIN_NO_LOCATION_MS - 5_000 }, [], now);
  assert.equal(staleCap.stateKey, 'no_loc');
  assert.equal(staleCap.stateClass, 'ops-state-no-loc');
  assert.equal(staleCap.pulsing, false);
  assert.equal(staleCap.label, 'أونلاين بدون موقع');
  assert.equal(captainLegendBucket(staleCap.stateKey), 'gray', 'no_loc shares the gray/offline legend counter & toggle');

  // Busy captain with >10m old location still preserves active order stage color
  const busyStaleCap = getCaptainVisualState({ id: 3, online: true, busy: true, last_loc_at: now - CAPTAIN_NO_LOCATION_MS - 5_000 }, [{ id: 10, captain_id: 3, status: 'picked_up' }], now);
  assert.equal(busyStaleCap.stateKey, 'green');
  assert.equal(captainLegendBucket(busyStaleCap.stateKey), 'green');
});

test('animateMarker cancels prior RAF before starting a new animation', () => {
  const cancelled = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  const origL = globalThis.L;
  let nextId = 100;
  try {
    globalThis.requestAnimationFrame = () => ++nextId;
    globalThis.cancelAnimationFrame = (id) => cancelled.push(id);
    globalThis.L = { latLng: ([lat, lng]) => ({ lat, lng }) };
    const mk = { getLatLng: () => ({ lat: 33.5, lng: 36.26 }), setLatLng() {} };
    animateMarker(mk, [33.51, 36.27]);
    assert.equal(mk._animRafId, 101);
    animateMarker(mk, [33.52, 36.28]);
    assert.deepEqual(cancelled, [101]);
    assert.equal(mk._animRafId, 102);
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
    globalThis.L = origL;
  }
});

test('server POST /api/captain/location: fix_age_ms clock-skew safety, validation, >2s out-of-order guard, 12s/8s server minGap, and legacy payloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-loc-api-'));
  const dbPath = path.join(dir, 'test.db');
  const port = 5500 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}/api`;
  const srv = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, DB_FILE: dbPath, JWT_SECRET: 'loc-test-secret-key-32-chars-minimum!!', ADMIN_PHONE: '0911111199', ADMIN_PASSWORD: 'Admin12345' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const call = async (p, method = 'GET', body = null, token = null) => {
    const h = {};
    if (body != null) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(base + p, { method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const withDb = async (fn) => {
    const c = createClient({ url: pathToFileURL(dbPath).href });
    try { return await fn(c); } finally { c.close(); }
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/zones`); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }

    // Check migration idempotency & schema columns
    await withDb(async (c) => {
      const uCols = (await c.execute('PRAGMA table_info(users)')).rows.map((x) => x.name);
      const lCols = (await c.execute('PRAGMA table_info(locations)')).rows.map((x) => x.name);
      assert.ok(uCols.includes('accuracy') && uCols.includes('fix_at'), 'users has accuracy and fix_at');
      assert.ok(lCols.includes('accuracy') && lCols.includes('fix_at'), 'locations has accuracy and fix_at');
    });

    const adm = (await call('/auth/login', 'POST', { phone: '0911111199', password: 'Admin12345' })).data.token;
    const cap1 = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770001', name: 'كابتن 1', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tok1 = (await call('/auth/login', 'POST', { phone: '0937770001', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tok1);

    // 1. Field validation (accuracy & fix_age_ms)
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, accuracy: -1 }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, accuracy: 'abc' }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, accuracy: 99999 }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, fix_age_ms: -1 }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, fix_age_ms: 300_001 }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, fix_age_ms: 'notnum' }, tok1)).status, 400);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.5, lng: 36.26, fix_age_ms: true }, tok1)).status, 400);

    // 2. Server-derived fix_at using fix_age_ms (and locations.at stays server receive time)
    const tBefore = Date.now();
    assert.equal((await call('/captain/location', 'POST', { lat: 33.501, lng: 36.261, accuracy: 80, fix_age_ms: 10_000, vis: 'visible' }, tok1)).status, 204);
    const tAfter = Date.now();
    await withDb(async (c) => {
      const u = (await c.execute({ sql: 'SELECT last_loc_at, fix_at, accuracy FROM users WHERE id=?', args: [cap1.id] })).rows[0];
      const l = (await c.execute({ sql: 'SELECT at, fix_at, accuracy FROM locations WHERE captain_id=? ORDER BY id DESC LIMIT 1', args: [cap1.id] })).rows[0];
      assert.ok(u.last_loc_at >= tBefore - 10_050 && u.last_loc_at <= tAfter - 9_950, 'last_loc_at derives from serverNow - fix_age_ms');
      assert.equal(u.fix_at, u.last_loc_at);
      assert.equal(u.accuracy, 80);
      assert.equal(l.fix_at, u.fix_at);
      assert.ok(l.at >= tBefore - 50 && l.at <= tAfter + 50, 'locations.at preserves server receive time');
    });

    // Out-of-order delayed fix (>2s older than stored users.last_loc_at) does NOT overwrite
    // First wait 12.1s or use a second captain seeded with newer fix so lastPing doesn't mask out-of-order rejection
    const capOoo = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770007', name: 'كابتن ترتيب', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokOoo = (await call('/auth/login', 'POST', { phone: '0937770007', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokOoo);
    await withDb((c) => c.execute({
      sql: 'UPDATE users SET last_lat=33.501, last_lng=36.261, last_loc_at=?, fix_at=?, accuracy=15 WHERE id=?',
      args: [Date.now() - 5_000, Date.now() - 5_000, capOoo.id],
    }));
    await call('/captain/location', 'POST', { lat: 33.509, lng: 36.269, accuracy: 10, fix_age_ms: 45_000 }, tokOoo);
    const liveOoo = (await call('/admin/live', 'GET', null, adm)).data.captains.find((x) => x.id === capOoo.id);
    assert.equal(liveOoo.lat, 33.501, 'fix >2s older than users.last_loc_at must not overwrite newer fix');

    // Better accuracy (80m -> 10m) even >200 km/h within 5s is accepted immediately without 120s lock
    const capImproved = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770004', name: 'كابتن تحسن', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokImproved = (await call('/auth/login', 'POST', { phone: '0937770004', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokImproved);
    await withDb((c) => c.execute({
      sql: 'UPDATE users SET last_lat=33.41, last_lng=36.26, last_loc_at=?, fix_at=?, accuracy=80 WHERE id=?',
      args: [Date.now() - 5_000, Date.now() - 5_000, capImproved.id],
    }));
    assert.equal((await call('/captain/location', 'POST', { lat: 33.50, lng: 36.26, accuracy: 10, fix_age_ms: 500 }, tokImproved)).status, 204);
    await withDb(async (c) => {
      const r = (await c.execute({ sql: 'SELECT last_lat, accuracy FROM users WHERE id=?', args: [capImproved.id] })).rows[0];
      assert.equal(r.last_lat, 33.50, 'strictly better accuracy jump must not be dropped');
      assert.equal(r.accuracy, 10);
    });

    // Double-confirmation anti-teleport: even when both <=100m (15m -> 20m), 1st spike is dropped but 2nd confirming ping near new spot unlocks immediately
    const capConfirm = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770005', name: 'كابتن تأكيد', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokConfirm = (await call('/auth/login', 'POST', { phone: '0937770005', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokConfirm);
    await withDb((c) => c.execute({
      sql: 'UPDATE users SET last_lat=33.41, last_lng=36.26, last_loc_at=?, fix_at=?, accuracy=15 WHERE id=?',
      args: [Date.now() - 5_000, Date.now() - 5_000, capConfirm.id],
    }));
    await call('/captain/location', 'POST', { lat: 33.50, lng: 36.26, accuracy: 20, fix_age_ms: 1_000 }, tokConfirm);
    let rConf = await withDb(async (c) => (await c.execute({ sql: 'SELECT last_lat FROM users WHERE id=?', args: [capConfirm.id] })).rows[0]);
    assert.equal(rConf.last_lat, 33.41, '1st unconfirmed spike dropped');
    await call('/captain/location', 'POST', { lat: 33.5002, lng: 36.2602, accuracy: 20, fix_age_ms: 0 }, tokConfirm);
    rConf = await withDb(async (c) => (await c.execute({ sql: 'SELECT last_lat FROM users WHERE id=?', args: [capConfirm.id] })).rows[0]);
    assert.equal(rConf.last_lat, 33.5002, '2nd confirming fix breaks free immediately without 120s lock');

    // 3. Old-client payload without accuracy/fix_age_ms AND payload with bogus client fix_at (+90s or -10min) do not 400 and store server time
    const cap2 = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770002', name: 'كابتن إرث', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tok2 = (await call('/auth/login', 'POST', { phone: '0937770002', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tok2);

    const tLegacyBefore = Date.now();
    assert.equal((await call('/captain/location', 'POST', { lat: 33.511, lng: 36.271, vis: 'visible' }, tok2)).status, 204);
    const liveRes = (await call('/admin/live', 'GET', null, adm)).data;
    const legacyCap = liveRes.captains.find((x) => x.id === cap2.id);
    assert.equal(legacyCap.lat, 33.511);
    assert.equal(legacyCap.accuracy, null);
    assert.ok(legacyCap.last_loc_at >= tLegacyBefore - 50);

    // Client sending bogus future fix_at (+90s) or old fix_at (-10min) is ignored (no 400) and stored within ~5s of server time
    const capSkew = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770008', name: 'كابتن ساعة خاطئة', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokSkew = (await call('/auth/login', 'POST', { phone: '0937770008', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokSkew);

    // End-to-end client helper + skewed clock (+90s ahead -> fix_age_ms ~2s)
    const skewedPos = normalizeGpsReading({ coords: { latitude: 33.512, longitude: 36.272, accuracy: 14 }, timestamp: Date.now() - 90_000 }, Date.now());
    const skewedDecision = evaluateCaptainLocationSend({ pos: skewedPos, st: { online: true, active: null, intervals: { active: 10_000, idle: 60_000 } }, now: skewedPos.receivedAt + 2_000 });
    assert.equal(skewedDecision.action, 'send');
    const srvNowBeforeSkew = Date.now();
    const resSkew = await call('/captain/location', 'POST', { ...skewedDecision.payload, fix_at: Date.now() + 90_000, vis: 'visible' }, tokSkew);
    assert.equal(resSkew.status, 204);
    const liveSkew = (await call('/admin/live', 'GET', null, adm)).data.captains.find((x) => x.id === capSkew.id);
    assert.ok(Math.abs(liveSkew.last_loc_at - srvNowBeforeSkew) <= 5_000, 'stored fix time stays within ~5s of server time regardless of phone clock');
    assert.equal(liveSkew.accuracy, 14);

    // 4. Server minGap rate cap: idle moved (>=50m) requires 12s (0.8 * 15s), whereas active requires 8s (0.8 * 10s)
    const capRate = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770009', name: 'كابتن معدل', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokRate = (await call('/auth/login', 'POST', { phone: '0937770009', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokRate);
    assert.equal((await call('/captain/location', 'POST', { lat: 33.500, lng: 36.260, accuracy: 12, fix_age_ms: 0 }, tokRate)).status, 204);

    // Prepare an active-order captain to verify 8s active minGap concurrently during the same window
    const merchRate = (await call('/admin/users', 'POST', {
      role: 'merchant', phone: '0927770009', name: 'تاجر معدل', business_name: 'متجر معدل', address: 'دمشق', lat: 33.505, lng: 36.265, password: 'Passw0rd1', zone_id: 1,
    }, adm)).data;
    const tokMerchRate = (await call('/auth/login', 'POST', { phone: '0927770009', password: 'Passw0rd1' })).data.token;
    const capActive = (await call('/admin/users', 'POST', { role: 'captain', phone: '0937770010', name: 'كابتن نشط', password: 'Passw0rd1', zone_id: 1 }, adm)).data;
    const tokActive = (await call('/auth/login', 'POST', { phone: '0937770010', password: 'Passw0rd1' })).data.token;
    await call('/captain/online', 'POST', { online: true }, tokActive);
    const ordRate = (await call('/merchant/orders', 'POST', { customer_address: 'شارع بغداد' }, tokMerchRate)).data;
    await withDb((c) => c.execute({
      sql: "UPDATE orders SET status='accepted', captain_id=?, offered_captain_id=NULL, offer_expires_at=NULL WHERE id=?",
      args: [capActive.id, ordRate.id],
    }));
    assert.equal((await call('/captain/location', 'POST', { lat: 33.505, lng: 36.265, accuracy: 12, fix_age_ms: 0 }, tokActive)).status, 204);

    await new Promise((r) => setTimeout(r, 9_500)); // 9.5s: < 12s idle-moved minGap, >= 8s active minGap
    await call('/captain/location', 'POST', { lat: 33.502, lng: 36.262, accuracy: 12, fix_age_ms: 0 }, tokRate);
    await call('/captain/location', 'POST', { lat: 33.507, lng: 36.267, accuracy: 12, fix_age_ms: 0 }, tokActive);
    let rRate = await withDb(async (c) => (await c.execute({ sql: 'SELECT last_lat FROM users WHERE id=?', args: [capRate.id] })).rows[0]);
    const rAct = await withDb(async (c) => (await c.execute({ sql: 'SELECT last_lat FROM users WHERE id=?', args: [capActive.id] })).rows[0]);
    assert.equal(rRate.last_lat, 33.500, 'idle moved ping at 9.5s must be dropped by 12s server minGap');
    assert.equal(rAct.last_lat, 33.507, 'active order ping at 9.5s must succeed (>8s server minGap)');
    await new Promise((r) => setTimeout(r, 3_000)); // ~12.5s >= 12s idle-moved minGap
    await call('/captain/location', 'POST', { lat: 33.502, lng: 36.262, accuracy: 12, fix_age_ms: 0 }, tokRate);
    rRate = await withDb(async (c) => (await c.execute({ sql: 'SELECT last_lat FROM users WHERE id=?', args: [capRate.id] })).rows[0]);
    assert.equal(rRate.last_lat, 33.502, 'idle moved ping after 12s minGap must succeed');
  } finally {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('shouldSkipWebLocationPost: browsers & old APKs send, native inactive sends, native active skips safely', () => {
  // Web browser (native absent) -> send (skip = false)
  assert.equal(shouldSkipWebLocationPost(undefined), false);
  assert.equal(shouldSkipWebLocationPost(null), false);

  // Old APK 1.4.3 (PantherNative exists, no isNativeTrackingActive method) -> send
  assert.equal(shouldSkipWebLocationPost({ syncState() {}, stopSiren() {} }), false);
  assert.equal(shouldSkipWebLocationPost({ isNativeTrackingActive: true }), false);

  // New APK present, native tracking not recently active -> send (fallback)
  assert.equal(shouldSkipWebLocationPost({ isNativeTrackingActive: () => false }), false);

  // Host bridge throws -> fail open and send from web
  assert.equal(
    shouldSkipWebLocationPost({ isNativeTrackingActive: () => { throw new Error('bridge dead'); } }),
    false
  );

  // New APK present and native tracking recently posted -> skip duplicate web POST
  assert.equal(shouldSkipWebLocationPost({ isNativeTrackingActive: () => true }), true);
});

test('Android APK 1.4.4 manifest, build.gradle, and cache-bust v31 match background tracking requirements', () => {
  const manifest = fs.readFileSync(new URL('../android-captain/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const gradle = fs.readFileSync(new URL('../android-captain/app/build.gradle', import.meta.url), 'utf8');
  const captainHtml = fs.readFileSync(new URL('../public/captain.html', import.meta.url), 'utf8');
  const captainJs = fs.readFileSync(new URL('../public/captain.js', import.meta.url), 'utf8');

  assert.match(manifest, /android:versionCode="10"/);
  assert.match(manifest, /android:versionName="1\.4\.4"/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_LOCATION/);
  assert.match(manifest, /android:foregroundServiceType="dataSync\|location"/);
  assert.doesNotMatch(manifest, /ACCESS_BACKGROUND_LOCATION/);

  assert.match(gradle, /versionCode 10/);
  assert.match(gradle, /versionName "1\.4\.4"/);

  assert.ok(captainHtml.includes('captain.js?v=panther2026v33'));
  assert.ok(captainJs.includes('./shared.js?v=panther2026v33'));
});

test('CaptainService.java corrective pass: 90s native window, seq == sendSeq guard, FGS stopSelf fallback, and permission-revoked downgrade', () => {
  const svc = fs.readFileSync(
    new URL('../android-captain/app/src/main/java/sy/panther/captain/CaptainService.java', import.meta.url),
    'utf8'
  );

  // 1. NATIVE_ACTIVE_WINDOW_MS updated to 90_000L (idle heartbeat is 60s)
  assert.match(svc, /NATIVE_ACTIVE_WINDOW_MS\s*=\s*90_000L\b/);
  assert.doesNotMatch(svc, /NATIVE_ACTIVE_WINDOW_MS\s*=\s*45_000L\b/);

  // 2. postLocationAttempt 2xx branch guards state updates with locationTrackingActive && seq == sendSeq
  const postMatch = svc.match(/private void postLocationAttempt\([\s\S]*?private void scheduleSingleRetry/);
  assert.ok(postMatch, 'postLocationAttempt must exist');
  const okBranch = postMatch[0].match(/if\s*\(code\s*>=\s*200\s*&&\s*code\s*<\s*300\)\s*\{[\s\S]*?return;\s*\}/);
  assert.ok(okBranch, '2xx success branch must exist in postLocationAttempt');
  assert.match(okBranch[0], /if\s*\(locationTrackingActive\s*&&\s*seq\s*==\s*sendSeq\)/);

  // 3. onStartCommand checks startForegroundCompat return value, retries once dataSync-only, and stops with START_NOT_STICKY on failure
  const onStartMatch = svc.match(/public int onStartCommand\([\s\S]*?private boolean hasValidOnlinePrefs/);
  assert.ok(onStartMatch, 'onStartCommand must exist');
  const stopNotStickyMatches = onStartMatch[0].match(/startForegroundCompat\(buildForegroundNotification\(TEXT_BG_IDLE\),\s*false\)[\s\S]*?stopSelf\(\);\s*return START_NOT_STICKY;/g) || [];
  assert.equal(stopNotStickyMatches.length, 2, 'Both explicit FGS fallback and background/boot/no-permission branch must retry dataSync-only then stopSelf + START_NOT_STICKY');

  // 4. checkCaptainState downgrades foreground service type to dataSync-only when location permission is revoked
  const checkStateMatch = svc.match(/private void checkCaptainState\([\s\S]*?private void checkUnreadMessages/);
  assert.ok(checkStateMatch, 'checkCaptainState must exist');
  assert.match(
    checkStateMatch[0],
    /if\s*\(!hasFineLocationPermission\(\)\)[\s\S]*?stopLocationTracking\(\);[\s\S]*?startForegroundCompat\(buildForegroundNotification\(TEXT_BG_IDLE\),\s*false\)/
  );
});
