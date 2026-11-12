import {
  $, $$, esc, money, time, badge, api, act, toast, connectWs, authScreen,
  makeMap, emoji, animateMarker, makeRoute, fitMapToPoints, DAMASCUS,
  serialNo, renderInstallBanner, isNativeApk, getServerUrl, getToken,
  setToken, openServerConfigModal, normalizeCaptainTone, playCaptainTone, lStore
} from './shared.js?v=panther2026v13';

if ('serviceWorker' in navigator && !isNativeApk()) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

authScreen('captain', (user) => {
  // Clean Captain Top Header (settings & logout are in the dedicated Settings tab)
  const topHeader = document.createElement('header');
  topHeader.className = 'panther-header';
  topHeader.innerHTML = `
    <h1>
      <img src="logo.jpg" alt="PANTHER" class="brand-logo-sm">
      <div class="hdr-brand-stack">
        <span class="brand-title-sm" dir="ltr">PANTHER</span>
        <span class="hdr-role-tag">الكابتن ${esc(user.name)}${user.tag ? ` <code dir="ltr" class="cap-tag-pill">#${esc(user.tag)}</code>` : ''}</span>
      </div>
    </h1>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="hdrStatusBadge" class="badge b-cancelled">⚪ أوفلاين</span>
    </div>`;
  document.body.prepend(topHeader);

  const bottomNav = $('#bottomNav');
  bottomNav.classList.remove('hide');

  const app = $('#app');
  app.classList.remove('hide');
  app.innerHTML = `
    ${renderInstallBanner('captain')}
    <!-- Global Incoming Offer Alert (always visible across all tabs) -->
    <div id="offer"></div>

    <!-- TAB 1: HOME (Hero Radar Status + Bento Stats + Live Radar Map) -->
    <section id="tab-home" class="cap-tab">
      <div class="card captain-hero-card" id="heroStatusCard">
        <div class="hero-ambient-glow"></div>
        <div class="hero-status-top">
          <div class="hero-radar-indicator" id="radarOrb">
            <span class="radar-core">🛵</span>
          </div>
          <div class="hero-status-text">
            <div class="hero-status-label">حالة المناوبة الميدانية</div>
            <div class="hero-status-title" id="onl">⚪ أوفلاين (متوقف عن العمل)</div>
            <div class="mut" id="gps" style="margin-top:4px">اضغط «ابدأ العمل» لاستقبال الطلبات الفورية</div>
          </div>
        </div>
        <button type="button" id="tog" class="ok hero-tog-btn">🚀 ابدأ العمل الآن</button>
      </div>

      <div class="stats4">
        <div class="card bento-stat-card bento-primary">
          <div class="bento-watermark">📦</div>
          <div class="bento-label">طلبات اليوم المسلّمة</div>
          <div class="bento-value" id="stDelivered">0</div>
          <div class="bento-sub" id="stTotalAll">إجمالي الكلي: 0 طلب</div>
        </div>
        <div class="card fin-hide">
          <div class="mut">أرباح التوصيل اليوم</div>
          <div class="stat" id="stEarnings">0 ل.س</div>
        </div>
        <div class="card fin-hide">
          <div class="mut">مستحقات المنصة اليوم</div>
          <div class="stat" id="stDue">0 ل.س</div>
          <div class="mut" id="stDueSub">عمولة 0 ل.س</div>
        </div>
        <div class="card bento-stat-card bento-accent" id="homeActCard" style="cursor:pointer">
          <div class="bento-watermark">🛵</div>
          <div class="bento-label">الطلبات النشطة حالياً</div>
          <div class="bento-value" id="stActiveCount">0</div>
          <div class="bento-action-link">إدارة الطلبات النشطة ⬅️</div>
        </div>
      </div>

      <div class="card bento-map-card" id="idleMapCard">
        <div class="row-head">
          <div>
            <h3 style="margin:0">📡 رادار الموقع الحي</h3>
            <div class="mut" style="font-size:12px">تتبع موقعك الميداني المباشر</div>
          </div>
          <span class="coord-pill" id="coordTxt" dir="ltr">33.5138, 36.2765</span>
        </div>
        <div id="imap" class="map" style="height:340px"></div>
      </div>
    </section>

    <!-- TAB 2: ACTIVE ORDERS (Dedicated exclusively to active orders) -->
    <section id="tab-active" class="cap-tab hide">
      <div id="active"></div>
    </section>

    <!-- TAB 3: COMPLETED / HISTORY ORDERS (Dedicated to past orders with filters) -->
    <section id="tab-history" class="cap-tab hide">
      <div class="card">
        <div class="row-head">
          <h3>📋 سجل الطلبات السابقة</h3>
          <span class="badge b-active" id="histCountBadge">0 طلب</span>
        </div>
        <div class="tabs" id="histFilterTabs" style="margin-bottom:10px">
          <button type="button" data-hfilter="all" class="active">الكل</button>
          <button type="button" data-hfilter="delivered">المسلّمة ✓</button>
          <button type="button" data-hfilter="failed">الفاشلة ✕</button>
        </div>
        <input id="histSearch" type="search" placeholder="🔍 ابحث برقم الطلب أو اسم المنشأة أو العنوان..." style="margin-bottom:12px">
        <div id="histList"></div>
      </div>
    </section>

    <!-- TAB 4: SETTINGS & PROFILE (Audio, Server, Map/GPS, Password, Logout) -->
    <section id="tab-settings" class="cap-tab hide">
      <div class="card">
        <div class="cap-sec-title">🪪 بطاقة الكابتن</div>
        <div class="setting-row">
          <div>
            <div class="setting-title">${esc(user.name)}</div>
            <div class="setting-sub">كود التعريف الثابت (للشحن والمحفظة)</div>
          </div>
          <code dir="ltr" class="cap-tag-pill" style="font-size:15px">${user.tag ? `#${esc(user.tag)}` : '—'}</code>
        </div>
      </div>
      <!-- Sound & Notification Settings -->
      <div class="card">
        <h3>🔊 إعدادات الصوت والتنبيهات</h3>
        <div class="setting-row">
          <div>
            <div class="setting-title">صافرة التنبيه والعمل بالخلفية</div>
            <div class="setting-sub" id="sndStatusSub">اختبر صوت صافرة استلام الطلبات الجديدة</div>
          </div>
          <button type="button" id="snd" class="ok sm">🔊 تجربة الصوت</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">الاهتزاز مع الرنين</div>
            <div class="setting-sub">اهتزاز الهاتف عند وصول طلب جديد</div>
          </div>
          <input type="checkbox" id="vibToggle" class="accent-warn" style="width:22px;height:22px">
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">نغمة التنبيه الصوتية</div>
            <div class="setting-sub">اختر نمط صوت التنبيه عند وصول الطلب</div>
          </div>
          <select id="toneSelect" style="width:auto;min-width:170px;padding:7px 10px">
            <option value="soft_bell">جرس ناعم (موصى به)</option>
            <option value="marimba">ماريمبا (دافئ)</option>
            <option value="chime">رنين خفيف</option>
            <option value="pulse">نبض هادئ</option>
            <option value="classic">تنبيه كلاسيكي</option>
            <option value="rapid">تنبيه سريع مزدوج</option>
            <option value="high">رنين واضح</option>
          </select>
        </div>
      </div>

      <!-- Map, Navigation & GPS Settings -->
      <div class="card">
        <h3>🗺️ إعدادات الخريطة والملاحة والـ GPS</h3>
        <div class="setting-row">
          <div>
            <div class="setting-title">تطبيق الملاحة الخارجي</div>
            <div class="setting-sub">التطبيق المستخدم عند الضغط على «افتح الملاحة»</div>
          </div>
          <select id="navAppSelect" style="width:auto;min-width:150px;padding:7px 10px">
            <option value="google">🗺️ خرائط قوقل (Google Maps)</option>
            <option value="waze">🚗 ويز (Waze)</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">مظهر الخريطة الافتراضي</div>
            <div class="setting-sub">اختر شكل الخريطة داخل التطبيق</div>
          </div>
          <select id="mapStyleSelect" style="width:auto;min-width:150px;padding:7px 10px">
            <option value="google">🗺️ خريطة قوقل العادية</option>
            <option value="hybrid">🛰️ قمر صناعي (واقعي)</option>
            <option value="dark">🌙 الوضع الليلي</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">وضع المحاكاة (GPS تجريبي)</div>
            <div class="setting-sub">توليد موقع وهمي متحرك لتجربة النظام بدون حركة فعلية</div>
          </div>
          <input type="checkbox" id="simc" class="accent-warn" style="width:22px;height:22px">
        </div>
      </div>

      <!-- Server & Connection Settings -->
      <div class="card">
        <h3>🌐 إعدادات السيرفر والاتصال</h3>
        <div class="setting-row">
          <div style="min-width:0;flex:1">
            <div class="setting-title">رابط السيرفر المتصل</div>
            <div class="setting-sub" id="srvCurrentLbl" dir="ltr" style="word-break:break-all;text-align:right">${esc(getServerUrl() || location.origin)}</div>
          </div>
          <button type="button" class="sec sm" id="cfgSrvBtn">🌐 تعديل / فحص</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">مزامنة وتحديث البيانات</div>
            <div class="setting-sub">إعادة جلب حالة الطلبات والسجل من السيرفر</div>
          </div>
          <button type="button" class="ghost sm" id="manualSyncBtn">🔄 تحديث الآن</button>
        </div>
      </div>

      <!-- Password Change -->
      <div class="card">
        <h3>🔒 تغيير كلمة المرور</h3>
        <form id="pwForm">
          <label>كلمة المرور الحالية</label>
          <input type="password" name="old_password" required autocomplete="current-password">
          <label>كلمة المرور الجديدة (6 أحرف على الأقل مع أرقام)</label>
          <input type="password" name="new_password" required minlength="6" autocomplete="new-password">
          <button type="submit" class="sec" style="width:100%;margin-top:12px">💾 حفظ كلمة المرور الجديدة</button>
        </form>
      </div>

      <!-- Logout -->
      <div class="card" style="border-color:var(--c-ef4444-a350)">
        <div class="setting-row" style="padding:0">
          <div>
            <div class="setting-title clr-bad-soft">🚪 تسجيل الخروج من الحساب</div>
            <div class="setting-sub">إيقاف استقبال الطلبات والخروج من الجلسة الحالية</div>
          </div>
          <button type="button" class="bad sm" id="logoutBtn" style="padding:9px 18px">خروج</button>
        </div>
      </div>
    </section>
  `;

  // ---------- State & Preferences ----------
  let currentTab = 'home';
  let st = { online: false, active: null, activeOrders: [], offer: null, intervals: { active: 10000, idle: 60000 } };
  let allHistory = [], histFilter = 'all', histQuery = '';
  let sim = false, simTimer = null, pos = null, watchId = null, lastSent = 0;
  let map = null, mk = [], me = null, idleMe = null, wake = null, cd = null;
  let routeLayer = null, lastRouteTime = 0, selectedActiveId = null;

  let vibEnabled = lStore.getItem('panther_vibrate') !== '0';
  let alarmTone = normalizeCaptainTone(lStore.getItem('panther_tone'));
  let navApp = lStore.getItem('panther_nav_app') || 'google';

  $('#vibToggle').checked = vibEnabled;
  $('#toneSelect').value = alarmTone;
  try {
    window.PantherNative?.setTone?.(alarmTone);
    window.PantherNative?.setVibrate?.(vibEnabled);
  } catch {}
  $('#navAppSelect').value = navApp;
  $('#mapStyleSelect').value = lStore.getItem('mashwar_map_style') || 'google';

  $('#vibToggle').onchange = (e) => {
    vibEnabled = e.target.checked;
    lStore.setItem('panther_vibrate', vibEnabled ? '1' : '0');
    try { window.PantherNative?.setVibrate?.(vibEnabled); } catch {}
    toast(vibEnabled ? '✅ تم تفعيل الاهتزاز' : 'تم إيقاف الاهتزاز');
  };
  $('#toneSelect').onchange = (e) => {
    alarmTone = normalizeCaptainTone(e.target.value);
    lStore.setItem('panther_tone', alarmTone);
    try { window.PantherNative?.setTone?.(alarmTone); } catch {}
    testSound();
  };
  $('#navAppSelect').onchange = (e) => {
    navApp = e.target.value;
    lStore.setItem('panther_nav_app', navApp);
    renderActive();
    toast('✅ تم حفظ تطبيق الملاحة المفضل');
  };

  // ---------- Tab Navigation ----------
  function switchTab(tabName) {
    currentTab = tabName;
    $$('.cap-tab').forEach((sec) => sec.classList.toggle('hide', sec.id !== `tab-${tabName}`));
    $$('#bottomNav button[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabName));
    if (tabName === 'home') setTimeout(() => idleMap?.invalidateSize(), 60);
    if (tabName === 'active') setTimeout(() => map?.invalidateSize(), 60);
    if (tabName === 'settings') {
      $('#srvCurrentLbl').textContent = getServerUrl() || location.origin;
    }
  }

  $$('#bottomNav button[data-tab]').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  $('#homeActCard').onclick = () => switchTab('active');

  // ---------- Idle Map ----------
  const initCenter = user.lat != null && user.lng != null ? [user.lat, user.lng] : DAMASCUS;
  const idleMap = makeMap('imap', initCenter, 13);

  $('#mapStyleSelect').onchange = (e) => {
    const style = e.target.value;
    idleMap?.setMapStyle?.(style);
    map?.setMapStyle?.(style);
    toast('✅ تم تغيير مظهر الخريطة');
  };

  // ---------- Audio & Notification Chimes ----------
  let actx = null, alarmTimer = null, alarmStopTimer = null, activePhrase = null, previewPhrase = null;
  const unlockAudio = () => {
    try {
      actx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch {}
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

  function testSound() {
    unlockAudio();
    if (!actx) return;
    alarmTone = normalizeCaptainTone($('#toneSelect')?.value || alarmTone);
    try { previewPhrase?.stop(); } catch {}
    previewPhrase = playCaptainTone(actx, alarmTone);
    if (vibEnabled) navigator.vibrate?.([140]);
  }

  const updateSndBtn = () => {
    const ok = Boolean(window.PantherNative) || (actx && actx.state === 'running');
    const sub = $('#sndStatusSub');
    if (sub) {
      sub.textContent = ok
        ? '✅ الصوت والتنبيه في الخلفية جاهز ويعمل'
        : '⚠️ اضغط على «تجربة الصوت» لتفعيل التنبيه الصوتي';
    }
  };
  $('#snd').onclick = () => {
    testSound();
    try { Notification?.requestPermission?.(); } catch {}
    setTimeout(updateSndBtn, 300);
    toast('🔊 تم تشغيل نغمة التنبيه المختارة');
  };
  setInterval(updateSndBtn, 2000);

  let lastWebNotifOfferId = null;
  function notifyOffer(o) {
    if (!o || window.PantherNative || lastWebNotifOfferId === o.id) return;
    lastWebNotifOfferId = o.id;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`🔔 طلب توصيل جديد ${serialNo(o)}`, {
          body: `من: ${o.merchant?.name || 'منشأة'} — العنوان: ${o.customer_address || '—'}`,
          icon: 'icon-192.png',
          requireInteraction: true,
        });
      }
    } catch {}
  }

  function startAlarm() {
    if (window.PantherNative) return; // Native foreground service plays the selected soft chime
    if (alarmTimer) return;
    unlockAudio();
    if (!actx) return;
    const playOnce = () => {
      try { activePhrase?.stop(); } catch {}
      const phrase = playCaptainTone(actx, alarmTone);
      activePhrase = phrase;
      if (vibEnabled) navigator.vibrate?.([180, 90, 180]);
      return phrase.repeatMs;
    };
    const intervalMs = playOnce();
    alarmTimer = setInterval(playOnce, intervalMs);
    clearTimeout(alarmStopTimer);
    alarmStopTimer = setTimeout(stopAlarm, 60_000);
  }

  function stopAlarm() {
    try { window.PantherNative?.stopSiren(); } catch {}
    clearInterval(alarmTimer); alarmTimer = null;
    clearTimeout(alarmStopTimer); alarmStopTimer = null;
    try { activePhrase?.stop(); } catch {}
    activePhrase = null;
    navigator.vibrate?.(0);
  }

  // ---------- Data Refresh & Rendering ----------
  async function refresh() {
    st = await api('/captain/state');
    try {
      window.PantherNative?.syncState(getServerUrl() || location.origin, getToken() || '', Boolean(st.online));
    } catch {}
    renderAll();

    const s = await api('/captain/summary');
    $('#stDelivered').textContent = s.delivered ?? 0;
    $('#stTotalAll').textContent = `إجمالي الكلي: ${s.total_delivered ?? s.delivered ?? 0} طلب`;
    $('#stEarnings').textContent = money(s.earnings_today ?? 0);
    $('#stDue').textContent = money(s.due ?? 0);
    $('#stDueSub').innerHTML = s.settled
      ? '<span class="clr-ok-soft">تمت التسوية اليوم ✓</span>'
      : `عمولة ${money(s.commission)}${s.liability ? ` + تعويضات ${money(s.liability)}` : ''}`;

    allHistory = await api('/captain/history');
    renderHistory();
  }

  function renderAll() {
    const allAct = st.activeOrders?.length ? st.activeOrders : (st.active ? [st.active] : []);
    $('#onl').textContent = st.online ? '🟢 متصل (أونلاين) — جاهز للطلبات' : '⚪ أوفلاين (متوقف عن العمل)';
    $('#tog').textContent = st.online ? '⏹️ إيقاف العمل (أوفلاين)' : '🚀 ابدأ العمل الآن';
    $('#tog').className = (st.online ? 'bad' : 'ok') + ' hero-tog-btn' + (st.online ? ' is-online' : '');
    $('#heroStatusCard')?.classList.toggle('is-online', Boolean(st.online));
    $('#radarOrb')?.classList.toggle('is-online', Boolean(st.online));

    const hdrBadge = $('#hdrStatusBadge');
    if (hdrBadge) {
      hdrBadge.textContent = st.online ? '🟢 أونلاين' : '⚪ أوفلاين';
      hdrBadge.className = 'badge ' + (st.online ? 'b-active' : 'b-cancelled');
    }

    $('#stActiveCount').textContent = allAct.length;
    const navBadge = $('#navActBadge');
    if (navBadge) {
      navBadge.textContent = allAct.length;
      navBadge.classList.toggle('hide', allAct.length === 0);
    }

    renderOffer();
    renderActive();
    st.online ? startGps() : stopGps();
  }

  function renderOffer() {
    clearInterval(cd);
    const o = st.offer, box = $('#offer');
    if (!o) { box.innerHTML = ''; stopAlarm(); return; }
    notifyOffer(o);
    startAlarm();
    box.innerHTML = `<div class="card offer">
  <div class="row-head">
    <h3>🔔 طلب توصيل جديد — <span dir="ltr">${serialNo(o)}</span></h3>
    <span class="badge b-offered">بانتظار قبول كابتن</span>
  </div>
  ${st.activeOrders && st.activeOrders.length > 0 ? '<div class="mut" style="margin-bottom:8px">⚡ طلب إضافي (لديك طلب نشط حالياً)</div>' : ''}
  <p><b>🏪 من المنشأة:</b> ${esc(o.merchant.name)}<br><span class="mut">${esc(o.merchant.address)}</span></p>
  <p style="background:var(--brand-primary-soft);padding:12px 14px;border-radius:12px;border:1px solid var(--border-brand-soft);margin:10px 0">
    <b>📍 عنوان التوصيل:</b> ${esc(o.customer_address || '—')}
  </p>
  <p class="mut fin-hide">عمولة المنصة: <b>${money(st.commission)}</b></p>
  <div id="cd" style="text-align:center;font-size:18px;font-weight:900;color:var(--status-warn-text);padding:8px">
    ⏱️ الوقت المتبقي: <span id="cdVal">--</span> ثانية
  </div>
  <div class="row" style="margin-top:12px">
    <button type="button" class="ok big" id="acc">✅ قبول الطلب</button>
    <button type="button" class="bad big" id="rej">✕ رفض</button>
  </div>
</div>`;
    const tick = () => {
      const s = Math.max(0, Math.round((o.offer_expires_at - Date.now()) / 1000));
      const e = document.getElementById('cdVal');
      if (e) e.textContent = s;
      if (!s) { clearInterval(cd); setTimeout(refresh, 1500); }
    };
    tick();
    cd = setInterval(tick, 1000);
    $('#acc').onclick = async () => {
      await act(() => api(`/captain/offers/${o.id}/accept`, 'POST'), '✅ تم قبول الطلب');
      selectedActiveId = o.id;
      await refresh();
      switchTab('active');
    };
    $('#rej').onclick = async () => {
      await act(() => api(`/captain/offers/${o.id}/reject`, 'POST'), 'تم رفض العرض');
      await refresh();
    };
  }

  function buildNavUrl(lat, lng) {
    if (navApp === 'waze') return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }

  const NEXT = {
    accepted: ['picked_up', '📦 استلمت الطلب من المنشأة'],
    picked_up: ['arrived', '📍 وصلت عند الزبون'],
    arrived: ['delivered', '✅ تم التسليم واستلام المبلغ'],
  };

  function renderActive() {
    const allAct = st.activeOrders?.length ? st.activeOrders : (st.active ? [st.active] : []);
    const box = $('#active');
    if (!allAct.length) {
      box.innerHTML = `<div class="card" style="text-align:center;padding:36px 18px">
        <div style="font-size:46px;margin-bottom:8px">🛵</div>
        <h3>لا توجد طلبات نشطة حالياً</h3>
        <p class="mut">عند قبول أي طلب توصيل جديد سيظهر هنا مع خريطة المسار وتفاصيل المنشأة والزبون كاملة.</p>
        <button type="button" class="sec" id="goHomeFromEmpty" style="margin-top:8px">🏠 العودة للرئيسية</button>
      </div>`;
      $('#goHomeFromEmpty').onclick = () => switchTab('home');
      map = null;
      selectedActiveId = null;
      return;
    }

    const o = allAct.find((x) => x.id === selectedActiveId) || allAct[0];
    selectedActiveId = o.id;
    st.active = o;
    const toMerchant = o.status === 'accepted';
    const dest = toMerchant ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
    const n = NEXT[o.status];

    const multiTabs = allAct.length > 1
      ? `<div class="card" style="padding:12px">
          <div class="mut" style="margin-bottom:8px">📦 الطلبات النشطة المسندة إليك (${allAct.length}) — اختر طلباً لإدارته:</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${allAct.map((x) => `<button type="button" class="${x.id === o.id ? 'ok' : 'sec'} sm" data-act-id="${x.id}"><span dir="ltr">${serialNo(x)}</span> — ${esc((x.customer_address || '').slice(0, 20))}</button>`).join('')}
          </div>
        </div>`
      : '';

    const stepIdx = o.status === 'accepted' ? 1 : o.status === 'picked_up' ? 2 : 3;
    const stepperHtml = `<div class="stepper">
      <div class="step-item ${stepIdx > 1 ? 'done' : 'curr'}"><span class="step-dot">1</span><span>للمنشأة</span></div>
      <div class="step-line ${stepIdx > 1 ? 'done' : ''}"></div>
      <div class="step-item ${stepIdx > 2 ? 'done' : stepIdx === 2 ? 'curr' : ''}"><span class="step-dot">2</span><span>للزبون</span></div>
      <div class="step-line ${stepIdx > 2 ? 'done' : ''}"></div>
      <div class="step-item ${stepIdx === 3 ? 'curr' : ''}"><span class="step-dot">3</span><span>التسليم</span></div>
    </div>`;

    const cleanPhone = (o.customer_phone || '').replace(/\D/g, '');
    const waPhone = cleanPhone.startsWith('0') ? '963' + cleanPhone.slice(1) : cleanPhone;

    box.innerHTML = `
      ${multiTabs}
      <div class="card">
        <div class="row-head">
          <h3>طلب نشط <span dir="ltr">${serialNo(o)}</span></h3>
          ${badge(o.status)}
        </div>
        ${stepperHtml}

        <!-- Merchant Box -->
        <div style="padding:12px;border-radius:12px;background:var(--c-ffffff-a030);border:1px solid var(--c-f59e0b-a200);margin-bottom:10px">
          <div style="font-weight:800;color:var(--gold);margin-bottom:4px">🏪 بيانات المنشأة (الاستلام)</div>
          <div><b>${esc(o.merchant.name)}</b> — <span class="mut">${esc(o.merchant.address)}</span></div>
          <div class="row" style="margin-top:8px">
            ${o.merchant.phone ? `<a class="btn-nav sec sm" href="tel:${esc(o.merchant.phone)}">📞 اتصال بالمنشأة</a>` : ''}
            ${o.merchant.lat != null ? `<a class="btn-nav ghost sm" href="${buildNavUrl(o.merchant.lat, o.merchant.lng)}" target="_blank" rel="noopener">🧭 موقع المنشأة</a>` : ''}
          </div>
        </div>

        <!-- Customer Box -->
        <div style="padding:12px;border-radius:12px;background:var(--c-22c55e-a080);border:1px solid var(--c-22c55e-a300);margin-bottom:10px">
          <div class="clr-ok-soft" style="font-weight:800;margin-bottom:4px">📍 بيانات التوصيل والزبون</div>
          <div style="font-size:16px;font-weight:800;margin-bottom:4px">${esc(o.customer_address || '—')}</div>
          ${o.customer_name && o.customer_name !== '—' ? `<div>الزبون: <b>${esc(o.customer_name)}</b></div>` : ''}
          ${o.notes ? `<div class="mut" style="margin-top:4px">📝 ملاحظات: ${esc(o.notes)}</div>` : ''}
          ${o.customer_phone ? `<div class="row" style="margin-top:8px">
            <a class="btn-nav ok sm" href="tel:${esc(o.customer_phone)}" dir="ltr">📞 ${esc(o.customer_phone)}</a>
            <a class="btn-nav sec sm" href="https://wa.me/${esc(waPhone)}" target="_blank" rel="noopener">💬 واتساب الزبون</a>
          </div>` : ''}
        </div>

        <!-- Financial Box -->
        ${(o.product_amount || o.delivery_fee) ? `<div class="fin-hide" style="padding:12px;border-radius:12px;background:var(--c-f59e0b-a100);border:1px solid var(--c-f59e0b-a260);margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span class="mut">💵 ادفع للمنشأة ثمن الطلب:</span><b>${money(o.product_amount)}</b></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span class="mut">🛵 أجرة التوصيل:</span><b>${money(o.delivery_fee)}</b></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid var(--c-f59e0b-a200);padding-top:6px;font-size:15.5px"><span style="color:var(--gold);font-weight:800">💰 استلم من الزبون الإجمالي:</span><b class="clr-ok-soft">${money(o.product_amount + o.delivery_fee)}</b></div>
        </div>` : ''}


        <div id="amap" class="map" style="height:330px"></div>

        <div class="cap-quick-actions">
          ${dest.lat != null ? `<a class="btn-nav qa-nav" href="${buildNavUrl(dest.lat, dest.lng)}" target="_blank" rel="noopener noreferrer">🧭 <span>ملاحة ${navApp === 'waze' ? 'Waze' : 'Google Maps'}</span></a>` : ''}
          ${o.merchant.phone ? `<a class="btn-nav qa-call" href="tel:${esc(o.merchant.phone)}" dir="ltr">📞 <span>اتصال بالمنشأة</span></a>` : ''}
          ${o.customer_phone ? `<a class="btn-nav qa-call qa-cust" href="tel:${esc(o.customer_phone)}" dir="ltr">📞 <span>اتصال بالزبون</span></a>` : ''}
        </div>

        <button type="button" class="big ok" id="nx">${n[1]}</button>
        ${o.status !== 'accepted' ? '<div class="cap-danger-zone"><div class="cap-danger-label">منطقة الإجراءات الخطرة</div><button type="button" class="big bad" id="fl">⚠️ الزبون لا يرد / العنوان خطأ</button></div>' : ''}
      </div>`;

    box.querySelectorAll('[data-act-id]').forEach((btn) => {
      btn.onclick = () => { selectedActiveId = Number(btn.dataset.actId); renderActive(); };
    });

    map = makeMap('amap', dest.lat != null ? [dest.lat, dest.lng] : undefined, 14);
    mk.forEach((m) => m.remove()); mk = [];
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    if (o.merchant.lat != null) mk.push(L.marker([o.merchant.lat, o.merchant.lng], { icon: emoji('🏪') }).addTo(map).bindTooltip(`🏪 ${o.merchant.name}`));
    if (o.customer_lat != null) mk.push(L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(map).bindTooltip(`📍 الزبون: ${o.customer_name}`));
    me = null;
    if (pos) showMe();
    const pts = [];
    if (o.merchant.lat != null) pts.push([o.merchant.lat, o.merchant.lng]);
    if (o.customer_lat != null) pts.push([o.customer_lat, o.customer_lng]);
    if (pos) pts.push([pos.lat, pos.lng]);
    if (pts.length) fitMapToPoints(map, pts);
    if (pos && dest.lat != null) {
      lastRouteTime = Date.now();
      makeRoute(map, [pos.lat, pos.lng], [dest.lat, dest.lng]).then((layer) => { routeLayer = layer; });
    }

    $('#nx').onclick = async () => {
      if (n[0] === 'delivered' && !confirm('تأكيد إتمام التسليم واستلام المبلغ من الزبون؟')) return;
      await act(() => api(`/captain/orders/${o.id}/status`, 'POST', { status: n[0] }), n[0] === 'delivered' ? '🎉 تم تسليم الطلب بنجاح!' : 'تم تحديث حالة الطلب');
      await refresh();
    };
    $('#fl')?.addEventListener('click', async () => {
      if (!confirm('الإبلاغ عن فشل التسليم؟ ستخسر أجرة التوصيل.')) return;
      await act(() => api(`/captain/orders/${o.id}/status`, 'POST', { status: 'failed_customer' }), 'تم الإبلاغ عن تعذر التسليم');
      await refresh();
    });
  }

  // ---------- History Rendering & Filtering ----------
  function renderHistory() {
    const q = histQuery.trim().toLowerCase();
    const filtered = allHistory.filter((o) => {
      if (histFilter !== 'all' && o.status !== histFilter) return false;
      if (!q) return true;
      const hay = `${serialNo(o)} ${o.merchant?.name || ''} ${o.customer_address || ''} ${o.customer_name || ''}`.toLowerCase();
      return hay.includes(q);
    });

    $('#histCountBadge').textContent = `${filtered.length} طلب`;
    const list = $('#histList');
    if (!filtered.length) {
      list.innerHTML = `<div class="mut" style="text-align:center;padding:26px 10px">لا توجد طلبات مطابقة في السجل</div>`;
      return;
    }

    list.innerHTML = filtered.slice(0, 60).map((o) => `
      <div class="hist-card">
        <div style="flex:1;min-width:190px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <b dir="ltr" style="color:var(--gold);font-size:15px">${serialNo(o)}</b>
            ${badge(o.status)}
          </div>
          <div style="font-weight:700">🏪 ${esc(o.merchant?.name || '—')}</div>
          <div class="mut" style="font-size:12.5px">📍 ${esc(o.customer_address || '—')}</div>
        </div>
        <div style="text-align:left">
          ${o.delivery_fee ? `<div class="clr-ok-soft" style="font-weight:800">${money(o.delivery_fee)}</div>` : ''}
          <div class="mut" style="font-size:11.5px">${time(o.closed_at)}</div>
        </div>
      </div>
    `).join('');
  }

  $$('#histFilterTabs button[data-hfilter]').forEach((btn) => {
    btn.onclick = () => {
      histFilter = btn.dataset.hfilter;
      $$('#histFilterTabs button').forEach((b) => b.classList.toggle('active', b === btn));
      renderHistory();
    };
  });
  $('#histSearch').oninput = (e) => {
    histQuery = e.target.value;
    renderHistory();
  };

  // ---------- Settings Actions ----------
  $('#cfgSrvBtn').onclick = () => {
    openServerConfigModal((newUrl) => {
      $('#srvCurrentLbl').textContent = newUrl || location.origin;
      refresh();
    });
  };
  $('#manualSyncBtn').onclick = async () => {
    await act(refresh, '✅ تم تحديث ومزامنة البيانات');
  };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await act(() => api('/auth/password', 'POST', f), '✅ تم تغيير كلمة المرور بنجاح');
    if (r) e.target.reset();
  };
  $('#logoutBtn').onclick = async () => {
    if (!confirm('هل تريد تسجيل الخروج من حساب الكابتن؟')) return;
    try { await api('/auth/logout-all', 'POST'); } catch {}
    try { window.PantherNative?.syncState('', '', false); } catch {}
    setToken(null);
    location.reload();
  };

  // ---------- GPS & Location Tracking ----------
  function showMe() {
    if (!pos) return;
    const coordEl = $('#coordTxt');
    if (coordEl) coordEl.textContent = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
    if (!idleMe) {
      idleMe = L.marker([pos.lat, pos.lng], { icon: emoji('🛵') }).addTo(idleMap).bindTooltip('🛵 موقعي الحالي');
      idleMap.setView([pos.lat, pos.lng], 15);
    } else {
      animateMarker(idleMe, [pos.lat, pos.lng]);
    }
    if (!map) return;
    if (!me) me = L.marker([pos.lat, pos.lng], { icon: emoji('🛵') }).addTo(map).bindTooltip('🛵 موقعي');
    else animateMarker(me, [pos.lat, pos.lng]);
    if (st.active && Date.now() - lastRouteTime > 30000) {
      const o = st.active;
      const dest = o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
      if (dest.lat != null) {
        lastRouteTime = Date.now();
        if (routeLayer) { routeLayer.remove(); routeLayer = null; }
        makeRoute(map, [pos.lat, pos.lng], [dest.lat, dest.lng]).then((layer) => { routeLayer = layer; });
      }
    }
  }

  function startGps() {
    if (sim) return startSim();
    if (watchId != null) return;
    if (!navigator.geolocation) { $('#gps').textContent = 'الجهاز لا يدعم تحديد الموقع GPS'; return; }
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        $('#gps').textContent = '📍 تحديد الموقع (GPS) متصل ويعمل بدقة ✓';
        showMe();
        maybeSend();
      },
      () => {
        $('#gps').textContent = '⚠️ يرجى تفعيل صلاحية الموقع (GPS) في الهاتف';
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    navigator.wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
  }

  function startSim() {
    if (simTimer) return;
    const baseLat = st.active?.merchant?.lat ?? user.lat ?? DAMASCUS[0];
    const baseLng = st.active?.merchant?.lng ?? user.lng ?? DAMASCUS[1];
    pos ??= { lat: baseLat + (Math.random() - 0.5) * 0.008, lng: baseLng + (Math.random() - 0.5) * 0.008 };
    $('#gps').textContent = '🧪 وضع محاكاة GPS التجريبي مفعّل';
    showMe();
    maybeSend();
    simTimer = setInterval(() => {
      const o = st.active;
      const d = o && (o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng });
      if (d && d.lat != null) {
        const dx = d.lat - pos.lat, dy = d.lng - pos.lng, n = Math.hypot(dx, dy), step = 0.0004;
        pos = n < step ? { lat: d.lat, lng: d.lng } : { lat: pos.lat + (dx / n) * step, lng: pos.lng + (dy / n) * step };
      } else {
        pos = { lat: pos.lat + (Math.random() - 0.5) * 0.0004, lng: pos.lng + (Math.random() - 0.5) * 0.0004 };
      }
      showMe();
      maybeSend();
    }, 2000);
  }

  function stopGps() {
    clearInterval(simTimer); simTimer = null;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    wake?.release().catch(() => {}); wake = null;
    $('#gps').textContent = 'اضغط «ابدأ العمل» لاستقبال الطلبات وتفعيل التتبع';
    pos = null;
  }

  function maybeSend() {
    if (!st.online || !pos) return;
    const gap = st.active ? st.intervals.active : st.intervals.idle;
    if (Date.now() - lastSent < gap) return;
    lastSent = Date.now();
    const vis = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
    api('/captain/location', 'POST', { ...pos, vis }).catch(() => {});
  }
  setInterval(maybeSend, 3000);

  $('#simc').onchange = (e) => {
    sim = e.target.checked;
    stopGps();
    pos = null;
    if (st.online) startGps();
    toast(sim ? '🧪 تم تفعيل محاكاة الـ GPS' : '📍 تم العودة للـ GPS الحقيقي');
  };

  $('#tog').onclick = async () => {
    const r = await act(() => api('/captain/online', 'POST', { online: !st.online }));
    if (r) { lastSent = 0; await refresh(); }
  };

  connectWs((m) => {
    if (m.type === 'offer' || m.type === 'offer_end' || m.type === 'order') {
      if (m.type === 'order') testSound();
      refresh();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      if (st.online && watchId != null) navigator.wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
    }
  });

  refresh();
});
