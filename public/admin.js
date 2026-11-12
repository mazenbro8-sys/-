import { $, $$, esc, points, time, badge, STATUS, api, act, toast, connectWs, authScreen, header, makeMap, pickLocation, emoji, DAMASCUS, captainModal, animateMarker, makeRoute, fitMapToPoints, createPulsingDot, enDigits, serialNo, renderInstallBanner, isStandalone } from './shared.js?v=panther2026v24';
import { getCaptainVisualState as deriveCaptainVisualState } from './live-state.js?v=panther2026v22';

const toDtLocal = (ms) => {
  if (ms == null) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function matchOrder(o, rawQ, stFilter = '') {
  if (stFilter && o.status !== stFilter) return false;
  const q = enDigits(rawQ || '').trim().toLowerCase();
  if (!q) return true;
  const qNum = q.replace(/^#/, '');
  const idStr = String(o.id);
  const serStr = String(o.serial_no || o.id).padStart(4, '0');
  if (qNum && (idStr.includes(qNum) || serStr.includes(qNum) || Number(qNum) === o.id)) return true;
  const hay = [
    o.merchant?.name,
    o.customer_address,
    o.captain?.name,
    o.captain_name,
    o.customer_name,
    o.customer_phone,
    STATUS[o.status],
  ].filter(Boolean).join(' ').toLowerCase();
  return enDigits(hay).includes(q);
}

authScreen('admin', (user) => {
  header('الإدارة', user);
  const app = $('#app'); app.classList.remove('hide');
  const TABS = {
    dash: '📊 لوحة التحكم',
    live: '📡 غرفة العمليات',
    users: '🏪 الحسابات',
    orders: '📦 الطلبات',
    wallet: '💰 المحفظة',
    settings: '⚙️ المناطق والإعدادات',
  };
  app.innerHTML = `<aside class="sb"><div class="logo"><img src="/brand/panther-mark-reversed.png" alt="PANTHER" class="brand-logo-sm" width="48" height="25"><div style="line-height:1.15"><div lang="en" dir="ltr"><span class="brand-pan">PAN</span><span class="brand-ther">THER</span></div><small style="font-size:10.5px;color:var(--brand-primary);letter-spacing:1.2px;display:block;font-weight:700"><span lang="en" dir="ltr">DELIVERY</span> • توصيل</small></div></div>
    <nav class="nav tabs">${Object.entries(TABS).map(([k, v]) => `<button data-t="${k}">${v}</button>`).join('')}</nav>
    <div class="sbfoot"><div class="av">${esc((user.name || 'A').slice(0, 1))}</div><b>${esc(user.name || 'المدير')}</b><button id="lo2">خروج</button></div></aside>
    <section class="main">
      <div class="topbar2">
        <div class="topbar-brand">
          <img src="/brand/panther-mark-reversed.png" alt="PANTHER" class="brand-logo-sm topbar-logo" width="46" height="24">
          <div class="topbar-title-stack">
            <span class="topbar-wordmark" lang="en" dir="ltr">PANTHER <span class="brand-delivery-sub">DELIVERY</span></span>
            <h2 id="ptitle"></h2>
          </div>
        </div>
        <div class="topbar-actions">
          ${!isStandalone() ? '<button type="button" class="ok sm" data-install-app="admin">📲 تثبيت تطبيق الإدارة</button>' : ''}
          <button type="button" id="adminAddOrderTop" class="ok sm"><span class="lbl-desk">➕ إضافة طلب لكابتن</span><span class="lbl-mob">➕ طلب</span></button>
          <button type="button" id="adminSndBtn" class="bad sm" aria-label="صوت إنذار الطلبات"><span class="snd-ico">🔇</span><span class="lbl-desk"> تفعيل صوت إنذار الطلبات</span></button>
          <div class="clock"><b id="clk"></b><span id="dt"></span></div>
        </div>
      </div>
      <div class="admin-install-slot">${renderInstallBanner('admin')}</div>
      <div id="shortageBox"></div>
      <div id="view" class="view"></div>
    </section>
    <nav class="admin-bottom-dock" aria-label="التنقل الرئيسي">
      <button type="button" data-t="live"><span class="dock-ico">📡</span><span class="dock-lbl">العمليات</span></button>
      <button type="button" data-t="orders"><span class="dock-ico">📦</span><span class="dock-lbl">الطلبات</span></button>
      <button type="button" data-t="users"><span class="dock-ico">🏪</span><span class="dock-lbl">الحسابات</span></button>
      <button type="button" data-t="wallet"><span class="dock-ico">💰</span><span class="dock-lbl">المحفظة</span></button>
      <button type="button" data-t="settings"><span class="dock-ico">⚙️</span><span class="dock-lbl">المزيد</span></button>
    </nav>`;
  $('#lo2').onclick = () => $('#lo').click();
  const tick = () => {
    const d = new Date();
    $('#clk').textContent = enDigits(d.toLocaleTimeString('en-GB'));
    $('#dt').textContent = enDigits(d.toLocaleDateString('ar-SY-u-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    tickCaptainLocAges();
  };

  // ---------- Admin Audio Alarm (Siren when orders > available captains) ----------
  let actx = null, alarmTimer = null, alarmGain = null, alarmOsc = null;
  let mutedShortageKey = '';
  const unlockAudio = () => { try { actx ??= new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch {} };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
  function testAdminSound() {
    unlockAudio();
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; g.gain.value = 0.85; o.connect(g); g.connect(actx.destination);
    o.frequency.setValueAtTime(1050, actx.currentTime);
    o.frequency.setValueAtTime(700, actx.currentTime + 0.35);
    o.start(); o.stop(actx.currentTime + 0.7);
  }
  const updateAdminSndBtn = () => {
    const ok = actx && actx.state === 'running', b = $('#adminSndBtn');
    if (!b) return;
    const titleTxt = ok ? 'صوت الإنذار مفعّل' : 'اضغط لتفعيل صوت الإنذار';
    if (b.dataset.sndOk !== (ok ? '1' : '0')) {
      b.dataset.sndOk = ok ? '1' : '0';
      b.innerHTML = `<span class="snd-ico">${ok ? '🔊' : '🔇'}</span><span class="lbl-desk"> ${titleTxt}</span>`;
      b.title = titleTxt;
      b.setAttribute('aria-label', titleTxt);
    }
    b.className = ok ? 'ok sm' : 'bad sm';
  };
  $('#adminSndBtn').onclick = () => { testAdminSound(); setTimeout(updateAdminSndBtn, 250); };
  setInterval(updateAdminSndBtn, 1500);

  function startAdminAlarm() {
    if (alarmTimer) return;
    unlockAudio();
    if (!actx) return;
    try {
      alarmOsc = actx.createOscillator(); alarmGain = actx.createGain();
      alarmOsc.type = 'square'; alarmGain.gain.value = 0.9;
      alarmOsc.connect(alarmGain); alarmGain.connect(actx.destination); alarmOsc.start();
      let hi = false;
      const step = () => {
        if (!actx) return;
        hi = !hi;
        alarmOsc.frequency.setValueAtTime(hi ? 1050 : 700, actx.currentTime);
        navigator.vibrate?.(hi ? [250] : [0]);
      };
      step(); alarmTimer = setInterval(step, 350);
    } catch {}
  }
  function stopAdminAlarm() {
    clearInterval(alarmTimer); alarmTimer = null;
    try { alarmOsc?.stop(); alarmOsc?.disconnect(); alarmGain?.disconnect(); } catch {}
    alarmOsc = alarmGain = null; navigator.vibrate?.(0);
  }

  const isZoneAdmin = user.role === 'zone_admin';
  const feed = [];
  let tab = 'dash', zones = [], liveMap = null, liveFitted = false, liveStageObs = null;
  let usersTab = 'merchant', usersZoneFilter = '', currentUsersList = [];
  let capMarkers = new Map(), merchMarkers = new Map(), orderMarkers = new Map(), routeLayers = new Map();
  let liveCache = { orders: [], recentOrders: [], captains: [], merchants: [], shortage: null };
  let liveSelection = null;
  let liveFilters = {
    showMerchants: true,
    showCaptains: true,
    showRoutes: true,
    showGreen: true,
    showBlue: true,
    showYellow: true,
    showNeutral: true,
    showGray: true,
  };
  let liveLegendCollapsed = window.innerWidth <= 767;
  let liveHintOverride = null;
  let locIntervals = { active: 10_000, idle: 60_000 };
  const ordersIndex = new Map();
  const rememberOrders = (list = []) => { list.forEach((o) => { if (o?.id) ordersIndex.set(o.id, o); }); };
  let refreshTimer;
  const zname = (id) => zones.find((z) => z.id === id)?.name || '—';

  function computeCaptainLocDiag(ts, vis, busy, now = Date.now()) {
    const t = Number(ts) || 0;
    const expectedMs = busy ? (locIntervals.active || 10_000) : (locIntervals.idle || 60_000);
    const visLabel = vis === 'visible'
      ? '🟢 التطبيق بالواجهة'
      : vis === 'hidden'
      ? '🌑 بالخلفية'
      : '⚪ غير محدد';
    if (!t) {
      return {
        ageText: 'آخر موقع: غير متوفر',
        colorClass: 'loc-age-muted',
        visLabel,
      };
    }
    const ageMs = Math.max(0, now - t);
    const ageSec = Math.floor(ageMs / 1000);
    let ageText;
    if (ageSec < 60) {
      ageText = `آخر موقع: منذ ${ageSec} ثانية`;
    } else if (ageSec < 3600) {
      ageText = `آخر موقع: منذ ${Math.floor(ageSec / 60)} دقيقة`;
    } else {
      ageText = `آخر موقع: منذ ${Math.floor(ageSec / 3600)} ساعة`;
    }
    const colorClass = ageMs <= 2 * expectedMs
      ? 'loc-age-ok'
      : ageMs <= 4 * expectedMs
      ? 'loc-age-warn'
      : 'loc-age-bad';
    return { ageText, colorClass, visLabel };
  }

  function renderCaptainLocDiag(c) {
    const ts = c.last_loc_at ?? c.at ?? '';
    const vis = c.last_loc_vis || '';
    const busy = Boolean(c.busy || c.active_order_id || (c.active_orders && c.active_orders.length));
    const d = computeCaptainLocDiag(ts, vis, busy);
    return `<div class="cap-loc-diag" data-loc-cap="${c.id}" data-loc-at="${ts || ''}" data-loc-vis="${esc(vis)}" data-loc-busy="${busy ? '1' : '0'}">
      <span class="cap-loc-age ${d.colorClass}">${esc(d.ageText)}</span>
      <span class="cap-loc-vis">${esc(d.visLabel)}</span>
    </div>`;
  }

  function renderCaptainPopupHtml(c) {
    const stTxt = c.busy ? `مشغول بطلب #${c.active_order_id}` : c.online ? '🟢 أونلاين متاح' : '⚪ أوفلاين';
    return `<div class="cap-map-popup">
      <div class="cap-map-popup-head"><b>🛵 ${esc(c.name)}</b>${c.tag ? ` <code dir="ltr" class="cap-tag-pill">#${esc(c.tag)}</code>` : ''} <span class="mut">(${esc(stTxt)})</span></div>
      ${renderCaptainLocDiag(c)}
    </div>`;
  }

  function tickCaptainLocAges() {
    const now = Date.now();
    document.querySelectorAll('[data-loc-cap]').forEach((el) => {
      const ts = el.dataset.locAt;
      const vis = el.dataset.locVis;
      const busy = el.dataset.locBusy === '1';
      const d = computeCaptainLocDiag(ts, vis, busy, now);
      const ageEl = el.querySelector('.cap-loc-age');
      const visEl = el.querySelector('.cap-loc-vis');
      if (ageEl) {
        if (ageEl.textContent !== d.ageText) ageEl.textContent = d.ageText;
        ageEl.className = `cap-loc-age ${d.colorClass}`;
      }
      if (visEl && visEl.textContent !== d.visLabel) {
        visEl.textContent = d.visLabel;
      }
    });
  }

  tick(); setInterval(tick, 1000);

  function orderStatusBadge(o) {
    const delayed = o?.delay_until && o.delay_until > Date.now()
      ? ` <span class="badge b-offered">⏱️ مؤجل (${Math.max(1, Math.ceil((o.delay_until - Date.now()) / 60000))} د)</span>`
      : '';
    return badge(o.status) + delayed;
  }

  function updateShortageBanner(shortage) {
    const box = $('#shortageBox');
    if (!box) return;
    if (!shortage || !shortage.alert || !shortage.orders?.length) {
      box.innerHTML = '';
      box.classList.add('hide');
      mutedShortageKey = '';
      stopAdminAlarm();
      return;
    }
    box.classList.remove('hide');
    rememberOrders(shortage.orders);
    const key = shortage.orders.map((o) => `${o.id}:${o.status}`).join(',');
    box.innerHTML = `<div class="card offer shortage-panel">
      <div class="row-head shortage-panel-head">
        <div class="shortage-title-wrap">
          <h3>⚠️ لوحة تحكم الطلب المرفوض (${shortage.orders.length})</h3>
          <span class="shortage-sub">رفض جميع الكباتن المتاحين استلام الطلب أو تجاوز الانتظار 5 دقائق — اختر الإجراء الفوري:</span>
        </div>
        <button type="button" class="bad sm" id="muteShortageBtn">🔕 كتم</button>
      </div>
      <div class="shortage-orders-list">
        ${shortage.orders.map((o) => `
          <div class="shortage-order-card" data-shortage-oid="${o.id}">
            <div class="shortage-order-info">
              <span class="shortage-serial" dir="ltr">${serialNo(o)}</span>
              <span class="shortage-merchant">🏪 ${esc(o.merchant?.name || '—')}</span>
              <span class="shortage-addr">📍 ${esc(o.customer_address || '—')}</span>
            </div>
            <div class="shortage-order-actions">
              <button type="button" class="ok sm" data-open-sheet="${o.id}" data-sheet-mode="assign">🛵 إسناد لكابتن</button>
              <button type="button" class="sec sm" data-open-sheet="${o.id}" data-sheet-mode="delay">⏱️ تأخير الطلب</button>
              <button type="button" class="sec sm" data-open-sheet="${o.id}" data-sheet-mode="notify">🔔 تنبيه المنشأة</button>
              <button type="button" class="bad sm" data-open-sheet="${o.id}" data-sheet-mode="cancel">✕ إلغاء الطلب</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
    $('#muteShortageBtn').onclick = () => {
      mutedShortageKey = key;
      stopAdminAlarm();
    };
    if (mutedShortageKey !== key) {
      startAdminAlarm();
    }
  }

  // Handle clicks inside shortageBanner
  $('#shortageBox').onclick = async (e) => {
    await handleOrderActionClick(e);
  };

  function renderOrderCaptainCell(o, capList = []) {
    const isClosed = ['delivered', 'cancelled', 'failed'].includes(o.status);
    let currentHtml = '<span class="cap-none-chip">— غير معيّن —</span>';
    if (o.captain) {
      currentHtml = `<div class="cap-assigned-bar">
        <a href="#" class="cap-chip" data-cap="${o.captain.id}" title="عرض موقع ورقم الكابتن">🛵 ${esc(o.captain.name)}</a>
        ${!isClosed ? `<button type="button" class="act-pill act-unassign" data-unassign="${o.id}" title="سحب الطلب من هذا الكابتن">✕ سحب</button>` : ''}
      </div>`;
    } else if (o.offered_captain) {
      currentHtml = `<div class="cap-assigned-bar">
        <span class="cap-offered-chip">🔔 معروض: ${esc(o.offered_captain.name)}</span>
        ${!isClosed ? `<button type="button" class="act-pill act-unassign" data-unassign="${o.id}" title="سحب العرض الحالي">✕ سحب</button>` : ''}
      </div>`;
    } else if (o.captain_name) {
      currentHtml = `<span class="cap-chip">🛵 ${esc(o.captain_name)}</span>`;
    }
    if (isClosed || !capList.length) return `<div class="cap-cell-wrap">${currentHtml}</div>`;
    return `<div class="cap-cell-wrap">
      ${currentHtml}
      <div class="assign-input-group">
        <select data-assign-sel="${o.id}">
          <option value="">${o.captain ? '🔄 تحويل لكابتن...' : '🛵 تعيين كابتن...'}</option>
          ${capList.map((c) => `<option value="${c.id}" ${c.online ? '' : 'disabled'}>${c.busy ? '🛵' : c.online ? '🟢' : '⚪'} ${esc(c.name)} (${c.busy ? 'مشغول' : c.online ? 'أونلاين' : 'أوفلاين — غير متاح'})</option>`).join('')}
        </select>
        <button type="button" data-assign-btn="${o.id}" title="تثبيت تعيين الكابتن">تعيين ✓</button>
      </div>
    </div>`;
  }

  function renderOrderRowActions(o) {
    const isClosed = ['delivered', 'cancelled', 'failed'].includes(o.status);
    const canCancel = !['delivered', 'cancelled', 'failed', 'expired'].includes(o.status);
    const hasCap = Boolean(o.captain || o.captain_id);
    const mobPrimary = isClosed
      ? `<button type="button" class="mob-primary-btn is-closed" data-open-sheet="${o.id}" data-sheet-mode="detail">🔍 تفاصيل الطلب</button>`
      : hasCap
        ? `<button type="button" class="mob-primary-btn is-assigned" data-open-sheet="${o.id}" data-sheet-mode="assign">🔄 تغيير الكابتن</button>`
        : `<button type="button" class="mob-primary-btn" data-open-sheet="${o.id}" data-sheet-mode="assign">🛵 تعيين كابتن</button>`;
    return `<div class="order-action-bar">
      <button type="button" class="act-pill act-details" data-d="${o.id}" title="عرض تفاصيل ومسار الطلب">🔍 تفاصيل</button>
      ${!isClosed ? `<button type="button" class="act-pill act-redispatch" data-redispatch="${o.id}" title="إعادة تدوير وعرض الطلب على الكباتن">🔄 تدوير</button>` : ''}
      ${canCancel ? `<button type="button" class="act-pill act-cancel" data-x="${o.id}" title="إلغاء الطلب نهائياً">✕ إلغاء</button>` : ''}
    </div>
    <div class="mob-card-actions">
      ${mobPrimary}
      <button type="button" class="mob-more-btn" data-open-sheet="${o.id}" data-sheet-mode="more" aria-label="المزيد من الإجراءات" title="المزيد من الإجراءات">⋯</button>
    </div>`;
  }

  async function refreshCurrentTab() {
    if (tab === 'dash') await views.dash();
    else if (tab === 'live') { clearTimeout(refreshTimer); await loadLive(); }
    else {
      try {
        const d = await api('/admin/live');
        liveCache = d;
      if (d.intervals) locIntervals = d.intervals;
        rememberOrders(d.orders);
        rememberOrders(d.recentOrders);
        updateShortageBanner(d.shortage);
      } catch {}
      if (tab === 'orders') await views.orders();
      else if (tab === 'users' && $('#nu')?.classList.contains('hide')) await views.users();
    }
  }

  let supportsDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) return false;
    const probe = document.createElement('div');
    probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = 'none';
    supportsDisplayTransition = getComputedStyle(probe).display === 'block';
    probe.remove();
    return supportsDisplayTransition;
  }

  async function closeSheetDialog(dlg) {
    if (!dlg || !dlg.open) return;
    if (!(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay())) {
      dlg.setAttribute('data-closing', '');
      const animations = dlg.getAnimations({ subtree: true });
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 400)),
        ]);
      }
      if (!dlg.hasAttribute('data-closing')) return;
      dlg.removeAttribute('data-closing');
    }
    dlg.returnValue = '';
    dlg.close();
  }

  function attachLightDismissFallback(dlg, onClose) {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    const isOutside = (ev) => {
      const r = dlg.getBoundingClientRect();
      return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
    };
    let pressedOutside = false;
    dlg.addEventListener('pointerdown', (ev) => { pressedOutside = isOutside(ev); });
    dlg.addEventListener('pointerup', (ev) => { if (pressedOutside && isOutside(ev)) onClose(); });
  }

  async function closeActionSheet() {
    await closeSheetDialog(document.getElementById('orderActionSheet'));
  }

  function ensureActionSheetDialog() {
    let dlg = document.getElementById('orderActionSheet');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'orderActionSheet';
    dlg.className = 'action-sheet';
    dlg.setAttribute('closedby', 'any');
    dlg.setAttribute('aria-labelledby', 'ashTitle');
    document.body.appendChild(dlg);

    dlg.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      closeActionSheet();
    });

    attachLightDismissFallback(dlg, closeActionSheet);
    return dlg;
  }

  async function openActionSheet(orderId, initialMode = 'more') {
    const oid = Number(orderId);
    let o = ordersIndex.get(oid)
      || (liveCache.orders || []).find((x) => x.id === oid)
      || (liveCache.recentOrders || []).find((x) => x.id === oid);
    if (!o) {
      try { o = await api(`/admin/orders/${oid}`); } catch (er) { return toast(er.message); }
    }
    if (!liveCache.captains?.length) {
      try { liveCache = await api('/admin/live'); } catch {}
    }
    const capList = liveCache.captains || [];
    const isClosed = ['delivered', 'cancelled', 'failed'].includes(o.status);
    const isWaiting = ['searching', 'offered'].includes(o.status);
    const canCancel = !['delivered', 'cancelled', 'failed', 'expired'].includes(o.status);
    const hasCap = Boolean(o.captain || o.captain_id);

    const dlg = ensureActionSheetDialog();
    dlg.removeAttribute('data-closing');

    const headerMarkup = `
      <div class="sheet-grab-wrap"><span class="sheet-grab-handle" aria-hidden="true"></span></div>
      <div class="sheet-header">
        <div class="sheet-title-group">
          <h3 id="ashTitle">طلب <span dir="ltr">${serialNo(o)}</span></h3>
          ${orderStatusBadge(o)}
        </div>
        <button type="button" class="ghost sm sheet-close-btn" id="ashClose" aria-label="إغلاق">✕</button>
      </div>
      <div class="sheet-meta">
        <span>🏪 ${esc(o.merchant?.name || '—')}</span>
        <span>📍 ${esc(o.customer_address || '—')}</span>
      </div>`;

    const renderMain = () => {
      dlg.innerHTML = `${headerMarkup}
        ${!isClosed ? `
          <div class="sheet-assign-box">
            <div class="sheet-section-lbl">🛵 إدارة الكابتن</div>
            ${o.captain ? `<div class="sheet-current-cap"><a href="#" class="cap-chip" data-cap="${o.captain.id}">🛵 ${esc(o.captain.name)}</a><button type="button" class="sec sm" data-unassign="${o.id}">✕ سحب الطلب</button></div>`
              : o.offered_captain ? `<div class="sheet-current-cap"><span class="cap-offered-chip">🔔 معروض: ${esc(o.offered_captain.name)}</span><button type="button" class="sec sm" data-unassign="${o.id}">✕ سحب العرض</button></div>`
              : ''}
            ${capList.length ? `
              <div class="assign-input-group">
                <select data-assign-sel="${o.id}">
                  <option value="">${hasCap ? '🔄 اختيار كابتن بديل...' : '🛵 اختر كابتن للتعيين...'}</option>
                  ${capList.map((c) => `<option value="${c.id}" ${c.online ? '' : 'disabled'}>${c.busy ? '🛵' : c.online ? '🟢' : '⚪'} ${esc(c.name)} (${c.busy ? 'مشغول' : c.online ? 'أونلاين' : 'أوفلاين — غير متاح'})</option>`).join('')}
                </select>
                <button type="button" class="ok sm" data-assign-btn="${o.id}">تعيين ✓</button>
              </div>
            ` : '<div class="mut">لا يوجد كباتن مسجلون في هذه المنطقة حالياً</div>'}
          </div>
        ` : ''}
        <div class="sheet-action-list">
          ${isWaiting ? `
            <button type="button" class="sheet-action-btn" data-sheet-subview="delay">⏱️ تأخير الطلب</button>
            <button type="button" class="sheet-action-btn" data-sheet-subview="notify">🔔 إرسال تنبيه للمنشأة</button>
          ` : ''}
          <button type="button" class="sheet-action-btn" data-sheet-detail="${o.id}">🔍 تفاصيل ومسار الطلب</button>
          ${o.status === 'accepted' ? `<button type="button" class="sheet-action-btn" data-force-pickup="${o.id}">⚡ تأكيد استلام (تجاوز GPS)</button>` : ''}
          ${!isClosed ? `<button type="button" class="sheet-action-btn" data-redispatch="${o.id}">🔄 إعادة تدوير</button>` : ''}
          ${hasCap && !isZoneAdmin ? `<button type="button" class="sheet-action-btn sheet-warn-btn" data-sheet-liability="${o.id}">⚠️ خصم نقاط تعويض</button>` : ''}
          ${canCancel ? `<button type="button" class="bad sheet-action-btn sheet-cancel-btn" data-sheet-subview="cancel">✕ إلغاء الطلب</button>` : ''}
        </div>
        <div id="sheetDetail" class="sheet-detail-slot"></div>`;
    };

    const renderDelayForm = () => {
      dlg.innerHTML = `${headerMarkup}
        <form id="sheetDelayForm" class="sheet-subform">
          <label for="sheetDelayMinutes">⏱️ اختر مدة تأخير الطلب</label>
          <div class="form-hint">سيتم إيقاف البحث التلقائي مؤقتاً وإشعار المنشأة «${esc(o.merchant?.name || 'المنشأة')}» فوراً.</div>
          <div class="delay-pills-row" role="group" aria-label="مدة التأخير السريعة">
            <button type="button" class="sec delay-pill-btn" data-delay-pick="10">10 دقائق</button>
            <button type="button" class="sec delay-pill-btn active" data-delay-pick="15">15 دقيقة</button>
            <button type="button" class="sec delay-pill-btn" data-delay-pick="30">30 دقيقة</button>
          </div>
          <select id="sheetDelayMinutes" name="minutes" required>
            <option value="10">10 دقائق</option>
            <option value="15" selected>15 دقيقة</option>
            <option value="30">30 دقيقة</option>
          </select>
          <div class="sheet-subform-actions">
            <button type="submit" class="ok" id="confirmDelayOrderBtn" autofocus>⏱️ تأكيد التأخير</button>
            <button type="button" class="sec" data-sheet-subview="main">رجوع</button>
          </div>
        </form>`;
      const selEl = dlg.querySelector('#sheetDelayMinutes');
      const syncPills = (val) => {
        dlg.querySelectorAll('[data-delay-pick]').forEach((b) => b.classList.toggle('active', b.dataset.delayPick === String(val)));
      };
      selEl.onchange = () => syncPills(selEl.value);
      dlg.querySelector('#sheetDelayForm').onsubmit = async (ev) => {
        ev.preventDefault();
        const minutes = Number(selEl.value || 15);
        const btn = ev.submitter || dlg.querySelector('#confirmDelayOrderBtn');
        if (btn) btn.disabled = true;
        const updated = await act(() => api(`/admin/orders/${o.id}/delay`, 'POST', { minutes }), `تم تأخير الطلب لمدة ${minutes} دقيقة وإشعار المنشأة`);
        if (btn) btn.disabled = false;
        if (updated) {
          rememberOrders([updated]);
          await closeActionSheet();
          await refreshCurrentTab();
        }
      };
      dlg.querySelector('#confirmDelayOrderBtn')?.focus();
    };

    const renderNotifyForm = () => {
      const defMsg = `الطلب ${serialNo(o)} متأخر قليلاً، جاري البحث عن كابتن وتأمينه بأسرع وقت.`;
      dlg.innerHTML = `${headerMarkup}
        <form id="sheetNotifyForm" class="sheet-subform">
          <label for="sheetNotifyMsg">🔔 رسالة التنبيه للمنشأة «${esc(o.merchant?.name || 'المنشأة')}»</label>
          <div class="form-hint">ستصل الرسالة فوراً كإشعار مباشر على شاشة المنشأة.</div>
          <div class="delay-pills-row">
            <button type="button" class="sec sm" data-notify-preset="الطلب متأخر قليلاً، جاري البحث عن كابتن وتأمينه بأسرع وقت.">⏳ جاري تأمين كابتن</button>
            <button type="button" class="sec sm" data-notify-preset="جميع الكباتن مشغولون بطلبات حالية، سيتم توجيه أقرب كابتن فور تفرغه.">🛵 الكباتن مشغولون حالياً</button>
          </div>
          <input id="sheetNotifyMsg" name="message" value="${esc(defMsg)}" required minlength="3" maxlength="250" autocomplete="off">
          <div class="sheet-subform-actions">
            <button type="submit" class="ok" id="confirmNotifyMerchantBtn" autofocus>🔔 تأكيد وإرسال التنبيه</button>
            <button type="button" class="sec" data-sheet-subview="main">رجوع</button>
          </div>
        </form>`;
      dlg.querySelector('#sheetNotifyForm').onsubmit = async (ev) => {
        ev.preventDefault();
        const message = dlg.querySelector('#sheetNotifyMsg').value.trim();
        if (!message) return;
        const btn = ev.submitter || dlg.querySelector('#confirmNotifyMerchantBtn');
        if (btn) btn.disabled = true;
        const ok = await act(() => api(`/admin/orders/${o.id}/notify-merchant`, 'POST', { message }), 'تم إرسال التنبيه للمنشأة بنجاح');
        if (btn) btn.disabled = false;
        if (ok) await closeActionSheet();
      };
      dlg.querySelector('#sheetNotifyMsg')?.focus();
    };

    const renderCancelForm = () => {
      dlg.innerHTML = `${headerMarkup}
        <form id="sheetCancelForm" class="sheet-confirm-box">
          <p id="cancelOrderDesc" class="sheet-confirm-msg">⚠️ هل أنت متأكد من إلغاء الطلب <b dir="ltr">${serialNo(o)}</b> نهائياً؟</p>
          <label for="sheetCancelReason">سبب الإلغاء (اختياري — يُرسل للمنشأة)</label>
          <input id="sheetCancelReason" name="reason" placeholder="مثال: عدم توفر كباتن حالياً..." maxlength="200" autocomplete="off">
          <div class="sheet-subform-actions">
            <button type="button" class="sec" data-sheet-subview="main" id="cancelOrderBackBtn" autofocus>تراجع</button>
            <button type="submit" class="bad" id="confirmCancelOrderBtn" aria-describedby="cancelOrderDesc">✕ تأكيد إلغاء الطلب</button>
          </div>
        </form>`;
      dlg.querySelector('#sheetCancelForm').onsubmit = async (ev) => {
        ev.preventDefault();
        const reason = dlg.querySelector('#sheetCancelReason').value.trim();
        const btn = ev.submitter || dlg.querySelector('#confirmCancelOrderBtn');
        if (btn) btn.disabled = true;
        const ok = await act(() => api(`/admin/orders/${o.id}/cancel`, 'POST', reason ? { reason } : {}), 'تم إلغاء الطلب');
        if (btn) btn.disabled = false;
        if (ok) {
          await closeActionSheet();
          await refreshCurrentTab();
        }
      };
      dlg.querySelector('#cancelOrderBackBtn')?.focus();
    };

    dlg.onclick = async (ev) => {
      if (ev.target.closest('#ashClose')) {
        await closeActionSheet();
        return;
      }
      const subBtn = ev.target.closest('[data-sheet-subview]');
      if (subBtn) {
        const sub = subBtn.dataset.sheetSubview;
        if (sub === 'main') renderMain();
        else if (sub === 'delay') renderDelayForm();
        else if (sub === 'notify') renderNotifyForm();
        else if (sub === 'cancel') renderCancelForm();
        return;
      }
      const pickBtn = ev.target.closest('[data-delay-pick]');
      if (pickBtn) {
        const val = pickBtn.dataset.delayPick;
        const selEl = dlg.querySelector('#sheetDelayMinutes');
        if (selEl) selEl.value = val;
        dlg.querySelectorAll('[data-delay-pick]').forEach((b) => b.classList.toggle('active', b.dataset.delayPick === val));
        return;
      }
      const presetBtn = ev.target.closest('[data-notify-preset]');
      if (presetBtn) {
        const inp = dlg.querySelector('#sheetNotifyMsg');
        if (inp) { inp.value = presetBtn.dataset.notifyPreset; inp.focus(); }
        return;
      }
      const detBtn = ev.target.closest('[data-sheet-detail]');
      if (detBtn) {
        const slot = dlg.querySelector('#sheetDetail');
        if (slot) await detail(Number(detBtn.dataset.sheetDetail), slot);
        return;
      }
      const liabBtn = ev.target.closest('[data-sheet-liability]');
      if (liabBtn) {
        openLiabilityModal(Number(liabBtn.dataset.sheetLiability), async () => {
          await closeActionSheet();
          await refreshCurrentTab();
        });
        return;
      }
      const capLink = ev.target.closest('[data-cap]');
      if (capLink) {
        ev.preventDefault();
        const cid = Number(capLink.dataset.cap);
        const cap = (liveCache.captains || []).find((c) => c.id === cid);
        if (cap) {
          await closeActionSheet();
          captainModal(cap);
        }
        return;
      }
      const res = await handleOrderActionClick(ev);
      if (res === 'done') await closeActionSheet();
    };

    if (initialMode === 'delay') renderDelayForm();
    else if (initialMode === 'notify') renderNotifyForm();
    else if (initialMode === 'cancel') renderCancelForm();
    else renderMain();

    if (!dlg.open) dlg.showModal();
    if (initialMode === 'assign') {
      dlg.querySelector(`[data-assign-sel="${o.id}"]`)?.focus();
    } else if (initialMode === 'detail') {
      const slot = dlg.querySelector('#sheetDetail');
      if (slot) await detail(o.id, slot);
    }
  }

  async function handleOrderActionClick(e) {
    const sheetBtn = e.target.closest('[data-open-sheet]');
    if (sheetBtn) {
      await openActionSheet(Number(sheetBtn.dataset.openSheet), sheetBtn.dataset.sheetMode || 'more');
      return 'handled';
    }
    const quickAssignBtn = e.target.closest('#shortageBox [data-quick-assign]');
    if (quickAssignBtn) {
      await openActionSheet(Number(quickAssignBtn.dataset.quickAssign), 'assign');
      return 'handled';
    }
    const redispBtn = e.target.closest('[data-redispatch]');
    if (redispBtn) {
      const oid = Number(redispBtn.dataset.redispatch);
      const ok = await act(() => api(`/admin/orders/${oid}/redispatch`, 'POST'), 'تمت إعادة عرض الطلب ليلف على الكباتن من جديد');
      if (ok) { await refreshCurrentTab(); return 'done'; }
      return 'handled';
    }
    const fpBtn = e.target.closest('[data-force-pickup]');
    if (fpBtn) {
      if (!confirm('تأكيد استلام الطلب إدارياً وتجاوز فحص GPS؟')) return 'handled';
      const oid = Number(fpBtn.dataset.forcePickup);
      const ok = await act(() => api(`/admin/orders/${oid}/force-pickup`, 'POST', {}), 'تم تأكيد استلام الطلب إدارياً');
      if (ok) { await refreshCurrentTab(); return 'done'; }
      return 'handled';
    }
    const assignBtn = e.target.closest('[data-assign-btn]');
    if (assignBtn) {
      const oid = Number(assignBtn.dataset.assignBtn);
      const container = assignBtn.parentElement || document;
      const sel = container.querySelector(`[data-assign-sel="${oid}"]`) || $(`[data-assign-sel="${oid}"]`);
      const capId = Number(sel?.value || 0);
      if (!capId) { toast('يرجى اختيار الكابتن أولاً من القائمة'); return 'handled'; }
      const ok = await act(() => api(`/admin/orders/${oid}/assign-captain`, 'POST', { captain_id: capId }), 'تم تعيين الكابتن للطلب بنجاح');
      if (ok) {
        if (ok.warning) setTimeout(() => toast(ok.warning), 180);
        await refreshCurrentTab();
        return 'done';
      }
      return 'handled';
    }
    const unassignBtn = e.target.closest('[data-unassign]');
    if (unassignBtn) {
      const oid = Number(unassignBtn.dataset.unassign);
      if (confirm('هل تريد إلغاء/سحب الطلب عن هذا الكابتن؟')) {
        const ok = await act(() => api(`/admin/orders/${oid}/unassign-captain`, 'POST'), 'تم سحب الطلب من الكابتن');
        if (ok) { await refreshCurrentTab(); return 'done'; }
      }
      return 'handled';
    }
    const addForCapBtn = e.target.closest('[data-add-order]');
    if (addForCapBtn) {
      const cid = addForCapBtn.dataset.addOrder ? Number(addForCapBtn.dataset.addOrder) : null;
      openAddOrderModal(cid);
      return 'handled';
    }
    const xEl = e.target.closest('[data-x]');
    if (xEl) {
      await openActionSheet(Number(xEl.dataset.x), 'cancel');
      return 'handled';
    }
    return false;
  }

  function openAddOrderModal(defaultCapId = null) {
    document.getElementById('addordmodal')?.remove();
    const merchList = liveCache.merchants || [];
    const capList = liveCache.captains || [];
    const unassignedOrders = (liveCache.orders || []).filter((o) => !['delivered', 'cancelled', 'failed'].includes(o.status));
    const el = document.createElement('div');
    el.id = 'addordmodal';
    el.style.cssText = 'position:fixed;inset:0;z-index:var(--z-modal);background:var(--surface-overlay);backdrop-filter:blur(4px);display:grid;place-items:center;padding:14px';
    el.innerHTML = `<div class="card" style="width:100%;max-width:480px;padding:18px;background:var(--bg-elevated);color:var(--text-primary);max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">➕ إضافة / تعيين طلب لكابتن</h3>
        <button type="button" class="ghost" id="aomClose">✕</button>
      </div>
      <form id="aomForm">
        <label>المنشأة</label>
        <select name="merchant_id" required>
          ${merchList.map((m) => `<option value="${m.id}">🏪 ${esc(m.business_name || m.name)}</option>`).join('') || '<option value="">لا توجد منشآت</option>'}
        </select>
        <label>عنوان التوصيل (مكان التوصيل)</label>
        <input name="customer_address" placeholder="اكتب عنوان التوصيل هنا..." required minlength="2" maxlength="250" autocomplete="off">
        <label>تعيين للكابتن</label>
        <select name="captain_id" id="aomCapSel">
          <option value="">🔍 بحث تلقائي عن كابتن متاح</option>
          ${capList.map((c) => `<option value="${c.id}" ${defaultCapId === c.id ? 'selected' : ''}>🛵 ${esc(c.name)} (${c.busy ? 'مشغول' : c.online ? 'أونلاين' : 'أوفلاين'})</option>`).join('')}
        </select>
        <button class="big ok" style="margin-top:12px">🛵 إضافة وإسناد الطلب</button>
      </form>
      ${defaultCapId && unassignedOrders.length ? `
        <hr style="border-color:var(--border-neutral);margin:14px 0">
        <h4 style="margin:0 0 8px">أو إسناد طلب حالي موجود لهذا الكابتن:</h4>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${unassignedOrders.map((o) => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;background:var(--bg-subtle);border-radius:8px">
              <div><b dir="ltr">${serialNo(o)}</b> — 📍 ${esc(o.customer_address || '—')} ${o.captain ? `<span class="mut">(حالياً مع ${esc(o.captain.name)})</span>` : ''}</div>
              <button type="button" class="ok sm" data-quick-assign="${o.id}">🛵 إسناد للكابتن</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.onclick = async (e) => {
      if (e.target === el) return close();
      const qa = e.target.closest('[data-quick-assign]');
      if (qa && defaultCapId) {
        const oid = Number(qa.dataset.quickAssign);
        const r = await act(() => api(`/admin/orders/${oid}/assign-captain`, 'POST', { captain_id: defaultCapId }), 'تم إسناد الطلب للكابتن');
        if (r?.warning) setTimeout(() => toast(r.warning), 180);
        close();
        await refreshCurrentTab();
      }
    };
    el.querySelector('#aomClose').onclick = close;
    el.querySelector('#aomForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const payload = {
        merchant_id: f.merchant_id ? Number(f.merchant_id) : undefined,
        customer_address: f.customer_address,
        captain_id: f.captain_id ? Number(f.captain_id) : undefined,
      };
      const res = await act(() => api('/admin/orders', 'POST', payload), payload.captain_id ? 'تم إنشاء الطلب وإسناده للكابتن مباشرة' : 'تم إنشاء الطلب وجاري البحث عن كابتن');
      if (res) {
        if (res.warning) setTimeout(() => toast(res.warning), 180);
        close();
        await refreshCurrentTab();
      }
    };
  }

  $('#adminAddOrderTop').onclick = () => openAddOrderModal(null);

  $('.tabs').onclick = (e) => {
    const btn = e.target.closest('[data-t]');
    if (btn) go(btn.dataset.t);
  };
  $('.admin-bottom-dock').onclick = (e) => {
    const btn = e.target.closest('[data-t]');
    if (btn) go(btn.dataset.t);
  };

  const syncMobileTableLabels = () => {
    $$('#view table').forEach((tbl) => {
      const ths = [...tbl.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      const fallback = !ths.length ? ['الوقت', 'التنبيه', 'إجراءات'] : [];
      const labels = ths.length ? ths : fallback;
      tbl.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          if (td.hasAttribute('colspan')) return;
          const lbl = labels[i] || '';
          if (lbl && td.dataset.label !== lbl) td.dataset.label = lbl;
          if (td.querySelector('.cap-cell-wrap')) td.classList.add('td-cap-cell');
          if (td.querySelector('.user-more-btn')) td.classList.add('td-user-actions');
          if (td.querySelector('.mob-card-actions')) td.classList.add('td-actions', 'td-order-actions');
          else if (td.querySelector('.order-action-bar, button[data-c], button[data-r]')) {
            td.classList.add('td-actions');
          }
        });
      });
    });
  };
  new MutationObserver(syncMobileTableLabels).observe($('#view'), { childList: true, subtree: true });

  async function go(t) {
    tab = t;
    clearTimeout(refreshTimer);
    if (view()) view().onclick = null;
    liveStageObs?.disconnect();
    liveStageObs = null;
    if (liveMap) { try { liveMap.remove(); } catch {} }
    liveMap = null; liveFitted = false;
    liveSelection = null;
    if (liveHintOverride?.timer) clearTimeout(liveHintOverride.timer);
    liveHintOverride = null;
    capMarkers.clear(); merchMarkers.clear(); orderMarkers.clear();
    if (routeLayers instanceof Map) routeLayers.clear();
    else routeLayers = new Map();
    document.body.classList.toggle('is-live-view', t === 'live');
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    const dockTarget = t === 'dash' ? 'live' : t;
    $$('.admin-bottom-dock button[data-t]').forEach((b) => {
      const isAct = b.dataset.t === dockTarget;
      b.classList.toggle('active', isAct);
      if (isAct) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    zones = await api('/admin/zones');
    const baseTitle = TABS[t].replace(/^\S+\s/, '');
    const myZoneName = isZoneAdmin ? (zones.find((z) => z.id === user.zone_id)?.name || '') : '';
    $('#ptitle').textContent = isZoneAdmin && myZoneName ? `${baseTitle} - ${myZoneName}` : baseTitle;
    await views[t]();
    syncMobileTableLabels();
  }
  const view = () => $('#view');

  function collectAllPoints(d) {
    const pts = [];
    (d.captains || []).forEach((c) => { if (c.lat != null && c.lng != null) pts.push([c.lat, c.lng]); });
    (d.merchants || []).forEach((m) => { if (m.lat != null && m.lng != null) pts.push([m.lat, m.lng]); });
    (d.orders || []).forEach((o) => {
      if (o.merchant?.lat != null && o.merchant?.lng != null) pts.push([o.merchant.lat, o.merchant.lng]);
      if (o.customer_lat != null && o.customer_lng != null) pts.push([o.customer_lat, o.customer_lng]);
    });
    return pts;
  }

  function capStatusTag(c) {
    if (c.status !== 'active') return badge(c.status);
    if (c.busy) {
      const ordBadges = (c.active_orders || []).map((ao) => `<span class="active-ord-mini"><b dir="ltr">#${ao.serial_no}</b> <button type="button" class="act-pill act-unassign-mini" data-unassign="${ao.id}" title="سحب الطلب من الكابتن">✕</button></span>`).join(' ');
      return `<div class="cap-busy-stack"><span class="badge b-accepted">🛵 مشغول (${(c.active_orders || []).length || 1})</span><div class="cap-busy-orders">${ordBadges}</div></div>`;
    }
    if (c.online) return '<span class="badge b-active">🟢 أونلاين متاح</span>';
    return '<span class="badge">⚪ أوفلاين</span>';
  }

  const views = {
    async dash() {
      const [s, d] = await Promise.all([api('/admin/stats'), api('/admin/live')]);
      liveCache = d;
      if (d.intervals) locIntervals = d.intervals;
      rememberOrders(d.orders);
      rememberOrders(d.recentOrders);
      updateShortageBanner(d.shortage || s.shortage);
      const merchList = d.merchants || [];
      const capList = d.captains || [];
      const liveOrders = d.orders || [];
      const recentOrders = d.recentOrders || [];
      const shownOrders = liveOrders.length ? liveOrders : recentOrders.slice(0, 10);

      const cards = [
        ['📦', s.live, 'الطلبات الحية الآن', 'live'],
        ['🏪', merchList.length || s.merchants, 'المنشآت المسجلة', 'users'],
        ['🛵', `${s.online}/${capList.length || s.captains}`, 'الكباتن (أونلاين / الكل)', 'users'],
        ['✅', s.deliveredToday, 'طلبات اليوم المسلّمة', 'orders'],
      ];

      view().innerHTML = `
        <div class="stats4">${cards.map(([i, n, l, to]) => `<div class="card sc" data-go="${to}" style="cursor:pointer"><div class="ic">${i}</div><div><div class="n">${n}</div><div class="mut">${l}</div></div></div>`).join('')}</div>

        <div class="dgrid exec-bento-grid" style="margin-bottom:18px">
          <div class="card exec-map-card">
            <div class="row-head">
              <div>
                <h3 style="margin:0">🗺️ نظرة تنفيذية حية على الأسطول</h3>
                <div class="mut" style="font-size:12px">توزيع المنشآت والكباتن والطلبات النشطة</div>
              </div>
              <div class="order-action-bar">
                <button type="button" class="act-pill act-details" id="dashFit">🎯 إظهار الكل</button>
                <button type="button" class="act-pill act-redispatch" data-go="live">📡 فتح غرفة العمليات</button>
              </div>
            </div>
            <div id="dashmap" class="map" style="height:370px"></div>
          </div>
          <div class="card exec-feed-card">
            <div class="row-head">
              <div>
                <h3 style="margin:0">⚡ سجل الأحداث الفوري</h3>
                <div class="mut" style="font-size:12px">آخر التحديثات الميدانية المباشرة</div>
              </div>
              <button type="button" class="act-pill act-details" id="dashRef">🔄 تحديث</button>
            </div>
            <ul class="feed">${feed.slice(0, 9).map((f) => `<li><span class="feed-dot"></span><div>${esc(f.t)}<small>${f.at}</small></div></li>`).join('') || '<li class="mut">لا نشاط جديد في هذه الجلسة بعد</li>'}</ul>
          </div>
        </div>

        <div class="card">
          <div class="row-head" style="flex-wrap:wrap;gap:10px">
            <div>
              <h3 style="margin:0">${liveOrders.length ? `📦 الطلبات الحية الجارية (${liveOrders.length})` : '📦 أحدث الطلبات المسجلة'}</h3>
              <div class="mut" style="font-size:12px">تحكم سريع بالتعيين أو التدوير أو التفاصيل</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex:1;justify-content:flex-end;min-width:240px;flex-wrap:wrap">
              <input id="dashOrderSearch" placeholder="🔍 بحث بالرقم التسلسلي (مثال: 0001) أو المنشأة أو العنوان..." style="max-width:320px;margin:0">
              <button type="button" class="ok sm" data-add-order="">➕ إضافة طلب لكابتن</button>
              <button type="button" class="sec sm" data-go="orders">كل الطلبات ⬅️</button>
            </div>
          </div>
          <div class="tablewrap">
            <table>
              <thead><tr><th>الرقم التسلسلي</th><th>المنشأة</th><th>عنوان التوصيل</th><th>الحالة</th><th>إدارة الكابتن</th><th>الوقت</th><th>إجراءات</th></tr></thead>
              <tbody id="dashOrderRows"></tbody>
            </table>
          </div>
        </div>

        <div id="detail"></div>`;

      const dashMap = makeMap('dashmap', DAMASCUS, 12);
      merchList.forEach((m) => {
        if (m.lat != null && m.lng != null) {
          L.marker([m.lat, m.lng], { icon: emoji('🏪') })
            .addTo(dashMap)
            .bindTooltip(`🏪 ${m.business_name || m.name}`);
        }
      });
      capList.forEach((c) => {
        if (c.lat != null && c.lng != null) {
          const icon = c.busy ? emoji('🛵') : c.online ? createPulsingDot('#10B981') : createPulsingDot('#94A3B8');
          const stTxt = c.busy ? `مشغول بطلب #${c.active_order_id}` : c.online ? 'أونلاين متاح' : 'أوفلاين (آخر موقع)';
          const mk = L.marker([c.lat, c.lng], { icon })
            .addTo(dashMap)
            .bindTooltip(`🛵 ${c.name} — ${stTxt}`)
            .bindPopup(renderCaptainPopupHtml(c));
          mk.on('popupopen', tickCaptainLocAges);
        }
      });
      liveOrders.forEach((o) => {
        if (o.customer_lat != null && o.customer_lng != null) {
          L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') })
            .addTo(dashMap)
            .bindTooltip(`📍 طلب ${serialNo(o)} (${o.customer_address || ''})`);
        }
        if (o.captain?.lat != null && ['accepted', 'picked_up', 'arrived'].includes(o.status)) {
          const dest = o.status === 'accepted' ? [o.merchant?.lat, o.merchant?.lng] : [o.customer_lat, o.customer_lng];
          if (dest[0] != null) makeRoute(dashMap, [o.captain.lat, o.captain.lng], dest);
        }
      });

      const pts = collectAllPoints(d);
      if (pts.length) fitMapToPoints(dashMap, pts);

      $('#dashFit').onclick = () => { if (pts.length) fitMapToPoints(dashMap, pts); };
      $('#dashRef').onclick = () => views.dash();

      const renderDashOrders = (q = '') => {
        const pool = q.trim() ? recentOrders : shownOrders;
        const filtered = pool.filter((o) => matchOrder(o, q));
        const tbody = $('#dashOrderRows');
        if (!tbody) return;
        tbody.innerHTML = filtered.map((o) => `<tr>
          <td dir="ltr"><b class="serial-pill">${serialNo(o)}</b></td>
          <td><b>🏪 ${esc(o.merchant?.name || '—')}</b></td>
          <td><b>📍 ${esc(o.customer_address || '—')}</b></td>
          <td>${orderStatusBadge(o)}${o.eta_minutes ? `<div class="mut">~${o.eta_minutes} د</div>` : ''}</td>
          <td>${renderOrderCaptainCell(o, capList)}</td>
          <td>${time(o.created_at)}</td>
          <td>${renderOrderRowActions(o)}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد طلبات مطابقة للبحث</td></tr>';
      };
      renderDashOrders();
      $('#dashOrderSearch').oninput = (e) => renderDashOrders(e.target.value);

      view().onclick = async (e) => {
        if (await handleOrderActionClick(e)) return;
        const goEl = e.target.closest('[data-go]');
        if (goEl) return go(goEl.dataset.go);
        const capEl = e.target.closest('[data-cap]');
        if (capEl) {
          e.preventDefault();
          const cid = Number(capEl.dataset.cap);
          const cap = capList.find((x) => x.id === cid) || recentOrders.find((o) => o.captain?.id === cid)?.captain;
          if (cap) captainModal(cap);
          return;
        }
        const panEl = e.target.closest('[data-pan]');
        if (panEl) {
          const [la, ln] = panEl.dataset.pan.split(',').map(Number);
          dashMap.setView([la, ln], 16);
          $('#dashmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        const detEl = e.target.closest('[data-d]');
        if (detEl) return detail(detEl.dataset.d);
      };
    },

    async live() {
      const s = await api('/admin/stats');
      updateShortageBanner(s.shortage);
      liveLegendCollapsed = window.innerWidth <= 767;
      liveSelection = null;
      if (liveHintOverride?.timer) clearTimeout(liveHintOverride.timer);
      liveHintOverride = null;

      view().innerHTML = `
        <div class="live-ops-stage">
          <div id="lmap" class="live-ops-map" aria-label="خريطة العمليات الحية"></div>
          <div class="live-ops-hud">
            <aside id="liveLegendPanel" class="live-legend-panel ${liveLegendCollapsed ? 'is-collapsed' : ''}" aria-label="دليل الخريطة والفلاتر">
              <div class="live-legend-head">
                <button type="button" id="liveLegendToggle" class="live-legend-toggle" aria-expanded="${!liveLegendCollapsed}" aria-controls="liveLegendBody">
                  <span>🎛️ الدليل والفلاتر (<span id="liveVisSummary">0</span>)</span>
                  <span id="liveLegendChev" aria-hidden="true">${liveLegendCollapsed ? '▾' : '▴'}</span>
                </button>
                <div class="live-legend-head-tools">
                  <button type="button" id="liveFit" class="live-hud-ico-btn" aria-label="تمركز الخريطة لإظهار الكل" title="إظهار الكل">🎯</button>
                  <button type="button" id="liveRef" class="live-hud-ico-btn" aria-label="تحديث البيانات الفورية" title="تحديث">🔄</button>
                </div>
              </div>
              <div id="liveLegendBody" class="live-legend-body">
                <div class="live-legend-kpis" id="lstats">
                  <div class="live-kpi-pill"><b id="lkLiveOrders">${s.live}</b><span>طلبات حية</span></div>
                  <div class="live-kpi-pill"><b id="lkOnlineCaps">${s.online}/${s.captains}</b><span>أونلاين</span></div>
                  <div class="live-kpi-pill"><b id="lkMerchants">${s.merchants}</b><span>منشآت</span></div>
                </div>
                <div class="live-legend-group-title">طبقات الخريطة</div>
                <label class="live-filter-row" for="lfMerchants">
                  <span class="live-filter-label"><input type="checkbox" id="lfMerchants" ${liveFilters.showMerchants ? 'checked' : ''}><span>🏪 إظهار المنشآت</span></span>
                  <span class="live-filter-count" id="lfcMerchants">0</span>
                </label>
                <label class="live-filter-row" for="lfCaptains">
                  <span class="live-filter-label"><input type="checkbox" id="lfCaptains" ${liveFilters.showCaptains ? 'checked' : ''}><span>🛵 إظهار الكباتن</span></span>
                  <span class="live-filter-count" id="lfcCaptains">0</span>
                </label>
                <label class="live-filter-row" for="lfRoutes">
                  <span class="live-filter-label"><input type="checkbox" id="lfRoutes" ${liveFilters.showRoutes ? 'checked' : ''}><span>📍 المسارات والوجهات</span></span>
                  <span class="live-filter-count" id="lfcRoutes">0</span>
                </label>
                <div class="live-legend-group-title">حالات العلامات</div>
                <label class="live-filter-row" for="lfGreen">
                  <span class="live-filter-label"><input type="checkbox" id="lfGreen" ${liveFilters.showGreen ? 'checked' : ''}><span class="live-swatch is-green" aria-hidden="true"></span><span>أخضر نابض: للزبون (استلام/وصول) أو طلب نشط</span></span>
                  <span class="live-filter-count" id="lfcGreen">0</span>
                </label>
                <label class="live-filter-row" for="lfBlue">
                  <span class="live-filter-label"><input type="checkbox" id="lfBlue" ${liveFilters.showBlue ? 'checked' : ''}><span class="live-swatch is-blue" aria-hidden="true"></span><span>أزرق نابض: كابتن متجه للمنشأة (مقبول)</span></span>
                  <span class="live-filter-count" id="lfcBlue">0</span>
                </label>
                <label class="live-filter-row" for="lfYellow">
                  <span class="live-filter-label"><input type="checkbox" id="lfYellow" ${liveFilters.showYellow ? 'checked' : ''}><span class="live-swatch is-yellow" aria-hidden="true"></span><span>أصفر نابض: كابتن متاح أو بحث/عرض</span></span>
                  <span class="live-filter-count" id="lfcYellow">0</span>
                </label>
                <label class="live-filter-row" for="lfNeutral">
                  <span class="live-filter-label"><input type="checkbox" id="lfNeutral" ${liveFilters.showNeutral ? 'checked' : ''}><span class="live-swatch is-neutral" aria-hidden="true"></span><span>محايد: منشأة بلا طلب مفتوح</span></span>
                  <span class="live-filter-count" id="lfcNeutral">0</span>
                </label>
                <label class="live-filter-row" for="lfGray">
                  <span class="live-filter-label"><input type="checkbox" id="lfGray" ${liveFilters.showGray ? 'checked' : ''}><span class="live-swatch is-gray" aria-hidden="true"></span><span>رمادي: كابتن أوفلاين (غير متاح)</span></span>
                  <span class="live-filter-count" id="lfcGray">0</span>
                </label>
              </div>
            </aside>
            <div id="liveHintBar" class="live-hint-bar" role="status" aria-live="polite"></div>
          </div>
          <dialog id="liveTransferDialog" class="live-transfer-dialog" aria-labelledby="ltTitle">
            <div class="lt-dlg-head">
              <h3 id="ltTitle">🔄 تأكيد نقل وتوجيه الطلب</h3>
              <button type="button" id="ltCloseBtn" class="ghost sm" aria-label="إغلاق">✕</button>
            </div>
            <p id="ltMsg" class="lt-dlg-msg"></p>
            <div id="ltMeta" class="lt-dlg-meta"></div>
            <div id="ltWarnBox" class="lt-dlg-warn hide" role="alert"></div>
            <div class="lt-dlg-actions">
              <button type="button" id="ltConfirmBtn" class="ok">✓ تأكيد النقل</button>
              <button type="button" id="ltCancelBtn" class="sec" autofocus>إلغاء</button>
            </div>
          </dialog>
        </div>`;

      liveMap = makeMap('lmap', DAMASCUS, 12);
      const stageEl = $('.live-ops-stage');
      if (stageEl && 'ResizeObserver' in window) {
        liveStageObs = new ResizeObserver(() => { liveMap?.invalidateSize({ animate: false }); });
        liveStageObs.observe(stageEl);
      }

      const legendPanel = $('#liveLegendPanel');
      const legendToggle = $('#liveLegendToggle');
      const legendChev = $('#liveLegendChev');
      legendToggle?.addEventListener('click', () => {
        liveLegendCollapsed = !liveLegendCollapsed;
        legendPanel?.classList.toggle('is-collapsed', liveLegendCollapsed);
        legendToggle.setAttribute('aria-expanded', String(!liveLegendCollapsed));
        if (legendChev) legendChev.textContent = liveLegendCollapsed ? '▾' : '▴';
      });

      $('#liveFit')?.addEventListener('click', () => {
        const pts = collectAllPoints(liveCache);
        if (pts.length) fitMapToPoints(liveMap, pts);
      });
      $('#liveRef')?.addEventListener('click', () => {
        clearTimeout(refreshTimer);
        loadLive();
      });

      const wireFilter = (id, key) => {
        $(id)?.addEventListener('change', (e) => {
          liveFilters[key] = e.target.checked;
          applyLiveFiltersAndMarkers();
        });
      };
      wireFilter('#lfMerchants', 'showMerchants');
      wireFilter('#lfCaptains', 'showCaptains');
      wireFilter('#lfRoutes', 'showRoutes');
      wireFilter('#lfGreen', 'showGreen');
      wireFilter('#lfBlue', 'showBlue');
      wireFilter('#lfYellow', 'showYellow');
      wireFilter('#lfNeutral', 'showNeutral');
      wireFilter('#lfGray', 'showGray');

      const dlg = $('#liveTransferDialog');
      dlg?.addEventListener('close', () => { dlg.returnValue = ''; });

      renderLiveHint();
      await loadLive();
    },

    async users() {
      if (isZoneAdmin && usersTab === 'admin') usersTab = 'merchant';

      const wirePwToggle = (btn, inp) => {
        if (!btn || !inp) return;
        btn.onclick = () => {
          const show = inp.type === 'password';
          inp.type = show ? 'text' : 'password';
          btn.setAttribute('aria-pressed', String(show));
          btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
          btn.textContent = show ? '🙈' : '👁️';
        };
      };

      async function deleteUser(uid) {
        return await act(() => api(`/admin/users/${uid}`, 'DELETE'), 'تم حذف الحساب');
      }

      async function closeUserSheet() {
        await closeSheetDialog(document.getElementById('userActionSheet'));
      }

      function ensureUserSheetDialog() {
        let dlg = document.getElementById('userActionSheet');
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.id = 'userActionSheet';
        dlg.className = 'action-sheet';
        dlg.setAttribute('closedby', 'any');
        dlg.setAttribute('aria-labelledby', 'ushTitle');
        document.body.appendChild(dlg);
        dlg.addEventListener('cancel', (ev) => {
          ev.preventDefault();
          closeUserSheet();
        });
        attachLightDismissFallback(dlg, closeUserSheet);
        return dlg;
      }

      const roleOptions = isZoneAdmin
        ? `<option value="merchant">🏪 منشأة</option><option value="captain">🛵 كابتن</option>`
        : `<option value="merchant">🏪 منشأة</option><option value="captain">🛵 كابتن</option><option value="zone_admin">🛡️ مدير منطقة</option><option value="admin">👑 مدير عام</option>`;
      const zoneSelectHtml = isZoneAdmin
        ? `<select name="zone_id" id="nzone" disabled>${zones.map((z) => `<option value="${z.id}" ${z.id === user.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select>`
        : `<select name="zone_id" id="nzone">${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select>`;

      const addBtnLabelForTab = (t) => ({
        merchant: '➕ منشأة جديدة',
        captain: '➕ كابتن جديد',
        admin: '➕ مسؤول جديد',
      }[t] || '➕ إضافة حساب جديد');

      view().innerHTML = `
        <div class="card users-header-card">
          <div class="row-head">
            <div>
              <h3 class="users-view-title">إدارة الحسابات</h3>
              <div class="mut" id="usersSummaryTxt">جارٍ تحميل الحسابات...</div>
            </div>
            <button type="button" class="ok sm" id="addb" aria-expanded="false" aria-controls="nu">${addBtnLabelForTab(usersTab)}</button>
          </div>
          <form id="nu" class="users-form hide" method="post" action="/api/admin/users">
            <div class="users-form-banner" id="nuHeading">إنشاء حساب جديد</div>
            <div class="row">
              <div>
                <label for="nrole">نوع الحساب</label>
                <select name="role" id="nrole">${roleOptions}</select>
              </div>
              <div id="nzoneWrap">
                <label for="nzone">المنطقة</label>
                ${zoneSelectHtml}
              </div>
            </div>
            <div class="row">
              <div>
                <label for="nuName">الاسم الكامل</label>
                <input id="nuName" name="name" required minlength="2" maxlength="60" autocomplete="name">
              </div>
              <div>
                <label for="nuPhone">رقم الهاتف</label>
                <input id="nuPhone" name="phone" inputmode="tel" required autocomplete="tel" autocorrect="off" autocapitalize="off" spellcheck="false">
              </div>
            </div>
            <div id="nuPwGroup">
              <label for="nuPw">كلمة المرور</label>
              <div id="nuPwHint" class="form-hint">6 أحرف على الأقل (حروف وأرقام).</div>
              <div class="pw-input-row">
                <input id="nuPw" name="password" type="password" minlength="6" maxlength="72" required autocomplete="new-password" aria-describedby="nuPwHint">
                <button type="button" class="sec sm pw-toggle-btn" id="nuPwToggle" aria-pressed="false" aria-label="إظهار كلمة المرور">👁️</button>
              </div>
            </div>
            <div id="mfields">
              <div class="row">
                <div>
                  <label for="nuBiz">اسم المنشأة</label>
                  <input id="nuBiz" name="business_name" maxlength="80" autocomplete="organization">
                </div>
                <div>
                  <label for="nuAddr">العنوان التفصيلي</label>
                  <input id="nuAddr" name="address" maxlength="200" autocomplete="street-address">
                </div>
              </div>
              <div class="nu-loc-link-box">
                <label for="nuMapLink">رابط الموقع من Google Maps</label>
                <div id="nuMapLinkHint" class="form-hint">الصق رابط المشاركة (@lat,lng أو maps.app.goo.gl) لاستخراج الإحداثيات ومعاينتها</div>
                <div class="nu-link-row">
                  <input id="nuMapLink" type="url" dir="ltr" inputmode="url" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="https://maps.app.goo.gl/..." aria-describedby="nuMapLinkHint" aria-invalid="false">
                  <button type="button" class="sec sm" id="nuParseLinkBtn">استخراج الموقع</button>
                </div>
                <div id="nuMapLinkFeedback" class="nu-loc-feedback hide" role="status" aria-live="polite"></div>
              </div>
              <div class="row nu-coords-row">
                <div>
                  <label for="nuLat">خط العرض (Latitude)</label>
                  <input id="nuLat" type="number" step="any" min="-90" max="90" dir="ltr" inputmode="decimal" placeholder="33.513800" aria-invalid="false">
                </div>
                <div>
                  <label for="nuLng">خط الطول (Longitude)</label>
                  <input id="nuLng" type="number" step="any" min="-180" max="180" dir="ltr" inputmode="decimal" placeholder="36.276500" aria-invalid="false">
                </div>
              </div>
              <div id="nuCoordsErr" class="nu-loc-feedback is-error hide" role="status"></div>
              <div id="nuLocActiveWarn" class="nu-loc-active-warn hide" role="status">⚠️ تغيير الموقع لا يؤثر على الطلبات الحالية</div>
              <label id="nmapLabel">موقع المنشأة على الخريطة (اضغط للتحديد أو للمعاينة)</label>
              <div id="nmap" class="map" role="region" aria-labelledby="nmapLabel"></div>
            </div>
            ${!isZoneAdmin ? `
            <div id="capCostFields" class="hide" style="margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:10px">
              <div style="font-weight:700;margin-bottom:8px">⚙️ تكلفة الطلب والإعفاء للكابتن (اختياري)</div>
              <div class="row">
                <div>
                  <label for="nuCostOverride">تكلفة طلب مخصصة (نقطة)</label>
                  <div class="form-hint">فارغ = الافتراضي، 0 = إعفاء دائم، رقم موجب = تكلفة مخصصة</div>
                  <input id="nuCostOverride" type="number" min="0" max="100000" step="1" placeholder="افتراضي">
                </div>
                <div>
                  <label for="nuExemptFrom">بداية الإعفاء المؤقت</label>
                  <input id="nuExemptFrom" type="datetime-local">
                </div>
                <div>
                  <label for="nuExemptUntil">نهاية الإعفاء المؤقت</label>
                  <input id="nuExemptUntil" type="datetime-local">
                </div>
              </div>
            </div>` : ''}
            <div class="nu-form-actions">
              <button type="submit" class="big ok" id="nuSubmitBtn">إنشاء الحساب</button>
              <button type="button" class="sec" id="nuCancelBtn">إلغاء</button>
            </div>
          </form>
        </div>

        <div class="card users-list-card">
          <div class="users-toolbar">
            <div class="users-seg-tabs" id="usersTabs" role="tablist" aria-label="أقسام الحسابات">
              <button type="button" role="tab" id="utab-merchant" data-utab="merchant" aria-controls="usersTabPanel" aria-selected="${usersTab === 'merchant'}" tabindex="${usersTab === 'merchant' ? '0' : '-1'}" class="${usersTab === 'merchant' ? 'active' : ''}">🏪 المنشآت</button>
              <button type="button" role="tab" id="utab-captain" data-utab="captain" aria-controls="usersTabPanel" aria-selected="${usersTab === 'captain'}" tabindex="${usersTab === 'captain' ? '0' : '-1'}" class="${usersTab === 'captain' ? 'active' : ''}">🛵 الكباتن</button>
              ${!isZoneAdmin ? `<button type="button" role="tab" id="utab-admin" data-utab="admin" aria-controls="usersTabPanel" aria-selected="${usersTab === 'admin'}" tabindex="${usersTab === 'admin' ? '0' : '-1'}" class="${usersTab === 'admin' ? 'active' : ''}">🛡️ المسؤولين</button>` : ''}
            </div>
            ${!isZoneAdmin ? `
              <div class="users-zone-filter-wrap">
                <label for="uZoneFilter" class="visually-hidden">تصفية حسب المنطقة</label>
                <select id="uZoneFilter" class="users-zone-filter">
                  <option value="">📍 كل المناطق</option>
                  ${zones.map((z) => `<option value="${z.id}" ${String(z.id) === String(usersZoneFilter) ? 'selected' : ''}>📍 ${esc(z.name)}</option>`).join('')}
                </select>
              </div>
            ` : ''}
          </div>
          <div id="usersTabPanel" role="tabpanel" aria-labelledby="utab-${esc(usersTab)}">
            <div class="tablewrap" id="usersTableWrap"></div>
          </div>
        </div>`;

      let npos = [null, null], origPos = [null, null], editActiveOrdersCount = 0;
      let locationSource = null, nmap = null, nmapCtrl = null, editUserId = null, usersReqSeq = 0;

      wirePwToggle($('#nuPwToggle'), $('#nuPw'));

      const setLinkFeedback = (msg = '', kind = '') => {
        const box = $('#nuMapLinkFeedback');
        const inp = $('#nuMapLink');
        if (!box || !inp) return;
        if (!msg) {
          box.textContent = '';
          box.className = 'nu-loc-feedback hide';
          inp.setAttribute('aria-invalid', 'false');
          inp.setAttribute('aria-describedby', 'nuMapLinkHint');
          return;
        }
        box.textContent = msg;
        box.className = `nu-loc-feedback ${kind === 'error' ? 'is-error' : 'is-ok'}`;
        if (kind === 'error') {
          inp.setAttribute('aria-invalid', 'true');
          inp.setAttribute('aria-describedby', 'nuMapLinkHint nuMapLinkFeedback');
        } else {
          inp.setAttribute('aria-invalid', 'false');
          inp.setAttribute('aria-describedby', 'nuMapLinkHint nuMapLinkFeedback');
        }
      };

      const setCoordsError = (msg = '') => {
        const box = $('#nuCoordsErr');
        const latEl = $('#nuLat');
        const lngEl = $('#nuLng');
        if (!box || !latEl || !lngEl) return;
        if (!msg) {
          box.textContent = '';
          box.classList.add('hide');
          latEl.setAttribute('aria-invalid', 'false');
          lngEl.setAttribute('aria-invalid', 'false');
          latEl.removeAttribute('aria-describedby');
          lngEl.removeAttribute('aria-describedby');
          return;
        }
        box.textContent = `❌ ${msg}`;
        box.classList.remove('hide');
        latEl.setAttribute('aria-invalid', 'true');
        lngEl.setAttribute('aria-invalid', 'true');
        latEl.setAttribute('aria-describedby', 'nuCoordsErr');
        lngEl.setAttribute('aria-describedby', 'nuCoordsErr');
      };

      const syncLocActiveWarning = () => {
        const warnEl = $('#nuLocActiveWarn');
        if (!warnEl) return;
        const isEditingMerch = editUserId != null && $('#nrole')?.value === 'merchant';
        const changed = npos[0] !== origPos[0] || npos[1] !== origPos[1];
        warnEl.classList.toggle('hide', !(isEditingMerch && editActiveOrdersCount > 0 && changed));
      };

      const ensureNuMap = () => {
        if (!nmap) {
          nmap = makeMap('nmap', DAMASCUS, 12);
          nmapCtrl = pickLocation(nmap, (a, b) => {
            npos = [a, b];
            locationSource = 'map';
            if ($('#nuLat')) $('#nuLat').value = String(Number(a.toFixed(6)));
            if ($('#nuLng')) $('#nuLng').value = String(Number(b.toFixed(6)));
            setCoordsError('');
            setLinkFeedback('');
            syncLocActiveWarning();
          });
        }
        setTimeout(() => nmap?.invalidateSize(), 60);
      };

      const readManualCoords = () => {
        const latRaw = enDigits($('#nuLat')?.value || '').trim();
        const lngRaw = enDigits($('#nuLng')?.value || '').trim();
        if (!latRaw && !lngRaw) return { empty: true };
        if (!latRaw || !lngRaw) return { error: 'يرجى إدخال كل من خط العرض وخط الطول' };
        const a = Number(latRaw);
        const b = Number(lngRaw);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) {
          return { error: 'خط العرض يجب أن يكون بين -90 و90 وخط الطول بين -180 و180' };
        }
        if (a === 0 && b === 0) {
          return { error: 'الإحداثيات (0, 0) غير صالحة' };
        }
        return { lat: a, lng: b };
      };

      const handleManualCoordInput = (validateNow = false) => {
        const res = readManualCoords();
        if (res.empty) {
          npos = [null, null];
          nmapCtrl?.clearMarker();
          setCoordsError('');
          syncLocActiveWarning();
          return;
        }
        if (res.error) {
          npos = [null, null];
          if (validateNow) setCoordsError(res.error);
          else setCoordsError('');
          syncLocActiveWarning();
          return;
        }
        npos = [res.lat, res.lng];
        locationSource = 'manual';
        setCoordsError('');
        ensureNuMap();
        nmapCtrl?.setMarker(res.lat, res.lng);
        nmap?.setView([res.lat, res.lng], Math.max(nmap?.getZoom() || 12, 15), { animate: false });
        syncLocActiveWarning();
      };

      $('#nuLat')?.addEventListener('input', () => handleManualCoordInput(false));
      $('#nuLng')?.addEventListener('input', () => handleManualCoordInput(false));
      $('#nuLat')?.addEventListener('blur', () => handleManualCoordInput(true));
      $('#nuLng')?.addEventListener('blur', () => handleManualCoordInput(true));

      const parseMapLink = async () => {
        const inp = $('#nuMapLink');
        const btn = $('#nuParseLinkBtn');
        const raw = inp?.value?.trim() || '';
        if (!raw) {
          setLinkFeedback('❌ يرجى لصق رابط Google Maps أولاً أو استخدام الحقول اليدوية', 'error');
          inp?.focus();
          return;
        }
        if (btn) btn.disabled = true;
        try {
          const data = await api('/admin/geo/parse-link', 'POST', { link: raw });
          const lat = Number(data.lat);
          const lng = Number(data.lng);
          npos = [lat, lng];
          locationSource = 'link';
          if ($('#nuLat')) $('#nuLat').value = String(Number(lat.toFixed(6)));
          if ($('#nuLng')) $('#nuLng').value = String(Number(lng.toFixed(6)));
          setCoordsError('');
          ensureNuMap();
          nmap?.invalidateSize();
          nmap?.setView([lat, lng], 16, { animate: false });
          nmapCtrl?.setMarker(lat, lng);
          setTimeout(() => {
            if (!nmap || !document.body.contains(nmap.getContainer())) return;
            nmap.invalidateSize();
            nmap.setView([lat, lng], 16, { animate: false });
            nmapCtrl?.setMarker(lat, lng);
          }, 80);
          setLinkFeedback(`✅ تم استخراج الموقع من الرابط (${lat.toFixed(5)}, ${lng.toFixed(5)}) — راجع العلامة على الخريطة قبل الحفظ`, 'ok');
          syncLocActiveWarning();
        } catch (err) {
          setLinkFeedback(`❌ ${err?.message || 'تعذّر استخراج الإحداثيات، استخدم الحقول اليدوية أو الخريطة'}`, 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      };

      $('#nuParseLinkBtn')?.addEventListener('click', () => parseMapLink());
      $('#nuMapLink')?.addEventListener('input', () => {
        if ($('#nuMapLink')?.getAttribute('aria-invalid') === 'true') setLinkFeedback('');
      });
      $('#nuMapLink')?.addEventListener('paste', () => {
        setTimeout(() => {
          if ($('#nuMapLink')?.value?.trim()) parseMapLink();
        }, 0);
      });
      $('#nuMapLink')?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          parseMapLink();
        }
      });

      const toDtLocal = (ms) => {
        if (ms == null) return '';
        const d = new Date(Number(ms));
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const fromDtLocal = (val) => {
        if (!val) return null;
        const ms = new Date(val).getTime();
        return Number.isFinite(ms) ? ms : null;
      };

      const syncNuRoleFields = () => {
        const val = $('#nrole').value;
        const isMerch = val === 'merchant';
        $('#mfields').classList.toggle('hide', !isMerch);
        $('#nuBiz').required = isMerch;
        $('#nuAddr').required = isMerch;
        if ($('#capCostFields')) $('#capCostFields').classList.toggle('hide', !(val === 'captain' && editUserId != null));
        if (!isZoneAdmin) $('#nzoneWrap').classList.toggle('hide', val === 'admin');
        if (isMerch && !$('#nu').classList.contains('hide')) ensureNuMap();
      };

      const closeNuForm = () => {
        editUserId = null;
        $('#nu').classList.add('hide');
        $('#addb').setAttribute('aria-expanded', 'false');
      };

      const openCreateForm = () => {
        const nu = $('#nu');
        if (!nu.classList.contains('hide') && editUserId == null) {
          closeNuForm();
          return;
        }
        editUserId = null;
        nu.reset();
        npos = [null, null];
        origPos = [null, null];
        editActiveOrdersCount = 0;
        locationSource = null;
        if ($('#nuMapLink')) $('#nuMapLink').value = '';
        if ($('#nuLat')) $('#nuLat').value = '';
        if ($('#nuLng')) $('#nuLng').value = '';
        setLinkFeedback('');
        setCoordsError('');
        syncLocActiveWarning();
        nmapCtrl?.clearMarker();
        nmap?.setView(DAMASCUS, 12, { animate: false });
        const defaultRole = usersTab === 'admin' ? 'zone_admin' : usersTab;
        $('#nrole').value = isZoneAdmin && defaultRole === 'zone_admin' ? 'merchant' : defaultRole;
        if (!isZoneAdmin && usersZoneFilter) {
          $('#nzone').value = String(usersZoneFilter);
        }
        $('#nuHeading').textContent = '➕ إنشاء حساب جديد';
        $('#nuPwGroup').classList.remove('hide');
        $('#nuPw').required = true;
        $('#nuPw').type = 'password';
        $('#nuPwToggle').setAttribute('aria-pressed', 'false');
        $('#nuPwToggle').textContent = '👁️';
        $('#nuSubmitBtn').textContent = 'إنشاء الحساب';
        nu.classList.remove('hide');
        $('#addb').setAttribute('aria-expanded', 'true');
        syncNuRoleFields();
        $('#nuName').focus();
      };

      const openEditForm = (u) => {
        editUserId = u.id;
        const nu = $('#nu');
        nu.reset();
        locationSource = null;
        editActiveOrdersCount = Number(u.active_orders_count || 0);
        origPos = [u.lat ?? null, u.lng ?? null];
        if ($('#nuMapLink')) $('#nuMapLink').value = '';
        setLinkFeedback('');
        setCoordsError('');
        $('#nuHeading').textContent = `✏️ تعديل بيانات: ${u.business_name || u.name}`;
        $('#nrole').value = u.role;
        if (u.zone_id != null && $('#nzone')) $('#nzone').value = String(u.zone_id);
        $('#nuName').value = u.name || '';
        $('#nuPhone').value = u.phone || '';
        $('#nuBiz').value = u.business_name || '';
        $('#nuAddr').value = u.address || '';
        $('#nuPwGroup').classList.add('hide');
        $('#nuPw').required = false;
        if ($('#nuCostOverride')) {
          $('#nuCostOverride').value = u.cost_override != null ? String(u.cost_override) : '';
          $('#nuExemptFrom').value = toDtLocal(u.exempt_from);
          $('#nuExemptUntil').value = toDtLocal(u.exempt_until);
        }
        $('#nuSubmitBtn').textContent = '💾 حفظ التعديلات';
        nu.classList.remove('hide');
        $('#addb').setAttribute('aria-expanded', 'true');
        syncNuRoleFields();
        if (u.role === 'merchant') {
          ensureNuMap();
          if (u.lat != null && u.lng != null) {
            npos = [u.lat, u.lng];
            if ($('#nuLat')) $('#nuLat').value = String(u.lat);
            if ($('#nuLng')) $('#nuLng').value = String(u.lng);
            setTimeout(() => {
              if (!nmap || !document.body.contains(nmap.getContainer())) return;
              nmap.invalidateSize();
              nmap.setView([u.lat, u.lng], 15, { animate: false });
              nmapCtrl?.setMarker(u.lat, u.lng);
            }, 80);
          } else {
            npos = [null, null];
            if ($('#nuLat')) $('#nuLat').value = '';
            if ($('#nuLng')) $('#nuLng').value = '';
            nmapCtrl?.clearMarker();
          }
        } else {
          npos = [null, null];
          if ($('#nuLat')) $('#nuLat').value = '';
          if ($('#nuLng')) $('#nuLng').value = '';
        }
        syncLocActiveWarning();
        nu.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => $('#nuName')?.focus(), 120);
      };

      async function renderUsersTable(role, zoneId) {
        const wrap = $('#usersTableWrap');
        if (!wrap) return;
        const seq = ++usersReqSeq;
        const params = new URLSearchParams({ role });
        if (!isZoneAdmin && zoneId) params.set('zone_id', String(zoneId));
        const rows = await api(`/admin/users?${params.toString()}`);
        if (seq !== usersReqSeq || !$('#usersTableWrap')) return;
        currentUsersList = rows;

        const tabNouns = { merchant: 'منشأة', captain: 'كابتن', admin: 'مسؤول' };
        const zoneSuffix = !isZoneAdmin && zoneId ? ` في ${zname(Number(zoneId))}` : '';
        const sumEl = $('#usersSummaryTxt');
        if (sumEl) sumEl.textContent = `${rows.length} ${tabNouns[role] || 'حساب'}${zoneSuffix}`;

        let theadHtml = '';
        let tbodyHtml = '';
        if (role === 'merchant') {
          theadHtml = `<tr><th scope="col">الاسم</th><th scope="col">اسم المنشأة</th><th scope="col">الهاتف</th><th scope="col">المنطقة</th><th scope="col">الحالة</th><th scope="col">إجراءات</th></tr>`;
          tbodyHtml = rows.map((u) => `<tr>
            <td>${esc(u.name)}</td>
            <td><b>🏪 ${esc(u.business_name || '—')}</b>${u.address ? `<div class="mut">${esc(u.address)}</div>` : ''}</td>
            <td dir="ltr">${esc(u.phone)}</td>
            <td>${esc(zname(u.zone_id))}</td>
            <td>${badge(u.status)}</td>
            <td class="td-user-actions">
              <button type="button" class="user-more-btn" data-user-sheet="${u.id}"><span aria-hidden="true">⋯</span><span class="visually-hidden">إجراءات المنشأة ${esc(u.business_name || u.name)}</span></button>
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="mut">لا توجد منشآت مسجلة في هذا النطاق</td></tr>';
        } else if (role === 'captain') {
          theadHtml = `<tr><th scope="col">الاسم</th><th scope="col">الهاتف</th><th scope="col">المنطقة</th><th scope="col">الحالة</th><th scope="col">إجراءات</th></tr>`;
          const capCostPill = (u) => {
            if (u.cost_source === 'exempt_temporary') return '<span class="badge b-active">✨ إعفاء مؤقت (0 نقطة)</span>';
            if (u.cost_source === 'exempt_permanent') return '<span class="badge b-active">✨ معفى دائم (0 نقطة)</span>';
            if (u.cost_source === 'override') return `<span class="badge">${u.effective_cost_points} نقطة (مخصص)</span>`;
            return '';
          };
          tbodyHtml = rows.map((u) => `<tr>
            <td><b>🛵 ${esc(u.name)}</b>${u.tag ? ` <code dir="ltr" class="cap-tag-pill">#${esc(u.tag)}</code>` : ''} ${capCostPill(u)}</td>
            <td dir="ltr">${esc(u.phone)}</td>
            <td>${esc(zname(u.zone_id))}</td>
            <td>
              <div class="user-status-cell">
                ${u.status !== 'active' ? badge(u.status) : ''}
                <span class="cap-online-pill ${u.online ? 'is-online' : 'is-offline'}"><span class="online-dot" aria-hidden="true"></span>${u.online ? 'متصل' : 'غير متصل'}</span>
              </div>
              ${renderCaptainLocDiag(u)}
            </td>
            <td class="td-user-actions">
              <button type="button" class="user-more-btn" data-user-sheet="${u.id}"><span aria-hidden="true">⋯</span><span class="visually-hidden">إجراءات الكابتن ${esc(u.name)}</span></button>
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="mut">لا يوجد كباتن مسجلون في هذا النطاق</td></tr>';
        } else {
          theadHtml = `<tr><th scope="col">الاسم</th><th scope="col">الهاتف</th><th scope="col">الصلاحية</th><th scope="col">المنطقة</th><th scope="col">الحالة</th><th scope="col">إجراءات</th></tr>`;
          tbodyHtml = rows.map((u) => `<tr>
            <td><b>${esc(u.name)}</b>${u.id === user.id ? ' <span class="badge b-active">أنت</span>' : ''}</td>
            <td dir="ltr">${esc(u.phone)}</td>
            <td>${u.role === 'admin' ? '<span class="role-pill is-super">👑 مدير عام</span>' : '<span class="role-pill is-zone">🛡️ مدير منطقة</span>'}</td>
            <td>${u.role === 'admin' && !u.zone_id ? '<span class="mut">كل المناطق</span>' : esc(zname(u.zone_id))}</td>
            <td>${badge(u.status)}</td>
            <td class="td-user-actions">
              <button type="button" class="user-more-btn" data-user-sheet="${u.id}"><span aria-hidden="true">⋯</span><span class="visually-hidden">إجراءات المسؤول ${esc(u.name)}</span></button>
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="mut">لا يوجد مسؤولون في هذا النطاق</td></tr>';
        }

        wrap.innerHTML = `<table><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table>`;
        syncMobileTableLabels();
      }

      function openUserSheet(uid) {
        const u = currentUsersList.find((x) => x.id === Number(uid));
        if (!u) return;
        const dlg = ensureUserSheetDialog();
        dlg.removeAttribute('data-closing');
        const isSelf = u.id === user.id;
        const displayTitle = u.business_name || u.name;
        const zoneLabel = u.role === 'admin' && !u.zone_id ? 'كل المناطق' : zname(u.zone_id);

        const headerMarkup = `
          <div class="sheet-grab-wrap"><span class="sheet-grab-handle" aria-hidden="true"></span></div>
          <div class="sheet-header">
            <div class="sheet-title-group">
              <h3 id="ushTitle">${esc(displayTitle)}${u.tag ? ` <code dir="ltr" class="cap-tag-pill">#${esc(u.tag)}</code>` : ''}</h3>
              ${badge(u.status)}
            </div>
            <button type="button" class="ghost sm sheet-close-btn" data-uact="close" aria-label="إغلاق">✕</button>
          </div>
          <div class="sheet-meta">
            <span>📞 <b dir="ltr">${esc(u.phone)}</b></span>
            <span>📍 ${esc(zoneLabel)}</span>
          </div>`;

        const renderMain = () => {
          const toggleLabel = u.status === 'active' ? '⏸️ إيقاف الحساب' : '✅ تفعيل الحساب';
          const toggleClass = u.status === 'active' ? 'sec' : 'ok';
          dlg.innerHTML = `${headerMarkup}
            <div class="sheet-actions-list">
              <button type="button" class="sec sheet-act-btn" data-uact="edit" autofocus>
                <span>✏️ تعديل البيانات</span><span class="sheet-chevron" aria-hidden="true">›</span>
              </button>
              <button type="button" class="sec sheet-act-btn" data-uact="pw">
                <span>🔑 تغيير كلمة المرور</span><span class="sheet-chevron" aria-hidden="true">›</span>
              </button>
              ${!isSelf ? `
                <button type="button" class="${toggleClass} sheet-act-btn" data-uact="toggle-status">
                  <span>${toggleLabel}</span><span class="sheet-chevron" aria-hidden="true">›</span>
                </button>
                <button type="button" class="bad sheet-act-btn" data-uact="delete">
                  <span>🗑️ حذف الحساب</span>
                </button>
              ` : ''}
            </div>`;
        };

        const renderPwForm = () => {
          dlg.innerHTML = `${headerMarkup}
            <form id="sheetPwForm" class="sheet-subform" method="post" action="/api/admin/users/${u.id}/reset-password">
              <label for="sheetNewPw">كلمة المرور الجديدة لحساب «${esc(displayTitle)}»</label>
              <div id="sheetPwHint" class="form-hint">6 أحرف على الأقل (تُسجِّل خروج الجلسات السابقة تلقائياً).</div>
              <div class="pw-input-row">
                <input id="sheetNewPw" name="password" type="password" minlength="6" maxlength="72" required autocomplete="new-password" aria-describedby="sheetPwHint">
                <button type="button" class="sec sm pw-toggle-btn" id="sheetPwToggle" aria-pressed="false" aria-label="إظهار كلمة المرور">👁️</button>
              </div>
              <div class="sheet-subform-actions">
                <button type="submit" class="ok">💾 حفظ كلمة المرور</button>
                <button type="button" class="sec" data-uact="back">رجوع</button>
              </div>
            </form>`;
          wirePwToggle(dlg.querySelector('#sheetPwToggle'), dlg.querySelector('#sheetNewPw'));
          dlg.querySelector('#sheetPwForm').onsubmit = async (ev) => {
            ev.preventDefault();
            const pw = dlg.querySelector('#sheetNewPw').value;
            const btn = ev.submitter || dlg.querySelector('#sheetPwForm button[type="submit"]');
            if (btn) btn.disabled = true;
            const ok = await act(() => api(`/admin/users/${u.id}/reset-password`, 'POST', { password: pw }), 'تم تغيير كلمة المرور');
            if (btn) btn.disabled = false;
            if (ok) await closeUserSheet();
          };
          dlg.querySelector('#sheetNewPw')?.focus();
        };

        const renderDeleteConfirm = () => {
          dlg.innerHTML = `${headerMarkup}
            <div class="sheet-confirm-box">
              <p id="delConfirmDesc" class="sheet-confirm-msg">⚠️ هل أنت متأكد من حذف حساب <b>${esc(displayTitle)}</b>؟ سيُمنع الحساب من تسجيل الدخول ويختفي من القائمة مع الاحتفاظ الكامل بسجل الطلبات السابقة.</p>
              <div class="sheet-subform-actions">
                <button type="button" class="sec" data-uact="back" id="cancelDeleteUserBtn" autofocus>تراجع</button>
                <button type="button" class="bad" data-uact="confirm-delete" id="confirmDeleteUserBtn" aria-describedby="delConfirmDesc">🗑️ تأكيد الحذف</button>
              </div>
            </div>`;
          dlg.querySelector('#cancelDeleteUserBtn')?.focus();
        };

        dlg.onclick = async (ev) => {
          const btn = ev.target.closest('[data-uact]');
          if (!btn) return;
          const action = btn.dataset.uact;
          if (action === 'close') {
            await closeUserSheet();
          } else if (action === 'back') {
            renderMain();
            dlg.querySelector('[data-uact="edit"]')?.focus();
          } else if (action === 'edit') {
            await closeUserSheet();
            openEditForm(u);
          } else if (action === 'pw') {
            renderPwForm();
          } else if (action === 'toggle-status') {
            const nextStatus = u.status === 'active' ? 'suspended' : 'active';
            btn.disabled = true;
            const ok = await act(() => api(`/admin/users/${u.id}`, 'PATCH', { status: nextStatus }), nextStatus === 'active' ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب');
            btn.disabled = false;
            if (ok) {
              await closeUserSheet();
              await renderUsersTable(usersTab, usersZoneFilter);
            }
          } else if (action === 'delete') {
            renderDeleteConfirm();
          } else if (action === 'confirm-delete') {
            btn.disabled = true;
            const ok = await deleteUser(u.id);
            btn.disabled = false;
            if (ok) {
              await closeUserSheet();
              await renderUsersTable(usersTab, usersZoneFilter);
            }
          }
        };

        renderMain();
        if (!dlg.open) dlg.showModal();
      }

      const activateUsersTab = async (nextTab, focusTab = false) => {
        if (!nextTab || (isZoneAdmin && nextTab === 'admin')) return;
        usersTab = nextTab;
        $$('#usersTabs [role="tab"]').forEach((b) => {
          const on = b.dataset.utab === usersTab;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', String(on));
          b.tabIndex = on ? 0 : -1;
          if (on && focusTab) b.focus();
        });
        $('#usersTabPanel')?.setAttribute('aria-labelledby', `utab-${usersTab}`);
        $('#addb').textContent = addBtnLabelForTab(usersTab);
        if (!$('#nu').classList.contains('hide') && editUserId == null) {
          const defaultRole = usersTab === 'admin' ? 'zone_admin' : usersTab;
          $('#nrole').value = isZoneAdmin && defaultRole === 'zone_admin' ? 'merchant' : defaultRole;
          syncNuRoleFields();
        }
        await renderUsersTable(usersTab, usersZoneFilter);
      };

      $('#addb').onclick = openCreateForm;
      $('#nuCancelBtn').onclick = closeNuForm;
      $('#nrole').onchange = syncNuRoleFields;

      $('#usersTabs').onclick = (e) => {
        const b = e.target.closest('[data-utab]');
        if (b && b.dataset.utab !== usersTab) activateUsersTab(b.dataset.utab);
      };

      $('#usersTabs').onkeydown = (e) => {
        const tabs = $$('#usersTabs [role="tab"]');
        const idx = tabs.indexOf(document.activeElement);
        if (idx < 0) return;
        let nextIdx = -1;
        // RTL tablist: ArrowLeft moves to next tab, ArrowRight moves to previous tab
        if (e.key === 'ArrowLeft') nextIdx = (idx + 1) % tabs.length;
        else if (e.key === 'ArrowRight') nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabs.length - 1;
        if (nextIdx >= 0) {
          e.preventDefault();
          activateUsersTab(tabs[nextIdx].dataset.utab, true);
        }
      };

      if ($('#uZoneFilter')) {
        $('#uZoneFilter').onchange = async (e) => {
          usersZoneFilter = e.target.value;
          if (!$('#nu').classList.contains('hide') && editUserId == null && usersZoneFilter) {
            $('#nzone').value = String(usersZoneFilter);
          }
          await renderUsersTable(usersTab, usersZoneFilter);
        };
      }

      $('#nu').onsubmit = async (e) => {
        e.preventDefault();
        const subBtn = $('#nuSubmitBtn');
        const f = Object.fromEntries(new FormData(e.target));
        if (isZoneAdmin) f.zone_id = Number(user.zone_id);
        else if (f.role === 'admin') f.zone_id = null;
        else f.zone_id = Number(f.zone_id);

        if (f.role === 'merchant') {
          const mc = readManualCoords();
          if (mc.error) {
            setCoordsError(mc.error);
            $('#nuLat')?.focus();
            return toast(mc.error);
          }
          if (!mc.empty) {
            npos = [mc.lat, mc.lng];
          }
          if (npos[0] == null || npos[1] == null) {
            const msg = 'حدّد موقع المنشأة عبر الرابط أو خط العرض والطول أو الخريطة';
            setCoordsError(msg);
            $('#nuLat')?.focus();
            return toast(msg);
          }
          [f.lat, f.lng] = npos;
          if (locationSource && (editUserId == null || npos[0] !== origPos[0] || npos[1] !== origPos[1])) {
            f.location_source = locationSource;
          }
        } else {
          delete f.business_name;
          delete f.address;
        }

        if (subBtn) subBtn.disabled = true;
        let ok = false;
        if (editUserId != null) {
          delete f.password;
          if (!isZoneAdmin && f.role === 'captain' && $('#nuCostOverride')) {
            const coRaw = $('#nuCostOverride').value.trim();
            f.cost_override = coRaw === '' ? null : Number(coRaw);
            f.exempt_from = fromDtLocal($('#nuExemptFrom').value);
            f.exempt_until = fromDtLocal($('#nuExemptUntil').value);
          }
          const patchRes = await act(() => api(`/admin/users/${editUserId}`, 'PATCH', f), null);
          ok = Boolean(patchRes);
          if (ok) toast(patchRes.warning || 'تم تحديث بيانات الحساب');
        } else {
          if (f.zone_id === null) delete f.zone_id;
          ok = await act(() => api('/admin/users', 'POST', f), 'تم إنشاء الحساب');
        }
        if (subBtn) subBtn.disabled = false;

        if (ok) {
          const targetTab = (f.role === 'admin' || f.role === 'zone_admin') ? 'admin' : f.role;
          closeNuForm();
          if (!isZoneAdmin && targetTab !== usersTab) {
            await activateUsersTab(targetTab);
          } else {
            await renderUsersTable(usersTab, usersZoneFilter);
          }
        }
      };

      view().onclick = (e) => {
        const sheetBtn = e.target.closest('[data-user-sheet]');
        if (sheetBtn) {
          openUserSheet(sheetBtn.dataset.userSheet);
        }
      };
      view().onchange = null;

      await renderUsersTable(usersTab, usersZoneFilter);
    },

    async orders() {
      const [rows, d] = await Promise.all([api('/admin/orders'), api('/admin/live')]);
      liveCache = d;
      if (d.intervals) locIntervals = d.intervals;
      rememberOrders(rows);
      rememberOrders(d.orders);
      updateShortageBanner(d.shortage);
      const capList = d.captains || [];
      const statusOpts = ['searching', 'offered', 'accepted', 'picked_up', 'arrived', 'delivered', 'cancelled', 'failed', 'expired']
        .map((k) => `<option value="${k}">${esc(STATUS[k] || k)}</option>`).join('');
      view().innerHTML = `<div class="card">
        <div class="row-head" style="flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <h3 style="margin:0">📦 سجل وبحث الطلبات <span id="orderCount" class="mut" style="font-size:13px"></span></h3>
          <div style="display:flex;gap:8px;flex:1;justify-content:flex-end;flex-wrap:wrap;min-width:260px">
            <input id="orderSearch" placeholder="🔍 ابحث بالرقم التسلسلي للطلب (مثال: 0001 أو 1) أو المنشأة أو الكابتن أو العنوان..." style="max-width:400px;margin:0">
            <select id="orderStatusFilter" style="max-width:190px;margin:0"><option value="">كل الحالات (${rows.length})</option>${statusOpts}</select>
            <button type="button" class="ok sm" data-add-order="">➕ إضافة طلب لكابتن</button>
          </div>
        </div>
        <div class="tablewrap"><table><thead><tr><th>الرقم التسلسلي</th><th>المنشأة</th><th>عنوان التوصيل</th><th>الحالة</th><th>إدارة الكابتن</th><th>الوقت</th><th>إجراءات</th></tr></thead><tbody id="orderRows"></tbody></table></div></div><div id="detail"></div>`;
      const renderOrders = () => {
        const q = $('#orderSearch')?.value || '';
        const st = $('#orderStatusFilter')?.value || '';
        const filtered = rows.filter((o) => matchOrder(o, q, st));
        $('#orderCount').textContent = `(${filtered.length} من ${rows.length})`;
        $('#orderRows').innerHTML = filtered.map((o) => `<tr><td dir="ltr"><b class="serial-pill">${serialNo(o)}</b></td><td><b>🏪 ${esc(o.merchant.name)}</b></td><td><b>📍 ${esc(o.customer_address || '—')}</b></td><td>${orderStatusBadge(o)}</td><td>${renderOrderCaptainCell(o, capList)}</td><td>${time(o.created_at)}${o.closed_at ? `<div class="mut">أُغلق ${time(o.closed_at)}</div>` : ''}</td><td>${renderOrderRowActions(o)}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد طلبات مطابقة للبحث</td></tr>';
      };
      renderOrders();
      $('#orderSearch').oninput = renderOrders;
      $('#orderStatusFilter').onchange = renderOrders;
      view().onclick = async (e) => {
        if (await handleOrderActionClick(e)) return;
        const dEl = e.target.closest('[data-d]');
        if (dEl) detail(dEl.dataset.d);
        const capEl = e.target.closest('[data-cap]');
        if (capEl) {
          e.preventDefault();
          const cid = Number(capEl.dataset.cap);
          const cap = capList.find((c) => c.id === cid) || rows.find((r) => r.captain?.id === cid)?.captain;
          if (cap) captainModal(cap);
        }
      };
    },

    async wallet() {
      const caps = await api('/admin/users?role=captain');
      const kindLabel = (k) => k === 'topup' ? 'شحن' : k === 'deduction' ? 'خصم طلب' : 'تعديل';
      view().innerHTML = `
        <div class="card">
          <h3>💰 محفظة النقاط وشحن الكباتن</h3>
          <search>
            <form id="wTagForm" class="row" style="align-items:flex-end;gap:10px;flex-wrap:wrap">
              <div style="flex:1;min-width:200px">
                <label for="wTagQuery">بحث بكود الكابتن (مثال: K7Q3M أو #K7Q3M)</label>
                <input id="wTagQuery" name="tag" required placeholder="#K7Q3M" autocorrect="off" autocapitalize="none" spellcheck="false" autocomplete="off">
              </div>
              <button type="submit" class="ok">🔍 فتح المحفظة</button>
            </form>
          </search>
        </div>
        <div class="card">
          <div class="row-head">
            <h3 style="margin:0">قائمة الكباتن والأرصدة (${caps.length})</h3>
            <span class="mut" style="font-size:12px">1 نقطة = 0.01 دينار أردني (أرقام صحيحة فقط)</span>
          </div>
          <div class="tablewrap">
            <table>
              <thead><tr><th>الكابتن</th><th>الكود</th><th>الهاتف</th><th>المنطقة</th><th>الرصيد</th><th>تكلفة الطلب</th><th>إجراء</th></tr></thead>
              <tbody>
                ${caps.map((u) => `<tr>
                  <td><b>🛵 ${esc(u.name)}</b></td>
                  <td dir="ltr">${u.tag ? `<code class="cap-tag-pill">#${esc(u.tag)}</code>` : '—'}</td>
                  <td dir="ltr">${esc(u.phone)}</td>
                  <td>${esc(zname(u.zone_id))}</td>
                  <td><b style="color:${(u.balance_points ?? 0) < (u.effective_cost_points ?? 25) ? 'var(--bad)' : 'var(--ok)'}">${u.balance_points ?? 0} نقطة</b></td>
                  <td>${u.effective_cost_points ?? 25} نقطة</td>
                  <td><button type="button" class="ok sm" data-wcap="${u.id}">⚡ شحن / السجل</button></td>
                </tr>`).join('') || '<tr><td colspan="7" class="mut">لا يوجد كباتن</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      const openCaptainWalletModal = async (cid) => {
        let dlg = $('#walletModal');
        if (!dlg) {
          dlg = document.createElement('dialog');
          dlg.id = 'walletModal';
          dlg.className = 'wallet-dlg';
          dlg.setAttribute('aria-labelledby', 'walletModalTitle');
          document.body.appendChild(dlg);
          dlg.addEventListener('click', (ev) => {
            if (ev.target === dlg) dlg.close();
          });
        }
        const data = await api(`/admin/captains/${cid}/ledger?limit=25`);
        const c = data.captain;
        const now = Date.now();
        let clientRef = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Determine exemption status line
        let exemptStatusText = 'غير معفى';
        if (c.cost_override === 0) {
          exemptStatusText = 'معفى دائم';
        } else if (c.exempt_until && Number(c.exempt_until) > now) {
          if (!c.exempt_from || Number(c.exempt_from) <= now) {
            exemptStatusText = `معفى حتى ${time(c.exempt_until)}`;
          } else {
            exemptStatusText = `إعفاء يبدأ ${time(c.exempt_from)} حتى ${time(c.exempt_until)}`;
          }
        }

        const sourceLabel = c.cost_source === 'exempt_permanent' ? 'إعفاء دائم' :
                            c.cost_source === 'exempt_temporary' ? 'إعفاء مؤقت' :
                            c.cost_source === 'override' ? 'سعر مخصص' : 'الافتراضي العام';

        dlg.innerHTML = `
          <div class="row-head" style="margin-bottom:10px">
            <div>
              <h3 id="walletModalTitle" style="margin:0">💳 محفظة ${esc(c.name)} ${c.tag ? `<code dir="ltr" class="cap-tag-pill">#${esc(c.tag)}</code>` : ''}</h3>
              <div class="mut" style="font-size:13px">الرصيد الحالي: <b>${c.balance_points ?? 0} نقطة</b> — التكلفة الفعلية: <b>${c.effective_cost_points} نقطة</b> (${sourceLabel})</div>
            </div>
            <button type="button" class="sec sm" id="wmClose">✕ إغلاق</button>
          </div>
          <form id="wmTopupForm">
            <div style="font-weight:700;margin-bottom:6px">💰 شحن الرصيد اليدوي</div>
            <label for="wmPts">إضافة رصيد (نقاط صحيحة — اتركه فارغاً إذا كنت تعدل الرسوم فقط)</label>
            <input id="wmPts" name="points" type="number" min="1" max="10000000" step="1" inputmode="numeric" placeholder="مثال: 500">
            <div class="wallet-presets">
              <button type="button" class="sec sm" data-addpts="100">+100</button>
              <button type="button" class="sec sm" data-addpts="250">+250</button>
              <button type="button" class="sec sm" data-addpts="500">+500</button>
              <button type="button" class="sec sm" data-addpts="1000">+1000</button>
            </div>
            <label for="wmNote" style="margin-top:6px">ملاحظة / رقم الحوالة (اختياري)</label>
            <input id="wmNote" name="note" maxlength="200" placeholder="حوالة بنكية / تسليم يدوي">

            ${!isZoneAdmin ? `
            <div class="billing-settings-box" style="margin-top:14px;padding:12px;border:1px solid var(--border-neutral-strong);border-radius:10px;background:var(--bg-subtle)">
              <div style="font-weight:700;margin-bottom:4px">⚙️ إعدادات الرسوم والخصم (المدير العام)</div>
              <div class="mut" style="font-size:12.5px;margin-bottom:8px">حالة الإعفاء الحالية: <b class="clr-ok-soft">${exemptStatusText}</b></div>

              <label for="wmCostOverride">تكلفة الطلب للكابتن (نقطة)</label>
              <div class="form-hint">فارغ = استخدام الافتراضي العام | 0 = معفى دائم | رقم موجب = تكلفة خاصة للكابتن</div>
              <input id="wmCostOverride" name="cost_override" type="number" min="0" max="100000" step="1" placeholder="استخدام الافتراضي العام">
              <div class="mut" style="font-size:12px;margin:2px 0 8px">القيمة الفعالة حالياً: <b>${c.effective_cost_points} نقطة</b> (المصدر: ${sourceLabel})</div>

              <div class="row">
                <div>
                  <label for="wmExemptFrom">بداية الإعفاء المؤقت</label>
                  <input id="wmExemptFrom" name="exempt_from" type="datetime-local">
                </div>
                <div>
                  <label for="wmExemptUntil">نهاية الإعفاء المؤقت</label>
                  <input id="wmExemptUntil" name="exempt_until" type="datetime-local">
                </div>
              </div>
            </div>` : ''}

            <div style="margin-top:14px;display:flex;gap:8px">
              <button type="submit" class="big ok" id="wmSubmit" style="flex:1">حفظ / تنفيذ العملية</button>
            </div>
          </form>
          <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
          <h4 style="margin:0 0 8px">📜 آخر الحركات المالية</h4>
          <div class="tablewrap">
            <table>
              <thead><tr><th>النوع</th><th>النقاط</th><th>الرصيد بعد</th><th>البيان</th><th>الوقت</th></tr></thead>
              <tbody>
                ${(data.entries || []).map((e) => `<tr>
                  <td>${kindLabel(e.kind)}</td>
                  <td dir="ltr"><b style="color:${e.amount >= 0 ? 'var(--ok)' : 'var(--bad)'}">${e.amount > 0 ? `+${e.amount}` : e.amount}</b></td>
                  <td>${e.balance_after}</td>
                  <td>${esc(e.note || (e.order_id ? `طلب #${String(e.order_id).padStart(4, '0')}` : '—'))}</td>
                  <td>${time(e.at)}</td>
                </tr>`).join('') || '<tr><td colspan="5" class="mut">لا توجد حركات مسجلة</td></tr>'}
              </tbody>
            </table>
          </div>`;

        if (!dlg.open) dlg.showModal();
        const closeBtn = dlg.querySelector('#wmClose');
        if (closeBtn) closeBtn.onclick = () => dlg.close();

        // Pre-fill billing fields for admin
        const costInp = dlg.querySelector('#wmCostOverride');
        if (!isZoneAdmin && costInp) {
          costInp.value = c.cost_override != null ? String(c.cost_override) : '';
          const fromInp = dlg.querySelector('#wmExemptFrom');
          if (fromInp) fromInp.value = toDtLocal(c.exempt_from);
          const untilInp = dlg.querySelector('#wmExemptUntil');
          if (untilInp) untilInp.value = toDtLocal(c.exempt_until);
        }

        dlg.querySelectorAll('[data-addpts]').forEach((b) => {
          b.onclick = () => { $('#wmPts').value = b.dataset.addpts; };
        });

        const topupForm = dlg.querySelector('#wmTopupForm');
        if (topupForm) topupForm.onsubmit = async (ev) => {
          ev.preventDefault();
          const btn = dlg.querySelector('#wmSubmit');

          const ptsInp = dlg.querySelector('#wmPts');
          const rawPts = ptsInp ? ptsInp.value.trim() : '';
          let doTopup = false;
          let pts = 0;
          if (rawPts !== '') {
            pts = Number(rawPts);
            if (!Number.isInteger(pts) || pts < 1) return toast('أدخل عدد نقاط صحيحاً موجباً للشحن');
            doTopup = true;
          }

          let doBillingPatch = false;
          const billingPayload = {};
          const costEl = dlg.querySelector('#wmCostOverride');
          if (!isZoneAdmin && costEl) {
            const rawCost = costEl.value.trim();
            const fromEl = dlg.querySelector('#wmExemptFrom');
            const untilEl = dlg.querySelector('#wmExemptUntil');
            const rawFrom = fromEl ? fromEl.value : '';
            const rawUntil = untilEl ? untilEl.value : '';

            // Cost validation
            let parsedCost = null;
            if (rawCost !== '') {
              parsedCost = Number(rawCost);
              if (!Number.isInteger(parsedCost) || parsedCost < 0) {
                return toast('تكلفة الطلب يجب أن تكون عدداً صحيحاً أكبر من أو يساوي 0 أو فارغاً');
              }
            }

            const fromEpoch = rawFrom ? new Date(rawFrom).getTime() : null;
            const untilEpoch = rawUntil ? new Date(rawUntil).getTime() : null;

            // Date validation
            if (fromEpoch != null && untilEpoch != null && untilEpoch <= fromEpoch) {
              return toast('تاريخ نهاية الإعفاء يجب أن يكون بعد تاريخ البداية');
            }
            if (fromEpoch == null && untilEpoch != null && untilEpoch < Date.now()) {
              return toast('تاريخ نهاية الإعفاء يجب أن يكون في المستقبل عند عدم تحديد تاريخ بداية');
            }

            // Check what changed compared to c
            const prevCost = c.cost_override != null ? Number(c.cost_override) : null;
            if (parsedCost !== prevCost) {
              billingPayload.cost_override = parsedCost;
              doBillingPatch = true;
            }

            const prevFrom = c.exempt_from != null ? Number(c.exempt_from) : null;
            if (fromEpoch !== prevFrom) {
              billingPayload.exempt_from = fromEpoch;
              doBillingPatch = true;
            }

            const prevUntil = c.exempt_until != null ? Number(c.exempt_until) : null;
            if (untilEpoch !== prevUntil) {
              billingPayload.exempt_until = untilEpoch;
              doBillingPatch = true;
            }
          }

          if (!doTopup && !doBillingPatch) {
            return toast('لم تقم بتغيير أي بيانات أو إدخال نقاط للشحن');
          }

          if (btn) btn.disabled = true;
          let topupOk = false;
          let billingOk = false;

          try {
            if (doTopup) {
              const noteInp = dlg.querySelector('#wmNote');
              const res = await act(() => api(`/admin/captains/${c.id}/topup`, 'POST', {
                points: pts,
                note: noteInp ? noteInp.value.trim() : '',
                client_ref: clientRef,
              }), 'تم شحن النقاط بنجاح');
              if (res) topupOk = true;
            }

            if (doBillingPatch) {
              const res = await act(() => api(`/admin/users/${c.id}`, 'PATCH', billingPayload), 'تم حفظ إعدادات الرسوم والإعفاء');
              if (res) billingOk = true;
            }

            if (topupOk || billingOk) {
              await openCaptainWalletModal(c.id);
            }
          } finally {
            if (btn) btn.disabled = false;
          }
        };
      };

      $('#wTagForm').onsubmit = async (e) => {
        e.preventDefault();
        const raw = $('#wTagQuery').value.trim().replace(/^#+/, '').toUpperCase();
        if (!raw) return;
        try {
          const cap = await api(`/admin/captains/by-tag/${encodeURIComponent(raw)}`);
          await openCaptainWalletModal(cap.id);
        } catch (err) {
          toast(err.message || 'الكابتن غير موجود');
        }
      };

      view().onclick = (e) => {
        const wBtn = e.target.closest('[data-wcap]');
        if (wBtn) openCaptainWalletModal(Number(wBtn.dataset.wcap));
      };
    },

    async settings() {
      const s = await api('/admin/stats');
      const pgLabels = {
        grace: 'فترة سماح (فحص 100 م عند توفر GPS)',
        on: 'إلزامي (GPS مطلوب + نطاق 100 م)',
        off: 'متوقف',
      };
      if (isZoneAdmin) {
        view().innerHTML = `<div class="grid">
          <div class="card commission-card">
            <h3>🪙 إعدادات النقاط والطلبات</h3>
            <p class="mut">تكلفة الطلب الافتراضية: <b>${points(s.order_cost_points ?? 25)}</b> (تُحدّد من الإدارة العامة)</p>
            <p class="mut">حجب الكابتن منخفض الرصيد: <b>${s.wallet_enforcement === 'on' ? 'مفعّل' : 'متوقف'}</b></p>
            <p class="mut">التحقق من موقع الاستلام (100 م): <b>${esc(pgLabels[s.pickup_gps_required || 'grace'] || 'فترة سماح')}</b></p>
            ${s.points_cutover_at ? `<p class="mut" style="font-size:12px">تفعيل محفظة النقاط: ${time(s.points_cutover_at)}</p>` : ''}
          </div>
          <div class="card"><h3>المنطقة المخصصة</h3><ul>${zones.map((z) => `<li>${esc(z.name)}</li>`).join('')}</ul></div></div>`;
        return;
      }
      view().innerHTML = `<div class="grid">
        <div class="card commission-card">
          <h3>🪙 إعدادات محفظة النقاط</h3>
          <label for="ocp">تكلفة الطلب الافتراضية (نقطة — القيمة 1 نقطة = 0.01 دينار أردني)</label>
          <div class="row"><input id="ocp" type="number" min="0" max="100000" step="1" value="${s.order_cost_points ?? 25}"><button type="button" id="ocpSave">حفظ</button></div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer">
            <input id="wenf" type="checkbox" style="width:auto;margin:0" ${s.wallet_enforcement === 'on' ? 'checked' : ''}>
            <span>منع استقبال الطلبات تلقائياً عند عدم كفاية رصيد النقاط</span>
          </label>
          <label for="pgps" style="display:block;margin-top:14px">التحقق من موقع الكابتن عند الاستلام (نطاق 100 م حول المنشأة)</label>
          <select id="pgps">
            <option value="grace" ${(s.pickup_gps_required || 'grace') === 'grace' ? 'selected' : ''}>فترة سماح (فحص 100 م إن توفر GPS والسماح بدونه)</option>
            <option value="on" ${s.pickup_gps_required === 'on' ? 'selected' : ''}>إلزامي بالكامل (يرفض الاستلام بدون GPS أو خارج 100 م)</option>
            <option value="off" ${s.pickup_gps_required === 'off' ? 'selected' : ''}>متوقف (تجاوز فحص المسافة)</option>
          </select>
          ${s.points_cutover_at ? `<p class="mut" style="font-size:12px;margin-top:12px">تفعيل نظام النقاط منذ: ${time(s.points_cutover_at)}</p>` : ''}
        </div>
        <div class="card"><h3>المناطق</h3><ul>${zones.map((z) => `<li>${esc(z.name)}</li>`).join('')}</ul><div class="row"><input id="zn" placeholder="اسم منطقة جديدة"><button type="button" id="za">إضافة</button></div></div></div>`;
      $('#ocpSave').onclick = () => act(() => api('/admin/settings/order-cost', 'PUT', { value: Number($('#ocp').value) }), 'تم حفظ تكلفة الطلب');
      $('#wenf').onchange = () => act(() => api('/admin/settings/wallet-enforcement', 'PUT', { enabled: $('#wenf').checked }), $('#wenf').checked ? 'تم تفعيل حجب الرصيد المنخفض' : 'تم إيقاف حجب الرصيد المنخفض');
      $('#pgps').onchange = () => act(() => api('/admin/settings/pickup-gps', 'PUT', { value: $('#pgps').value }), 'تم تحديث إعداد التحقق من الموقع');
      $('#za').onclick = async () => { await act(() => api('/admin/zones', 'POST', { name: $('#zn').value }), 'تمت الإضافة'); views.settings(); };
    },
  };

  function openLiabilityModal(orderId, onSaved) {
    let dlg = $('#liabilityModal');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'liabilityModal';
      dlg.className = 'wallet-dlg';
      dlg.setAttribute('aria-labelledby', 'liabModalTitle');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
    }
    dlg.innerHTML = `
      <div class="row-head" style="margin-bottom:10px">
        <div>
          <h3 id="liabModalTitle" style="margin:0">⚠️ تسوية / خصم نقاط تعويض</h3>
          <div class="mut" style="font-size:13px">يسجل كحركة خصم يدوي سالبة في سجل الكابتن (للمدير العام فقط)</div>
        </div>
        <button type="button" class="sec sm" id="liabClose">✕ إغلاق</button>
      </div>
      <form id="liabForm">
        <label for="liabPts">عدد النقاط المخصومة (نقطة صحيحة)</label>
        <input id="liabPts" name="points" type="number" min="1" max="1000000" step="1" inputmode="numeric" required autofocus placeholder="مثال: 50">
        <label for="liabReason" style="margin-top:8px">السبب الإلزامي (تلف / تأخير / تعويض)</label>
        <input id="liabReason" name="reason" minlength="3" maxlength="200" required placeholder="اكتب السبب بوضوح">
        <div class="row" style="margin-top:12px">
          <button type="submit" class="bad" id="liabSubmit">تأكيد خصم النقاط</button>
          <button type="button" class="sec" id="liabCancel">إلغاء</button>
        </div>
      </form>`;
    if (!dlg.open) dlg.showModal();
    $('#liabClose').onclick = () => dlg.close();
    $('#liabCancel').onclick = () => dlg.close();
    $('#liabForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = $('#liabSubmit');
      const pts = Number($('#liabPts').value);
      const reason = $('#liabReason').value.trim();
      btn.disabled = true;
      const res = await act(() => api(`/admin/orders/${orderId}/liability`, 'POST', { points: pts, reason }), 'تم خصم نقاط التسوية');
      btn.disabled = false;
      if (res) {
        dlg.close();
        if (onSaved) await onSaved(res);
      }
    };
  }

  async function detail(id, targetBox = null) {
    const detBox = targetBox || $('#detail');
    if (!detBox) return;
    if (targetBox) {
      const pageDet = $('#view #detail');
      if (pageDet) pageDet.innerHTML = '';
    } else {
      const sheetDet = $('#sheetDetail');
      if (sheetDet) sheetDet.innerHTML = '';
    }
    const o = await api(`/admin/orders/${id}`);
    ordersIndex.set(o.id, o);
    const capList = liveCache.captains || [];
    const hasMap = (o.merchant?.lat != null) || (o.customer_lat != null) || (o.captain?.lat != null);
    detBox.innerHTML = `<div class="card"><h3>طلب — الرقم التسلسلي <span dir="ltr">${serialNo(o)}</span> ${orderStatusBadge(o)}</h3>
        <p><b>المنشأة:</b> ${esc(o.merchant.name)} — <b>📍 عنوان التوصيل:</b> ${esc(o.customer_address || '—')}</p>
        ${!targetBox ? `<div style="margin:10px 0;padding:10px;background:var(--bg-subtle);border-radius:10px">
          <b>🛵 الكابتن المسند للطلب:</b>
          <div style="margin-top:6px">${renderOrderCaptainCell(o, capList)}</div>
        </div>` : `<p><b>🛵 الكابتن:</b> ${esc(o.captain?.name || 'غير معيّن')}</p>`}
        <p>تكلفة الطلب: <b>${points(o.cost_points ?? 0)}</b>${o.cost_source === 'exempt' ? ' <span class="badge b-active">معفى</span>' : o.cost_source === 'captain_override' ? ' <span class="mut">(سعر خاص)</span>' : ''}${o.liability ? ` — تسوية نقاط إدارية: <b class="clr-bad">-${points(o.liability)}</b> (${esc(o.liability_reason || '')})` : ''}${o.cost_points == null && o.commission > 0 ? ` <span class="mut">(أرشيف ل.س: ${enDigits(o.commission)})</span>` : ''}</p>
        ${hasMap ? '<div id="dmap" class="map" style="height:260px"></div>' : ''}
        <ol class="timeline">${o.events.map((e) => `<li>${time(e.at)} — ${esc(e.type)} ${esc(e.actor || '')}</li>`).join('')}</ol>
        ${!targetBox ? `<div class="row">${o.status === 'accepted' ? `<button type="button" class="ok" id="fpBtn">⚡ تأكيد استلام (تجاوز GPS)</button>` : ''}${!isZoneAdmin && o.captain_id !== undefined && o.captain ? `<button type="button" class="bad" id="lb">⚠️ تعديل / خصم نقاط (تعويض)</button>` : ''}
        ${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? '<button type="button" class="sec" id="ca">إلغاء الطلب نهائياً</button>' : ''}</div>` : ''}</div>`;
    if (hasMap) {
      const dmap = makeMap('dmap', DAMASCUS, 13);
      const pts = [];
      if (o.merchant?.lat != null) {
        L.marker([o.merchant.lat, o.merchant.lng], { icon: emoji('🏪') }).addTo(dmap).bindTooltip(`🏪 ${o.merchant.name}`);
        pts.push([o.merchant.lat, o.merchant.lng]);
      }
      if (o.customer_lat != null) {
        L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(dmap).bindTooltip(`📍 ${o.customer_address || ''}`);
        pts.push([o.customer_lat, o.customer_lng]);
      }
      if (o.captain?.lat != null) {
        L.marker([o.captain.lat, o.captain.lng], { icon: emoji('🛵') })
          .addTo(dmap)
          .bindTooltip(`🛵 ${o.captain.name}`)
          .bindPopup(renderCaptainPopupHtml({ ...o.captain, busy: true, active_order_id: o.serial_id || o.id, online: true }))
          .on('popupopen', tickCaptainLocAges);
        pts.push([o.captain.lat, o.captain.lng]);
      }
      if (pts.length) fitMapToPoints(dmap, pts);
      if (o.captain?.lat != null && ['accepted', 'picked_up', 'arrived'].includes(o.status)) {
        const dest = o.status === 'accepted' ? [o.merchant?.lat, o.merchant?.lng] : [o.customer_lat, o.customer_lng];
        if (dest[0] != null) makeRoute(dmap, [o.captain.lat, o.captain.lng], dest);
      }
      setTimeout(() => dmap.invalidateSize(), 120);
    }
    $('#fpBtn', detBox)?.addEventListener('click', async () => {
      if (!confirm('تأكيد استلام الطلب إدارياً وتجاوز فحص GPS؟')) return;
      const ok = await act(() => api(`/admin/orders/${id}/force-pickup`, 'POST', {}), 'تم تأكيد استلام الطلب إدارياً');
      if (ok) { await detail(id, targetBox); await refreshCurrentTab(); }
    });
    $('#lb', detBox)?.addEventListener('click', () => {
      openLiabilityModal(id, async () => {
        await detail(id, targetBox);
        await refreshCurrentTab();
      });
    });
    $('#ca', detBox)?.addEventListener('click', async () => {
      if (confirm('إلغاء الطلب نهائياً؟')) {
        await act(() => api(`/admin/orders/${id}/cancel`, 'POST'), 'تم الإلغاء');
        detail(id, targetBox);
        await refreshCurrentTab();
      }
    });
    detBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function findMerchantByOrder(o) {
    if (!o) return null;
    if (o.merchant_id != null) {
      const byId = (liveCache.merchants || []).find((m) => m.id === o.merchant_id);
      if (byId) return byId;
    }
    const name = o.merchant?.name;
    if (!name) return null;
    return (liveCache.merchants || []).find((m) => (m.business_name || m.name) === name) || null;
  }

  function orderBelongsToMerchant(o, m) {
    if (!o || !m) return false;
    if (o.merchant_id != null) return o.merchant_id === m.id;
    const oName = o.merchant?.name;
    return Boolean(oName && oName === (m.business_name || m.name));
  }

  function getMerchantOpenOrders(m) {
    return (liveCache.orders || []).filter(
      (o) => orderBelongsToMerchant(o, m) && !['delivered', 'cancelled', 'failed', 'expired'].includes(o.status)
    );
  }

  function getMerchantTransferableOrder(m) {
    const open = getMerchantOpenOrders(m);
    return open.find((o) => o.status === 'searching') || open.find((o) => o.status === 'offered') || null;
  }

  function getMerchantVisualState(m) {
    const open = getMerchantOpenOrders(m);
    if (open.some((o) => ['searching', 'offered'].includes(o.status))) {
      return { stateKey: 'yellow', stateClass: 'ops-state-yellow ops-pulsing', pulsing: true, label: 'بانتظار كابتن', openOrders: open };
    }
    if (open.some((o) => ['accepted', 'picked_up', 'arrived'].includes(o.status))) {
      return { stateKey: 'green', stateClass: 'ops-state-green ops-pulsing', pulsing: true, label: 'طلب نشط قيد التنفيذ', openOrders: open };
    }
    return { stateKey: 'neutral', stateClass: 'ops-state-neutral', pulsing: false, label: 'لا يوجد طلب مفتوح', openOrders: [] };
  }

  function getCaptainVisualState(c) {
    return deriveCaptainVisualState(c, liveCache.orders || []);
  }

  function isLiveStateFilterVisible(stateKey) {
    if (stateKey === 'green') return liveFilters.showGreen;
    if (stateKey === 'blue') return liveFilters.showBlue;
    if (stateKey === 'yellow') return liveFilters.showYellow;
    if (stateKey === 'neutral') return liveFilters.showNeutral;
    if (stateKey === 'gray') return liveFilters.showGray;
    return true;
  }

  function renderLiveHint() {
    const bar = $('#liveHintBar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.classList.remove('is-selecting', 'is-warning');

    if (liveHintOverride?.text) {
      if (liveHintOverride.tone === 'warning') bar.classList.add('is-warning');
      else if (liveHintOverride.tone === 'selecting') bar.classList.add('is-selecting');
      const sp = document.createElement('span');
      sp.textContent = liveHintOverride.text;
      bar.appendChild(sp);
      return;
    }

    if (liveSelection?.kind === 'merchant') {
      const m = (liveCache.merchants || []).find((x) => x.id === liveSelection.merchantId);
      const ord = (liveCache.orders || []).find((x) => x.id === liveSelection.orderId) || ordersIndex.get(liveSelection.orderId);
      bar.classList.add('is-selecting');
      const sp = document.createElement('span');
      sp.textContent = `📌 محدد: طلب ${ord ? serialNo(ord) : ''} من «${m?.business_name || m?.name || 'المنشأة'}» — اختر كابتن أونلاين للنقل (أو Esc للإلغاء)`;
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'live-hint-clear';
      clr.textContent = '✕ إلغاء';
      clr.addEventListener('click', () => setLiveSelection(null));
      bar.append(sp, clr);
      return;
    }

    if (liveSelection?.kind === 'captain') {
      const cap = (liveCache.captains || []).find((x) => x.id === liveSelection.captainId);
      bar.classList.add('is-selecting');
      const sp = document.createElement('span');
      sp.textContent = `📌 محدد: الكابتن «${cap?.name || 'الكابتن'}» — اختر منشأة صفراء لنقل طلبها إليه (أو Esc للإلغاء)`;
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'live-hint-clear';
      clr.textContent = '✕ إلغاء';
      clr.addEventListener('click', () => setLiveSelection(null));
      bar.append(sp, clr);
      return;
    }

    const sp = document.createElement('span');
    sp.textContent = '💡 اضغط على منشأة صفراء (بحث/عرض) أو كابتن أونلاين لنقل وتوجيه الطلبات';
    bar.appendChild(sp);
  }

  function showLiveNotice(text, tone = 'warning', durationMs = 4500) {
    if (liveHintOverride?.timer) clearTimeout(liveHintOverride.timer);
    const timer = setTimeout(() => {
      liveHintOverride = null;
      renderLiveHint();
    }, durationMs);
    liveHintOverride = { text, tone, timer };
    renderLiveHint();
  }

  function setLiveSelection(sel) {
    if (liveHintOverride?.timer) clearTimeout(liveHintOverride.timer);
    liveHintOverride = null;
    liveSelection = sel;
    refreshAllMarkerSelectionClasses();
    renderLiveHint();
  }

  function buildLiveMarkerIcon({ kindClass, stateClass, selected, validTarget, dimmed, glyph, badgeCount }) {
    const classes = ['ops-marker', kindClass, stateClass];
    if (selected) classes.push('is-selected');
    if (validTarget) classes.push('is-valid-target');
    if (dimmed) classes.push('is-dimmed');
    const badgeHtml = badgeCount > 0 ? `<span class="ops-pin-badge" aria-hidden="true">${badgeCount}</span>` : '';
    return L.divIcon({
      className: classes.join(' '),
      html: `<span class="ops-pin-ring" aria-hidden="true"></span><span class="ops-pin-core" aria-hidden="true">${glyph}</span>${badgeHtml}`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function wireMarkerDomAccessibility(mk, ariaLabel, onActivate) {
    mk._opsActivate = onActivate;
    mk._opsAriaLabel = ariaLabel;
    const applyToEl = () => {
      const el = mk.getElement?.();
      if (!el) return;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', mk._opsAriaLabel || '');
      if (!el.dataset.opsKeyWired) {
        el.dataset.opsKeyWired = '1';
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            mk._opsActivate?.();
          }
        });
      }
    };
    if (!mk._opsClickWired) {
      mk._opsClickWired = true;
      mk.on('click', () => mk._opsActivate?.());
      mk.on('add', applyToEl);
    }
    applyToEl();
  }

  function computeMerchantSelectionFlags(m, st) {
    const transferable = getMerchantTransferableOrder(m);
    const selected = liveSelection?.kind === 'merchant' && liveSelection.merchantId === m.id;
    let validTarget = false;
    let dimmed = false;
    if (liveSelection?.kind === 'captain') {
      validTarget = Boolean(transferable);
      dimmed = !validTarget;
    } else if (liveSelection?.kind === 'merchant' && !selected) {
      dimmed = true;
    }
    return { selected, validTarget, dimmed, transferableCount: st.openOrders.length };
  }

  function computeCaptainSelectionFlags(c) {
    const selected = liveSelection?.kind === 'captain' && liveSelection.captainId === c.id;
    let validTarget = false;
    let dimmed = false;
    if (liveSelection?.kind === 'merchant') {
      validTarget = Boolean(c.online);
      dimmed = !c.online;
    } else if (liveSelection?.kind === 'captain' && !selected) {
      dimmed = true;
    }
    return { selected, validTarget, dimmed };
  }

  function upsertMerchantMarker(m) {
    if (!liveMap || m == null) return;
    const existing = merchMarkers.get(m.id);
    if (m.lat == null || m.lng == null) {
      if (existing) { existing.remove(); merchMarkers.delete(m.id); }
      return;
    }
    const st = getMerchantVisualState(m);
    const shouldShow = liveFilters.showMerchants && isLiveStateFilterVisible(st.stateKey);
    const { selected, validTarget, dimmed, transferableCount } = computeMerchantSelectionFlags(m, st);
    const name = m.business_name || m.name || 'منشأة';
    const orderInfo = st.openOrders.length
      ? ` — ${st.openOrders.map((o) => `${serialNo(o)} (${STATUS[o.status] || o.status})`).join('، ')}`
      : ' — لا يوجد طلب مفتوح';
    const tip = `🏪 ${name}${orderInfo}`;
    const sig = `${st.stateClass}|${selected ? 1 : 0}|${validTarget ? 1 : 0}|${dimmed ? 1 : 0}|${transferableCount}`;

    let mk = existing;
    if (!mk) {
      const icon = buildLiveMarkerIcon({
        kindClass: 'ops-merchant',
        stateClass: st.stateClass,
        selected,
        validTarget,
        dimmed,
        glyph: '🏪',
        badgeCount: transferableCount,
      });
      mk = L.marker([m.lat, m.lng], { icon });
      mk._opsSig = sig;
      mk._opsCoords = `${m.lat},${m.lng}`;
      mk.bindTooltip(tip);
      merchMarkers.set(m.id, mk);
    } else {
      const coords = `${m.lat},${m.lng}`;
      if (mk._opsCoords !== coords) {
        mk.setLatLng([m.lat, m.lng]);
        mk._opsCoords = coords;
      }
      if (mk._opsSig !== sig) {
        mk.setIcon(buildLiveMarkerIcon({
          kindClass: 'ops-merchant',
          stateClass: st.stateClass,
          selected,
          validTarget,
          dimmed,
          glyph: '🏪',
          badgeCount: transferableCount,
        }));
        mk._opsSig = sig;
      }
      mk.setTooltipContent?.(tip) || mk.bindTooltip(tip);
    }

    if (shouldShow) {
      if (!liveMap.hasLayer(mk)) mk.addTo(liveMap);
    } else if (liveMap.hasLayer(mk)) {
      mk.remove();
    }

    wireMarkerDomAccessibility(mk, tip, () => {
      const freshM = (liveCache.merchants || []).find((x) => x.id === m.id) || m;
      handleMerchantTap(freshM);
    });
  }

  function upsertCaptainMarker(c, { animate = false } = {}) {
    if (!liveMap || c == null) return;
    const existing = capMarkers.get(c.id);
    if (c.lat == null || c.lng == null) {
      if (existing) { existing.remove(); capMarkers.delete(c.id); }
      return;
    }
    const st = getCaptainVisualState(c);
    const shouldShow = liveFilters.showCaptains && isLiveStateFilterVisible(st.stateKey);
    const { selected, validTarget, dimmed } = computeCaptainSelectionFlags(c);
    const actCount = st.activeCount || c.active_orders?.length || (st.busy ? 1 : 0);
    const tip = `🛵 ${c.name} — ${st.busy ? `${st.label} (${actCount})` : st.label}`;
    const sig = `${st.stateClass}|${selected ? 1 : 0}|${validTarget ? 1 : 0}|${dimmed ? 1 : 0}|${actCount}`;

    let mk = existing;
    if (!mk) {
      const icon = buildLiveMarkerIcon({
        kindClass: 'ops-captain',
        stateClass: st.stateClass,
        selected,
        validTarget,
        dimmed,
        glyph: '🛵',
        badgeCount: actCount,
      });
      mk = L.marker([c.lat, c.lng], { icon });
      mk._opsSig = sig;
      mk._opsCoords = `${c.lat},${c.lng}`;
      mk.bindTooltip(tip);
      capMarkers.set(c.id, mk);
    } else {
      const coords = `${c.lat},${c.lng}`;
      if (mk._opsCoords !== coords) {
        if (animate && liveMap.hasLayer(mk)) animateMarker(mk, [c.lat, c.lng]);
        else mk.setLatLng([c.lat, c.lng]);
        mk._opsCoords = coords;
      }
      if (mk._opsSig !== sig) {
        mk.setIcon(buildLiveMarkerIcon({
          kindClass: 'ops-captain',
          stateClass: st.stateClass,
          selected,
          validTarget,
          dimmed,
          glyph: '🛵',
          badgeCount: actCount,
        }));
        mk._opsSig = sig;
      }
      mk.setTooltipContent?.(tip) || mk.bindTooltip(tip);
    }

    if (shouldShow) {
      if (!liveMap.hasLayer(mk)) mk.addTo(liveMap);
    } else if (liveMap.hasLayer(mk)) {
      mk.remove();
    }

    wireMarkerDomAccessibility(mk, tip, () => {
      const freshC = (liveCache.captains || []).find((x) => x.id === c.id) || c;
      handleCaptainTap(freshC);
    });
  }

  function refreshAllMarkerSelectionClasses() {
    (liveCache.merchants || []).forEach((m) => upsertMerchantMarker(m));
    (liveCache.captains || []).forEach((c) => upsertCaptainMarker(c));
  }

  function syncOrderOverlay(o) {
    if (!liveMap || !o?.id) return;
    const pinKey = 'c' + o.id;
    const isClosed = ['delivered', 'cancelled', 'failed', 'expired'].includes(o.status);
    const showRoutes = liveFilters.showRoutes && !isClosed;

    const existingPin = orderMarkers.get(pinKey);
    if (showRoutes && o.customer_lat != null && o.customer_lng != null) {
      const tip = `📍 طلب ${serialNo(o)}: ${o.customer_address || ''}`;
      if (!existingPin) {
        const mk = L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(liveMap).bindTooltip(tip);
        orderMarkers.set(pinKey, mk);
      } else {
        existingPin.setLatLng([o.customer_lat, o.customer_lng]);
        if (!liveMap.hasLayer(existingPin)) existingPin.addTo(liveMap);
        existingPin.setTooltipContent?.(tip);
      }
    } else if (existingPin) {
      existingPin.remove();
      orderMarkers.delete(pinKey);
    }

    if (!(routeLayers instanceof Map)) routeLayers = new Map();
    const existingRoute = routeLayers.get(o.id);
    if (showRoutes && o.captain?.lat != null && ['accepted', 'picked_up', 'arrived'].includes(o.status)) {
      const dest = o.status === 'accepted' ? [o.merchant?.lat, o.merchant?.lng] : [o.customer_lat, o.customer_lng];
      const capCoords = `${o.captain.lat},${o.captain.lng}->${dest[0]},${dest[1]}`;
      if (dest[0] != null && dest[1] != null) {
        if (!existingRoute || existingRoute._opsSig !== capCoords) {
          existingRoute?.layer?.remove?.();
          const tokenSig = capCoords;
          makeRoute(liveMap, [o.captain.lat, o.captain.lng], dest).then((layer) => {
            if (tab === 'live' && liveMap && liveFilters.showRoutes) {
              const prev = routeLayers.get(o.id);
              prev?.layer?.remove?.();
              routeLayers.set(o.id, { layer, _opsSig: tokenSig });
            } else {
              layer.remove();
            }
          });
        } else if (existingRoute.layer && !liveMap.hasLayer(existingRoute.layer)) {
          existingRoute.layer.addTo(liveMap);
        }
      }
    } else if (existingRoute) {
      existingRoute.layer?.remove?.();
      routeLayers.delete(o.id);
    }
  }

  function updateLegendCountsAndKpis() {
    const orders = (liveCache.orders || []).filter((o) => !['delivered', 'cancelled', 'failed', 'expired'].includes(o.status));
    const merchants = liveCache.merchants || [];
    const captains = liveCache.captains || [];

    let mCount = 0, cCount = 0, green = 0, blue = 0, yellow = 0, neutral = 0, gray = 0;
    let visCount = 0;
    merchants.forEach((m) => {
      if (m.lat == null || m.lng == null) return;
      mCount++;
      const st = getMerchantVisualState(m);
      if (st.stateKey === 'green') green++;
      else if (st.stateKey === 'yellow') yellow++;
      else neutral++;
      if (liveFilters.showMerchants && isLiveStateFilterVisible(st.stateKey)) visCount++;
    });
    captains.forEach((c) => {
      if (c.lat == null || c.lng == null) return;
      cCount++;
      const st = getCaptainVisualState(c);
      if (st.stateKey === 'green') green++;
      else if (st.stateKey === 'blue') blue++;
      else if (st.stateKey === 'yellow') yellow++;
      else gray++;
      if (liveFilters.showCaptains && isLiveStateFilterVisible(st.stateKey)) visCount++;
    });

    const onlineCaps = captains.filter((c) => c.online).length;
    const setTxt = (id, val) => { const el = $(id); if (el) el.textContent = String(val); };
    setTxt('#lkLiveOrders', orders.length);
    setTxt('#lkOnlineCaps', `${onlineCaps}/${captains.length}`);
    setTxt('#lkMerchants', merchants.length);
    setTxt('#lfcMerchants', mCount);
    setTxt('#lfcCaptains', cCount);
    setTxt('#lfcRoutes', orders.length);
    setTxt('#lfcGreen', green);
    setTxt('#lfcBlue', blue);
    setTxt('#lfcYellow', yellow);
    setTxt('#lfcNeutral', neutral);
    setTxt('#lfcGray', gray);
    setTxt('#liveVisSummary', visCount);
  }

  function applyLiveFiltersAndMarkers() {
    if (tab !== 'live' || !liveMap) return;
    (liveCache.merchants || []).forEach((m) => upsertMerchantMarker(m));
    (liveCache.captains || []).forEach((c) => upsertCaptainMarker(c));
    (liveCache.orders || []).forEach((o) => syncOrderOverlay(o));
    updateLegendCountsAndKpis();
  }

  function syncCaptainDerivedBusyState(captainId) {
    if (!captainId) return null;
    const cap = (liveCache.captains || []).find((c) => c.id === captainId);
    if (!cap) return null;
    const acts = (liveCache.orders || []).filter(
      (o) => o.captain_id === captainId && ['accepted', 'picked_up', 'arrived'].includes(o.status)
    );
    cap.busy = acts.length > 0;
    cap.active_order_id = acts[0]?.id ?? null;
    cap.active_orders = acts.map((x) => ({
      id: x.id,
      serial_no: x.serial_no || String(x.id).padStart(4, '0'),
      customer_address: x.customer_address,
      status: x.status,
    }));
    return cap;
  }

  function applyOrderUpdateToLiveCache(freshOrder) {
    if (!freshOrder?.id) return;
    rememberOrders([freshOrder]);
    const orders = liveCache.orders || (liveCache.orders = []);
    const idx = orders.findIndex((x) => x.id === freshOrder.id);
    const prevOrder = idx >= 0 ? orders[idx] : null;
    const prevCapId = prevOrder?.captain_id ?? null;
    const isClosed = ['delivered', 'cancelled', 'failed', 'expired'].includes(freshOrder.status);

    if (isClosed) {
      if (idx >= 0) orders.splice(idx, 1);
    } else if (idx >= 0) {
      orders[idx] = freshOrder;
    } else {
      orders.unshift(freshOrder);
    }

    if (tab === 'live' && liveMap) {
      const m = findMerchantByOrder(freshOrder) || findMerchantByOrder(prevOrder);
      if (m) upsertMerchantMarker(m);
      if (prevCapId && prevCapId !== freshOrder.captain_id) {
        const oldCap = syncCaptainDerivedBusyState(prevCapId);
        if (oldCap) upsertCaptainMarker(oldCap);
      }
      if (freshOrder.captain_id) {
        const newCap = syncCaptainDerivedBusyState(freshOrder.captain_id);
        if (newCap) {
          if (freshOrder.captain?.lat != null && newCap.lat == null) {
            newCap.lat = freshOrder.captain.lat;
            newCap.lng = freshOrder.captain.lng;
          }
          upsertCaptainMarker(newCap);
        }
      }
      syncOrderOverlay(freshOrder);
      if (liveSelection?.kind === 'merchant' && liveSelection.orderId === freshOrder.id) {
        if (!['searching', 'offered'].includes(freshOrder.status)) {
          setLiveSelection(null);
          showLiveNotice(`ℹ️ تغيرت حالة الطلب ${serialNo(freshOrder)} إلى «${STATUS[freshOrder.status] || freshOrder.status}»`, 'info', 3500);
        }
      }
      updateLegendCountsAndKpis();
    }
  }

  function handleMerchantTap(m) {
    if (!m) return;
    if (liveSelection?.kind === 'captain') {
      const cap = (liveCache.captains || []).find((c) => c.id === liveSelection.captainId);
      if (!cap || !cap.online) {
        setLiveSelection(null);
        showLiveNotice('⛔ الكابتن المحدد لم يعد متصلاً', 'warning');
        return;
      }
      const open = getMerchantOpenOrders(m);
      const transferable = getMerchantTransferableOrder(m);
      if (transferable) {
        openLiveTransferDialog(transferable, m, cap);
        return;
      }
      const locked = open.find((o) => ['picked_up', 'arrived'].includes(o.status));
      if (locked) {
        showLiveNotice(`⚠️ لا يمكن نقل الطلب ${serialNo(locked)} بعد الاستلام أو الوصول للزبون عبر الخريطة`, 'warning');
        toast('لا يمكن نقل طلب بعد الاستلام أو الوصول للزبون');
        return;
      }
      const acceptedOnly = open.find((o) => o.status === 'accepted');
      if (acceptedOnly) {
        showLiveNotice(`ℹ️ الطلب ${serialNo(acceptedOnly)} قيد التوجه للمنشأة بالفعل وليس في حالة بحث/عرض`, 'warning');
        return;
      }
      showLiveNotice(`ℹ️ منشأة «${m.business_name || m.name}» ليس لديها طلب في حالة بحث أو عرض للنقل`, 'warning');
      return;
    }

    if (liveSelection?.kind === 'merchant' && liveSelection.merchantId === m.id) {
      setLiveSelection(null);
      return;
    }

    const open = getMerchantOpenOrders(m);
    const transferable = getMerchantTransferableOrder(m);
    if (transferable) {
      setLiveSelection({ kind: 'merchant', merchantId: m.id, orderId: transferable.id });
      return;
    }
    const locked = open.find((o) => ['picked_up', 'arrived'].includes(o.status));
    if (locked) {
      showLiveNotice(`⚠️ لا يمكن نقل الطلب ${serialNo(locked)} لأنه في حالة «${STATUS[locked.status]}» (تم استلامه أو وصل للزبون)`, 'warning');
      toast('لا يمكن نقل طلب تم استلامه أو وصل للزبون من الخريطة');
      return;
    }
    const acceptedOnly = open.find((o) => o.status === 'accepted');
    if (acceptedOnly) {
      showLiveNotice(`ℹ️ طلب «${m.business_name || m.name}» (${serialNo(acceptedOnly)}) مسند بالفعل لكابتن في الطريق للمنشأة`, 'warning');
      return;
    }
    showLiveNotice(`ℹ️ منشأة «${m.business_name || m.name}» ليس لديها أي طلب مفتوح حالياً`, 'warning', 3200);
  }

  function handleCaptainTap(c) {
    if (!c) return;
    if (!c.online) {
      showLiveNotice(`⛔ الكابتن «${c.name}» أوفلاين حالياً ولا يصلح للنقل`, 'warning');
      toast('الكابتن أوفلاين ولا يمكن تعيين الطلبات له');
      return;
    }
    if (liveSelection?.kind === 'merchant') {
      const m = (liveCache.merchants || []).find((x) => x.id === liveSelection.merchantId);
      const ord = (liveCache.orders || []).find((o) => o.id === liveSelection.orderId) || getMerchantTransferableOrder(m);
      if (!ord || !['searching', 'offered'].includes(ord.status)) {
        setLiveSelection(null);
        showLiveNotice('⚠️ الطلب لم يعد في حالة بحث أو عرض للنقل', 'warning');
        return;
      }
      openLiveTransferDialog(ord, m, c);
      return;
    }
    if (liveSelection?.kind === 'captain' && liveSelection.captainId === c.id) {
      setLiveSelection(null);
      return;
    }
    setLiveSelection({ kind: 'captain', captainId: c.id });
  }

  function openLiveTransferDialog(order, merchant, captain) {
    const dlg = $('#liveTransferDialog');
    if (!dlg) return;
    if (!['searching', 'offered'].includes(order?.status)) {
      showLiveNotice('⚠️ لا يمكن نقل هذا الطلب في حالته الحالية', 'warning');
      return;
    }
    if (!captain?.online) {
      showLiveNotice('⛔ الكابتن أوفلاين ولا يصلح للنقل', 'warning');
      return;
    }

    const merchName = merchant?.business_name || merchant?.name || order.merchant?.name || 'المنشأة';
    const capName = captain.name || 'الكابتن';
    const actCount = captain.active_orders?.length || (captain.busy ? 1 : 0);
    const capStateLabel = captain.busy ? `مشغول حالياً (${actCount} طلب)` : 'أونلاين متاح';

    $('#ltMsg').innerHTML = `هل تريد نقل الطلب <b dir="ltr">${serialNo(order)}</b> من «<b>${esc(merchName)}</b>» إلى «<b>${esc(capName)}</b>»؟`;
    $('#ltMeta').innerHTML = `
      <div>📍 <b>الوجهة:</b> ${esc(order.customer_address || '—')}</div>
      <div>🛵 <b>حالة الكابتن:</b> ${esc(capStateLabel)}</div>
      <div>💰 <b>رصيد الكابتن:</b> ${points(captain.balance_points ?? 0)}${captain.effective_cost_points != null ? ` • <b>تكلفة الطلب:</b> ${points(captain.effective_cost_points)}` : ''}</div>`;

    const warnBox = $('#ltWarnBox');
    const confirmBtn = $('#ltConfirmBtn');
    const cancelBtn = $('#ltCancelBtn');
    const closeBtn = $('#ltCloseBtn');
    warnBox.classList.add('hide');
    warnBox.textContent = '';
    confirmBtn.textContent = '✓ تأكيد النقل';
    confirmBtn.removeAttribute('aria-describedby');
    confirmBtn.disabled = false;

    const ac = new AbortController();
    let awaitingWarningConfirm = false;

    const cleanup = () => ac.abort();
    dlg.addEventListener('close', cleanup, { once: true });

    const closeDlg = () => {
      cleanup();
      if (dlg.open) dlg.close();
    };
    cancelBtn.addEventListener('click', closeDlg, { signal: ac.signal });
    closeBtn.addEventListener('click', closeDlg, { signal: ac.signal });

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      try {
        const body = awaitingWarningConfirm
          ? { captain_id: captain.id, confirm_warning: true }
          : { captain_id: captain.id, check_warning: true };
        const res = await api(`/admin/orders/${order.id}/assign-captain`, 'POST', body);
        if (res?.needs_confirm && res.warning) {
          awaitingWarningConfirm = true;
          warnBox.textContent = `⚠️ ${res.warning}`;
          warnBox.classList.remove('hide');
          confirmBtn.textContent = '⚠️ تأكيد النقل رغم تنبيه الرصيد';
          confirmBtn.setAttribute('aria-describedby', 'ltWarnBox');
          confirmBtn.disabled = false;
          return;
        }
        applyOrderUpdateToLiveCache(res);
        closeDlg();
        setLiveSelection(null);
        toast(`✅ تم نقل الطلب ${serialNo(order)} إلى ${capName}`);
      } catch (err) {
        warnBox.textContent = `❌ ${err.message || 'تعذّر إتمام النقل'}`;
        warnBox.classList.remove('hide');
        confirmBtn.disabled = false;
        toast(err.message || 'تعذّر إتمام النقل');
      }
    }, { signal: ac.signal });

    dlg.showModal();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tab === 'live' && liveSelection && !document.querySelector('dialog[open]')) {
      setLiveSelection(null);
    }
  });

  async function loadLive() {
    if (tab !== 'live' || !liveMap) return;
    const d = await api('/admin/live');
    if (tab !== 'live' || !liveMap) return;
    liveCache = d;
    if (d.intervals) locIntervals = d.intervals;
    rememberOrders(d.orders);
    rememberOrders(d.recentOrders);
    updateShortageBanner(d.shortage);

    const merchants = d.merchants || [];
    const captains = d.captains || [];
    const orders = d.orders || [];

    const seenM = new Set();
    merchants.forEach((m) => {
      if (m.lat != null && m.lng != null) seenM.add(m.id);
      upsertMerchantMarker(m);
    });
    [...merchMarkers.keys()].filter((k) => !seenM.has(k)).forEach((k) => { merchMarkers.get(k).remove(); merchMarkers.delete(k); });

    const seenC = new Set();
    captains.forEach((c) => {
      if (c.lat != null && c.lng != null) seenC.add(c.id);
      upsertCaptainMarker(c);
    });
    [...capMarkers.keys()].filter((k) => !seenC.has(k)).forEach((k) => { capMarkers.get(k).remove(); capMarkers.delete(k); });

    const openOrderIds = new Set(orders.map((o) => o.id));
    [...orderMarkers.keys()].forEach((k) => {
      const idNum = Number(String(k).replace(/^c/, ''));
      if (!openOrderIds.has(idNum)) { orderMarkers.get(k).remove(); orderMarkers.delete(k); }
    });
    if (routeLayers instanceof Map) {
      [...routeLayers.keys()].forEach((idNum) => {
        if (!openOrderIds.has(idNum)) { routeLayers.get(idNum)?.layer?.remove?.(); routeLayers.delete(idNum); }
      });
    }
    orders.forEach((o) => syncOrderOverlay(o));

    updateLegendCountsAndKpis();
    renderLiveHint();

    if (!liveFitted) {
      const pts = collectAllPoints(d);
      if (pts.length) { fitMapToPoints(liveMap, pts); liveFitted = true; }
    }
  }

  function setCap(id, lat, lng, label, busy, online = true, capObj = null) {
    if (tab !== 'live' || !liveMap) return;
    const target = capObj ? { ...capObj, id, lat, lng, busy: Boolean(busy), online: Boolean(online) } : { id, name: label || `#${id}`, lat, lng, busy: Boolean(busy), online: Boolean(online) };
    upsertCaptainMarker(target, { animate: true });
  }

  connectWs((m) => {
    const myZoneShortage = isZoneAdmin && m.zoneShortage ? m.zoneShortage : null;
    if (myZoneShortage || m.shortage) updateShortageBanner(myZoneShortage || m.shortage);
    const lbl = {
      order: 'تحديث على طلب' + (m.order ? ` ${serialNo(m.order)}` : ''),
      pending_user: 'طلب تسجيل جديد',
      flag: 'تنبيه أمني جديد',
      captain: 'تحديث حالة كابتن',
    }[m.type];
    if (lbl) {
      feed.unshift({ t: lbl, at: new Date().toLocaleTimeString('en-GB') });
      feed.length = Math.min(feed.length, 20);
      if (tab === 'dash') views.dash();
      else if (tab === 'orders') views.orders();
    }
    if (m.type === 'loc') {
      const capInCache = (liveCache.captains || []).find((c) => c.id === m.captain_id);
      if (capInCache) {
        capInCache.lat = m.lat;
        capInCache.lng = m.lng;
        if (m.at) capInCache.last_loc_at = m.at;
        if (m.vis) capInCache.last_loc_vis = m.vis;
        if (m.busy !== undefined) capInCache.busy = m.busy;
        if (m.active_order_id !== undefined) capInCache.active_order_id = m.active_order_id;
        if (m.active_orders !== undefined) capInCache.active_orders = m.active_orders;
      }
      (liveCache.orders || []).forEach((o) => {
        if (o.captain_id === m.captain_id) {
          o.captain = o.captain ? { ...o.captain, lat: m.lat, lng: m.lng } : { id: m.captain_id, lat: m.lat, lng: m.lng };
        }
      });
      const capInUsers = (currentUsersList || []).find((c) => c.id === m.captain_id);
      if (capInUsers) {
        if (m.at) capInUsers.last_loc_at = m.at;
        if (m.vis) capInUsers.last_loc_vis = m.vis;
        if (m.busy !== undefined) capInUsers.busy = m.busy;
      }
      document.querySelectorAll(`[data-loc-cap="${m.captain_id}"]`).forEach((el) => {
        if (m.at) el.dataset.locAt = String(m.at);
        if (m.vis) el.dataset.locVis = m.vis;
        if (m.busy !== undefined) el.dataset.locBusy = m.busy ? '1' : '0';
      });
      tickCaptainLocAges();
      if (tab === 'live' && liveMap) {
        if (capInCache) {
          upsertCaptainMarker(capInCache, { animate: true });
        } else {
          setCap(m.captain_id, m.lat, m.lng, null, m.busy, true, null);
        }
        (liveCache.orders || [])
          .filter((o) => o.captain_id === m.captain_id && ['accepted', 'picked_up', 'arrived'].includes(o.status))
          .forEach((o) => syncOrderOverlay(o));
      }
    } else if (m.type === 'balance') {
      const capInCache = (liveCache.captains || []).find((c) => c.id === m.captain_id);
      if (capInCache && m.balance_points != null) capInCache.balance_points = m.balance_points;
      if (tab === 'wallet') views.wallet();
    } else if (m.type === 'captain') {
      const capInCache = (liveCache.captains || []).find((c) => c.id === m.id);
      if (capInCache) {
        capInCache.online = Boolean(m.online);
        if (tab === 'live' && liveMap) {
          upsertCaptainMarker(capInCache);
          if (liveSelection?.kind === 'captain' && liveSelection.captainId === capInCache.id && !capInCache.online) {
            setLiveSelection(null);
            showLiveNotice(`⛔ أصبح الكابتن «${capInCache.name}» أوفلاين`, 'warning');
          }
          updateLegendCountsAndKpis();
        }
      } else if (tab === 'live') {
        loadLive();
      }
    } else if (m.type === 'order') {
      if (m.order) {
        applyOrderUpdateToLiveCache(m.order);
      } else if (tab === 'live') {
        loadLive();
      }
    } else if (m.type === 'pending_user') {
      toast('طلب تسجيل جديد بانتظار الموافقة');
    }
  });

  go('dash');
});
