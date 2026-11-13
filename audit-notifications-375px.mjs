import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const repoDir = process.cwd();
const require = createRequire(path.join(repoDir, 'package.json'));
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-notif-375-'));
const dbPath = path.join(tmpDir, 'notif-audit.db');
const chromeProfile = path.join(tmpDir, 'chrome-prof');
const port = 5500 + Math.floor(Math.random() * 200);
const cdpPort = 9900 + Math.floor(Math.random() * 80);
const apiBase = `http://127.0.0.1:${port}/api`;
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let srv = null;
let chrome = null;
let cdpWs = null;

async function call(p, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitForHttp(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function makeCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const errors = [];
    let allowExpected400 = false;
    ws.on('open', () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej, method });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({
        ws,
        send,
        errors,
        setAllowExpected400(v) { allowExpected400 = Boolean(v); },
      });
    });
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const ex = msg.params?.exceptionDetails;
        errors.push(`RuntimeException: ${ex?.text || ''} ${ex?.exception?.description || ''}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (args.includes('favicon')) return;
        if (allowExpected400 && args.includes('status of 400')) return;
        errors.push(`ConsoleError: ${args}`);
      } else if (msg.method === 'Network.responseReceived') {
        const r = msg.params?.response;
        if (r && r.status >= 400 && r.url.includes(`127.0.0.1:${port}`) && !r.url.includes('favicon')) {
          if (allowExpected400 && r.status === 400 && r.url.endsWith('/api/admin/notifications')) return;
          errors.push(`HTTP ${r.status}: ${r.url}`);
        }
      }
    });
    ws.on('error', reject);
  });
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Eval error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

async function waitForFn(cdp, expr, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await evalJs(cdp, `Boolean(${expr})`);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const diag = await evalJs(cdp, `({ url: location.href, text: document.body?.innerText?.slice(0, 300) })`).catch(() => ({}));
  throw new Error(`Timeout waiting for: ${expr}; diag=${JSON.stringify(diag)}; errors=${JSON.stringify(cdp.errors)}`);
}

async function measureControls(cdp, viewName, selectorRoot = 'document') {
  return evalJs(cdp, `(() => {
    const docEl = document.documentElement;
    const vw = docEl.clientWidth;
    const sw = docEl.scrollWidth;
    const bodySw = document.body.scrollWidth;
    const root = ${selectorRoot};
    const interactive = [...root.querySelectorAll('a, button, input, select, textarea, summary, [role="button"], [data-tab], [data-t]')];
    const violations = [];
    for (const el of interactive) {
      if (el.closest('.leaflet-control-attribution') || el.closest('.leaflet-control-zoom') || el.closest('.hide')) continue;
      if (root === document && el.closest('dialog:not([open])')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 47.5 || r.height < 47.5) {
        violations.push({
          id: el.id || '',
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 28),
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
        });
      }
    }
    return { view: ${JSON.stringify(viewName)}, vw, sw, bodySw, overflowPx: Math.max(0, sw - vw, bodySw - vw), violations };
  })()`);
}

function rectsOverlap(a, b) {
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

const report = { viewport: '375x812', checks: {} };

try {
  srv = spawn('node', ['src/server.js'], {
    cwd: repoDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbPath,
      JWT_SECRET: 'panther-notif-audit-secret-32-chars-min!!',
      ADMIN_PHONE: '0911111111',
      ADMIN_PASSWORD: 'Admin12345',
      OFFER_TIMEOUT_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(`${apiBase}/zones`);

  const admTok = (await call('/auth/login', 'POST', { phone: '0911111111', password: 'Admin12345' })).data.token;
  assert.ok(admTok, 'admin token missing');

  const zaReg = await call('/admin/users', 'POST', {
    role: 'zone_admin', phone: '0919300001', name: 'مدير منطقة المزة', password: 'Passw0rdX', zone_id: 1,
  }, admTok);
  assert.equal(zaReg.status, 201);
  const zaTok = (await call('/auth/login', 'POST', { phone: '0919300001', password: 'Passw0rdX' })).data.token;

  const merchReg = await call('/admin/users', 'POST', {
    role: 'merchant', phone: '0929300001', name: 'أبو طارق', business_name: 'مطعم الشام', password: 'Passw0rdX', zone_id: 1, address: 'المزة جبل', lat: 33.512, lng: 36.262,
  }, admTok);
  assert.equal(merchReg.status, 201);
  const merchTok = (await call('/auth/login', 'POST', { phone: '0929300001', password: 'Passw0rdX' })).data.token;

  const capReg = await call('/admin/users', 'POST', {
    role: 'captain', phone: '0939300001', name: 'كابتن سامر', password: 'Passw0rdX', zone_id: 1,
  }, admTok);
  assert.equal(capReg.status, 201);
  await call(`/admin/captains/${capReg.data.id}/topup`, 'POST', { points: 100, note: 'رصيد بداية' }, admTok);
  const capTok = (await call('/auth/login', 'POST', { phone: '0939300001', password: 'Passw0rdX' })).data.token;

  await call('/captain/online', 'POST', { online: true }, capTok);
  await call('/captain/location', 'POST', { lat: 33.512, lng: 36.262, vis: 'visible' }, capTok);

  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await makeCdp(pageTarget.webSocketDebuggerUrl);
  cdpWs = cdp.ws;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
  });

  // =========================================================================
  // 1. ADMIN @ 375px: Bell, Inbox Dialog, "الرسائل" Send Form, Inline Errors, Sent List
  // =========================================================================
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/admin.html` });
  await waitForFn(cdp, "document.readyState === 'complete'");
  await evalJs(cdp, `localStorage.setItem('panther_token_admin', ${JSON.stringify(admTok)})`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/admin.html` });
  await waitForFn(cdp, "document.querySelector('#notifBellBtn') && document.querySelector('.admin-bottom-dock [data-t=\"messages\"]')");
  await new Promise((r) => setTimeout(r, 250));

  const adminHeaderCheck = await evalJs(cdp, `(() => {
    const bell = document.querySelector('#notifBellBtn').getBoundingClientRect();
    const snd = document.querySelector('#adminSndBtn').getBoundingClientRect();
    const add = document.querySelector('#adminAddOrderTop').getBoundingClientRect();
    const brand = document.querySelector('.topbar-brand').getBoundingClientRect();
    return {
      bell: { w: Math.round(bell.width), h: Math.round(bell.height), left: Math.round(bell.left), right: Math.round(bell.right), top: Math.round(bell.top), bottom: Math.round(bell.bottom) },
      snd: { left: Math.round(snd.left), right: Math.round(snd.right), top: Math.round(snd.top), bottom: Math.round(snd.bottom) },
      add: { left: Math.round(add.left), right: Math.round(add.right), top: Math.round(add.top), bottom: Math.round(add.bottom) },
      brand: { left: Math.round(brand.left), right: Math.round(brand.right), top: Math.round(brand.top), bottom: Math.round(brand.bottom) },
    };
  })()`);
  assert.ok(adminHeaderCheck.bell.w >= 48 && adminHeaderCheck.bell.h >= 48, 'Admin bell >= 48px');
  assert.equal(rectsOverlap(adminHeaderCheck.bell, adminHeaderCheck.snd), false, 'Bell must not overlap Sound btn');
  assert.equal(rectsOverlap(adminHeaderCheck.bell, adminHeaderCheck.add), false, 'Bell must not overlap Add Order btn');
  assert.equal(rectsOverlap(adminHeaderCheck.bell, adminHeaderCheck.brand), false, 'Bell must not overlap Brand');

  // Switch to "الرسائل" tab
  await evalJs(cdp, "document.querySelector('.admin-bottom-dock [data-t=\"messages\"]').click()");
  await waitForFn(cdp, "document.querySelector('#adminMsgForm') && document.querySelector('#adminSentList')");
  await new Promise((r) => setTimeout(r, 200));

  const adminMessagesLayout = await measureControls(cdp, 'admin-messages');
  assert.equal(adminMessagesLayout.overflowPx, 0, 'Admin messages view must have 0px overflow at 375px');
  assert.equal(adminMessagesLayout.violations.length, 0, `Admin messages touch target violations: ${JSON.stringify(adminMessagesLayout.violations)}`);

  // Verify every input/select/textarea in #adminMsgForm has a matching <label for>
  const formCheck = await evalJs(cdp, `(() => {
    const controls = [...document.querySelectorAll('#adminMsgForm input, #adminMsgForm select, #adminMsgForm textarea')];
    const missingLabels = controls.filter((c) => !c.id || !document.querySelector('#adminMsgForm label[for="' + c.id + '"]')).map((c) => c.id || c.name);
    const targetTypes = [...document.querySelectorAll('#msgTargetType option')].map((o) => o.value);
    const roleOpts = [...document.querySelectorAll('#msgTargetRole option')].map((o) => o.value);
    return {
      missingLabels,
      targetTypes,
      roleOpts,
      titleCounterInit: document.querySelector('#msgTitleCount').textContent.trim(),
      bodyCounterInit: document.querySelector('#msgBodyCount').textContent.trim(),
    };
  })()`);
  assert.deepEqual(formCheck.missingLabels, [], 'Every form control must have <label for>');
  assert.deepEqual(formCheck.targetTypes, ['all', 'zone', 'role', 'user']);
  assert.ok(formCheck.roleOpts.includes('captain') && formCheck.roleOpts.includes('merchant') && formCheck.roleOpts.includes('zone_admin'));
  assert.equal(formCheck.titleCounterInit, '0 / 80');
  assert.equal(formCheck.bodyCounterInit, '0 / 500');

  // Live character counter check + inline error preservation check (submit HTML-only title so server rejects 400)
  cdp.setAllowExpected400(true);
  await evalJs(cdp, `(() => {
    const t = document.querySelector('#msgTitle');
    const b = document.querySelector('#msgBody');
    t.value = '<b></b>';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = 'تفاصيل رسالة اختبار';
    b.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const countersMid = await evalJs(cdp, `({
    titleCount: document.querySelector('#msgTitleCount').textContent.trim(),
    bodyCount: document.querySelector('#msgBodyCount').textContent.trim(),
  })`);
  assert.equal(countersMid.titleCount, '7 / 80');
  assert.equal(countersMid.bodyCount, `${'تفاصيل رسالة اختبار'.length} / 500`);

  await evalJs(cdp, "document.querySelector('#msgSubmitBtn').click()");
  await waitForFn(cdp, "!document.querySelector('#msgFormError').classList.contains('hide')");
  cdp.setAllowExpected400(false);
  const afterError = await evalJs(cdp, `({
    errTxt: document.querySelector('#msgFormError').textContent.trim(),
    titleVal: document.querySelector('#msgTitle').value,
    bodyVal: document.querySelector('#msgBody').value,
  })`);
  assert.ok(afterError.errTxt.length > 0, 'Inline server error must appear');
  assert.equal(afterError.titleVal, '<b></b>', 'Form title must NOT clear on server error');
  assert.equal(afterError.bodyVal, 'تفاصيل رسالة اختبار', 'Form body must NOT clear on server error');

  // Send two real notifications as super admin:
  // (1) to role = captain ("إشعار أول للكباتن")
  // (2) to all ("تعميم عام للجميع")
  await evalJs(cdp, `(() => {
    const sel = document.querySelector('#msgTargetType');
    sel.value = 'role';
    sel.dispatchEvent(new Event('change'));
    document.querySelector('#msgTargetRole').value = 'captain';
    const t = document.querySelector('#msgTitle');
    const b = document.querySelector('#msgBody');
    t.value = 'توجيه ميداني هام';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = 'يرجى الالتزام بالسرعة النظامية عند التقاطعات.';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#msgSubmitBtn').click();
  })()`);
  await waitForFn(cdp, "document.querySelector('#adminSentList').textContent.includes('توجيه ميداني هام')");

  await evalJs(cdp, `(() => {
    const sel = document.querySelector('#msgTargetType');
    sel.value = 'all';
    sel.dispatchEvent(new Event('change'));
    const t = document.querySelector('#msgTitle');
    const b = document.querySelector('#msgBody');
    t.value = 'تعميم عام للجميع';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = 'ساعات العمل اليوم مستمرة حتى منتصف الليل.';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#msgSubmitBtn').click();
  })()`);
  await waitForFn(cdp, "document.querySelector('#adminSentList').textContent.includes('تعميم عام للجميع')");
  const sentCheck = await evalJs(cdp, `(() => {
    const items = [...document.querySelectorAll('#adminSentList .msg-sent-item')];
    return {
      count: items.length,
      firstText: items[0]?.textContent || '',
      hasReadCount: (items[0]?.textContent || '').includes('قُرئت: 0'),
      hasTime: Boolean(items[0]?.querySelector('time')?.textContent?.trim()),
    };
  })()`);
  assert.ok(sentCheck.count >= 2 && sentCheck.hasReadCount && sentCheck.hasTime, 'Sent list must show title, target, time, and read count');

  // Admin opens own bell inbox dialog & closes via visible button
  await evalJs(cdp, "document.querySelector('#notifBellBtn').click()");
  await waitForFn(cdp, "document.querySelector('#notifInboxDialog')?.open");
  const adminDlgCheck = await measureControls(cdp, 'admin-inbox-dialog', "document.querySelector('#notifInboxDialog')");
  assert.equal(adminDlgCheck.overflowPx, 0);
  assert.equal(adminDlgCheck.violations.length, 0);
  await evalJs(cdp, "document.querySelector('#notifInboxClose').click()");
  await waitForFn(cdp, "!document.querySelector('#notifInboxDialog')?.open");
  report.checks.admin = { layout: adminMessagesLayout, sentCount: sentCheck.count };

  // =========================================================================
  // 2. ZONE ADMIN @ 375px: Restricted Target Options + Send to Zone Captain
  // =========================================================================
  await evalJs(cdp, `localStorage.setItem('panther_token_admin', ${JSON.stringify(zaTok)})`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/admin.html` });
  await waitForFn(cdp, "document.querySelector('.admin-bottom-dock [data-t=\"messages\"]')");
  await evalJs(cdp, "document.querySelector('.admin-bottom-dock [data-t=\"messages\"]').click()");
  await waitForFn(cdp, "document.querySelector('#adminMsgForm')");
  await new Promise((r) => setTimeout(r, 200));

  const zaFormCheck = await evalJs(cdp, `(() => {
    const targetTypes = [...document.querySelectorAll('#msgTargetType option')].map((o) => o.value);
    const roleOpts = [...document.querySelectorAll('#msgTargetRole option')].map((o) => o.value);
    const hasZoneSelect = Boolean(document.querySelector('#msgTargetZone'));
    return { targetTypes, roleOpts, hasZoneSelect };
  })()`);
  assert.deepEqual(zaFormCheck.targetTypes, ['role', 'user'], 'zone_admin must NOT see all or zone options');
  assert.deepEqual(zaFormCheck.roleOpts, ['captain', 'merchant'], 'zone_admin must NOT see admin or zone_admin role options');
  assert.equal(zaFormCheck.hasZoneSelect, false, 'zone_admin must NOT have a zone selector rendered');
  const zaLayout = await measureControls(cdp, 'zone-admin-messages');
  assert.equal(zaLayout.overflowPx, 0);
  assert.equal(zaLayout.violations.length, 0);

  // Send one notification from zone_admin to captain
  await evalJs(cdp, `(() => {
    document.querySelector('#msgTargetRole').value = 'captain';
    const t = document.querySelector('#msgTitle');
    const b = document.querySelector('#msgBody');
    t.value = 'تنبيه مدير المزة';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = 'زيادة الطلبات حالياً في حي المزة.';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#msgSubmitBtn').click();
  })()`);
  await waitForFn(cdp, "document.querySelector('#adminSentList').textContent.includes('تنبيه مدير المزة')");
  report.checks.zoneAdmin = { targetTypes: zaFormCheck.targetTypes, roleOpts: zaFormCheck.roleOpts, overflowPx: zaLayout.overflowPx };

  // =========================================================================
  // 3. CAPTAIN @ 375px: Bell, Unread Badge, Dialog Inbox, Read Action, Live WS, Offer Priority
  // =========================================================================
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/captain.html` });
  await waitForFn(cdp, "document.readyState === 'complete'");
  await evalJs(cdp, `localStorage.setItem('panther_token_captain', ${JSON.stringify(capTok)})`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/captain.html` });
  await waitForFn(cdp, "document.querySelector('#notifBellBtn') && Number(document.querySelector('#notifUnreadBadge')?.textContent || 0) >= 3");
  await new Promise((r) => setTimeout(r, 250));

  const capCheck = await evalJs(cdp, `(() => {
    const hdr = document.querySelector('.panther-header').getBoundingClientRect();
    const bell = document.querySelector('#notifBellBtn').getBoundingClientRect();
    const statusBadge = document.querySelector('#hdrStatusBadge').getBoundingClientRect();
    const h1 = document.querySelector('.panther-header h1').getBoundingClientRect();
    return {
      headerHeight: Math.round(hdr.height),
      badgeText: document.querySelector('#notifUnreadBadge').textContent.trim(),
      hasSendForm: Boolean(document.querySelector('#adminMsgForm')),
      bell: { w: Math.round(bell.width), h: Math.round(bell.height), left: Math.round(bell.left), right: Math.round(bell.right), top: Math.round(bell.top), bottom: Math.round(bell.bottom) },
      statusBadge: { left: Math.round(statusBadge.left), right: Math.round(statusBadge.right), top: Math.round(statusBadge.top), bottom: Math.round(statusBadge.bottom) },
      h1: { left: Math.round(h1.left), right: Math.round(h1.right), top: Math.round(h1.top), bottom: Math.round(h1.bottom) },
    };
  })()`);
  assert.equal(capCheck.badgeText, '3');
  assert.equal(capCheck.hasSendForm, false, 'Captain must never see send form');
  assert.ok(capCheck.bell.w >= 48 && capCheck.bell.h >= 48);
  assert.equal(rectsOverlap(capCheck.bell, capCheck.statusBadge), false, 'Captain bell must not overlap status badge');
  assert.equal(rectsOverlap(capCheck.bell, capCheck.h1), false, 'Captain bell must not overlap header brand');
  assert.ok(capCheck.headerHeight <= 76, `Captain header stayed compact single row (got ${capCheck.headerHeight}px)`);

  // Open Inbox dialog via bell
  await evalJs(cdp, "document.querySelector('#notifBellBtn').click()");
  await waitForFn(cdp, "document.querySelector('#notifInboxDialog')?.open && document.querySelectorAll('#notifInboxList .notif-item').length === 3");

  const capDlgLayout = await measureControls(cdp, 'captain-inbox-dialog', "document.querySelector('#notifInboxDialog')");
  assert.equal(capDlgLayout.overflowPx, 0);
  assert.equal(capDlgLayout.violations.length, 0, `Captain dialog touch violations: ${JSON.stringify(capDlgLayout.violations)}`);

  const inboxContentCheck = await evalJs(cdp, `(() => {
    const dlg = document.querySelector('#notifInboxDialog');
    const items = [...dlg.querySelectorAll('#notifInboxList .notif-item')];
    return {
      ariaLabelledBy: dlg.getAttribute('aria-labelledby'),
      hasTitleEl: Boolean(document.getElementById(dlg.getAttribute('aria-labelledby'))),
      titles: items.map((el) => el.querySelector('.notif-item-title')?.textContent?.trim()),
      firstUnreadShape: items[0]?.querySelector('.notif-state-shape')?.textContent?.trim(),
      firstUnreadText: items[0]?.querySelector('.notif-state-text')?.textContent?.trim(),
    };
  })()`);
  assert.equal(inboxContentCheck.hasTitleEl, true, '<dialog> must have valid aria-labelledby');
  assert.equal(inboxContentCheck.titles[0], 'تنبيه مدير المزة', 'Newest notification must be first');
  assert.equal(inboxContentCheck.firstUnreadShape, '●', 'Unread state must use a shape symbol');
  assert.ok(inboxContentCheck.firstUnreadText.includes('جديد'), 'Unread state must use text');

  // Mark newest unread notification as read
  await evalJs(cdp, "document.querySelector('#notifInboxList .notif-item').click()");
  await waitForFn(cdp, "document.querySelector('#notifInboxList .notif-item').classList.contains('is-read') && document.querySelector('#notifUnreadBadge').textContent.trim() === '2'");
  const readPillCheck = await evalJs(cdp, `({
    shape: document.querySelector('#notifInboxList .notif-item .notif-state-shape')?.textContent?.trim(),
    text: document.querySelector('#notifInboxList .notif-item .notif-state-text')?.textContent?.trim(),
    badgeAfterRead: document.querySelector('#notifUnreadBadge').textContent.trim(),
  })`);
  assert.equal(readPillCheck.shape, '✓');
  assert.equal(readPillCheck.text, 'مقروء');
  assert.equal(readPillCheck.badgeAfterRead, '2');

  // Tag an existing DOM item node to prove real-time WS prepends WITHOUT reloading the whole list
  await evalJs(cdp, "document.querySelector('#notifInboxList .notif-item').dataset.keptNode = 'yes'");
  const wsSendRes = await call('/admin/notifications', 'POST', {
    target_type: 'role',
    target_role: 'captain',
    title: 'إشعار فوري لحظي',
    body: 'وصل عبر WebSocket أثناء فتح صندوق الوارد',
  }, admTok);
  assert.equal(wsSendRes.status, 201);

  await waitForFn(cdp, "document.querySelectorAll('#notifInboxList .notif-item').length === 4 && document.querySelector('#notifUnreadBadge').textContent.trim() === '3'");
  const wsPrependCheck = await evalJs(cdp, `(() => {
    const items = [...document.querySelectorAll('#notifInboxList .notif-item')];
    return {
      firstTitle: items[0]?.querySelector('.notif-item-title')?.textContent?.trim(),
      secondKeptNode: items[1]?.dataset?.keptNode === 'yes',
      badge: document.querySelector('#notifUnreadBadge').textContent.trim(),
    };
  })()`);
  assert.equal(wsPrependCheck.firstTitle, 'إشعار فوري لحظي');
  assert.equal(wsPrependCheck.secondKeptNode, true, 'Existing inbox DOM nodes must NOT be reloaded when WS notification prepends');
  assert.equal(wsPrependCheck.badge, '3');

  // Captain Offer Priority test: trigger a live delivery order while Inbox dialog is OPEN
  const ordRes = await call('/merchant/orders', 'POST', { customer_address: 'شارع الثورة بناء 14' }, merchTok);
  assert.equal(ordRes.status, 201);
  await waitForFn(cdp, "!document.querySelector('#notifOfferPrioritySlot').classList.contains('hide') && document.querySelector('#notifOfferAccBtn')");
  await new Promise((r) => setTimeout(r, 150));

  const offerPriorityCheck = await evalJs(cdp, `(() => {
    const slot = document.querySelector('#notifOfferPrioritySlot').getBoundingClientRect();
    const inboxCard = document.querySelector('.notif-inbox-card').getBoundingClientRect();
    const accBtn = document.querySelector('#notifOfferAccBtn').getBoundingClientRect();
    const rejBtn = document.querySelector('#notifOfferRejBtn').getBoundingClientRect();
    return {
      dialogStillOpen: document.querySelector('#notifInboxDialog').open,
      slotVisible: getComputedStyle(document.querySelector('#notifOfferPrioritySlot')).display !== 'none',
      slotBottom: Math.round(slot.bottom),
      inboxTop: Math.round(inboxCard.top),
      offerText: document.querySelector('#notifOfferPrioritySlot').textContent,
      accBtnH: Math.round(accBtn.height),
      rejBtnH: Math.round(rejBtn.height),
    };
  })()`);
  assert.equal(offerPriorityCheck.dialogStillOpen, true);
  assert.equal(offerPriorityCheck.slotVisible, true);
  assert.ok(offerPriorityCheck.slotBottom <= offerPriorityCheck.inboxTop, `Active offer (${offerPriorityCheck.slotBottom}px) must sit above inbox card (${offerPriorityCheck.inboxTop}px)`);
  assert.ok(offerPriorityCheck.offerText.includes('شارع الثورة'), 'Offer details must appear in priority slot');
  assert.ok(offerPriorityCheck.accBtnH >= 48 && offerPriorityCheck.rejBtnH >= 48);

  const offerDlgLayout = await measureControls(cdp, 'captain-inbox-with-offer', "document.querySelector('#notifInboxDialog')");
  assert.equal(offerDlgLayout.overflowPx, 0);
  assert.equal(offerDlgLayout.violations.length, 0);

  // Close dialog with Escape key
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitForFn(cdp, "!document.querySelector('#notifInboxDialog').open");

  report.checks.captain = {
    headerHeight: capCheck.headerHeight,
    badgeInitial: capCheck.badgeText,
    readUpdateOk: true,
    wsPrependWithoutReload: wsPrependCheck.secondKeptNode,
    offerPriorityAboveInbox: offerPriorityCheck.slotBottom <= offerPriorityCheck.inboxTop,
    overflowPx: Math.max(capDlgLayout.overflowPx, offerDlgLayout.overflowPx),
  };

  // =========================================================================
  // 4. MERCHANT @ 375px: Bell, Unread Badge, Inbox Dialog, Close Button, No Send Form
  // =========================================================================
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/merchant.html` });
  await waitForFn(cdp, "document.readyState === 'complete'");
  await evalJs(cdp, `localStorage.setItem('panther_token_merchant', ${JSON.stringify(merchTok)})`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/merchant.html` });
  await waitForFn(cdp, "document.querySelector('#notifBellBtn') && Number(document.querySelector('#notifUnreadBadge')?.textContent || 0) >= 1");
  await new Promise((r) => setTimeout(r, 250));

  const merchHeaderCheck = await evalJs(cdp, `(() => {
    const bell = document.querySelector('#notifBellBtn').getBoundingClientRect();
    const lo = document.querySelector('#lo').getBoundingClientRect();
    const h1 = document.querySelector('.panther-header h1').getBoundingClientRect();
    return {
      badge: document.querySelector('#notifUnreadBadge').textContent.trim(),
      hasSendForm: Boolean(document.querySelector('#adminMsgForm')),
      bell: { w: Math.round(bell.width), h: Math.round(bell.height), left: Math.round(bell.left), right: Math.round(bell.right), top: Math.round(bell.top), bottom: Math.round(bell.bottom) },
      lo: { left: Math.round(lo.left), right: Math.round(lo.right), top: Math.round(lo.top), bottom: Math.round(lo.bottom) },
      h1: { left: Math.round(h1.left), right: Math.round(h1.right), top: Math.round(h1.top), bottom: Math.round(h1.bottom) },
    };
  })()`);
  assert.equal(merchHeaderCheck.badge, '1');
  assert.equal(merchHeaderCheck.hasSendForm, false, 'Merchant must never see send form');
  assert.ok(merchHeaderCheck.bell.w >= 48 && merchHeaderCheck.bell.h >= 48);
  assert.equal(rectsOverlap(merchHeaderCheck.bell, merchHeaderCheck.lo), false);
  assert.equal(rectsOverlap(merchHeaderCheck.bell, merchHeaderCheck.h1), false);

  const merchLayout = await measureControls(cdp, 'merchant-main');
  assert.equal(merchLayout.overflowPx, 0);
  assert.equal(merchLayout.violations.length, 0, `Merchant touch violations: ${JSON.stringify(merchLayout.violations)}`);

  await evalJs(cdp, "document.querySelector('#notifBellBtn').click()");
  await waitForFn(cdp, "document.querySelector('#notifInboxDialog')?.open && document.querySelector('#notifInboxList .notif-item')");
  await evalJs(cdp, "document.querySelector('#notifInboxClose').click()");
  await waitForFn(cdp, "!document.querySelector('#notifInboxDialog').open");

  report.checks.merchant = { badge: merchHeaderCheck.badge, overflowPx: merchLayout.overflowPx };
  report.errors = cdp.errors;
  assert.deepEqual(cdp.errors, [], `Console/network errors encountered: ${JSON.stringify(cdp.errors)}`);

  console.log(JSON.stringify({ ok: true, report }, null, 2));
} finally {
  try { cdpWs?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { srv?.kill(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
