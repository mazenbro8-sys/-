import {
  $, $$, esc, points, time, badge, api, act, toast, connectWs, authScreen,
  makeMap, emoji, animateMarker, makeRoute, fitMapToPoints, DAMASCUS,
  serialNo, renderInstallBanner, isNativeApk, getServerUrl, getToken,
  setToken, openServerConfigModal, ALARM_SOUNDS, normalizeCaptainTone, playCaptainTone, lStore,
  mountNotificationsBell
} from './shared.js?v=panther2026v27';

if ('serviceWorker' in navigator && !isNativeApk()) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

authScreen('captain', (user) => {
  // Clean Captain Top Header (settings & logout are in the dedicated Settings tab)
  const topHeader = document.createElement('header');
  topHeader.className = 'panther-header';
  topHeader.innerHTML = `
    <h1>
      <img src="brand/panther-mark-reversed.png" alt="PANTHER" class="brand-logo-sm" width="48" height="25">
      <div class="hdr-brand-stack">
        <span class="brand-title-sm" lang="en" dir="ltr">PANTHER <span class="brand-delivery-sub">DELIVERY</span></span>
        <span class="hdr-role-tag">الكابتن ${esc(user.name)}${user.tag ? ` <code dir="ltr" class="cap-tag-pill">#${esc(user.tag)}</code>` : ''}</span>
      </div>
    </h1>
    <div id="hdrRightActions" class="hdr-right-actions" style="display:flex;gap:8px;align-items:center">
      <span id="hdrStatusBadge" class="badge b-cancelled">⚪ أوفلاين</span>
    </div>`;
  document.body.prepend(topHeader);
  const notifCtrl = mountNotificationsBell(topHeader.querySelector('#hdrRightActions'), {
    insertBefore: topHeader.querySelector('#hdrStatusBadge'),
  });

  const bottomNav = $('#bottomNav');
  bottomNav.classList.remove('hide');

  const app = $('#app');
  app.classList.remove('hide');
  app.innerHTML = `
    ${renderInstallBanner('captain')}

    <!-- TAB 1: HOME (Status First -> Offer / Active Order -> Brief Today Stats -> Collapsible Map) -->
    <section id="tab-home" class="cap-tab">
      <div class="card captain-hero-card" id="heroStatusCard">
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

      <!-- Incoming Offer Alert (priority slot directly below status when present) -->
      <div id="offer"></div>

      <div id="capLowBalBanner" class="wallet-banner-warn hide">
        <span>⚠️ رصيد النقاط لا يكفي لتكلفة الطلب التالي — لن تصلك عروض جديدة حتى شحن المحفظة لدى الإدارة.</span>
        <button type="button" id="goWalletFromWarnBtn" class="sec sm">💰 المحفظة</button>
      </div>

      <!-- Active Order Quick Summary (below status/offer when an order is active) -->
      <div id="homeActiveOrderBox"></div>

      <!-- Compact Today Stats -->
      <div class="stats4">
        <div class="card bento-stat-card bento-primary">
          <div class="bento-label">طلبات اليوم المسلّمة</div>
          <div class="bento-value" id="stDelivered">0</div>
          <div class="bento-sub" id="stTotalAll">إجمالي الكلي: 0 طلب</div>
          <div class="bento-sub" id="stDeductedToday">خصم اليوم: 0 نقطة</div>
        </div>
        <div class="card bento-stat-card bento-accent" id="homeActCard" role="button" tabindex="0">
          <div class="bento-label">الطلبات النشطة حالياً</div>
          <div class="bento-value" id="stActiveCount">0</div>
          <div class="bento-action-link">إدارة الطلبات النشطة ⬅️</div>
        </div>
      </div>

      <!-- Subtle Collapsible Live Location Radar -->
      <details class="card bento-map-card" id="idleMapCard">
        <summary class="map-disclosure-summary">
          <span class="map-summary-label">📡 رادار الموقع الحي</span>
          <span class="coord-pill" id="coordTxt" dir="ltr">33.5138, 36.2765</span>
        </summary>
        <div class="map-disclosure-body">
          <div class="mut" style="font-size:12px;margin-bottom:8px">تتبع موقعك الميداني المباشر</div>
          <div id="imap" class="map" style="height:220px"></div>
        </div>
      </details>
    </section>

    <!-- TAB 2: ACTIVE ORDERS (Dedicated exclusively to active orders) -->
    <section id="tab-active" class="cap-tab hide">
      <div id="active"></div>
    </section>

    <!-- TAB 3: WALLET (Points Balance, Order Cost & Ledger) -->
    <section id="tab-wallet" class="cap-tab hide">
      <div id="capWalletLowBal" class="wallet-banner-warn hide">⚠️ رصيد النقاط لا يكفي لتكلفة الطلب التالي — تواصل مع الإدارة لشحن رصيدك لاستقبال العروض.</div>
      <div class="card" id="capWalletCard">
        <div class="row-head">
          <div>
            <h3 style="margin:0">💰 محفظة النقاط</h3>
            <div class="mut" style="font-size:12px">1 نقطة = 0.01 دينار أردني</div>
          </div>
          <button type="button" class="sec sm" id="capWalletRefBtn">🔄 تحديث</button>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin:10px 0">
          <div>الرصيد الحالي: <b id="capBalVal">0 نقطة</b></div>
          <div>تكلفة الطلب: <b id="capCostVal">25 نقطة</b></div>
          <div>المتاح: <b id="capAvailVal">0 نقطة</b></div>
        </div>
        <div class="tablewrap">
          <table>
            <thead><tr><th>العملية</th><th>النقاط</th><th>الرصيد</th><th>التفاصيل</th><th>الوقت</th></tr></thead>
            <tbody id="capLedgerRows"><tr><td colspan="5" class="mut">جاري التحميل...</td></tr></tbody>
          </table>
        </div>
      </div>
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
        <label class="setting-row" for="vibToggle" style="cursor:pointer">
          <div>
            <div class="setting-title">الاهتزاز مع الرنين</div>
            <div class="setting-sub">اهتزاز الهاتف عند وصول طلب جديد</div>
          </div>
          <input type="checkbox" id="vibToggle" class="accent-warn">
        </label>
        <div class="setting-row">
          <div>
            <div class="setting-title">نغمة التنبيه الصوتية</div>
            <div class="setting-sub">اختر نمط صوت التنبيه عند وصول الطلب</div>
          </div>
          <div class="tone-picker-row">
            <select id="toneSelect" aria-label="نغمة التنبيه الصوتية" style="width:auto;min-width:170px">
              ${ALARM_SOUNDS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
            </select>
            <button type="button" id="toneTestBtn" class="sec sm">🔊 تجربة الصوت</button>
          </div>
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
      <div class="card" style="border-color:var(--status-bad-border)">
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
  let pos = null, watchId = null, lastSent = 0;
  let map = null, mk = [], me = null, idleMe = null, wake = null, cd = null;
  let routeLayer = null, lastRouteTime = 0, selectedActiveId = null, lastAutoShownOfferId = null;

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
  $('#toneTestBtn').onclick = () => testSound();
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
    if (tabName === 'home' && $('#idleMapCard')?.open) {
      setTimeout(() => {
        idleMap?.invalidateSize();
        if (pos) idleMap?.setView([pos.lat, pos.lng], 15);
      }, 60);
    }
    if (tabName === 'active') setTimeout(() => map?.invalidateSize(), 60);
    if (tabName === 'wallet') loadCaptainWallet();
    if (tabName === 'settings') {
      $('#srvCurrentLbl').textContent = getServerUrl() || location.origin;
    }
  }

  $$('#bottomNav button[data-tab]').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  $('#homeActCard').onclick = () => switchTab('active');
  $('#homeActCard').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      switchTab('active');
    }
  };
  $('#goWalletFromWarnBtn')?.addEventListener('click', () => switchTab('wallet'));
  $('#idleMapCard')?.addEventListener('toggle', () => {
    if ($('#idleMapCard')?.open) {
      setTimeout(() => {
        idleMap?.invalidateSize();
        if (pos) idleMap?.setView([pos.lat, pos.lng], 15);
      }, 60);
    }
  });

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
    $('#stDeductedToday').textContent = `خصم اليوم: ${points(s.deducted_today ?? 0)}`;

    allHistory = await api('/captain/history');
    renderHistory();
    await loadCaptainWallet();
  }

  function syncLowBalWarn(isLow) {
    const low = Boolean(isLow);
    $('#capLowBalBanner')?.classList.toggle('hide', !low);
    $('#capWalletLowBal')?.classList.toggle('hide', !low);
  }

  function formatAvailablePoints(data) {
    const avail = Number(data?.available_points ?? data?.balance_points ?? 0);
    const enforced = (data?.wallet_enforcement ?? 'off') === 'on';
    if (!enforced && avail <= 0) return 'متاح (الرصيد غير إلزامي حالياً)';
    if (avail < 0) return '0 نقطة (محجوز للطلب النشط)';
    return `${avail} نقطة`;
  }

  async function loadCaptainWallet() {
    try {
      const w = await api('/captain/wallet');
      const kindLbl = (k) => k === 'topup' ? 'شحن' : k === 'deduction' ? 'خصم طلب' : 'تعديل';
      $('#capBalVal').textContent = `${w.balance_points ?? 0} نقطة`;
      $('#capCostVal').textContent = `${w.required_cost ?? 25} نقطة`;
      $('#capAvailVal').textContent = formatAvailablePoints(w);
      syncLowBalWarn(w.low_balance);
      $('#capLedgerRows').innerHTML = (w.entries || []).map((e) => `<tr>
        <td>${kindLbl(e.kind)}</td>
        <td dir="ltr"><b style="color:${e.amount >= 0 ? 'var(--ok)' : 'var(--bad)'}">${e.amount > 0 ? `+${e.amount}` : e.amount}</b></td>
        <td>${e.balance_after}</td>
        <td>${esc(e.note || (e.order_id ? `طلب #${String(e.order_id).padStart(4, '0')}` : '—'))}</td>
        <td>${time(e.at)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="mut">لا توجد حركات مالية بعد</td></tr>';
    } catch {}
  }

  const HOME_STAGE_LABEL = {
    accepted: 'المرحلة الحالية: التوجه للمنشأة للاستلام',
    picked_up: 'المرحلة الحالية: تم الاستلام — التوجه للزبون',
    arrived: 'المرحلة الحالية: عند موقع الزبون — بانتظار تأكيد التسليم',
  };

  function renderHomeActiveSummary(allAct) {
    const box = $('#homeActiveOrderBox');
    if (!box) return;
    if (!allAct.length) {
      box.innerHTML = '';
      return;
    }
    const o = allAct.find((x) => x.id === selectedActiveId) || allAct[0];
    const stageTxt = HOME_STAGE_LABEL[o.status] || 'طلب قيد التنفيذ';
    box.innerHTML = `<div class="card home-active-card">
      <div class="row-head">
        <h3>🛵 ${allAct.length > 1 ? `طلباتك النشطة (${allAct.length})` : 'طلبك النشط الآن'} — <span dir="ltr">${serialNo(o)}</span></h3>
        ${badge(o.status)}
      </div>
      <div class="home-active-stage">${stageTxt}</div>
      <div style="margin-top:8px"><b>🏪 ${esc(o.merchant?.name || '—')}</b></div>
      <div class="home-active-addr">📍 ${esc(o.customer_address || '—')}</div>
      <button type="button" class="ok big" id="homeOpenActiveBtn">🛵 متابعة الطلب النشط</button>
    </div>`;
    $('#homeOpenActiveBtn').onclick = () => switchTab('active');
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
    if (st.balance_points !== undefined) {
      $('#capBalVal').textContent = `${st.balance_points} نقطة`;
      $('#capCostVal').textContent = `${st.required_cost ?? 25} نقطة`;
      $('#capAvailVal').textContent = formatAvailablePoints(st);
      syncLowBalWarn(st.low_balance);
    }
    const navBadge = $('#navActBadge');
    if (navBadge) {
      navBadge.textContent = allAct.length;
      navBadge.classList.toggle('hide', allAct.length === 0);
    }

    renderOffer();
    renderHomeActiveSummary(allAct);
    renderActive();
    st.online ? startGps() : stopGps();
  }

  function renderOffer() {
    clearInterval(cd);
    const o = st.offer, box = $('#offer');
    const homeTab = $('#tab-home');
    if (!o) {
      box.innerHTML = '';
      homeTab?.classList.remove('home-compact');
      lastAutoShownOfferId = null;
      stopAlarm();
      notifCtrl?.syncCaptainOffer(null);
      return;
    }
    homeTab?.classList.add('home-compact');
    const mapCard = $('#idleMapCard');
    if (mapCard?.open) mapCard.open = false;
    if (o.id !== lastAutoShownOfferId) {
      lastAutoShownOfferId = o.id;
      if (currentTab !== 'home') switchTab('home');
    }
    notifyOffer(o);
    startAlarm();
    const acceptCurrentOffer = async () => {
      await act(() => api(`/captain/offers/${o.id}/accept`, 'POST'), '✅ تم قبول الطلب');
      selectedActiveId = o.id;
      await refresh();
      switchTab('active');
    };
    const rejectCurrentOffer = async () => {
      await act(() => api(`/captain/offers/${o.id}/reject`, 'POST'), 'تم رفض العرض');
      await refresh();
    };
    notifCtrl?.syncCaptainOffer({
      offer: o,
      exempt: st.exempt,
      effective_cost_points: st.effective_cost_points,
      onAccept: acceptCurrentOffer,
      onReject: rejectCurrentOffer,
    });
    box.innerHTML = `<div class="card offer offer-sheet">
  <div class="row-head">
    <h3>🔔 طلب توصيل جديد — <span dir="ltr">${serialNo(o)}</span></h3>
    <span class="badge b-offered">بانتظار قبول كابتن</span>
  </div>
  ${st.activeOrders && st.activeOrders.length > 0 ? '<div class="mut" style="margin-bottom:8px">⚡ طلب إضافي (لديك طلب نشط حالياً)</div>' : ''}
  <p><b>🏪 من المنشأة:</b> ${esc(o.merchant.name)}<br><span class="mut">${esc(o.merchant.address)}</span></p>
  <p style="background:var(--brand-primary-soft);padding:12px 14px;border-radius:12px;border:1px solid var(--border-brand-soft);margin:10px 0">
    <b>📍 عنوان التوصيل:</b> ${esc(o.customer_address || '—')}
  </p>
  <p class="mut">تكلفة الطلب عند التسليم: <b>${st.exempt ? 'معفى (0 نقطة)' : points(st.effective_cost_points ?? 0)}</b></p>
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
      notifCtrl?.updateCaptainOfferCountdown?.(s);
      if (!s) { clearInterval(cd); setTimeout(refresh, 1500); }
    };
    tick();
    cd = setInterval(tick, 1000);
    $('#acc').onclick = acceptCurrentOffer;
    $('#rej').onclick = rejectCurrentOffer;
  }

  function buildNavUrl(lat, lng) {
    if (navApp === 'waze') return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }

  const NEXT = {
    accepted: ['picked_up', '📦 استلمت الطلب من المنشأة'],
    picked_up: ['arrived', '📍 وصلت عند الزبون'],
    arrived: ['delivered', '✅ تم التسليم'],
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
      <div class="step-item ${stepIdx > 1 ? 'done' : 'curr'}"><span class="step-dot">${stepIdx > 1 ? '✓' : '1'}</span><span>للمنشأة</span></div>
      <div class="step-line ${stepIdx > 1 ? 'done' : ''}"></div>
      <div class="step-item ${stepIdx > 2 ? 'done' : stepIdx === 2 ? 'curr' : ''}"><span class="step-dot">${stepIdx > 2 ? '✓' : '2'}</span><span>للزبون</span></div>
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
        <div style="padding:12px;border-radius:12px;background:var(--bg-subtle);border:1px solid var(--border-brand-soft);margin-bottom:10px">
          <div style="font-weight:800;color:var(--brand-primary);margin-bottom:4px">🏪 بيانات المنشأة (الاستلام)</div>
          <div><b>${esc(o.merchant.name)}</b> — <span class="mut">${esc(o.merchant.address)}</span></div>
        </div>

        <!-- Customer Box -->
        <div style="padding:12px;border-radius:12px;background:var(--status-ok-soft);border:1px solid var(--status-ok-border);margin-bottom:10px">
          <div class="clr-ok-soft" style="font-weight:800;margin-bottom:4px">📍 بيانات التوصيل والزبون</div>
          <div style="font-size:16px;font-weight:800;margin-bottom:4px">${esc(o.customer_address || '—')}</div>
          ${o.customer_name && o.customer_name !== '—' ? `<div>الزبون: <b>${esc(o.customer_name)}</b></div>` : ''}
          ${o.notes ? `<div class="mut" style="margin-top:4px">📝 ملاحظات: ${esc(o.notes)}</div>` : ''}
          ${o.customer_phone ? `<div class="row" style="margin-top:8px">
            <a class="btn-nav sec sm" href="https://wa.me/${esc(waPhone)}" target="_blank" rel="noopener">💬 واتساب الزبون</a>
          </div>` : ''}
        </div>

        <div id="amap" class="map" style="height:330px"></div>

        <div class="cap-quick-actions">
          ${dest.lat != null
            ? `<a id="qaNavBtn" class="btn-nav qa-nav" href="${buildNavUrl(dest.lat, dest.lng)}" target="_blank" rel="noopener noreferrer">🧭 <span>ملاحة</span></a>`
            : `<button type="button" id="qaNavBtn" class="btn-nav qa-nav">🧭 <span>ملاحة</span></button>`}
          ${o.merchant.phone
            ? `<a id="qaMerchCallBtn" class="btn-nav qa-call" href="tel:${esc(o.merchant.phone)}">📞 <span>اتصال منشأة</span></a>`
            : `<button type="button" id="qaMerchCallBtn" class="btn-nav qa-call">📞 <span>اتصال منشأة</span></button>`}
          ${o.customer_phone
            ? `<a id="qaCustCallBtn" class="btn-nav qa-call qa-cust" href="tel:${esc(o.customer_phone)}">📞 <span>اتصال زبون</span></a>`
            : `<button type="button" id="qaCustCallBtn" class="btn-nav qa-call qa-cust">📞 <span>اتصال زبون</span></button>`}
        </div>

        <button type="button" class="big ok" id="nx">${n[1]}</button>
        ${o.status !== 'accepted' ? '<div class="cap-danger-zone"><div class="cap-danger-label">منطقة الإجراءات الخطرة</div><button type="button" class="big bad" id="fl">⚠️ الزبون لا يرد / العنوان خطأ</button></div>' : ''}
      </div>`;

    if (dest.lat == null) {
      $('#qaNavBtn')?.addEventListener('click', () => toast('إحداثيات الوجهة غير متوفرة على الخريطة'));
    }
    if (!o.merchant.phone) {
      $('#qaMerchCallBtn')?.addEventListener('click', () => toast('رقم المنشأة غير متوفر'));
    }
    if (!o.customer_phone) {
      $('#qaCustCallBtn')?.addEventListener('click', () => toast('📄 رقم الزبون مدوّن على فاتورة المنشأة عند الاستلام'));
    }

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
      const btn = $('#nx');
      if (n[0] === 'delivered' && !confirm('تأكيد إتمام تسليم الطلب؟')) return;
      let payload = { status: n[0] };
      if (n[0] === 'picked_up') {
        btn.disabled = true;
        btn.textContent = '⏳ جاري التحقق من الموقع...';
        try {
          const gps = await getFreshGps();
          if (gps) payload = { status: n[0], lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy };
        } finally {
          btn.disabled = false;
          btn.textContent = n[1];
        }
      }
      await act(() => api(`/captain/orders/${o.id}/status`, 'POST', payload), n[0] === 'delivered' ? '🎉 تم تسليم الطلب بنجاح!' : 'تم تحديث حالة الطلب');
      await refresh();
    };
    $('#fl')?.addEventListener('click', async () => {
      if (!confirm('الإبلاغ عن تعذر تسليم الطلب؟')) return;
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
            <b dir="ltr" style="color:var(--brand-primary);font-size:15px">${serialNo(o)}</b>
            ${badge(o.status)}
          </div>
          <div style="font-weight:700">🏪 ${esc(o.merchant?.name || '—')}</div>
          <div class="mut" style="font-size:12.5px">📍 ${esc(o.customer_address || '—')}</div>
        </div>
        <div style="text-align:left">
          ${o.status === 'delivered' && o.cost_points > 0 ? `<div class="clr-bad" style="font-weight:800">-${points(o.cost_points)}</div>` : o.status === 'delivered' && o.cost_points === 0 ? `<div class="clr-ok-soft" style="font-weight:700">معفى</div>` : ''}
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

  function getFreshGps() {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const coords = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : undefined,
          };
          pos = { lat: coords.lat, lng: coords.lng };
          showMe();
          resolve(coords);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  function startGps() {
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

  function stopGps() {
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

  $('#tog').onclick = async () => {
    const r = await act(() => api('/captain/online', 'POST', { online: !st.online }));
    if (r) { lastSent = 0; await refresh(); }
  };
  $('#capWalletRefBtn').onclick = () => loadCaptainWallet();

  connectWs((m) => {
    if (m.type === 'notification') {
      notifCtrl?.handleWsNotification(m);
    } else if (m.type === 'balance') {
      toast('💳 تم تحديث رصيد محفظتك');
      refresh();
    } else if (m.type === 'offer' || m.type === 'offer_end' || m.type === 'order') {
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
