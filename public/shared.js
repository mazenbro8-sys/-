// Shared client helpers (no inline scripts: CSP-safe)
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => new Intl.NumberFormat('ar-SY').format(n || 0) + ' ل.س';
export const time = (ms) => (ms ? new Date(ms).toLocaleString('ar-SY', { hour12: true }) : '—');

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

let token = sessionStorage.getItem('token');
export const getToken = () => token;
export function setToken(t) { token = t; t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'); }

export async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
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
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { delay = 1000; ws.send(JSON.stringify({ type: 'auth', token })); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = (e) => { if (!stop && e.code !== 4003) setTimeout(open, (delay = Math.min(delay * 2, 15000))); };
  };
  open();
  return () => { stop = true; ws?.close(); };
}

// ---------- maps ----------
export const DAMASCUS = [33.5138, 36.2765];

const TILES_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILES_OSM  = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/* --- pulsing dot CSS (injected once) --- */
if (!document.getElementById('_pulsingDotCSS')) {
  const style = document.createElement('style');
  style.id = '_pulsingDotCSS';
  style.textContent = `
    @keyframes _pulse {
      0%   { transform: scale(1);   opacity: 1; }
      70%  { transform: scale(2.5); opacity: 0; }
      100% { transform: scale(2.5); opacity: 0; }
    }
    .pulsing-dot {
      width: 12px; height: 12px; border-radius: 50%;
      position: relative;
    }
    .pulsing-dot::after {
      content: ''; position: absolute; inset: 0;
      border-radius: 50%; background: inherit;
      animation: _pulse 1.4s ease-out infinite;
    }
  `;
  document.head.appendChild(style);
}

export function makeMap(el, center = DAMASCUS, zoom = 13) {
  const m = L.map(el, { zoomControl: false }).setView(center, zoom);
  L.control.zoom({ position: 'topright' }).addTo(m);

  const darkTile = L.tileLayer(TILES_DARK, { maxZoom: 19, attribution: '© CartoDB © OpenStreetMap' });
  const osmTile  = L.tileLayer(TILES_OSM,  { maxZoom: 19, attribution: '© OpenStreetMap' });
  darkTile.addTo(m);

  m._tileLayers = { dark: darkTile, osm: osmTile };
  m.toggleTiles = () => {
    if (m.hasLayer(darkTile)) { m.removeLayer(darkTile); osmTile.addTo(m); }
    else { m.removeLayer(osmTile); darkTile.addTo(m); }
  };
  return m;
}

export const emoji = (e) => L.divIcon({
  html: `<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))">${e}</div>`,
  className: '', iconSize: [26, 26], iconAnchor: [13, 13]
});

export function pickLocation(map, onPick) {
  let mk;
  map.on('click', (e) => { if (mk) mk.setLatLng(e.latlng); else mk = L.marker(e.latlng).addTo(map); onPick(e.latlng.lat, e.latlng.lng); });
}

export async function makeRoute(map, from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('no route');
    const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    return L.polyline(coords, { color: '#0984e3', weight: 5, opacity: .8 }).addTo(map);
  } catch {
    return L.polyline([from, to], { color: '#0984e3', weight: 4, opacity: .6, dashArray: '10 8' }).addTo(map);
  }
}

export function animateMarker(marker, newLatLng, duration = 1000) {
  const start = performance.now();
  const from = marker.getLatLng();
  const to = L.latLng(newLatLng);
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;

  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;      // ease-in-out
    marker.setLatLng([from.lat + dLat * ease, from.lng + dLng * ease]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function fitMapToPoints(map, points) {
  if (!points?.length) return;
  const bounds = L.latLngBounds(points.map(p => L.latLng(p[0], p[1])));
  map.fitBounds(bounds, { padding: [40, 40] });
}

export function createPulsingDot(color = '#6c5ce7') {
  return L.divIcon({
    html: `<div class="pulsing-dot" style="background:${color}"></div>`,
    className: '', iconSize: [12, 12], iconAnchor: [6, 6]
  });
}

// ---------- login / register ----------
export async function authScreen(role, onReady) {
  const root = $('#auth');
  if (token) {
    try { const me = await api('/me'); if (me.role === role) return onReady(me); } catch {}
    setToken(null);
  }
  const zones = [];
  root.classList.remove('hide');
  const canReg = false; // الحسابات تُنشأ من الإدارة فقط
  root.innerHTML = `<div class="card hero"><div class="logo">🛵</div><h2>مشوار</h2><p class="mut">سجّل الدخول للمتابعة. الحسابات تُنشأ من الإدارة.</p>
    <form id="lf"><label>رقم الهاتف</label><input name="phone" inputmode="tel" autocomplete="username" required>
    <label>كلمة المرور</label><input name="password" type="password" autocomplete="current-password" required>
    <button class="big">دخول</button></form>
    ${canReg ? '<p class="mut" style="text-align:center"><a href="#" id="toReg">حساب جديد</a></p>' : ''}</div>
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
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/auth/login', 'POST', f);
      if (r.user.role !== role) {
        if (['admin', 'merchant', 'captain'].includes(r.user.role)) {
          setToken(r.token);
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
  h.innerHTML = `<h1>🛵 مشوار — ${esc(title)}</h1><span>${esc(user.business_name || user.name)}</span><button class="sec" id="lo">خروج</button>`;
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
  el.innerHTML = `<div class="card" style="width:100%;max-width:440px;padding:18px;background:#18181b;color:#fff">
    <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">🛵 ${esc(cap.name)}</h3><button type="button" class="ghost" id="capx">✕</button></div>
    <p style="margin:10px 0">📞 <b dir="ltr">${esc(cap.phone || '—')}</b></p>
    ${hasLoc ? '<div id="capmap" class="map" style="height:220px"></div>' : '<div class="mut">موقع الكابتن غير متوفر حالياً</div>'}
    ${cap.phone ? `<a href="tel:${esc(cap.phone)}" style="display:block;text-align:center;margin-top:12px;padding:12px;border-radius:12px;background:#22c55e;color:#fff;font-weight:700;text-decoration:none">📞 اتصال مباشر</a>` : ''}
  </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector('#capx').onclick = close;
  if (hasLoc) {
    const m = makeMap('capmap', [cap.lat, cap.lng], 15);
    L.marker([cap.lat, cap.lng], { icon: emoji('🛵') }).addTo(m);
    setTimeout(() => m.invalidateSize(), 50);
  }
}