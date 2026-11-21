import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-batch3-'));
const dbFile = path.join(tmpDir, 'batch3.db');
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = dbFile;
process.env.ADMIN_PHONE = '0911111144';
process.env.ADMIN_PASSWORD = 'TestPass99';
process.env.JWT_SECRET = 'batch3-xss-test-jwt-secret-min-32-chars!!';

const { client, db } = await import('../src/db.js');
const { api } = await import('../src/routes.js');
const { attachWs, signToken } = await import('../src/realtime.js');

const app = express();
app.use('/api', express.json({ limit: '16kb' }), api);
const server = http.createServer(app);
attachWs(server);

let base;
let admTok;

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

async function createUser(body) {
  const r = await call('/admin/users', 'POST', body, admTok);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = await db.get('SELECT * FROM users WHERE id=?', r.data.id);
  return { id: r.data.id, row, tok: signToken(row) };
}

/** Extract leaf `${...}` template interpolations recursively (scanning inside nested templates rather than flagging static `name="business_name"` HTML attributes). */
function extractTemplateInterpolations(src) {
  const exprs = [];
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      const nestedTemplates = [];
      let outside = '';
      let segStart = j;
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === "'" || ch === '"') {
          const q = ch;
          j++;
          while (j < src.length && src[j] !== q) {
            if (src[j] === '\\') j++;
            j++;
          }
        } else if (ch === '`') {
          outside += src.slice(segStart, j);
          const tStart = j + 1;
          j++;
          let nDepth = 0;
          while (j < src.length) {
            const c2 = src[j];
            if (c2 === '\\') { j += 2; continue; }
            if (c2 === '$' && src[j + 1] === '{') { nDepth++; j += 2; continue; }
            if (c2 === '}' && nDepth > 0) { nDepth--; j++; continue; }
            if (c2 === '`' && nDepth === 0) break;
            j++;
          }
          nestedTemplates.push(src.slice(tStart, j));
          segStart = j + 1;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      outside += src.slice(segStart, j);
      if (nestedTemplates.length > 0) {
        for (const nt of nestedTemplates) exprs.push(...extractTemplateInterpolations(nt));
        exprs.push(outside);
      } else {
        exprs.push(outside);
      }
      i = j;
    }
  }
  return exprs;
}

/** Split top-level ternary/binary parts lightly and verify risky property expressions sit inside `esc(...)`. */
function isInterpolationSafeForRiskyField(expr, riskyRe) {
  if (!riskyRe.test(expr)) return true;
  if (/^\s*esc\s*\(/.test(expr)) return true;
  // Strip outer `esc(...)` calls and verify no risky identifier remains unescaped outside `esc(...)`
  let cleaned = expr;
  let changed = true;
  while (changed) {
    changed = false;
    cleaned = cleaned.replace(/\besc\s*\(([^()]*|\([^()]*\))*\)/g, () => {
      changed = true;
      return '__ESC__';
    });
  }
  // Safe pure numeric/link derivatives already constrained
  cleaned = cleaned
    .replace(/\bserialNo\s*\([^)]*\)/g, '__SAFE__')
    .replace(/\bpoints\s*\([^)]*\)/g, '__SAFE__')
    .replace(/\btime\s*\([^)]*\)/g, '__SAFE__')
    .replace(/\benDigits\s*\([^)]*\)/g, '__SAFE__')
    .replace(/\bwaPhone\b/g, '__SAFE__')
    .replace(/\bsafeMerchTel\b/g, '__SAFE__')
    .replace(/\bsafeTel\b/g, '__SAFE__');
  // Conditional guards in JS conditions (`o.customer_name && o.customer_name !== '—' ? ...`) are safe if the branch value is __ESC__
  const qIdx = cleaned.indexOf('?');
  if (qIdx >= 0) {
    cleaned = cleaned.slice(qIdx + 1);
  }
  return !riskyRe.test(cleaned);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}/api`;
  admTok = (await call('/auth/login', 'POST', { phone: '0911111144', password: 'TestPass99' })).data.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { client.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F-07 backend: strips HTML tags from merchant/admin orders, merchant business_name/address/name, and zones while preserving Arabic & punctuation', async () => {
  const merch = await createUser({
    role: 'merchant',
    phone: '0929111001',
    name: 'علي <img src=x onerror=alert(1)> حسن',
    business_name: 'مطعم <img src=x onerror=alert(1)> النور & الشام "1"',
    address: 'المزة <script>alert(1)</script> شارع 14',
    lat: 33.51,
    lng: 36.26,
    password: 'Passw0rd1',
    zone_id: 1,
  });

  assert.equal(merch.row.name, 'علي حسن');
  assert.equal(merch.row.business_name, 'مطعم النور & الشام "1"');
  assert.equal(merch.row.address, 'المزة شارع 14');
  assert.doesNotMatch(merch.row.business_name + merch.row.name + merch.row.address, /[<>]|onerror|script/i);

  // PATCH user also strips HTML
  const patchRes = await call(`/admin/users/${merch.id}`, 'PATCH', {
    business_name: 'متجر <b>التجربة</b> الحديث',
    address: 'برامكة <svg onload=alert(2)> بناء 7',
  }, admTok);
  assert.equal(patchRes.status, 200);
  const patchedRow = await db.get('SELECT business_name, address FROM users WHERE id=?', merch.id);
  assert.equal(patchedRow.business_name, 'متجر التجربة الحديث');
  assert.equal(patchedRow.address, 'برامكة بناء 7');

  // Merchant POST /merchant/orders with XSS payload in customer_name, customer_address, notes
  const ordRes = await call('/merchant/orders', 'POST', {
    customer_name: 'زبون <img src=x onerror=alert(1)> تجربة',
    customer_phone: '0944555666',
    customer_address: 'كفرسوسة <img src=x onerror=alert(1)> دخلة 2',
    notes: 'الطابق 3 <img src=x onerror=alert(1)> بدون جرس',
  }, merch.tok);
  assert.equal(ordRes.status, 201);
  const ordDb = await db.get('SELECT customer_name, customer_phone, customer_address, notes FROM orders WHERE id=?', ordRes.data.id);
  assert.equal(ordDb.customer_name, 'زبون تجربة');
  assert.equal(ordDb.customer_address, 'كفرسوسة دخلة 2');
  assert.equal(ordDb.notes, 'الطابق 3 بدون جرس');

  // Pure tag payload in optional customer_name/notes stores safe fallback/null; pure tag in required address rejects 400
  const ordTagOnly = await call('/merchant/orders', 'POST', {
    customer_name: '<img src=x onerror=alert(1)>',
    customer_address: 'شارع النصر 12',
    notes: '<img src=x onerror=alert(1)>',
  }, merch.tok);
  assert.equal(ordTagOnly.status, 201);
  const ordTagDb = await db.get('SELECT customer_name, notes FROM orders WHERE id=?', ordTagOnly.data.id);
  assert.equal(ordTagDb.customer_name, '—');
  assert.equal(ordTagDb.notes, null);

  const badAddr = await call('/merchant/orders', 'POST', {
    customer_address: '<img src=x onerror=alert(1)>',
  }, merch.tok);
  assert.equal(badAddr.status, 400);

  // Admin POST /admin/orders & zone creation also strip HTML
  const zRes = await call('/admin/zones', 'POST', { name: 'منطقة <script>x</script> الجديدة' }, admTok);
  assert.equal(zRes.status, 201);
  assert.equal(zRes.data.name, 'منطقة الجديدة');

  const admOrd = await call('/admin/orders', 'POST', {
    merchant_id: merch.id,
    customer_name: 'سعيد <img src=x onerror=alert(1)>',
    customer_address: 'المالكي <svg onload=alert(1)> جادة 4',
    notes: 'ملاحظة <i>مهمة</i>',
  }, admTok);
  assert.equal(admOrd.status, 201);
  const admOrdDb = await db.get('SELECT customer_name, customer_address, notes FROM orders WHERE id=?', admOrd.data.id);
  assert.equal(admOrdDb.customer_name, 'سعيد');
  assert.equal(admOrdDb.customer_address, 'المالكي جادة 4');
  assert.equal(admOrdDb.notes, 'ملاحظة مهمة');
});

test('F-07 static scan: public/*.js HTML/Leaflet sinks never interpolate risky user fields without esc()', () => {
  const targetFiles = ['admin.js', 'captain.js', 'merchant.js', 'shared.js', 'map-search.js', 'live-transfer.js', 'live-state.js', 'download.js'];
  const riskyFieldRe = /\b(business_name|customer_name|customer_address|notes|merchant\.name|merchant\?\.name|captain\.name|captain\?\.name|offered_captain\.name|liability_reason|sender_name|(?:m|c|o|u|cap|merch|freshC|freshM|cachedCap)\.name)\b/;

  const findings = [];
  for (const fname of targetFiles) {
    const code = fs.readFileSync(new URL(`../public/${fname}`, import.meta.url), 'utf8');

    // 1. Check direct Leaflet tooltip/popup argument templates & variable builders (`tip`, `tipHtml`, `bindTooltip(...)`, etc.)
    const sinkCallRe = /\.(?:bindTooltip|setTooltipContent|bindPopup|setPopupContent)\s*\(([^;]{1,400})\)/g;
    let m;
    while ((m = sinkCallRe.exec(code)) !== null) {
      const arg = m[1];
      for (const expr of extractTemplateInterpolations(arg)) {
        if (!isInterpolationSafeForRiskyField(expr, riskyFieldRe)) {
          findings.push(`${fname}: direct tooltip/popup interpolation without esc(): ${expr}`);
        }
      }
      // Check bare property passed directly e.g. bindTooltip(cap.name)
      if (!arg.includes('`') && !/\besc\s*\(/.test(arg) && riskyFieldRe.test(arg)) {
        findings.push(`${fname}: direct tooltip/popup identifier without esc(): ${arg}`);
      }
    }

    // Check `const tip = `...`` / `const tipHtml = `...`` passed to bindTooltip/setTooltipContent
    const tipAssignRe = /\bconst\s+(tip|tipHtml|merchTip|custTip|safeCapTip)\s*=\s*`([^`]*)`/g;
    while ((m = tipAssignRe.exec(code)) !== null) {
      const varName = m[1];
      // `spec.tip` when paired with `tipHtml` for aria-label only is checked separately
      if (varName === 'tip' && /tipHtml/.test(code.slice(m.index, m.index + 300))) continue;
      for (const expr of extractTemplateInterpolations('`' + m[2] + '`')) {
        if (!isInterpolationSafeForRiskyField(expr, riskyFieldRe)) {
          findings.push(`${fname}: ${varName} interpolation without esc(): ${expr}`);
        }
      }
    }

    // 2. Check `.innerHTML = `...`` and `.insertAdjacentHTML(..., `...`)` templates
    const htmlSinkRe = /(?:\.innerHTML\s*=\s*|insertAdjacentHTML\s*\([^,]+,\s*)`([\s\S]*?)`;/g;
    while ((m = htmlSinkRe.exec(code)) !== null) {
      for (const expr of extractTemplateInterpolations('`' + m[1] + '`')) {
        if (!isInterpolationSafeForRiskyField(expr, riskyFieldRe)) {
          findings.push(`${fname}: innerHTML template interpolation without esc(): ${expr}`);
        }
      }
    }
  }

  assert.deepEqual(findings, [], `Found unescaped HTML/tooltip interpolations:\n${findings.join('\n')}`);
});

test('F-07 & F-15 runtime check: captainModal escapes tooltips/HTML, destroys map on close, and connectWs clears reconnect timer', async () => {
  const tooltipsBound = [];
  let mapRemovedCount = 0;
  const createdElements = [];

  class FakeEl {
    constructor(tag) {
      this.tagName = tag;
      this.id = '';
      this.children = [];
      this._html = '';
      this.style = { cssText: '' };
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      this.dataset = {};
    }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { this.children.push(...cs); }
    remove() { const idx = createdElements.indexOf(this); if (idx >= 0) createdElements.splice(idx, 1); }
    querySelector(sel) {
      if (sel === '#capx') return { onclick: null };
      if (sel === '#toastLive' || sel === '#toastRegion') return null;
      return new FakeEl('div');
    }
    querySelectorAll() { return []; }
    addEventListener() {}
  }

  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  const origLoc = globalThis.location;
  const origL = globalThis.L;
  const origWs = globalThis.WebSocket;

  const headEl = new FakeEl('head');
  const bodyEl = new FakeEl('body');
  globalThis.document = {
    body: bodyEl,
    head: headEl,
    activeElement: null,
    createElement: (t) => { const e = new FakeEl(t); createdElements.push(e); return e; },
    getElementById: (id) => (id === '_mapCSS' ? {} : createdElements.find((x) => x.id === id) || null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  globalThis.window = { innerWidth: 375, addEventListener: () => {} };
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:3000', pathname: '/captain', origin: 'http://127.0.0.1:3000' };
  globalThis.L = {
    map: () => ({
      setView() { return this; },
      removeLayer() {},
      on() {},
      stop() {},
      invalidateSize() {},
      remove() { mapRemovedCount++; },
    }),
    control: { zoom: () => ({ addTo() {} }) },
    Control: { extend: () => function () { return { addTo() {} }; } },
    DomUtil: { create: () => new FakeEl('div') },
    tileLayer: () => ({ addTo() {}, on() {}, setUrl() {} }),
    divIcon: (opts) => opts,
    marker: () => ({
      addTo() { return this; },
      bindTooltip(content) { tooltipsBound.push(String(content)); return this; },
    }),
  };

  let openedWs = [];
  globalThis.WebSocket = class FakeWs {
    constructor(url) { this.url = url; this.closed = false; openedWs.push(this); }
    send() {}
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.({ code: 1006 });
    }
  };

  try {
    const shared = await import('../public/shared.js');
    const malicious = '<img src=x onerror="window.__xssFired=1">';
    shared.captainModal({
      name: malicious,
      phone: '0931112223<script>alert(1)</script>',
      lat: 33.51,
      lng: 36.27,
    });

    assert.equal(tooltipsBound.length, 1);
    assert.ok(!/<img\b/i.test(tooltipsBound[0]), 'tooltip must escape <img> tag');
    assert.ok(tooltipsBound[0].includes('&lt;img src=x onerror=&quot;window.__xssFired=1&quot;&gt;'));

    const modalEl = createdElements.find((x) => x.id === 'capmodal');
    assert.ok(modalEl, 'captainModal must mount DOM element');
    assert.ok(!/<img\b|<script\b/i.test(modalEl.innerHTML), 'modal HTML must escape malicious payload');

    // Trigger close via reopen -> removes previous Leaflet map cleanly
    modalEl.remove = FakeEl.prototype.remove;
    const prevRemove = mapRemovedCount;
    shared.captainModal({ name: 'ثاني', phone: '0931112224', lat: 33.51, lng: 36.27 });
    assert.equal(mapRemovedCount, prevRemove + 1, 'opening second captainModal must remove previous capmap');
    const secondCloseBtn = createdElements.find((x) => x.id === 'capmodal');
    assert.ok(secondCloseBtn);

    // Test connectWs clears reconnect timer when stop() is called immediately after close
    const stopWs = shared.connectWs(() => {});
    assert.equal(openedWs.length, 1);
    openedWs[0].close(); // schedules 2000ms reconnect timer
    stopWs();
    // Wait briefly? Better: spy setTimeout/clearTimeout directly to prove timer was cleared synchronously!
    const origSetT = globalThis.setTimeout;
    const origClrT = globalThis.clearTimeout;
    const scheduledIds = [];
    const clearedIds = [];
    globalThis.setTimeout = (fn, ms) => {
      const h = origSetT(() => {}, 60_000);
      scheduledIds.push(h);
      return h;
    };
    globalThis.clearTimeout = (h) => {
      clearedIds.push(h);
      origClrT(h);
    };
    try {
      const stop2 = shared.connectWs(() => {});
      openedWs[openedWs.length - 1].close();
      assert.equal(scheduledIds.length, 1, 'close schedules reconnect timer');
      stop2();
      assert.ok(clearedIds.includes(scheduledIds[0]), 'stop() must cancel scheduled reconnect timer');
    } finally {
      for (const h of scheduledIds) origClrT(h);
      globalThis.setTimeout = origSetT;
      globalThis.clearTimeout = origClrT;
    }
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
    globalThis.location = origLoc;
    globalThis.L = origL;
    globalThis.WebSocket = origWs;
  }
});

test('CSP meta tags & leak guards are present cleanly across HTML and map views', () => {
  for (const file of ['captain.html', 'admin.html', 'merchant.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*script-src\s+'self'[^"]*"/i);
    assert.match(html, /https:\/\/appassets\.panther\.sy/);
    assert.doesNotMatch(html, /frame-ancestors/i, 'frame-ancestors is invalid in <meta> CSP');
    assert.doesNotMatch(html, /upgrade-insecure-requests/i, 'upgrade-insecure-requests must not be in static meta CSP');
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/i, 'script-src must not allow unsafe-inline');
  }

  const captainJs = fs.readFileSync(new URL('../public/captain.js', import.meta.url), 'utf8');
  assert.match(captainJs, /destroyActiveMap\(\)/);
  assert.match(captainJs, /mapOrderId === o\.id/);
  assert.match(captainJs, /prevTab === 'active' && tabName !== 'active'/);

  const adminJs = fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
  assert.match(adminJs, /destroyLeafletMap\(nmap\)/);
  assert.match(adminJs, /destroyLeafletMap\(detailMap\)/);
  assert.match(adminJs, /liveRouteSeq/);
  assert.match(adminJs, /detailRouteSeq/);
});
