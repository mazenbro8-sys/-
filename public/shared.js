// Shared client helpers (no inline scripts: CSP-safe)
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const enDigits = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0);
export const esc = (v) => enDigits(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const serialNo = (o) => '#' + String(typeof o === 'object' ? (o?.serial_no || o?.id || 0) : (o || 0)).padStart(4, '0');
export const points = (n) => `${enDigits(new Intl.NumberFormat('en-US').format(Math.trunc(Number(n) || 0)))} نقطة`;
export const time = (ms) => (ms ? enDigits(new Date(ms).toLocaleString('ar-SY-u-nu-latn', { hour12: true })) : '—');

// Automatically convert any Arabic/Persian digits typed into inputs/textareas into English digits (0-9)
if (typeof document !== 'undefined') {
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
}

export const STATUS = {
  searching: 'جاري البحث عن كابتن', offered: 'بانتظار قبول كابتن', accepted: 'الكابتن في الطريق للمنشأة',
  picked_up: 'تم الاستلام، في الطريق للزبون', arrived: 'وصل عند الزبون', delivered: 'تم التسليم',
  cancelled: 'ملغي', failed: 'فشل التسليم', expired: 'لا يوجد كابتن متاح',
  pending: 'بانتظار الموافقة', active: 'مفعّل', suspended: 'موقوف', deleted: 'محذوف',
};
export const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS[s] || s)}</span>`;

/** Format timestamp as compact Arabic relative duration using English digits. */
export function formatRelativeNotifTime(ts, now = Date.now()) {
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return '—';
  const diffMs = Math.max(0, Number(now) - num);
  if (diffMs < 60_000) return 'الآن';
  if (diffMs < 3_600_000) return `قبل ${enDigits(Math.floor(diffMs / 60_000))} د`;
  if (diffMs < 86_400_000) return `قبل ${enDigits(Math.floor(diffMs / 3_600_000))} س`;
  return `قبل ${enDigits(Math.floor(diffMs / 86_400_000))} ي`;
}

/**
 * Sort inbox notifications (un-acked requires_ack pinned at top, newest first)
 * and compute unread / >threshold grouping metadata.
 */
export function sortAndPrepareNotifications(rows, { groupThreshold = 5 } = {}) {
  const valid = Array.isArray(rows) ? rows.filter((n) => n && n.id != null) : [];
  const isRead = (n) => Boolean(n.read || n.read_at);
  const isPinnedAck = (n) => Boolean(n.requires_ack && !isRead(n));
  const byNewest = (a, b) =>
    ((Number(b.created_at) || 0) - (Number(a.created_at) || 0))
    || ((Number(b.id) || 0) - (Number(a.id) || 0));

  const pinnedAckItems = valid.filter(isPinnedAck).sort(byNewest);
  const regularItems = valid.filter((n) => !isPinnedAck(n)).sort(byNewest);
  const items = [...pinnedAckItems, ...regularItems];
  const unreadItems = items.filter((n) => !isRead(n));
  const unreadCount = unreadItems.length;
  const regularUnreadIds = unreadItems.filter((n) => !n.requires_ack).map((n) => n.id);
  const shouldGroupBanner = unreadCount > groupThreshold;
  const bannerText = shouldGroupBanner ? `لديك ${enDigits(unreadCount)} رسائل جديدة` : '';
  return { items, pinnedAckItems, unreadCount, regularUnreadIds, shouldGroupBanner, bannerText };
}

/** Pure queue transition helper: append/coalesce a toast item with cap enforcement. */
export function enqueueToastItem(queue, nextItem, { maxQueue = 12 } = {}) {
  const text = String(nextItem?.msg ?? '').trim();
  if (!text) return queue.slice();
  const ms = Math.max(1000, Math.min(15_000, Number(nextItem?.ms) || 3500));
  const tag = String(nextItem?.tag || '');
  const replaceTag = Boolean(nextItem?.replaceTag && tag);
  const priority = nextItem?.priority === 'high' ? 'high' : 'normal';

  let list = replaceTag ? queue.filter((q) => q.tag !== tag) : queue.slice();
  if (list.some((q) => q.msg === text)) return list;

  while (list.length >= maxQueue) {
    const dropIdx = list.findIndex((q) => q.priority !== 'high');
    if (dropIdx >= 0) list.splice(dropIdx, 1);
    else list.shift();
  }
  const entry = { msg: text, ms, tag, priority };
  if (priority === 'high') {
    const firstNormal = list.findIndex((q) => q.priority !== 'high');
    if (firstNormal >= 0) list.splice(firstNormal, 0, entry);
    else list.push(entry);
  } else {
    list.push(entry);
  }
  return list;
}

const _toastState = { queue: [], active: [], timers: new Map(), deferTimer: null, nextId: 1 };

function toastRectIntersectsProtected() {
  if (typeof document === 'undefined') return false;
  const hdr = document.querySelector('.panther-header');
  const hdrRect = hdr?.getBoundingClientRect();
  const topOffset = (hdrRect && hdrRect.height > 0) ? Math.ceil(hdrRect.bottom + 8) : 16;
  const bandTop = topOffset - 4;
  const bandBottom = topOffset + 76;
  const criticalEls = document.querySelectorAll(
    '#offer .offer-sheet, #offer #acc, #offer #rej, #tab-active #nx, #tab-active #fl, #tab-active .cap-quick-actions'
  );
  for (const el of criticalEls) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top < bandBottom && r.bottom > bandTop) return true;
  }
  return false;
}

function getOrCreateToastRegion() {
  let region = document.getElementById('toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast';
    region.className = 'toast-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'التنبيهات');
    if (typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover')) {
      region.setAttribute('popover', 'manual');
    }
    document.body.appendChild(region);
  }
  let live = document.getElementById('toastLive');
  if (!live) {
    live = document.createElement('div');
    live.id = 'toastLive';
    live.className = 'inclusively-hidden';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  return { region, live };
}

function showRegionLayer(region, visible) {
  const hasPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
  if (visible) {
    const hdr = document.querySelector('.panther-header');
    const hr = hdr?.getBoundingClientRect();
    const topOffset = (hr && hr.height > 0) ? Math.ceil(hr.bottom + 8) : 16;
    region.style.setProperty('--toast-top-offset', `${topOffset}px`);
    region.classList.add('is-open');
    if (hasPopover) {
      try {
        if (!region.matches(':popover-open')) region.showPopover();
      } catch {}
    }
  } else {
    region.classList.remove('is-open');
    if (hasPopover) {
      try {
        if (region.matches(':popover-open')) region.hidePopover();
      } catch {}
    }
  }
}

function scheduleToastTimer(id, ms) {
  const existing = _toastState.timers.get(id);
  if (existing) clearTimeout(existing);
  const tid = setTimeout(() => dismissActiveToast(id), ms);
  _toastState.timers.set(id, tid);
}

function dismissActiveToast(id, { restoreFocus = false } = {}) {
  const timer = _toastState.timers.get(id);
  if (timer) clearTimeout(timer);
  _toastState.timers.delete(id);

  const idx = _toastState.active.findIndex((a) => a.id === id);
  if (idx >= 0) _toastState.active.splice(idx, 1);

  const region = document.getElementById('toast');
  const el = region?.querySelector(`[data-toast-id="${id}"]`);
  const hadFocus = Boolean(restoreFocus && el && el.contains(document.activeElement));
  const priorFocus = el?._priorFocus;
  el?.remove();

  flushToastQueue();

  if (hadFocus) {
    const nextBtn = region?.querySelector('.toast-close');
    if (nextBtn) nextBtn.focus();
    else if (priorFocus && typeof priorFocus.focus === 'function' && priorFocus.isConnected) {
      try { priorFocus.focus(); } catch {}
    }
  }
}

function flushToastQueue() {
  if (typeof document === 'undefined') return;
  clearTimeout(_toastState.deferTimer);
  _toastState.deferTimer = null;

  const { region, live } = getOrCreateToastRegion();
  const maxVisible = (typeof window !== 'undefined' && window.innerWidth <= 767) ? 1 : 2;

  if (_toastState.queue.length > 0 && toastRectIntersectsProtected()) {
    if (_toastState.active.length === 0) showRegionLayer(region, false);
    _toastState.deferTimer = setTimeout(flushToastQueue, 300);
    return;
  }

  while (_toastState.active.length < maxVisible && _toastState.queue.length > 0) {
    const next = _toastState.queue.shift();
    const id = _toastState.nextId++;
    const entry = { ...next, id };
    _toastState.active.push(entry);

    const card = document.createElement('div');
    card.className = 'toast-item';
    card.dataset.toastId = String(id);
    if (entry.tag) card.dataset.toastTag = entry.tag;
    card._priorFocus = document.activeElement;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = entry.msg;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'إغلاق التنبيه');
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => dismissActiveToast(id, { restoreFocus: true });

    card.append(msgSpan, closeBtn);
    const pause = () => {
      const t = _toastState.timers.get(id);
      if (t) { clearTimeout(t); _toastState.timers.delete(id); }
    };
    const resume = () => {
      if (_toastState.active.some((a) => a.id === id) && !card.matches(':focus-within')) {
        scheduleToastTimer(id, 1800);
      }
    };
    card.addEventListener('pointerenter', pause);
    card.addEventListener('pointerleave', resume);
    card.addEventListener('focusin', pause);
    card.addEventListener('focusout', resume);

    region.appendChild(card);
    scheduleToastTimer(id, entry.ms);

    try {
      if (typeof document.ariaNotify === 'function') document.ariaNotify(entry.msg);
      else live.textContent = entry.msg;
    } catch {
      live.textContent = entry.msg;
    }
  }

  showRegionLayer(region, _toastState.active.length > 0);
}

/** Display a non-blocking queued toast alert clear of offers and active actions. */
export function toast(msg, msOrOpts = 3500) {
  if (typeof document === 'undefined') return;
  const opts = typeof msOrOpts === 'object' && msOrOpts !== null
    ? msOrOpts
    : { ms: Number(msOrOpts) || 3500 };
  const text = String(msg ?? '').trim();
  if (!text) return;

  if (opts.replaceTag && opts.tag) {
    const activeIds = _toastState.active.filter((a) => a.tag === opts.tag).map((a) => a.id);
    for (const id of activeIds) dismissActiveToast(id);
  }
  if (_toastState.active.some((a) => a.msg === text)) return;

  _toastState.queue = enqueueToastItem(_toastState.queue, {
    msg: text,
    ms: opts.ms ?? 3500,
    tag: opts.tag || '',
    replaceTag: Boolean(opts.replaceTag),
    priority: opts.priority || 'normal',
  });
  flushToastQueue();
}

/** Replace any queued/active tagged toast messages with one collapsed summary toast. */
export function collapseToastTag(tag, msg, ms = 3500) {
  toast(msg, { ms, tag, replaceTag: true });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const region = document.getElementById('toast');
    if (region) showRegionLayer(region, false);
  });
  document.addEventListener('close', () => setTimeout(flushToastQueue, 40), true);
}

/**
 * Delay invoking `fn` until `ms` milliseconds after the last call.
 * Exposes `.cancel()` to clear any pending timer when a view unmounts or re-renders.
 */
export function debounce(fn, ms = 300) {
  let timerId = null;
  function debounced(...args) {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      fn.apply(this, args);
    }, ms);
  }
  debounced.cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
  return debounced;
}

const makeSafeStore = (kind) => {
  const mem = new Map();
  const raw = () => { try { return window[kind]; } catch { return null; } };
  return {
    getItem(k) { try { const s = raw(); return s ? s.getItem(k) : (mem.get(k) ?? null); } catch { return mem.get(k) ?? null; } },
    setItem(k, v) { mem.set(k, String(v)); try { raw()?.setItem(k, String(v)); } catch {} },
    removeItem(k) { mem.delete(k); try { raw()?.removeItem(k); } catch {} },
    clear() { mem.clear(); try { raw()?.clear(); } catch {} },
  };
};
export const sStore = makeSafeStore('sessionStorage');
export const lStore = makeSafeStore('localStorage');

const pathname = typeof location !== 'undefined' ? (location.pathname || '') : '';
const ROLE_KEY = pathname.includes('admin') ? 'admin' : pathname.includes('merchant') ? 'merchant' : pathname.includes('captain') ? 'captain' : 'app';
// Remove the old unscoped sessionStorage key if it exists
sStore.removeItem('token');
let token = sStore.getItem('token_' + ROLE_KEY) || lStore.getItem('panther_token_' + ROLE_KEY);
export const getToken = () => token;
export function setToken(t) {
  token = t;
  if (t) {
    sStore.setItem('token_' + ROLE_KEY, t);
    lStore.setItem('panther_token_' + ROLE_KEY, t);
  } else {
    sStore.removeItem('token_' + ROLE_KEY);
    lStore.removeItem('panther_token_' + ROLE_KEY);
  }
}

// ---------- Server URL Config (for Android APK / Capacitor / Remote Server) ----------
export const isNativeApk = () =>
  Boolean(window.Capacitor?.isNativePlatform?.() || window.PANTHER_APK || location.protocol === 'file:' || (location.hostname === 'localhost' && !location.port));

export const DEFAULT_APK_SERVER = 'https://mashwar-app.onrender.com';

// Auto-migrate stale temporary Cloudflare Quick Tunnel URLs on upgraded APK installs
if ((lStore.getItem('panther_server_url') || '').includes('.trycloudflare.com')) {
  lStore.removeItem('panther_server_url');
}

export function getServerUrl() {
  const saved = (lStore.getItem('panther_server_url') || '').trim().replace(/\/+$/, '');
  if (saved) return saved;
  if (window.PANTHER_DEFAULT_SERVER) return String(window.PANTHER_DEFAULT_SERVER).trim().replace(/\/+$/, '');
  if (isNativeApk()) return DEFAULT_APK_SERVER;
  return '';
}

export function setServerUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) lStore.setItem('panther_server_url', clean);
  else lStore.removeItem('panther_server_url');
}

export function openServerConfigModal(onSaved) {
  document.getElementById('srvCfgModal')?.remove();
  const current = getServerUrl() || (!isNativeApk() ? location.origin : '');
  const modal = document.createElement('div');
  modal.id = 'srvCfgModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:var(--z-modal);background:var(--surface-overlay);backdrop-filter:var(--blur-sm);display:grid;place-items:center;padding:var(--space-4)';
  modal.innerHTML = `<div class="card" style="width:100%;max-width:430px;text-align:right">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h3 style="margin:0;color:var(--brand-primary)">🌐 إعدادات اتصال السيرفر</h3>
      <button type="button" class="ghost sm" id="srvCfgClose" aria-label="إغلاق">✕</button>
    </div>
    <p class="mut" style="font-size:13px;margin:0 0 12px">أدخل رابط السيرفر (مثل رابط Cloudflare أو الدومين أو IP الشبكة المحلية):</p>
    <input id="srvUrlInput" dir="ltr" type="url" placeholder="https://mashwar-app.onrender.com" value="${esc(current)}" style="width:100%;margin-bottom:10px;text-align:left">
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
    if (!val) { msg.textContent = '⚠️ يرجى إدخال رابط السيرفر أولاً'; msg.style.color = 'var(--status-warn-text)'; return; }
    msg.textContent = '⏳ جاري فحص الاتصال بالسيرفر...'; msg.style.color = 'var(--text-secondary)';
    try {
      const r = await fetch(val + '/api/zones');
      if (r.ok) { msg.textContent = '✅ الاتصال بالسيرفر ناجح ويعمل بشكل ممتاز!'; msg.style.color = 'var(--status-ok-text)'; }
      else { msg.textContent = `❌ السيرفر استجاب برمز خطأ (${r.status})`; msg.style.color = 'var(--status-bad-text)'; }
    } catch {
      msg.textContent = '❌ تعذّر الوصول للسيرفر، تأكد من الرابط أو اتصال الإنترنت'; msg.style.color = 'var(--status-bad-text)';
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
  typeof window !== 'undefined' &&
  (isNativeApk() ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true);

if (typeof window !== 'undefined') {
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
}

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
  modal.style.cssText = 'position:fixed;inset:0;z-index:var(--z-toast);background:var(--surface-overlay);backdrop-filter:blur(6px);display:grid;place-items:center;padding:14px';
  modal.innerHTML = `<div class="card" style="width:100%;max-width:440px;padding:20px;border:1.5px solid var(--border-brand-soft);text-align:right">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="/icon-192.png" alt="PANTHER" style="width:48px;height:48px;border-radius:12px;border:1px solid var(--border-brand-soft)">
        <div>
          <h3 style="margin:0;color:var(--brand-primary)">📲 تثبيت ${esc(meta.short)}</h3>
          <div class="mut" style="font-size:12px">يعمل كتطبيق هاتف مستقل بشاشة كاملة</div>
        </div>
      </div>
      <button type="button" class="ghost sm" id="pwaClose" aria-label="إغلاق">✕</button>
    </div>
    <div style="background:var(--brand-primary-soft);border:1px solid var(--border-brand-soft);border-radius:12px;padding:12px;margin-bottom:10px">
      <b style="color:var(--brand-primary);display:block;margin-bottom:6px">🤖 على هواتف أندرويد (Chrome / Samsung):</b>
      <ol style="margin:0;padding-right:18px;font-size:13.5px;line-height:1.7;color:var(--text-secondary)">
        <li>اضغط على زر القائمة <b>(⋮)</b> في أعلى المتصفح.</li>
        <li>اختر <b>«تثبيت التطبيق» (Install App)</b> أو <b>«الإضافة إلى الشاشة الرئيسية»</b>.</li>
        <li>اضغط <b>تثبيت</b> ليظهر التطبيق بأيقونة <b>PANTHER</b> على هاتفك.</li>
      </ol>
    </div>
    <div style="background:var(--bg-subtle);border:1px solid var(--border-neutral-strong);border-radius:12px;padding:12px;margin-bottom:14px">
      <b class="clr-near-wht" style="display:block;margin-bottom:6px">🍎 على هواتف آيفون (Safari):</b>
      <ol style="margin:0;padding-right:18px;font-size:13.5px;line-height:1.7;color:var(--text-secondary)">
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
  if (role === 'admin') return '';
  const meta = APP_META[role] || APP_META.merchant;
  const wantInstall = new URLSearchParams(location.search).get('install') === '1';
  if (!wantInstall) return '';
  return `<div class="card" id="appInstallCard" style="border:1.5px solid var(--border-brand-soft);background:var(--bg-elevated);margin-bottom:14px;text-align:right">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="/icon-192.png" alt="PANTHER" style="width:54px;height:54px;border-radius:14px;border:1.5px solid var(--border-brand-soft)">
        <div>
          <div style="font-weight:900;font-size:15.5px;color:var(--text-primary)">${meta.icon} ${esc(meta.name)}</div>
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

if (typeof document !== 'undefined') {
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
}

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
    const err = new Error(data.error || 'حدث خطأ');
    err.status = r.status;
    throw err;
  }
  return data;
}

async function postLogoutStep(path, body, timeoutMs = 2000) {
  const base = getServerUrl();
  if (!token || (isNativeApk() && !base)) return;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch {
    // Never block logout on network/server failure
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function performLogout({ isCaptain = false, hasActiveOrder = false, onBeforeClear = null } = {}) {
  if (isCaptain && !hasActiveOrder) {
    await postLogoutStep('/captain/online', { online: false }, 2000);
  }
  await postLogoutStep('/auth/logout-all', null, 2000);
  try { onBeforeClear?.(); } catch {}
  setToken(null);
  location.reload();
}

export const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message); } };

export function connectWs(onMsg) {
  let ws = null, stop = false, delay = 1000, reconnectTimer = null;
  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const open = () => {
    clearReconnect();
    if (stop) return;
    const base = getServerUrl();
    if (isNativeApk() && !base) return;
    const wsUrl = base
      ? base.replace(/^http/i, 'ws') + '/ws'
      : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { delay = 1000; ws.send(JSON.stringify({ type: 'auth', token })); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = (e) => {
      if (!stop && e.code !== 4003) {
        clearReconnect();
        reconnectTimer = setTimeout(open, (delay = Math.min(delay * 2, 15000)));
      }
    };
  };
  open();
  return () => {
    stop = true;
    clearReconnect();
    try { ws?.close(); } catch {}
  };
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
if (typeof document !== 'undefined' && !document.getElementById('_mapCSS')) {
  const style = document.createElement('style');
  style.id = '_mapCSS';
  style.textContent = `
    .pulsing-dot {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid var(--text-primary); box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      position: relative;
    }
  `;
  document.head.appendChild(style);
}

function buildTileLayer(key) {
  const cfg = MAP_STYLES[key] || MAP_STYLES.google;
  const proxyUrl = () => (getServerUrl() || '') + cfg.proxy;
  const forceProxy = sStore.getItem('mashwar_tile_proxy') === '1';
  const layer = L.tileLayer(forceProxy ? proxyUrl() : cfg.direct, cfg.opts);
  let errs = 0, proxied = forceProxy;
  layer.on('tileerror', () => {
    if (!proxied && ++errs >= 2) {
      proxied = true;
      sStore.setItem('mashwar_tile_proxy', '1');
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

  let saved = lStore.getItem('mashwar_map_style') || 'google';
  if (!layers[saved]) saved = 'google';
  let currentKey = saved;
  layers[currentKey].addTo(m);

  m._tileLayers = layers;
  m.setMapStyle = (key) => {
    if (!layers[key] || key === currentKey) return;
    m.removeLayer(layers[currentKey]);
    currentKey = key;
    layers[currentKey].addTo(m);
    lStore.setItem('mashwar_map_style', key);
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
  html: `<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6))">${esc(e)}</div>`,
  className: '', iconSize: [28, 28], iconAnchor: [14, 14],
});

export function pickLocation(map, onPick) {
  let mk;
  const setMarker = (lat, lng) => {
    const ll = L.latLng(lat, lng);
    if (mk) mk.setLatLng(ll);
    else mk = L.marker(ll, { icon: emoji('📍') }).addTo(map);
    return mk;
  };
  const clearMarker = () => {
    if (mk) {
      mk.remove();
      mk = null;
    }
  };
  map.on('click', (e) => {
    setMarker(e.latlng.lat, e.latlng.lng);
    onPick(e.latlng.lat, e.latlng.lng);
  });
  return { setMarker, clearMarker };
}

const ROUTE_CACHE_TTL_MS = 60_000;
const ROUTE_CACHE_MAX = 250;
const OSRM_TIMEOUT_MS = 6_000;
const routeCache = new Map();
const roundCoord4 = (n) => Number(n).toFixed(4);

/** Compute the OSRM route cache key rounded to 4 decimals + travel mode. */
export const makeRouteCacheKey = (from, to, mode = 'driving') =>
  `${mode}:${roundCoord4(from[0])},${roundCoord4(from[1])}->${roundCoord4(to[0])},${roundCoord4(to[1])}`;

/** Clear the browser OSRM route cache (testing helper). */
export const clearRouteCache = () => routeCache.clear();

async function fetchWithTimeout(url, ms = OSRM_TIMEOUT_MS) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  if (ac) {
    timer = setTimeout(() => ac.abort(), ms);
    timer.unref?.();
  }
  try {
    return await fetch(url, ac ? { signal: ac.signal } : undefined);
  } finally {
    clearTimeout(timer);
  }
}

export async function makeRoute(map, from, to, mode = 'driving') {
  const safeMode = encodeURIComponent(mode || 'driving');
  const key = makeRouteCacheKey(from, to, mode || 'driving');
  const now = Date.now();
  const cached = routeCache.get(key);
  if (cached?.coords && cached.expiresAt > now) {
    return L.polyline(cached.coords, { color: '#F5B700', weight: 5, opacity: 0.92 }).addTo(map);
  }

  let coordsPromise = cached?.inFlight;
  if (!coordsPromise) {
    const directUrl = `https://router.project-osrm.org/route/v1/${safeMode}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const proxyUrl = `${getServerUrl()}/api/route?from=${encodeURIComponent(from[0] + ',' + from[1])}&to=${encodeURIComponent(to[0] + ',' + to[1])}`;

    coordsPromise = (async () => {
      for (const url of [directUrl, proxyUrl]) {
        try {
          const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
          if (!res.ok) continue;
          const data = await res.json();
          if (data.code === 'Ok' && data.routes?.length) {
            const coords = data.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
            routeCache.set(key, { coords, expiresAt: Date.now() + ROUTE_CACHE_TTL_MS });
            return coords;
          }
        } catch {}
      }
      routeCache.delete(key);
      return null;
    })();
    if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
    routeCache.set(key, { inFlight: coordsPromise, expiresAt: now + ROUTE_CACHE_TTL_MS });
  }

  const coords = await coordsPromise;
  if (coords) {
    return L.polyline(coords, { color: '#F5B700', weight: 5, opacity: 0.92 }).addTo(map);
  }
  return L.polyline([from, to], { color: '#F5B700', weight: 4, opacity: 0.8, dashArray: '10 8' }).addTo(map);
}

/** Calculate distance in meters between two coordinates via Haversine. */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const STALE_RECOVERY_BACKOFF_MS = [60_000, 120_000, 180_000];

/** Normalize browser GeolocationPosition using monotonic callback receivedAt and bounded clock-skew-safe initialAge. */
export function normalizeGpsReading(position, now = Date.now()) {
  const coords = position?.coords || {};
  const rawAcc = coords.accuracy;
  const hasAcc = rawAcc !== undefined && rawAcc !== null && rawAcc !== '' && typeof rawAcc !== 'boolean';
  const accNum = hasAcc ? Number(rawAcc) : NaN;
  const accuracy = Number.isFinite(accNum) && accNum >= 0 ? Math.round(accNum * 10) / 10 : null;
  const receivedAt = Number.isFinite(Number(now)) ? Math.round(Number(now)) : Date.now();
  const rawTs = Number(position?.timestamp);
  const delta = Number.isFinite(rawTs) ? Math.round(receivedAt - rawTs) : NaN;
  const initialAge = Number.isFinite(delta) && delta >= 0 && delta <= 60_000 ? delta : 0;
  return {
    lat: Number(coords.latitude),
    lng: Number(coords.longitude),
    ...(accuracy != null ? { accuracy } : {}),
    receivedAt,
    initialAge,
  };
}

/** Decide whether a watchPosition reading should replace currentPos (uses monotonic receivedAt, never p.timestamp). */
export function shouldAcceptGpsReading(reading, currentPos, lastGoodFixAt = 0, now = Date.now(), { maxAccuracyM = 100, goodFixGraceMs = 60_000 } = {}) {
  if (!reading || !Number.isFinite(reading.lat) || !Number.isFinite(reading.lng)) return false;
  if (reading.accuracy != null && reading.accuracy > maxAccuracyM) {
    if (!currentPos) return true;
    const goodAgeMs = now - (Number(lastGoodFixAt) || Number(currentPos.receivedAt) || 0);
    return goodAgeMs > goodFixGraceMs;
  }
  return true;
}

/** Evaluate whether captain.js should send current pos, wait, or trigger stale recovery (using receivedAt + clock-skew-safe fix_age_ms). */
export function evaluateCaptainLocationSend({
  pos,
  st,
  lastSent = 0,
  lastSentPos = null,
  now = Date.now(),
  staleMaxAgeMs = 30_000,
  moveTriggerM = 50,
  idleMovedIntervalMs = 15_000,
}) {
  if (!st?.online || !pos) return { action: 'skip', reason: 'offline_or_empty' };
  const receivedAt = Number(pos.receivedAt) || 0;
  const staleAgeMs = Math.max(0, now - receivedAt);
  if (!receivedAt || staleAgeMs > staleMaxAgeMs) {
    return { action: 'refresh_stale', fixAgeMs: staleAgeMs };
  }
  const activeMs = Number(st.intervals?.active) || 10_000;
  const idleMs = Number(st.intervals?.idle) || 60_000;
  const idleMovedGap = Math.min(idleMs, Math.max(activeMs, idleMovedIntervalMs));
  const movedM = lastSentPos && Number.isFinite(lastSentPos.lat) && Number.isFinite(lastSentPos.lng)
    ? haversineMeters(lastSentPos.lat, lastSentPos.lng, pos.lat, pos.lng)
    : Infinity;
  const isIdleMoved = !st.active && movedM >= moveTriggerM;
  const targetGap = st.active ? activeMs : (isIdleMoved ? idleMovedGap : idleMs);
  const elapsedMs = now - (Number(lastSent) || 0);
  if (elapsedMs < targetGap) {
    return { action: 'wait', movedM, elapsedMs, targetGap };
  }
  const initialAge = Math.max(0, Math.min(60_000, Number(pos.initialAge) || 0));
  const fixAgeMs = Math.max(0, Math.min(60_000, Math.round((now - receivedAt) + initialAge)));
  return {
    action: 'send',
    reason: movedM >= moveTriggerM ? 'moved' : 'interval',
    movedM,
    payload: {
      lat: pos.lat,
      lng: pos.lng,
      ...(pos.accuracy != null ? { accuracy: pos.accuracy } : {}),
      fix_age_ms: fixAgeMs,
    },
  };
}

/** Skip web POSTs only when the native Android app's tracking bridge confirms a recent upload. */
export function shouldSkipWebLocationPost(nativeBridge) {
  if (!nativeBridge) return false;
  try {
    if (typeof nativeBridge.isNativeTrackingActive !== 'function') return false;
    return Boolean(nativeBridge.isNativeTrackingActive());
  } catch {
    return false;
  }
}

/** Backoff scheduler for restarting watchPosition + getFreshGps: 30s initial, then 60s -> 120s -> 180s cap, visible & online only. */
export function evaluateStaleRecovery({
  decision,
  online,
  visible,
  now = Date.now(),
  lastRecoveryAt = 0,
  attempts = 0,
  inFlight = false,
}) {
  if (decision?.action !== 'refresh_stale' || !online || !visible || inFlight) {
    return { shouldRecover: false, waitMs: 0 };
  }
  if (attempts <= 0) {
    return { shouldRecover: true, nextAttempts: 1, cooldownMs: 0 };
  }
  const idx = Math.min(attempts - 1, STALE_RECOVERY_BACKOFF_MS.length - 1);
  const cooldownMs = STALE_RECOVERY_BACKOFF_MS[idx];
  const elapsed = now - (Number(lastRecoveryAt) || 0);
  if (elapsed < cooldownMs) {
    return { shouldRecover: false, waitMs: cooldownMs - elapsed, cooldownMs };
  }
  return { shouldRecover: true, nextAttempts: attempts + 1, cooldownMs };
}

export function animateMarker(marker, newLatLng, duration = 1000) {
  if (marker?._animRafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(marker._animRafId);
    marker._animRafId = null;
  }
  const start = performance.now();
  const from = marker.getLatLng();
  const to = L.latLng(newLatLng);
  if (from.lat === to.lat && from.lng === to.lng) return;
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;

  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    marker.setLatLng([from.lat + dLat * ease, from.lng + dLng * ease]);
    if (t < 1) {
      marker._animRafId = requestAnimationFrame(step);
    } else {
      marker._animRafId = null;
    }
  }
  marker._animRafId = requestAnimationFrame(step);
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

export function createPulsingDot(color = '#10B981') {
  const safeColor = esc(String(color || '#10B981').replace(/[^#a-zA-Z0-9(),.% -]/g, '')) || '#10B981';
  return L.divIcon({
    html: `<div class="pulsing-dot" style="background:${safeColor}"></div>`,
    className: '', iconSize: [14, 14], iconAnchor: [7, 7],
  });
}

// ---------- login / register ----------
function showAuthRetryBanner(_err, role) {
  const el = document.getElementById('auth');
  if (!el) return;
  el.classList.remove('hide');
  el.innerHTML = `
    <div class="card" style="text-align:center;padding:var(--space-6)">
      <div style="font-size:48px;margin-bottom:var(--space-3)">📡</div>
      <h2 style="margin:0 0 var(--space-3);color:var(--text-primary)">تعذّر الاتصال بالسيرفر</h2>
      <p class="mut" style="margin-bottom:var(--space-4)">يرجى التحقق من اتصال الإنترنت</p>
      <button type="button" class="ok" id="authRetryBtn" style="width:100%;min-height:var(--touch-jumbo)">🔄 إعادة المحاولة</button>
      <button type="button" class="ghost sm" id="authResetBtn" style="width:100%;margin-top:var(--space-3)">تسجيل الخروج وإعادة الدخول</button>
    </div>
  `;
  $('#authRetryBtn', el).onclick = () => location.reload();
  $('#authResetBtn', el).onclick = () => {
    sStore.clear();
    lStore.removeItem('panther_token_' + (role || 'app'));
    lStore.removeItem('panther_token_admin');
    lStore.removeItem('panther_token_merchant');
    lStore.removeItem('panther_token_captain');
    location.reload();
  };
}

export async function authScreen(role, onReady) {
  const root = $('#auth');
  const wantInstall = role !== 'admin' && new URLSearchParams(location.search).get('install') === '1';
  if (token) {
    try {
      const me = await api('/me');
      if (me.role === role || (role === 'admin' && me.role === 'zone_admin')) {
        onReady(me);
        if (wantInstall) setTimeout(() => promptInstallApp(role), 350);
        return;
      }
      // Role mismatch: legitimately clear (user switched roles)
      setToken(null);
    } catch (err) {
      // Only clear on 401 (token expired/invalid). Keep on network errors.
      if (err && (err.status === 401 || err.message?.includes('401') || err.message?.includes('Unauthorized'))) {
        setToken(null);
      } else {
        // Network/server error: keep token, show retry banner, do NOT clear
        showAuthRetryBanner(err, role);
        return;
      }
    }
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
      <div class="brand-emblem-wrap">
        <img src="brand/panther-mark-reversed.png" alt="PANTHER DELIVERY" class="brand-logo-lg" width="128" height="67">
        <span class="brand-role-pill">${roleIcon} ${esc(roleLabel)}</span>
      </div>
      <div class="brand-title-gradient" lang="en" dir="ltr">PANTHER DELIVERY</div>
      <div class="brand-sub"><span lang="en" dir="ltr">B2B SMART DISPATCH</span> • نظام التوصيل الذكي</div>
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
      const matchesRole = r.user.role === role || (role === 'admin' && r.user.role === 'zone_admin');
      if (!matchesRole) {
        const targetRoute = r.user.role === 'zone_admin' ? 'admin' : r.user.role;
        if (['admin', 'merchant', 'captain'].includes(targetRoute)) {
          setToken(r.token);
          lStore.setItem('panther_token_' + targetRoute, r.token);
          location.href = '/' + targetRoute;
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
  const installBtn = !isStandalone() && ROLE_KEY !== 'admin'
    ? `<button type="button" class="ok sm" data-install-app="${esc(ROLE_KEY)}">📲 تثبيت</button>`
    : '';
  const srvBtn = (isNativeApk() || getServerUrl())
    ? `<button type="button" class="ghost sm" data-server-cfg="1" title="إعدادات السيرفر">🌐 السيرفر</button>`
    : '';
  h.innerHTML = `
    <h1>
      <img src="brand/panther-mark-reversed.png" alt="PANTHER" class="brand-logo-sm" width="48" height="25">
      <div class="hdr-brand-stack">
        <span class="brand-title-sm" lang="en" dir="ltr">PANTHER <span class="brand-delivery-sub">DELIVERY</span></span>
        <span class="hdr-role-tag">${esc(title)}</span>
      </div>
    </h1>
    <div class="hdr-right-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="hdr-user-chip">👤 ${esc(user.business_name || user.name)}</span>
      ${srvBtn}${installBtn}
      <button type="button" class="sec sm" id="lo">خروج</button>
    </div>`;
  document.body.prepend(h);
  if (!document.body.classList.contains('ad')) {
    const actionsEl = h.querySelector('.hdr-right-actions');
    const logoutEl = h.querySelector('#lo');
    mountNotificationsBell(actionsEl, { insertBefore: logoutEl });
  }
  $('#lo', h).onclick = async () => {
    await performLogout({
      isCaptain: user?.role === 'captain' || ROLE_KEY === 'captain',
      onBeforeClear: onLogout,
    });
  };
}

let capModalMap = null;
function destroyCapModalMap() {
  if (!capModalMap) return;
  try { capModalMap.stop?.(); } catch {}
  try { capModalMap.remove(); } catch {}
  capModalMap = null;
}

/** Captain details modal: name, phone, live location on a map, and a direct call button. */
export function captainModal(cap) {
  if (!cap) return;
  destroyCapModalMap();
  document.getElementById('capmodal')?.remove();
  const el = document.createElement('div');
  el.id = 'capmodal';
  el.style.cssText = 'position:fixed;inset:0;z-index:var(--z-modal);background:var(--surface-overlay);backdrop-filter:var(--blur-sm);display:grid;place-items:center;padding:var(--space-4)';
  const hasLoc = cap.lat != null && cap.lng != null;
  const safeTel = String(cap.phone || '').replace(/[^0-9+*#()-]/g, '');
  el.innerHTML = `<div class="card" style="width:100%;max-width:440px">
    <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">🛵 ${esc(cap.name)}</h3><button type="button" class="ghost" id="capx">✕</button></div>
    <p style="margin:10px 0">📞 <b dir="ltr">${esc(cap.phone || '—')}</b></p>
    ${hasLoc ? '<div id="capmap" class="map" style="height:240px"></div>' : '<div class="mut">موقع الكابتن غير متوفر حالياً</div>'}
    ${safeTel ? `<a href="tel:${esc(safeTel)}" style="display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:var(--touch-min);text-align:center;margin-top:12px;padding:12px;border-radius:12px;background:var(--status-ok);color:var(--text-on-ok);font-weight:800;text-decoration:none">📞 اتصال مباشر</a>` : ''}
  </div>`;
  document.body.appendChild(el);
  const close = () => {
    destroyCapModalMap();
    el.remove();
  };
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector('#capx').onclick = close;
  if (hasLoc) {
    capModalMap = makeMap('capmap', [cap.lat, cap.lng], 15);
    L.marker([cap.lat, cap.lng], { icon: emoji('🛵') }).addTo(capModalMap).bindTooltip(esc(cap.name || ''));
    setTimeout(() => { if (capModalMap) capModalMap.invalidateSize(); }, 60);
  }
}

// ---------- Shared Web Audio Alarm Sound Library (Captain fixed melody & Admin library) ----------
export const CAPTAIN_TONES = [
  { id: 'order_melody', key: 'order_melody', label: 'نغمة الطلب الجديد', repeatMs: 2720 },
];

export const ALARM_SOUNDS = [
  { id: 'classic', label: 'كلاسيكي', repeatMs: 1850 },
  { id: 'rapid', label: 'سريع', repeatMs: 1350 },
  { id: 'high', label: 'عالي', repeatMs: 1700 },
  { id: 'double_pulse', label: 'ثلاث نبضات - طلب جديد', repeatMs: 1920 },
  { id: 'calm', label: 'هادئ', repeatMs: 2400 },
];

const LEGACY_TONE_MAP = {
  classic: 'classic',
  rapid: 'rapid',
  high: 'high',
  pulse: 'double_pulse',
  double_pulse: 'double_pulse',
  calm: 'calm',
  soft_bell: 'calm',
  marimba: 'calm',
  chime: 'calm',
};

const ALARM_PATTERNS = {
  classic: {
    repeatMs: 1850,
    steps: [
      { type: 'triangle', freq: 784, offsetSec: 0, durSec: 0.34, peak: 0.27, attackSec: 0.015 },
      { type: 'triangle', freq: 587.33, offsetSec: 0.36, durSec: 0.40, peak: 0.25, attackSec: 0.015 },
    ],
  },
  rapid: {
    repeatMs: 1350,
    steps: [
      { type: 'triangle', freq: 880, offsetSec: 0, durSec: 0.12, peak: 0.26, attackSec: 0.008 },
      { type: 'triangle', freq: 1174.66, offsetSec: 0.15, durSec: 0.12, peak: 0.26, attackSec: 0.008 },
      { type: 'triangle', freq: 880, offsetSec: 0.30, durSec: 0.12, peak: 0.26, attackSec: 0.008 },
      { type: 'triangle', freq: 1174.66, offsetSec: 0.45, durSec: 0.14, peak: 0.26, attackSec: 0.008 },
    ],
  },
  high: {
    repeatMs: 1700,
    steps: [
      { type: 'sine', freq: 1174.66, offsetSec: 0, durSec: 0.20, peak: 0.24, attackSec: 0.01 },
      { type: 'sine', freq: 1567.98, offsetSec: 0.17, durSec: 0.22, peak: 0.24, attackSec: 0.01 },
      { type: 'sine', freq: 1975.53, offsetSec: 0.34, durSec: 0.32, peak: 0.22, attackSec: 0.01 },
    ],
  },
  double_pulse: {
    repeatMs: 1920,
    maxGain: 0.42,
    steps: [
      { type: 'triangle', freq: 1100, offsetSec: 0, durSec: 0.20, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1100, offsetSec: 0.31, durSec: 0.20, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1100, offsetSec: 0.62, durSec: 0.20, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
    ],
  },
  calm: {
    repeatMs: 2400,
    steps: [
      { type: 'sine', freq: 392, offsetSec: 0, durSec: 0.42, peak: 0.21, attackSec: 0.045 },
      { type: 'sine', freq: 493.88, offsetSec: 0.28, durSec: 0.48, peak: 0.21, attackSec: 0.045 },
      { type: 'sine', freq: 587.33, offsetSec: 0.58, durSec: 0.58, peak: 0.20, attackSec: 0.05 },
    ],
  },
};

const CAPTAIN_PATTERNS = {
  order_melody: {
    repeatMs: 2720,
    maxGain: 0.42,
    steps: [
      { type: 'triangle', freq: 880, offsetSec: 0, durSec: 0.16, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1760, offsetSec: 0, durSec: 0.16, peak: 0.42 * 0.20, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1100, offsetSec: 0.20, durSec: 0.16, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 2200, offsetSec: 0.20, durSec: 0.16, peak: 0.42 * 0.20, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1320, offsetSec: 0.40, durSec: 0.16, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 2640, offsetSec: 0.40, durSec: 0.16, peak: 0.42 * 0.20, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 1760, offsetSec: 0.60, durSec: 0.32, peak: 0.42, attackSec: 0.008, releaseSec: 0.008 },
      { type: 'triangle', freq: 3520, offsetSec: 0.60, durSec: 0.32, peak: 0.42 * 0.20, attackSec: 0.008, releaseSec: 0.008 },
    ],
  },
};

export function normalizeCaptainTone(_tone) {
  return 'order_melody';
}

export function normalizeAdminTone(tone) {
  if (tone == null || tone === '' || tone === 'default') return 'default';
  return LEGACY_TONE_MAP[tone] || 'default';
}

function playOscillatorSteps(actx, steps, repeatMs, { maxGain = 0.28, hardSquare = false } = {}) {
  const now = actx.currentTime;
  const nodes = [];

  for (const s of steps) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    const t0 = now + s.offsetSec;
    const tEnd = t0 + s.durSec;
    o.type = s.type;
    o.frequency.setValueAtTime(s.freq, t0);
    for (const ramp of s.freqRamps || []) {
      o.frequency.linearRampToValueAtTime(ramp.freq, t0 + ramp.offsetSec);
    }
    if (hardSquare) {
      g.gain.setValueAtTime(s.peak, t0);
    } else if (s.releaseSec) {
      const peak = Math.min(s.peak, maxGain);
      const tAtk = t0 + Math.min(s.attackSec || 0.008, s.durSec * 0.4);
      const tRel = Math.max(tAtk, tEnd - Math.min(s.releaseSec, s.durSec * 0.4));
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, tAtk);
      g.gain.setValueAtTime(peak, tRel);
      g.gain.linearRampToValueAtTime(0.0001, tEnd);
    } else {
      const tAtk = t0 + Math.min(s.attackSec || 0.012, s.durSec * 0.4);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(Math.min(s.peak, maxGain), tAtk);
      g.gain.exponentialRampToValueAtTime(0.0001, tEnd);
    }
    o.connect(g);
    g.connect(actx.destination);
    o.start(t0);
    o.stop(hardSquare || s.releaseSec ? tEnd : tEnd + 0.015);
    nodes.push({ o, g });
  }

  return {
    repeatMs,
    stop() {
      for (const { o, g } of nodes) {
        try { o.stop(); } catch {}
        try { o.disconnect(); g.disconnect(); } catch {}
      }
      nodes.length = 0;
    },
  };
}

/**
 * Plays one cycle of the captain's fixed alarm melody ('order_melody').
 * Returns { stop, repeatMs }.
 */
export function playCaptainTone(actx, key = 'order_melody') {
  const tone = normalizeCaptainTone(key);
  const spec = CAPTAIN_PATTERNS[tone];
  return playOscillatorSteps(actx, spec.steps, spec.repeatMs, { maxGain: spec.maxGain || 0.42 });
}

/**
 * Gates the captain offer alarm so it starts only once when a new offered order appears
 * (by offer ID), stays silent across refreshes or status updates, and stops when cleared or offline.
 */
export function createCaptainAlarmGate({ onStart, onStop } = {}) {
  let lastAlarmOfferId = null;
  return {
    syncOffer(offer, { online = true } = {}) {
      if (!online || !offer || offer.id == null || (offer.status && offer.status !== 'offered')) {
        lastAlarmOfferId = null;
        onStop?.();
        return { started: false, stopped: true, lastAlarmOfferId: null };
      }
      if (offer.id !== lastAlarmOfferId) {
        lastAlarmOfferId = offer.id;
        onStart?.(offer);
        return { started: true, stopped: false, lastAlarmOfferId };
      }
      return { started: false, stopped: false, lastAlarmOfferId };
    },
    reset() {
      lastAlarmOfferId = null;
      onStop?.();
    },
    getLastOfferId() {
      return lastAlarmOfferId;
    },
  };
}

/**
 * Plays an admin alarm sound cycle: preserves legacy 1050Hz/700Hz siren for 'default'
 * or plays the chosen sound from the shared 5-sound library.
 */
export function playAdminTone(actx, rawTone = 'default') {
  const tone = normalizeAdminTone(rawTone);
  if (tone === 'default') {
    return playOscillatorSteps(
      actx,
      [
        { type: 'square', freq: 1050, offsetSec: 0, durSec: 0.35, peak: 0.85 },
        { type: 'square', freq: 700, offsetSec: 0.35, durSec: 0.35, peak: 0.85 },
      ],
      700,
      { maxGain: 0.9, hardSquare: true }
    );
  }
  const spec = ALARM_PATTERNS[tone] || ALARM_PATTERNS.calm;
  return playOscillatorSteps(actx, spec.steps, spec.repeatMs, { maxGain: spec.maxGain || 0.28 });
}

// ---------- Shared One-Way Notifications Inbox (Bell + Modal Dialog) ----------
let _notifCtrl = null;

/** Returns the active notifications inbox controller if mounted on this page. */
export function getNotificationsController() {
  return _notifCtrl;
}

/**
 * Mounts the notification bell button with unread badge and native <dialog> inbox
 * into a page header container, reusing a single page controller instance.
 */
export function mountNotificationsBell(containerEl, { insertBefore = null } = {}) {
  if (typeof document === 'undefined' || !containerEl) return _notifCtrl;

  if (!_notifCtrl) {
    let unreadCount = 0;
    let activeOfferState = null;
    const listeners = new Set();

    const notifyListeners = (evt) => {
      for (const fn of listeners) {
        try { fn(evt); } catch {}
      }
    };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'notifBellBtn';
    btn.className = 'sec sm notif-bell-btn';
    btn.setAttribute('aria-label', 'صندوق الإشعارات');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = `
      <span class="notif-bell-ico" aria-hidden="true">🔔</span>
      <span id="notifUnreadBadge" class="notif-unread-badge hide" dir="ltr">0</span>`;

    const dlg = document.createElement('dialog');
    dlg.id = 'notifInboxDialog';
    dlg.className = 'notif-inbox-dialog';
    dlg.setAttribute('aria-labelledby', 'notifInboxTitle');
    dlg.setAttribute('closedby', 'any');
    dlg.innerHTML = `
      <div id="notifOfferPrioritySlot" class="notif-offer-priority-slot hide" role="region" aria-label="عرض توصيل نشط له الأولوية"></div>
      <div class="card notif-inbox-card">
        <div class="notif-inbox-head">
          <div class="notif-inbox-title-wrap">
            <h3 id="notifInboxTitle">🔔 الإشعارات</h3>
            <span id="notifInboxUnreadSummary" class="badge">0 غير مقروء</span>
          </div>
          <div class="notif-inbox-head-actions">
            <button type="button" id="notifMarkAllReadBtn" class="sec sm notif-mark-all-btn hide">✓ تعليم الكل كمقروء</button>
            <button type="button" id="notifInboxClose" class="sec sm notif-inbox-close" aria-label="إغلاق صندوق الإشعارات" autofocus>✕ إغلاق</button>
          </div>
        </div>
        <div id="notifInboxGroupSummary" class="notif-group-inline hide" role="status" aria-live="polite"></div>
        <div id="notifInboxStatus" class="mut notif-inbox-status hide" aria-live="polite"></div>
        <div id="notifInboxList" class="notif-inbox-list" role="list"></div>
      </div>`;
    document.body.appendChild(dlg);

    const badgeEl = btn.querySelector('#notifUnreadBadge');
    const summaryEl = dlg.querySelector('#notifInboxUnreadSummary');
    const groupInlineEl = dlg.querySelector('#notifInboxGroupSummary');
    const markAllBtn = dlg.querySelector('#notifMarkAllReadBtn');
    const statusEl = dlg.querySelector('#notifInboxStatus');
    const listEl = dlg.querySelector('#notifInboxList');
    const offerSlotEl = dlg.querySelector('#notifOfferPrioritySlot');
    const closeBtn = dlg.querySelector('#notifInboxClose');

    const syncUnreadUi = () => {
      const n = Math.max(0, Number(unreadCount) || 0);
      unreadCount = n;
      badgeEl.textContent = n > 99 ? '99+' : String(n);
      badgeEl.classList.toggle('hide', n === 0);
      btn.setAttribute('aria-label', n > 0 ? `صندوق الإشعارات (${n} غير مقروء)` : 'صندوق الإشعارات');
      summaryEl.textContent = n > 0 ? `${enDigits(n)} غير مقروء` : 'لا توجد رسائل جديدة';
      summaryEl.className = n > 0 ? 'badge b-searching' : 'badge';

      if (n > 5) {
        groupInlineEl.textContent = `📩 لديك ${enDigits(n)} رسائل جديدة — الأحدث أولاً`;
        groupInlineEl.classList.remove('hide');
      } else {
        groupInlineEl.textContent = '';
        groupInlineEl.classList.add('hide');
      }

      const hasDomList = listEl.querySelectorAll('.notif-item').length > 0;
      const regularUnreadDom = listEl.querySelectorAll('.notif-item.is-unread:not([data-pinned-ack="1"])').length;
      const showMarkAll = hasDomList ? regularUnreadDom > 0 : n > 0;
      markAllBtn.classList.toggle('hide', !showMarkAll);
    };

    const setUnreadCount = (n) => {
      unreadCount = Math.max(0, Number(n) || 0);
      syncUnreadUi();
      notifyListeners({ type: 'unread', unreadCount });
    };

    const refreshUnreadCount = async () => {
      try {
        const r = await api('/notifications/unread-count');
        setUnreadCount(r?.unread_count ?? 0);
      } catch {}
    };

    const statePillHtml = (isRead) => (isRead
      ? '<span class="notif-state-pill is-read"><span class="notif-state-shape" aria-hidden="true">✓</span><span class="notif-state-text">مقروء</span></span>'
      : '<span class="notif-state-pill is-unread"><span class="notif-state-shape" aria-hidden="true">●</span><span class="notif-state-text">جديد</span></span>');

    const markItemReadUi = (itemEl) => {
      if (!itemEl || itemEl.classList.contains('is-read')) return;
      itemEl.classList.remove('is-unread', 'is-ack-required');
      itemEl.classList.add('is-read');
      itemEl.removeAttribute('data-pinned-ack');
      itemEl.querySelector('.notif-ack-btn')?.remove();
      itemEl.querySelector('.notif-ack-pill')?.remove();
      const pill = itemEl.querySelector('.notif-state-pill');
      if (pill) pill.outerHTML = statePillHtml(true);
    };

    const syncItemExpandVisibility = (itemEl) => {
      if (!itemEl) return;
      const expandBtn = itemEl.querySelector('.notif-expand-btn');
      const bodyEl = itemEl.querySelector('.notif-item-body');
      if (!expandBtn || !bodyEl) return;
      if (itemEl.classList.contains('is-expanded')) {
        expandBtn.classList.remove('hide');
        return;
      }
      const text = bodyEl.textContent || '';
      const heuristicLong = text.length > 90 || (text.match(/\n/g)?.length || 0) >= 2;
      const visualOverflow = bodyEl.clientHeight > 0 && bodyEl.scrollHeight > bodyEl.clientHeight + 2;
      expandBtn.classList.toggle('hide', !(heuristicLong || visualOverflow));
    };

    const refreshListExpandVisibility = () => {
      for (const itemEl of listEl.querySelectorAll('.notif-item')) {
        syncItemExpandVisibility(itemEl);
      }
    };

    const refreshRelativeTimes = () => {
      const now = Date.now();
      for (const tEl of listEl.querySelectorAll('time[data-ts]')) {
        const ts = Number(tEl.dataset.ts);
        if (ts > 0) tEl.textContent = formatRelativeNotifTime(ts, now);
      }
    };

    const markNotificationRead = async (n, itemEl, actionBtn = null) => {
      if (!itemEl || itemEl.classList.contains('is-read')) return true;
      const triggerBtn = itemEl.querySelector('.notif-item-trigger');
      if (triggerBtn) triggerBtn.disabled = true;
      if (actionBtn) actionBtn.disabled = true;
      try {
        await api(`/notifications/${n.id}/read`, 'POST');
        markItemReadUi(itemEl);
        setUnreadCount(Math.max(0, unreadCount - 1));
        notifyListeners({ type: 'read', id: n.id, requires_ack: Boolean(n.requires_ack) });
        refreshUnreadCount();
        return true;
      } catch (err) {
        toast(err?.message || 'تعذر تحديث حالة القراءة');
        return false;
      } finally {
        if (triggerBtn) triggerBtn.disabled = false;
        if (actionBtn) actionBtn.disabled = false;
      }
    };

    const createInboxItemEl = (n) => {
      const isRead = Boolean(n.read || n.read_at);
      const isPinnedAck = Boolean(n.requires_ack && !isRead);
      const itemEl = document.createElement('article');
      itemEl.className = `notif-item ${isRead ? 'is-read' : 'is-unread'}${isPinnedAck ? ' is-ack-required' : ''}`;
      itemEl.dataset.notifId = String(n.id);
      if (isPinnedAck) itemEl.dataset.pinnedAck = '1';
      itemEl.setAttribute('role', 'listitem');

      const bodyText = String(n.body || '');
      const heuristicLong = bodyText.length > 90 || (bodyText.match(/\n/g)?.length || 0) >= 2;

      itemEl.innerHTML = `
        <button type="button" class="notif-item-trigger" aria-expanded="false">
          <div class="notif-item-top">
            ${isPinnedAck ? '<span class="notif-ack-pill">⚠️ يتطلب الموافقة</span>' : ''}
            <strong class="notif-item-title">${esc(n.title || '')}</strong>
          </div>
          <div class="notif-item-body">${esc(bodyText)}</div>
          <div class="notif-item-meta mut">
            <span class="notif-item-byline">
              <span>${esc(n.sender_name || 'الإدارة')}</span>
              <span aria-hidden="true">•</span>
              <time data-ts="${esc(n.created_at || '')}" title="${esc(time(n.created_at))}">${esc(formatRelativeNotifTime(n.created_at))}</time>
            </span>
            ${statePillHtml(isRead)}
          </div>
        </button>
        <div class="notif-item-actions">
          <button type="button" class="sec sm notif-expand-btn${heuristicLong ? '' : ' hide'}" aria-expanded="false">عرض المزيد</button>
          ${isPinnedAck ? '<button type="button" class="ok sm notif-ack-btn">✓ موافق</button>' : ''}
        </div>`;

      const triggerBtn = itemEl.querySelector('.notif-item-trigger');
      const expandBtn = itemEl.querySelector('.notif-expand-btn');
      const ackBtn = itemEl.querySelector('.notif-ack-btn');

      const toggleExpanded = () => {
        const expanded = itemEl.classList.toggle('is-expanded');
        triggerBtn?.setAttribute('aria-expanded', String(expanded));
        if (expandBtn) {
          expandBtn.textContent = expanded ? 'عرض أقل' : 'عرض المزيد';
          expandBtn.setAttribute('aria-expanded', String(expanded));
        }
        syncItemExpandVisibility(itemEl);
      };

      const handlePrimaryTap = async () => {
        toggleExpanded();
        if (!itemEl.dataset.pinnedAck) {
          await markNotificationRead(n, itemEl);
        }
      };

      triggerBtn.onclick = handlePrimaryTap;
      itemEl.onclick = (e) => {
        if (e.target.closest('button')) return;
        handlePrimaryTap();
      };
      if (expandBtn) {
        expandBtn.onclick = (e) => {
          e.stopPropagation();
          toggleExpanded();
        };
      }
      if (ackBtn) {
        ackBtn.onclick = async (e) => {
          e.stopPropagation();
          await markNotificationRead(n, itemEl, ackBtn);
        };
      }
      return itemEl;
    };

    const setStatus = (msg = '') => {
      if (!msg) {
        statusEl.textContent = '';
        statusEl.classList.add('hide');
      } else {
        statusEl.textContent = msg;
        statusEl.classList.remove('hide');
      }
    };

    const loadInbox = async () => {
      setStatus('⏳ جاري تحميل الإشعارات...');
      try {
        const rows = await api('/notifications/inbox');
        setStatus('');
        listEl.innerHTML = '';
        const prepared = sortAndPrepareNotifications(rows);
        if (!prepared.items.length) {
          listEl.innerHTML = '<div class="notif-empty mut">لا توجد إشعارات في صندوق الوارد حالياً</div>';
          setUnreadCount(0);
          return;
        }
        for (const n of prepared.items) {
          listEl.appendChild(createInboxItemEl(n));
        }
        setUnreadCount(prepared.unreadCount);
        requestAnimationFrame(() => {
          refreshListExpandVisibility();
          refreshRelativeTimes();
        });
      } catch (err) {
        setStatus(err?.message || 'تعذر تحميل الإشعارات');
      }
    };

    const markAllRead = async () => {
      if (markAllBtn.disabled) return;
      markAllBtn.disabled = true;
      try {
        const rows = await api('/notifications/inbox');
        const prepared = sortAndPrepareNotifications(rows);
        const idsToMark = prepared.regularUnreadIds;
        if (!idsToMark.length) {
          if (prepared.pinnedAckItems.length > 0) {
            toast(`⚠️ متبقي ${enDigits(prepared.pinnedAckItems.length)} إشعار يتطلب الضغط على «موافق»`, { tag: 'notif-ack-warn', replaceTag: true });
          } else {
            toast('لا توجد رسائل عادية غير مقروءة');
          }
          await refreshUnreadCount();
          return;
        }
        let marked = 0;
        const chunkSize = 5;
        for (let i = 0; i < idsToMark.length; i += chunkSize) {
          const chunk = idsToMark.slice(i, i + chunkSize);
          const settled = await Promise.allSettled(
            chunk.map(async (id) => {
              await api(`/notifications/${id}/read`, 'POST');
              return id;
            })
          );
          for (const res of settled) {
            if (res.status === 'fulfilled') {
              marked++;
              const itemEl = listEl.querySelector(`[data-notif-id="${res.value}"]`);
              if (itemEl) markItemReadUi(itemEl);
              notifyListeners({ type: 'read', id: res.value, requires_ack: false });
            }
          }
        }
        await refreshUnreadCount();
        const remainingAck = prepared.pinnedAckItems.length;
        if (marked > 0 && remainingAck > 0) {
          toast(`✅ تم تعليم ${enDigits(marked)} كمقروء — متبقي ${enDigits(remainingAck)} يتطلب موافقتك`);
        } else if (marked > 0) {
          toast('✅ تم تعليم جميع الإشعارات كمقروءة');
        }
      } catch (err) {
        toast(err?.message || 'تعذر تعليم الكل كمقروء');
      } finally {
        markAllBtn.disabled = false;
      }
    };

    const renderCaptainOfferPriority = () => {
      const o = activeOfferState?.offer;
      if (!o) {
        offerSlotEl.innerHTML = '';
        offerSlotEl.classList.add('hide');
        return;
      }
      const secs = Math.max(0, Math.round(((o.offer_expires_at || 0) - (Date.now() - (activeOfferState?.clockOffsetMs || 0))) / 1000));
      offerSlotEl.classList.remove('hide');
      offerSlotEl.innerHTML = `
        <div class="notif-offer-priority-head">
          <strong>⚡ عرض توصيل نشط — الأولوية للطلب <span dir="ltr">${serialNo(o)}</span></strong>
          <span class="badge b-offered" dir="ltr">⏱️ <span id="notifOfferLeft">${enDigits(secs)}</span>ث</span>
        </div>
        <div class="notif-offer-priority-meta">
          <div>🏪 <b>${esc(o.merchant?.name || 'منشأة')}</b></div>
          <div>📍 ${esc(o.customer_address || '—')}</div>
        </div>
        <div class="notif-offer-priority-actions">
          <button type="button" id="notifOfferAccBtn" class="ok">✅ قبول الطلب</button>
          <button type="button" id="notifOfferRejBtn" class="bad">✕ رفض</button>
        </div>`;

      const accBtn = offerSlotEl.querySelector('#notifOfferAccBtn');
      const rejBtn = offerSlotEl.querySelector('#notifOfferRejBtn');
      if (accBtn) {
        accBtn.onclick = async () => {
          accBtn.disabled = true;
          try { await activeOfferState?.onAccept?.(); } finally {
            accBtn.disabled = false;
            if (dlg.open) dlg.close();
          }
        };
      }
      if (rejBtn) {
        rejBtn.onclick = async () => {
          rejBtn.disabled = true;
          try { await activeOfferState?.onReject?.(); } finally {
            rejBtn.disabled = false;
            if (dlg.open) dlg.close();
          }
        };
      }
    };

    const openInbox = async () => {
      renderCaptainOfferPriority();
      if (!dlg.open) dlg.showModal();
      await loadInbox();
    };

    btn.onclick = () => openInbox();
    closeBtn.onclick = () => { if (dlg.open) dlg.close(); };
    markAllBtn.onclick = () => markAllRead();

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const outside = (e) => {
        const r = dlg.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      dlg.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
      dlg.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e) && dlg.open) dlg.close(); });
    }

    _notifCtrl = {
      button: btn,
      dialog: dlg,
      get unreadCount() { return unreadCount; },
      open: openInbox,
      close: () => { if (dlg.open) dlg.close(); },
      refreshUnreadCount,
      markAllRead,
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      syncCaptainOffer(offerState) {
        activeOfferState = offerState?.offer ? offerState : null;
        renderCaptainOfferPriority();
      },
      updateCaptainOfferCountdown(secs) {
        const el = offerSlotEl.querySelector('#notifOfferLeft');
        if (el) el.textContent = enDigits(Math.max(0, Number(secs) || 0));
      },
      handleWsNotification(msg) {
        const n = msg?.notification;
        setUnreadCount(unreadCount + 1);
        if (dlg.open && n && n.id != null && !listEl.querySelector(`[data-notif-id="${n.id}"]`)) {
          listEl.querySelector('.notif-empty')?.remove();
          const el = createInboxItemEl({ ...n, read: false, read_at: null });
          if (n.requires_ack) {
            listEl.prepend(el);
          } else {
            const pinned = listEl.querySelectorAll('[data-pinned-ack="1"]');
            if (pinned.length > 0) pinned[pinned.length - 1].after(el);
            else listEl.prepend(el);
          }
          syncUnreadUi();
          requestAnimationFrame(() => syncItemExpandVisibility(el));
        }
        refreshUnreadCount();
      },
    };

    refreshUnreadCount();
  }

  const bellBtn = _notifCtrl.button;
  if (insertBefore && insertBefore.parentElement === containerEl) {
    containerEl.insertBefore(bellBtn, insertBefore);
  } else if (bellBtn.parentElement !== containerEl) {
    containerEl.appendChild(bellBtn);
  }
  return _notifCtrl;
}
