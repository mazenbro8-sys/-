// Shared client helpers (no inline scripts: CSP-safe)
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const enDigits = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0);
export const esc = (v) => enDigits(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const serialNo = (o) => '#' + String(typeof o === 'object' ? (o?.serial_no || o?.id || 0) : (o || 0)).padStart(4, '0');
export const money = (n) => enDigits(new Intl.NumberFormat('en-US').format(n || 0)) + ' ل.س';
export const time = (ms) => (ms ? enDigits(new Date(ms).toLocaleString('ar-SY-u-nu-latn', { hour12: true })) : '—');

// Automatically convert any Arabic/Persian digits typed into inputs/textareas into English digits (0-9)
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.value === 'string') {
    const conv = enDigits(el.value);
    if (conv !== el.value) {
      const pos = el.selectionStart;
      el.value = conv;
      try { if (pos != null) el.setSelectionRange(pos, pos); } catch {}
    }
  }
}, true);

export const STATUS = {
  searching: 'جاري البحث عن كابتن', offered: 'بانتظار قبول كابتن', accepted: 'الكابتن في الطريق للمنشأة',
  picked_up: 'تم الاستلام، في الطريق للزبون', arrived: 'وصل عند الزبون', delivered: 'تم التسليم',
  cancelled: 'ملغي', failed: 'فشل التسليم', expired: 'لا يوجد كابتن متاح',
  pending: 'بانتظار الموافقة', active: 'مفعّل', suspended: 'موقوف',
};
export const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS[s] || s)}</span>`;

export function toast(msg, ms = 3500) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = 'none'), ms);
}

const ROLE_KEY = location.pathname.includes('admin') ? 'admin' : location.pathname.includes('merchant') ? 'merchant' : location.pathname.includes('captain') ? 'captain' : 'app';
let token = sessionStorage.getItem('token') || localStorage.getItem('panther_token_' + ROLE_KEY);
export const getToken = () => token;
export function setToken(t) {
  token = t;
  if (t) {
    sessionStorage.setItem('token', t);
    localStorage.setItem('panther_token_' + ROLE_KEY, t);
  } else {
    sessionStorage.removeItem('token');
    localStorage.removeItem('panther_token_' + ROLE_KEY);
  }
}

// ---------- Server URL Config (for Android APK / Capacitor / Remote Server) ----------
export const isNativeApk = () =>
  Boolean(window.Capacitor?.isNativePlatform?.() || window.PANTHER_APK || location.protocol === 'file:' || (location.hostname === 'localhost' && !location.port));

export function getServerUrl() {
  const saved = (localStorage.getItem('panther_server_url') || '').trim().replace(/\/+$/, '');
  if (saved) return saved;
  if (window.PANTHER_DEFAULT_SERVER) return String(window.PANTHER_DEFAULT_SERVER).trim().replace(/\/+$/, '');
  return '';
}

export function setServerUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem('panther_server_url', clean);
  else localStorage.removeItem('panther_server_url');
}

export function openServerConfigModal(onSaved) {
  document.getElementById('srvCfgModal')?.remove();
  const current = getServerUrl() || (!isNativeApk() ? location.origin : '');
  const modal = document.createElement('div');
  modal.id = 'srvCfgModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);display:grid;place-items:center;padding:14px';
  modal.innerHTML = `<div class="card" style="width:100%;max-width:430px;padding:20px;border:1.5px solid rgba(251,191,36,.45);text-align:right">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h3 style="margin:0;color:var(--gold)">🌐 إعدادات اتصال السيرفر</h3>
      <button type="button" class="ghost sm" id="srvCfgClose">✕</button>
    </div>
    <p class="mut" style="font-size:13px;margin:0 0 12px">أدخل رابط السيرفر (مثل رابط Cloudflare أو الدومين أو IP الشبكة المحلية):</p>
    <input id="srvUrlInput" dir="ltr" type="url" placeholder="https://example.trycloudflare.com" value="${esc(current)}" style="width:100%;margin-bottom:10px;text-align:left">
    <div id="srvTestMsg" class="mut" style="font-size:12.5px;margin-bottom:10px;min-height:18px"></div>
    <div class="row">
      <button type="button" class="sec" id="srvTestBtn">🔌 فحص الاتصال</button>
      <button type="button" class="ok" id="srvSaveBtn">💾 حفظ واعتماد</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('#srvCfgClose', modal).onclick = close;
  const inp = $('#srvUrlInput', modal), msg = $('#srvTestMsg', modal);
  $('#srvTestBtn', modal).onclick = async () => {
    const val = inp.value.trim().replace(/\/+$/, '');
    if (!val) { msg.textContent = '⚠️ يرجى إدخال رابط السيرفر أولاً'; msg.style.color = '#fbbf24'; /* warn */ return; }
    msg.textContent = '⏳ جاري فحص الاتصال بالسيرفر...'; msg.style.color = '#a1a1aa'; /* zinc */
    try {
      const r = await fetch(val + '/api/zones');
      if (r.ok) { msg.textContent = '✅ الاتصال بالسيرفر ناجح ويعمل بشكل ممتاز!'; msg.style.color = '#22c55e'; /* ok */ }
      else { msg.textContent = `❌ السيرفر استجاب برمز خطأ (${r.status})`; msg.style.color = '#ef4444'; /* bad */ }
    } catch {
      msg.textContent = '❌ تعذّر الوصول للسيرفر، تأكد من الرابط أو اتصال الإنترنت'; msg.style.color = '#ef4444'; /* bad */
    }
  };
  $('#srvSaveBtn', modal).onclick = () => {
    const val = inp.value.trim().replace(/\/+$/, '');
    if (!isNativeApk() && val === location.origin) setServerUrl('');
    else setServerUrl(val);
    toast('✅ تم حفظ رابط السيرفر');
    close();
    if (onSaved) onSaved(val);
    else location.reload();
  };
}

// ---------- PWA Service Worker & App Installation ----------
if ('serviceWorker' in navigator && !isNativeApk()) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let deferredPrompt = null;
export const isStandalone = () =>
  isNativeApk() ||
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $$('[data-install-app]').forEach((b) => b.classList.remove('hide'));
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  toast('✅ تم تثبيت تطبيق PANTHER على هاتفك بنجاح!');
  $('#appInstallCard')?.classList.add('hide');
});

export const APP_META = {
  merchant: {
    name: 'PANTHER — تطبيق المنشأة',
    short: 'تطبيق المنشأة',
    icon: '🏪',
    desc: 'اطلب كابتن توصيل بضغطة زر وتابع الكابتن مباشرة على الخريطة',
    url: '/merchant?install=1',
  },
  captain: {
    name: 'PANTHER — تطبيق الكابتن',
    short: 'تطبيق الكابتن',
    icon: '🛵',
    desc: 'استقبل طلبات التوصيل بصوت التنبيه الفوري والملاحة الحية',
    url: '/captain?install=1',
  },
  admin: {
    name: 'PANTHER — تطبيق الإدارة',
    short: 'تطبيق الإدارة',
    icon: '⚙️',
    desc: 'لوحة التحكم وغرفة العمليات وتوجيه الكباتن والتنبيهات المباشرة',
    url: '/admin?install=1',
  },
};

export async function promptInstallApp(role = ROLE_KEY) {
  const meta = APP_META[role] || APP_META.merchant;
  if (deferredPrompt) {
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        deferredPrompt = null;
        return;
      }
    } catch {}
  }
  document.getElementById('pwaInstallModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'pwaInstallModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.78);backdrop-filter:blur(6px);display:grid;place-items:center;padding:14px';
  modal.innerHTML = `<div class="card" style="width:100%;max-width:440px;padding:20px;border:1.5px solid rgba(251,191,36,.45);text-align:right">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="/icon-192.png" alt="PANTHER" style="width:48px;height:48px;border-radius:12px;border:1px solid rgba(251,191,36,.4)">
        <div>
          <h3 style="margin:0;color:var(--gold)">📲 تثبيت ${esc(meta.short)}</h3>
          <div class="mut" style="font-size:12px">يعمل كتطبيق هاتف مستقل بشاشة كاملة</div>
        </div>
      </div>
      <button type="button" class="ghost sm" id="pwaClose">✕</button>
    </div>
    <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:12px;padding:12px;margin-bottom:10px">
      <b class="clr-warn" style="display:block;margin-bottom:6px">🤖 على هواتف أندرويد (Chrome / Samsung):</b>
      <ol style="margin:0;padding-right:18px;font-size:13.5px;line-height:1.7;color:var(--c-mut)">
        <li>اضغط على زر القائمة <b>(⋮)</b> في أعلى المتصفح.</li>
        <li>اختر <b>«تثبيت التطبيق» (Install App)</b> أو <b>«الإضافة إلى الشاشة الرئيسية»</b>.</li>
        <li>اضغط <b>تثبيت</b> ليظهر التطبيق بأيقونة <b>PANTHER</b> على هاتفك.</li>
      </ol>
    </div>
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px;margin-bottom:14px">
      <b class="clr-near-wht" style="display:block;margin-bottom:6px">🍎 على هواتف آيفون (Safari):</b>
      <ol style="margin:0;padding-right:18px;font-size:13.5px;line-height:1.7;color:var(--c-mut)">
        <li>اضغط على زر المشاركة <b>(⬆️ Share)</b> في أسفل المتصفح.</li>
        <li>اختر <b>«إضافة إلى الصفحة الرئيسية» (Add to Home Screen)</b>.</li>
        <li>اضغط <b>إضافة (Add)</b> في أعلى الشاشة.</li>
      </ol>
    </div>
    <div class="row">
      <button type="button" class="sec" id="pwaCopyLink">🔗 نسخ رابط التحميل</button>
      <button type="button" class="ok" id="pwaDone">تم، فهمت</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('#pwaClose', modal).onclick = close;
  $('#pwaDone', modal).onclick = close;
  $('#pwaCopyLink', modal).onclick = async () => {
    const url = location.origin + meta.url;
    try { await navigator.clipboard.writeText(url); toast('✅ تم نسخ رابط تحميل التطبيق'); } catch { prompt('انسخ الرابط:', url); }
  };
}

export function renderInstallBanner(role = ROLE_KEY) {
  const meta = APP_META[role] || APP_META.merchant;
  const wantInstall = new URLSearchParams(location.search).get('install') === '1';
  if (isStandalone() && !wantInstall) return '';
  return `<div class="card" id="appInstallCard" style="border:1.5px solid rgba(251,191,36,.45);background:linear-gradient(145deg,rgba(24,20,17,.96),rgba(234,88,12,.14));margin-bottom:14px;text-align:right">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="/icon-192.png" alt="PANTHER" style="width:54px;height:54px;border-radius:14px;border:1.5px solid rgba(251,191,36,.5);box-shadow:0 6px 18px rgba(234,88,12,.3)">
        <div>
          <div style="font-weight:900;font-size:15.5px;color:var(--c-ink)">${meta.icon} ${esc(meta.name)}</div>
          <div class="mut" style="font-size:12.5px">${esc(meta.desc)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;width:100%;margin-top:6px">
        <button type="button" class="ok" data-install-app="${esc(role)}" style="flex:2;min-width:180px">📲 تحميل وتثبيت التطبيق على الهاتف</button>
        <button type="button" class="sec sm" data-copy-app="${esc(meta.url)}" style="flex:1;min-width:110px">🔗 نسخ رابط التطبيق</button>
        <a href="/" style="text-decoration:none"><button type="button" class="ghost sm">📦 كل التطبيقات</button></a>
      </div>
    </div>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const instBtn = e.target.closest('[data-install-app]');
  if (instBtn) {
    e.preventDefault();
    promptInstallApp(instBtn.dataset.installApp || ROLE_KEY);
    return;
  }
  const copyBtn = e.target.closest('[data-copy-app]');
  if (copyBtn) {
    e.preventDefault();
    const url = (getServerUrl() || location.origin) + copyBtn.dataset.copyApp;
    try { await navigator.clipboard.writeText(url); toast('✅ تم نسخ رابط تحميل التطبيق'); } catch { prompt('انسخ رابط التطبيق:', url); }
    return;
  }
  const srvBtn = e.target.closest('[data-server-cfg]');
  if (srvBtn) {
    e.preventDefault();
    openServerConfigModal();
  }
});

export async function api(path, method = 'GET', body) {
  const base = getServerUrl();
  if (isNativeApk() && !base) {
    openServerConfigModal();
    throw new Error('يرجى تحديد رابط السيرفر أولاً');
  }
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) { setToken(null); location.reload(); }
    throw new Error(data.error || 'حدث خطأ');
  }
  return data;
}
export const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message); } };

export function connectWs(onMsg) {
  let ws, stop = false, delay = 1000;
  const open = () => {
    const base = getServerUrl();
    if (isNativeApk() && !base) return;
    const wsUrl = base
      ? base.replace(/^http/i, 'ws') + '/ws'
      : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { delay = 1000; ws.send(JSON.stringify({ type: 'auth', token })); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = (e) => { if (!stop && e.code !== 4003) setTimeout(open, (delay = Math.min(delay * 2, 15000))); };
  };
  open();
  return () => { stop = true; ws?.close(); };
}

// ---------- maps (Google Maps Streets/Hybrid + Dark + OSM, zero API key, auto proxy fallback) ----------
export const DAMASCUS = [33.5138, 36.2765];

const MAP_STYLES = {
  google: {
    label: '🗺️ قوقل',
    direct: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=ar',
    proxy: '/api/tile/gm/{z}/{x}/{y}',
    opts: { subdomains: ['0', '1', '2', '3'], maxZoom: 20, attribution: '© Google Maps' },
  },
  hybrid: {
    label: '🛰️ واقعي',
    direct: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&hl=ar',
    proxy: '/api/tile/gh/{z}/{x}/{y}',
    opts: { subdomains: ['0', '1', '2', '3'], maxZoom: 20, attribution: '© Google Satellite' },
  },
  dark: {
    label: '🌙 ليلي',
    direct: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    proxy: '/api/tile/dark/{z}/{x}/{y}',
    opts: { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO' },
  },
  osm: {
    label: '🌍 خريطة',
    direct: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    proxy: '/api/tile/osm/{z}/{x}/{y}',
    opts: { subdomains: 'abc', maxZoom: 19, attribution: '© OpenStreetMap' },
  },
};

/* --- map CSS (injected once) --- */
if (!document.getElementById('_mapCSS')) {
  const style = document.createElement('style');
  style.id = '_mapCSS';
  style.textContent = `
    @keyframes _pulse {
      0%   { transform: scale(1);   opacity: .95; }
      70%  { transform: scale(2.6); opacity: 0; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    .pulsing-dot {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid var(--c-ink); box-shadow: 0 2px 6px rgba(0,0,0,.5);
      position: relative;
    }
    .pulsing-dot::after {
      content: ''; position: absolute; inset: -2px;
      border-radius: 50%; background: inherit;
      animation: _pulse 1.5s ease-out infinite;
    }
  `;
  document.head.appendChild(style);
}

function buildTileLayer(key) {
  const cfg = MAP_STYLES[key] || MAP_STYLES.google;
  const proxyUrl = () => (getServerUrl() || '') + cfg.proxy;
  const forceProxy = sessionStorage.getItem('mashwar_tile_proxy') === '1';
  const layer = L.tileLayer(forceProxy ? proxyUrl() : cfg.direct, cfg.opts);
  let errs = 0, proxied = forceProxy;
  layer.on('tileerror', () => {
    if (!proxied && ++errs >= 2) {
      proxied = true;
      sessionStorage.setItem('mashwar_tile_proxy', '1');
      layer.setUrl(proxyUrl());
    }
  });
  return layer;
}

export function makeMap(el, center = DAMASCUS, zoom = 13) {
  const m = L.map(el, { zoomControl: false }).setView(center, zoom);
  L.control.zoom({ position: 'topright' }).addTo(m);

  const layers = {
    google: buildTileLayer('google'),
    hybrid: buildTileLayer('hybrid'),
    dark: buildTileLayer('dark'),
    osm: buildTileLayer('osm'),
  };

  let saved = localStorage.getItem('mashwar_map_style') || 'google';
  if (!layers[saved]) saved = 'google';
  let currentKey = saved;
  layers[currentKey].addTo(m);

  m._tileLayers = layers;
  m.setMapStyle = (key) => {
    if (!layers[key] || key === currentKey) return;
    m.removeLayer(layers[currentKey]);
    currentKey = key;
    layers[currentKey].addTo(m);
    localStorage.setItem('mashwar_map_style', key);
    if (m._styleBtns) {
      Object.entries(m._styleBtns).forEach(([k, b]) => b.classList.toggle('on', k === key));
    }
  };
  m.toggleTiles = () => m.setMapStyle(currentKey === 'google' ? 'hybrid' : currentKey === 'hybrid' ? 'dark' : 'google');

  // Layer switcher + "My Location" control
  const Ctrl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctrl');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      m._styleBtns = {};
      for (const k of ['google', 'hybrid', 'dark']) {
        const b = L.DomUtil.create('button', 'ghost tab map-btn' + (k === currentKey ? ' on' : ''), box);
        b.type = 'button';
        b.textContent = MAP_STYLES[k].label;
        b.onclick = (ev) => { ev.preventDefault(); m.setMapStyle(k); };
        m._styleBtns[k] = b;
      }
      const locBtn = L.DomUtil.create('button', 'ghost tab map-btn', box);
      locBtn.type = 'button';
      locBtn.textContent = '📍 موقعي';
      locBtn.title = 'الانتقال إلى موقعي الحالي';
      locBtn.onclick = (ev) => {
        ev.preventDefault();
        if (!navigator.geolocation) return toast('المتصفح لا يدعم تحديد الموقع');
        navigator.geolocation.getCurrentPosition(
          (p) => m.setView([p.coords.latitude, p.coords.longitude], 15),
          () => toast('يرجى السماح بصلاحية الموقع (GPS) في المتصفح'),
          { enableHighAccuracy: true, timeout: 10000 }
        );
      };
      return box;
    },
  });
  new Ctrl().addTo(m);

  setTimeout(() => m.invalidateSize(), 80);
  return m;
}

export const emoji = (e) => L.divIcon({
  html: `<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))">${e}</div>`,
  className: '', iconSize: [28, 28], iconAnchor: [14, 14],
});

export function pickLocation(map, onPick) {
  let mk;
  map.on('click', (e) => {
    if (mk) mk.setLatLng(e.latlng);
    else mk = L.marker(e.latlng, { icon: emoji('📍') }).addTo(map);
    onPick(e.latlng.lat, e.latlng.lng);
  });
}

export async function makeRoute(map, from, to) {
  const directUrl = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
  const proxyUrl = `${getServerUrl()}/api/route?from=${encodeURIComponent(from[0] + ',' + from[1])}&to=${encodeURIComponent(to[0] + ',' + to[1])}`;
  for (const url of [directUrl, proxyUrl]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.length) {
        const coords = data.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
        return L.polyline(coords, { color: '#f59e0b', weight: 5, opacity: 0.92 }).addTo(map);
      }
    } catch {}
  }
  return L.polyline([from, to], { color: '#f59e0b', weight: 4, opacity: 0.8, dashArray: '10 8' }).addTo(map);
}

export function animateMarker(marker, newLatLng, duration = 1000) {
  const start = performance.now();
  const from = marker.getLatLng();
  const to = L.latLng(newLatLng);
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;

  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    marker.setLatLng([from.lat + dLat * ease, from.lng + dLng * ease]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function fitMapToPoints(map, points) {
  const pts = (points || [])
    .filter((p) => Array.isArray(p) && p[0] != null && p[1] != null && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Number(p[0]), Number(p[1])]);
  if (!pts.length) return;
  if (pts.length === 1) { map.setView(pts[0], 15); return; }
  const bounds = L.latLngBounds(pts.map((p) => L.latLng(p[0], p[1])));
  map.fitBounds(bounds, { padding: [45, 45], maxZoom: 16 });
}

export function createPulsingDot(color = '#22c55e') {
  return L.divIcon({
    html: `<div class="pulsing-dot" style="background:${color}"></div>`,
    className: '', iconSize: [14, 14], iconAnchor: [7, 7],
  });
}

// ---------- login / register ----------
export async function authScreen(role, onReady) {
  const root = $('#auth');
  const wantInstall = new URLSearchParams(location.search).get('install') === '1';
  if (token) {
    try {
      const me = await api('/me');
      if (me.role === role) {
        onReady(me);
        if (wantInstall) setTimeout(() => promptInstallApp(role), 350);
        return;
      }
    } catch {}
    setToken(null);
  }
  const zones = [];
  root.classList.remove('hide');
  const canReg = false; // الحسابات تُنشأ من الإدارة فقط
  const roleLabel = { admin: 'غرفة العمليات والإدارة', merchant: 'بوابة المنشآت الشريكة', captain: 'تطبيق الكابتن الميداني' }[role] || '';
  const roleIcon = { admin: '⚡', merchant: '🏪', captain: '🛵' }[role] || '🐆';
  const srvBadge = isNativeApk() || getServerUrl()
    ? `<div style="margin-top:14px;text-align:center"><button type="button" class="ghost sm" data-server-cfg="1">🌐 إعدادات السيرفر${getServerUrl() ? ` (${esc(getServerUrl())})` : ' (غير محدد)'}</button></div>`
    : `<div style="margin-top:14px;text-align:center"><button type="button" class="ghost sm" data-server-cfg="1">🌐 تغيير رابط السيرفر</button></div>`;
  root.innerHTML = `${renderInstallBanner(role)}
    <div class="card hero vault-card">
      <div class="vault-glow-orb"></div>
      <div class="brand-emblem-wrap">
        <img src="logo.jpg" alt="PANTHER DELIVERY" class="brand-logo-lg">
        <span class="brand-role-pill">${roleIcon} ${esc(roleLabel)}</span>
      </div>
      <div class="brand-title-gradient" dir="ltr">PANTHER DELIVERY</div>
      <div class="brand-sub">B2B SMART DISPATCH • نظام التوصيل الذكي</div>
      <p class="mut" style="margin:0 auto 18px;max-width:320px;line-height:1.6">سجّل الدخول إلى حسابك المعتمد للمتابعة. تُدار جميع الحسابات مركزياً عبر الإدارة.</p>
      <form id="lf" class="vault-form" style="text-align:right">
        <div class="input-group">
          <label>📱 رقم الهاتف المعتمد</label>
          <input name="phone" inputmode="tel" placeholder="09xxxxxxxx" autocomplete="username" required>
        </div>
        <div class="input-group">
          <label>🔒 كلمة المرور</label>
          <input name="password" type="password" placeholder="••••••••" autocomplete="current-password" required>
        </div>
        <button class="big vault-submit">🚀 تسجيل الدخول للنظام</button>
      </form>
      ${srvBadge}
      ${canReg ? '<p class="mut" style="text-align:center"><a href="#" id="toReg">حساب جديد</a></p>' : ''}
    </div>
    ${canReg ? `<div class="card hide" id="regc"><h2>حساب جديد</h2><form id="rf">
    <label>الاسم</label><input name="name" required minlength="2" maxlength="60">
    <label>رقم الهاتف</label><input name="phone" inputmode="tel" required>
    <label>كلمة المرور (8 أحرف على الأقل مع أرقام)</label><input name="password" type="password" minlength="8" required autocomplete="new-password">
    <label>المنطقة</label><select name="zone_id">${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select>
    ${role === 'merchant' ? `<label>اسم المنشأة</label><input name="business_name" required>
    <label>العنوان</label><input name="address" required>
    <label>حدّد موقع المنشأة على الخريطة (اضغط)</label><div id="regmap" class="map"></div>` : ''}
    <button class="big">إرسال الطلب</button></form>
    <p class="mut">سيتم تفعيل حسابك بعد موافقة الإدارة.</p></div>` : ''}`;
  if (wantInstall) setTimeout(() => promptInstallApp(role), 350);
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/auth/login', 'POST', f);
      if (r.user.role !== role) {
        if (['admin', 'merchant', 'captain'].includes(r.user.role)) {
          setToken(r.token);
          localStorage.setItem('panther_token_' + r.user.role, r.token);
          location.href = '/' + r.user.role;
          return;
        }
        return toast('هذا الحساب ليس من هذه الواجهة');
      }
      setToken(r.token); root.classList.add('hide'); onReady(r.user);
    } catch (er) { toast(er.message); }
  };
  if (canReg) {
    let pos = [null, null], map;
    $('#toReg').onclick = (e) => {
      e.preventDefault(); $('#regc').classList.remove('hide');
      if (role === 'merchant' && !map) { map = makeMap('regmap'); pickLocation(map, (a, b) => (pos = [a, b])); }
    };
    $('#rf').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      f.role = role; f.zone_id = Number(f.zone_id);
      if (role === 'merchant') { if (pos[0] == null) return toast('حدّد موقع المنشأة على الخريطة'); [f.lat, f.lng] = pos; }
      try { const r = await api('/auth/register', 'POST', f); toast(r.message, 7000); e.target.reset(); } catch (er) { toast(er.message); }
    };
  }
}

export function header(title, user, onLogout) {
  const h = document.createElement('header');
  h.className = 'panther-header';
  const installBtn = !isStandalone()
    ? `<button type="button" class="ok sm" data-install-app="${esc(ROLE_KEY)}">📲 تثبيت</button>`
    : '';
  const srvBtn = (isNativeApk() || getServerUrl())
    ? `<button type="button" class="ghost sm" data-server-cfg="1" title="إعدادات السيرفر">🌐 السيرفر</button>`
    : '';
  h.innerHTML = `
    <h1>
      <img src="logo.jpg" alt="PANTHER" class="brand-logo-sm">
      <div class="hdr-brand-stack">
        <span class="brand-title-sm" dir="ltr">PANTHER</span>
        <span class="hdr-role-tag">${esc(title)}</span>
      </div>
    </h1>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="hdr-user-chip">👤 ${esc(user.business_name || user.name)}</span>
      ${srvBtn}${installBtn}
      <button class="sec sm" id="lo">خروج</button>
    </div>`;
  document.body.prepend(h);
  $('#lo', h).onclick = async () => { try { await api('/auth/logout-all', 'POST'); } catch {} onLogout?.(); setToken(null); location.reload(); };
}

/** Captain details modal: name, phone, live location on a map, and a direct call button. */
export function captainModal(cap) {
  if (!cap) return;
  document.getElementById('capmodal')?.remove();
  const el = document.createElement('div');
  el.id = 'capmodal';
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:grid;place-items:center;padding:14px';
  const hasLoc = cap.lat != null && cap.lng != null;
  el.innerHTML = `<div class="card" style="width:100%;max-width:440px;padding:18px;background:var(--c-ground);color:var(--c-ink)">
    <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">🛵 ${esc(cap.name)}</h3><button type="button" class="ghost" id="capx">✕</button></div>
    <p style="margin:10px 0">📞 <b dir="ltr">${esc(cap.phone || '—')}</b></p>
    ${hasLoc ? '<div id="capmap" class="map" style="height:240px"></div>' : '<div class="mut">موقع الكابتن غير متوفر حالياً</div>'}
    ${cap.phone ? `<a href="tel:${esc(cap.phone)}" style="display:block;text-align:center;margin-top:12px;padding:12px;border-radius:12px;background:#22c55e;color:#fff;font-weight:700;text-decoration:none">📞 اتصال مباشر</a>` : ''}
  </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector('#capx').onclick = close;
  if (hasLoc) {
    const m = makeMap('capmap', [cap.lat, cap.lng], 15);
    L.marker([cap.lat, cap.lng], { icon: emoji('🛵') }).addTo(m).bindTooltip(cap.name);
    setTimeout(() => m.invalidateSize(), 60);
  }
}
