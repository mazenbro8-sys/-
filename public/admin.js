import { $, $$, esc, money, time, badge, STATUS, api, act, toast, connectWs, authScreen, header, makeMap, pickLocation, emoji, DAMASCUS, captainModal, animateMarker, makeRoute, fitMapToPoints, createPulsingDot, enDigits, serialNo } from './shared.js?v=6';

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
    users: '🏪 المنشآت والكباتن',
    orders: '📦 الطلبات',
    settle: '💰 الخزينة',
    flags: '⚠️ التنبيهات الأمنية',
    settings: '⚙️ المناطق والإعدادات',
  };
  app.innerHTML = `<aside class="sb"><div class="logo"><i>🛵</i>مشوار</div>
    <nav class="nav tabs">${Object.entries(TABS).map(([k, v]) => `<button data-t="${k}">${v}</button>`).join('')}</nav>
    <div class="sbfoot"><div class="av">${esc((user.name || 'A').slice(0, 1))}</div><b>${esc(user.name || 'المدير')}</b><button id="lo2">خروج</button></div></aside>
    <section class="main">
      <div class="topbar2" style="flex-wrap:wrap;gap:10px">
        <h2 id="ptitle"></h2>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button type="button" id="adminAddOrderTop" class="ok sm">➕ إضافة طلب لكابتن</button>
          <button type="button" id="adminSndBtn" class="bad sm">🔇 تفعيل صوت إنذار الطلبات</button>
          <div class="clock"><b id="clk"></b><span id="dt"></span></div>
        </div>
      </div>
      <div id="shortageBox" style="padding:0 18px"></div>
      <div id="view" class="view"></div>
    </section>`;
  $('#lo2').onclick = () => $('#lo').click();
  const tick = () => {
    const d = new Date();
    $('#clk').textContent = enDigits(d.toLocaleTimeString('en-GB'));
    $('#dt').textContent = enDigits(d.toLocaleDateString('ar-SY-u-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  };
  tick(); setInterval(tick, 1000);

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
    b.textContent = ok ? '🔊 صوت الإنذار مفعّل' : '🔇 اضغط لتفعيل صوت الإنذار';
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

  const feed = [];
  let tab = 'dash', zones = [], liveMap = null, liveFitted = false;
  let capMarkers = new Map(), merchMarkers = new Map(), orderMarkers = new Map(), routeLayers = [];
  let liveCache = { orders: [], recentOrders: [], captains: [], merchants: [], shortage: null };
  let refreshTimer;
  const zname = (id) => zones.find((z) => z.id === id)?.name || '—';

  function updateShortageBanner(shortage) {
    const box = $('#shortageBox');
    if (!box) return;
    if (!shortage || !shortage.alert || !shortage.orders?.length) {
      box.innerHTML = '';
      mutedShortageKey = '';
      stopAdminAlarm();
      return;
    }
    const key = shortage.orders.map((o) => `${o.id}:${o.status}`).join(',');
    const capList = liveCache.captains || [];
    box.innerHTML = `
      <div class="card offer" style="border:2px solid #ef4444;background:rgba(239,68,68,.16);margin-top:12px;margin-bottom:0">
        <div class="row-head" style="flex-wrap:wrap;gap:10px">
          <div>
            <h3 style="color:#fca5a5;margin:0">🚨 إنذار عاجل: يوجد طلبات بانتظار كابتن (${shortage.unassignedCount}) ولا يوجد كباتن متاحون كافيون!</h3>
            <div class="mut" style="color:#fecaca;margin-top:4px">
              طلبات بدون كابتن: <b>${shortage.searchingCount}</b> — إجمالي الطلبات المنتظرة: <b>${shortage.unassignedCount}</b> — الكباتن المتاحون حالياً: <b>${shortage.freeOnlineCaptains}</b>
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button type="button" class="bad sm" id="muteShortageBtn">🔕 كتم صوت الإنذار</button>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
          ${shortage.orders.map((o) => `
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;background:rgba(0,0,0,.35);border-radius:10px">
              <div>
                <b dir="ltr">${serialNo(o)}</b> — <b>🏪 ${esc(o.merchant?.name || '—')}</b> — 📍 <b>${esc(o.customer_address || '—')}</b> ${badge(o.status)}
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <select data-assign-sel="${o.id}" style="padding:5px 8px;font-size:12px;margin:0;min-width:140px">
                  <option value="">-- اختر كابتن لتعيينه فوراً --</option>
                  ${capList.map((c) => `<option value="${c.id}">🛵 ${esc(c.name)} (${c.busy ? 'مشغول' : c.online ? 'أونلاين' : 'أوفلاين'})</option>`).join('')}
                </select>
                <button type="button" class="ok sm" data-assign-btn="${o.id}">🛵 تعيين للكابتن</button>
                <button type="button" class="bad sm" data-x="${o.id}">إلغاء الطلب</button>
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
    let currentHtml = '<span class="mut">— بدون كابتن —</span>';
    if (o.captain) {
      currentHtml = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <a href="#" data-cap="${o.captain.id}" style="color:var(--cy);font-weight:700">🛵 ${esc(o.captain.name)}</a>
        ${!isClosed ? `<button type="button" class="bad sm" data-unassign="${o.id}" title="سحب/إلغاء الطلب عن هذا الكابتن">✕ إلغاء عن الكابتن</button>` : ''}
      </div>`;
    } else if (o.offered_captain) {
      currentHtml = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="color:#fbbf24">🔔 معروض على ${esc(o.offered_captain.name)}</span>
        ${!isClosed ? `<button type="button" class="bad sm" data-unassign="${o.id}">✕ سحب العرض</button>` : ''}
      </div>`;
    } else if (o.captain_name) {
      currentHtml = `<span>🛵 ${esc(o.captain_name)}</span>`;
    }
    if (isClosed || !capList.length) return currentHtml;
    return `${currentHtml}
      <div style="display:flex;gap:4px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <select data-assign-sel="${o.id}" style="padding:4px 8px;font-size:12px;margin:0;min-width:130px;max-width:170px">
          <option value="">${o.captain ? '🔄 تحويل لكابتن آخر...' : '🛵 تعيين كابتن...'}</option>
          ${capList.map((c) => `<option value="${c.id}">🛵 ${esc(c.name)} (${c.busy ? 'مشغول' : c.online ? 'أونلاين' : 'أوفلاين'})</option>`).join('')}
        </select>
        <button type="button" class="ok sm" data-assign-btn="${o.id}">تعيين</button>
      </div>`;
  }

  async function refreshCurrentTab() {
    if (tab === 'dash') await views.dash();
    else if (tab === 'live') { clearTimeout(refreshTimer); await loadLive(); }
    else if (tab === 'orders') await views.orders();
  }

  async function handleOrderActionClick(e) {
    const assignBtn = e.target.closest('[data-assign-btn]');
    if (assignBtn) {
      const oid = Number(assignBtn.dataset.assignBtn);
      const container = assignBtn.parentElement || document;
      const sel = container.querySelector(`[data-assign-sel="${oid}"]`) || $(`[data-assign-sel="${oid}"]`);
      const capId = Number(sel?.value || 0);
      if (!capId) { toast('يرجى اختيار الكابتن أولاً من القائمة'); return true; }
      await act(() => api(`/admin/orders/${oid}/assign-captain`, 'POST', { captain_id: capId }), 'تم تعيين الكابتن للطلب بنجاح');
      await refreshCurrentTab();
      return true;
    }
    const unassignBtn = e.target.closest('[data-unassign]');
    if (unassignBtn) {
      const oid = Number(unassignBtn.dataset.unassign);
      if (confirm('هل تريد إلغاء/سحب الطلب عن هذا الكابتن؟')) {
        await act(() => api(`/admin/orders/${oid}/unassign-captain`, 'POST'), 'تم سحب الطلب من الكابتن');
        await refreshCurrentTab();
      }
      return true;
    }
    const addForCapBtn = e.target.closest('[data-add-order]');
    if (addForCapBtn) {
      const cid = addForCapBtn.dataset.addOrder ? Number(addForCapBtn.dataset.addOrder) : null;
      openAddOrderModal(cid);
      return true;
    }
    const xEl = e.target.closest('[data-x]');
    if (xEl && confirm('إلغاء الطلب نهائياً؟')) {
      await act(() => api(`/admin/orders/${xEl.dataset.x}/cancel`, 'POST'), 'تم إلغاء الطلب');
      await refreshCurrentTab();
      return true;
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
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:grid;place-items:center;padding:14px';
    el.innerHTML = `<div class="card" style="width:100%;max-width:480px;padding:18px;background:#18181b;color:#fff;max-height:90vh;overflow-y:auto">
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
        <hr style="border-color:rgba(255,255,255,.1);margin:14px 0">
        <h4 style="margin:0 0 8px">أو إسناد طلب حالي موجود لهذا الكابتن:</h4>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${unassignedOrders.map((o) => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,.05);border-radius:8px">
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
        await act(() => api(`/admin/orders/${oid}/assign-captain`, 'POST', { captain_id: defaultCapId }), 'تم إسناد الطلب للكابتن');
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

  async function go(t) {
    tab = t;
    clearTimeout(refreshTimer);
    liveMap = null; liveFitted = false;
    capMarkers.clear(); merchMarkers.clear(); orderMarkers.clear(); routeLayers = [];
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('#ptitle').textContent = TABS[t].replace(/^\S+\s/, '');
    zones = await api('/admin/zones');
    await views[t]();
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
      const ordBadges = (c.active_orders || []).map((ao) => `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(59,130,246,.2);padding:2px 6px;border-radius:6px;margin:2px"><b dir="ltr">#${ao.serial_no}</b> <button type="button" class="bad sm" style="padding:1px 5px;font-size:10px" data-unassign="${ao.id}" title="سحب الطلب من الكابتن">✕</button></span>`).join(' ');
      return `<span class="badge b-accepted">🛵 مشغول (${(c.active_orders || []).length || 1})</span><div>${ordBadges}</div>`;
    }
    if (c.online) return '<span class="badge b-active">🟢 أونلاين متاح</span>';
    return '<span class="badge">⚪ أوفلاين</span>';
  }

  const views = {
    async dash() {
      const [s, d] = await Promise.all([api('/admin/stats'), api('/admin/live')]);
      liveCache = d;
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

        <div class="dgrid" style="margin-bottom:16px">
          <div class="card">
            <div class="row-head">
              <h3>🗺️ الخريطة الحية (المنشآت والكباتن والطلبات)</h3>
              <div style="display:flex;gap:6px">
                <button type="button" class="sec sm" id="dashFit">🎯 إظهار الكل</button>
                <button type="button" class="sec sm" data-go="live">📡 غرفة العمليات</button>
              </div>
            </div>
            <div id="dashmap" class="map" style="height:370px"></div>
          </div>
          <div class="card" style="padding:16px">
            <div class="row-head">
              <h3>⚡ آخر النشاطات</h3>
              <button type="button" class="sec sm" id="dashRef">🔄 تحديث</button>
            </div>
            <ul class="feed">${feed.slice(0, 8).map((f) => `<li>${esc(f.t)}<small>${f.at}</small></li>`).join('') || '<li class="mut">لا نشاط جديد في هذه الجلسة بعد</li>'}</ul>
          </div>
        </div>

        <div class="card">
          <div class="row-head" style="flex-wrap:wrap;gap:10px">
            <h3>${liveOrders.length ? `📦 الطلبات الحية الجارية (${liveOrders.length})` : '📦 الطلبات (ابحث بالرقم التسلسلي أو عيّن كابتن)'}</h3>
            <div style="display:flex;gap:8px;align-items:center;flex:1;justify-content:flex-end;min-width:240px;flex-wrap:wrap">
              <input id="dashOrderSearch" placeholder="🔍 بحث بالرقم التسلسلي (مثال: 0001) أو المنشأة أو العنوان..." style="max-width:320px;margin:0">
              <button type="button" class="ok sm" data-add-order="">➕ إضافة طلب لكابتن</button>
              <button type="button" class="sec sm" data-go="orders">كل الطلبات</button>
            </div>
          </div>
          <div class="tablewrap">
            <table>
              <thead><tr><th>الرقم التسلسلي</th><th>المنشأة</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن (تحديد / إلغاء)</th><th>الوقت</th><th></th></tr></thead>
              <tbody id="dashOrderRows"></tbody>
            </table>
          </div>
        </div>

        <div class="split2">
          <div class="card">
            <div class="row-head">
              <h3>🏪 المنشآت (${merchList.length})</h3>
              <button type="button" class="sec sm" data-go="users">➕ إدارة المنشآت</button>
            </div>
            <div class="tablewrap">
              <table>
                <thead><tr><th>اسم المنشأة</th><th>الهاتف</th><th>المنطقة / العنوان</th><th>الحالة</th><th></th></tr></thead>
                <tbody>
                  ${merchList.map((m) => `<tr>
                    <td><b>🏪 ${esc(m.business_name || m.name)}</b><div class="mut">${esc(m.name)}</div></td>
                    <td dir="ltr">${esc(m.phone)}</td>
                    <td>${esc(zname(m.zone_id))}<div class="mut">${esc(m.address || '')}</div></td>
                    <td>${badge(m.status)}</td>
                    <td>${m.lat != null ? `<button type="button" class="ghost sm" data-pan="${m.lat},${m.lng}">📍 موقع</button>` : '<span class="mut">بلا موقع</span>'}</td>
                  </tr>`).join('') || '<tr><td colspan="5" class="mut">لا توجد منشآت مسجلة</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="row-head">
              <h3>🛵 الكباتن (${capList.length})</h3>
              <button type="button" class="sec sm" data-go="users">➕ إدارة الكباتن</button>
            </div>
            <div class="tablewrap">
              <table>
                <thead><tr><th>اسم الكابتن</th><th>الهاتف</th><th>الاتصال والطلبات</th><th>إجراءات</th></tr></thead>
                <tbody>
                  ${capList.map((c) => `<tr>
                    <td><a href="#" data-cap="${c.id}" style="color:var(--cy);font-weight:700">🛵 ${esc(c.name)}</a><div class="mut">${esc(zname(c.zone_id))}</div></td>
                    <td dir="ltr">${esc(c.phone)}</td>
                    <td>${capStatusTag(c)}</td>
                    <td>
                      <button type="button" class="ok sm" data-add-order="${c.id}">➕ إضافة طلب</button>
                      ${c.lat != null ? ` <button type="button" class="ghost sm" data-pan="${c.lat},${c.lng}">📍 موقع</button>` : ''}
                    </td>
                  </tr>`).join('') || '<tr><td colspan="4" class="mut">لا يوجد كباتن مسجلون</td></tr>'}
                </tbody>
              </table>
            </div>
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
          const icon = c.busy ? emoji('🛵') : c.online ? createPulsingDot('#22c55e') : createPulsingDot('#94a3b8');
          const stTxt = c.busy ? `مشغول بطلب #${c.active_order_id}` : c.online ? 'أونلاين متاح' : 'أوفلاين (آخر موقع)';
          L.marker([c.lat, c.lng], { icon })
            .addTo(dashMap)
            .bindTooltip(`🛵 ${c.name} — ${stTxt}`);
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
          <td dir="ltr"><b>${serialNo(o)}</b></td>
          <td><b>${esc(o.merchant?.name || '—')}</b></td>
          <td><b>📍 ${esc(o.customer_address || '—')}</b></td>
          <td>${badge(o.status)}${o.eta_minutes ? `<div class="mut">~${o.eta_minutes} د</div>` : ''}</td>
          <td>${renderOrderCaptainCell(o, capList)}</td>
          <td>${time(o.created_at)}</td>
          <td>
            <button type="button" class="ghost sm" data-d="${o.id}">تفاصيل</button>
            ${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? ` <button type="button" class="bad sm" data-x="${o.id}">إلغاء الطلب</button>` : ''}
          </td>
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
      view().innerHTML = `
        <div class="stats" id="lstats">
          ${[['طلبات حية', s.live], ['كباتن أونلاين', `${s.online}/${s.captains}`], ['منشآت', s.merchants], ['سُلّم اليوم', s.deliveredToday], ['بانتظار الموافقة', s.pending], ['تنبيهات', s.flags]].map(([k, v]) => `<div class="card"><div class="stat">${v}</div><div class="mut">${k}</div></div>`).join('')}
        </div>
        <div class="card">
          <div class="row-head">
            <h3>🗺️ خريطة العمليات المباشرة</h3>
            <div style="display:flex;gap:6px">
              <button type="button" class="sec sm" id="liveFit">🎯 إظهار الكل</button>
              <button type="button" class="sec sm" id="liveRef">🔄 تحديث الآن</button>
            </div>
          </div>
          <div id="lmap" class="map" style="height:500px"></div>
        </div>
        <div class="card">
          <div class="row-head" style="flex-wrap:wrap;gap:10px">
            <h3>📦 الطلبات الحية الجارية</h3>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1;justify-content:flex-end">
              <input id="liveOrderSearch" placeholder="🔍 ابحث بالرقم التسلسلي (مثال: 0001) أو المنشأة أو العنوان..." style="max-width:340px;margin:0">
              <button type="button" class="ok sm" data-add-order="">➕ إضافة طلب لكابتن</button>
            </div>
          </div>
          <div class="tablewrap">
            <table>
              <thead><tr><th>الرقم التسلسلي</th><th>المنشأة</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن (تحديد / إلغاء)</th><th></th></tr></thead>
              <tbody id="lrows"></tbody>
            </table>
          </div>
        </div>
        <div id="detail"></div>
        <div class="split2">
          <div class="card">
            <h3>🛵 الكباتن ومواقعهم</h3>
            <div class="tablewrap">
              <table>
                <thead><tr><th>الكابتن</th><th>الهاتف</th><th>الحالة والطلبات</th><th>إجراءات</th></tr></thead>
                <tbody id="lcaps"></tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h3>🏪 المنشآت</h3>
            <div class="tablewrap">
              <table>
                <thead><tr><th>المنشأة</th><th>الهاتف</th><th>العنوان</th><th></th></tr></thead>
                <tbody id="lmerchs"></tbody>
              </table>
            </div>
          </div>
        </div>`;

      liveMap = makeMap('lmap', DAMASCUS, 12);
      $('#liveFit').onclick = () => {
        const pts = collectAllPoints(liveCache);
        if (pts.length) fitMapToPoints(liveMap, pts);
      };
      $('#liveRef').onclick = () => { clearTimeout(refreshTimer); loadLive(); };

      view().onclick = async (e) => {
        if (await handleOrderActionClick(e)) return;
        const dEl = e.target.closest('[data-d]');
        if (dEl) return detail(dEl.dataset.d);
        const capEl = e.target.closest('[data-cap]');
        if (capEl) {
          e.preventDefault();
          const cid = Number(capEl.dataset.cap);
          const cap = (liveCache.captains || []).find((c) => c.id === cid) || (liveCache.orders || []).find((o) => o.captain?.id === cid)?.captain;
          if (cap) captainModal(cap);
          return;
        }
        const panEl = e.target.closest('[data-pan]');
        if (panEl && liveMap) {
          const [la, ln] = panEl.dataset.pan.split(',').map(Number);
          liveMap.setView([la, ln], 16);
          $('#lmap').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };

      await loadLive();
    },

    async users() {
      const rows = await api('/admin/users');
      const mCount = rows.filter((u) => u.role === 'merchant').length;
      const cCount = rows.filter((u) => u.role === 'captain').length;
      view().innerHTML = `<div class="card"><div class="row-head"><h3 style="margin:0">إضافة حساب (المنشآت: ${mCount} — الكباتن: ${cCount})</h3><button type="button" id="addb">➕ منشأة / كابتن جديد</button></div><form id="nu" class="hide">
        <div class="row"><div><label>النوع</label><select name="role" id="nrole"><option value="merchant">🏪 منشأة</option><option value="captain">🛵 كابتن</option></select></div>
        <div><label>المنطقة</label><select name="zone_id">${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div></div>
        <div class="row"><div><label>الاسم</label><input name="name" required minlength="2"></div><div><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div></div>
        <label>كلمة المرور (6 أحرف على الأقل، حروف وأرقام)</label><input name="password" type="text" minlength="6" required autocomplete="off">
        <div id="mfields"><label>اسم المنشأة</label><input name="business_name"><label>العنوان</label><input name="address"><label>موقع المنشأة (اضغط على الخريطة لتحديده)</label><div id="nmap" class="map"></div></div>
        <button class="big ok">إنشاء الحساب</button></form></div>
        <div class="card"><div class="tablewrap"><table><thead><tr><th>النوع</th><th>الاسم</th><th>الهاتف</th><th>المنطقة</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>
      ${rows.map((u) => `<tr>
        <td>${u.role === 'merchant' ? '🏪 منشأة' : '🛵 كابتن'}</td>
        <td><b>${esc(u.business_name || u.name)}</b><div class="mut">${esc(u.role === 'merchant' ? u.name + ' — ' + (u.address || '') : '')}</div></td>
        <td dir="ltr">${esc(u.phone)}</td>
        <td><select data-zone="${u.id}">${zones.map((z) => `<option value="${z.id}" ${z.id === u.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></td>
        <td>${badge(u.status)}${u.online ? ' 🟢' : ''}</td>
        <td>
          ${u.status !== 'active' ? `<button type="button" class="ok sm" data-st="active" data-id="${u.id}">تفعيل</button> ` : ''}
          ${u.status !== 'suspended' ? `<button type="button" class="bad sm" data-st="suspended" data-id="${u.id}">إيقاف</button> ` : ''}
          <button type="button" class="sec sm" data-pw="${u.id}">كلمة مرور</button>
        </td></tr>`).join('') || '<tr><td colspan="6" class="mut">لا توجد حسابات مسجلة</td></tr>'}</tbody></table></div></div>`;
      let npos = [null, null], nmap;
      $('#addb').onclick = () => {
        $('#nu').classList.toggle('hide');
        if (!nmap && !$('#nu').classList.contains('hide')) {
          nmap = makeMap('nmap', DAMASCUS, 12);
          pickLocation(nmap, (a, b) => (npos = [a, b]));
        }
        setTimeout(() => nmap?.invalidateSize(), 60);
      };
      $('#nrole').onchange = (e) => $('#mfields').classList.toggle('hide', e.target.value !== 'merchant');
      $('#nu').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target)); f.zone_id = Number(f.zone_id);
        if (f.role === 'merchant') {
          if (npos[0] == null) return toast('حدّد موقع المنشأة على الخريطة');
          [f.lat, f.lng] = npos;
        } else { delete f.business_name; delete f.address; }
        if (await act(() => api('/admin/users', 'POST', f), 'تم إنشاء الحساب')) views.users();
      };
      view().onclick = async (e) => {
        const stBtn = e.target.closest('[data-st]');
        if (stBtn) {
          const d = stBtn.dataset;
          if (d.st === 'suspended' && !confirm('إيقاف الحساب فوراً؟')) return;
          await act(() => api(`/admin/users/${d.id}`, 'PATCH', { status: d.st }), 'تم التحديث');
          views.users();
          return;
        }
        const pwBtn = e.target.closest('[data-pw]');
        if (pwBtn) {
          const p = prompt('كلمة مرور جديدة (6 أحرف على الأقل، حروف وأرقام)');
          if (p) act(() => api(`/admin/users/${pwBtn.dataset.pw}/reset-password`, 'POST', { password: p }), 'تم تغيير كلمة المرور');
        }
      };
      view().onchange = (e) => {
        if (e.target.dataset.zone) act(() => api(`/admin/users/${e.target.dataset.zone}`, 'PATCH', { zone_id: Number(e.target.value) }), 'تم نقل المنطقة');
      };
    },

    async orders() {
      const [rows, d] = await Promise.all([api('/admin/orders'), api('/admin/live')]);
      liveCache = d;
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
        <div class="tablewrap"><table><thead><tr><th>الرقم التسلسلي</th><th>المنشأة</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن (تحديد / إلغاء)</th><th>الوقت</th><th></th></tr></thead><tbody id="orderRows"></tbody></table></div></div><div id="detail"></div>`;
      const renderOrders = () => {
        const q = $('#orderSearch')?.value || '';
        const st = $('#orderStatusFilter')?.value || '';
        const filtered = rows.filter((o) => matchOrder(o, q, st));
        $('#orderCount').textContent = `(${filtered.length} من ${rows.length})`;
        $('#orderRows').innerHTML = filtered.map((o) => `<tr><td dir="ltr"><b>${serialNo(o)}</b></td><td><b>${esc(o.merchant.name)}</b></td><td><b>📍 ${esc(o.customer_address || '—')}</b></td><td>${badge(o.status)}</td><td>${renderOrderCaptainCell(o, capList)}</td><td>${time(o.created_at)}${o.closed_at ? `<div class="mut">أُغلق ${time(o.closed_at)}</div>` : ''}</td><td><button type="button" class="ghost sm" data-d="${o.id}">تفاصيل</button>${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? ` <button type="button" class="bad sm" data-x="${o.id}">إلغاء</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد طلبات مطابقة للبحث</td></tr>';
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

    async settle() {
      const day = view().dataset.day || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
      const r = await api(`/admin/settlements?day=${day}`);
      const total = r.rows.reduce((a, x) => a + x.total, 0);
      view().innerHTML = `<div class="card"><div class="row"><input type="date" id="sd" value="${r.day}"><b>إجمالي المستحق: ${money(total)}</b></div>
        <div class="tablewrap"><table><thead><tr><th>الكابتن</th><th>الهاتف</th><th>طلبات مسلّمة</th><th>العمولة</th><th>تعويضات</th><th>الإجمالي</th><th></th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td dir="ltr">${esc(x.phone)}</td><td>${x.orders_count}</td><td>${money(x.commission_total)}</td><td>${money(x.liability_total)}</td><td><b>${money(x.total)}</b></td>
        <td>${x.collected_at ? `<span class="badge b-active">تم التحصيل ${time(x.collected_at)}</span>` : `<button type="button" class="ok sm" data-c="${x.captain_id}">تم التحصيل</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد بيانات لهذا اليوم</td></tr>'}</tbody></table></div></div>`;
      $('#sd').onchange = (e) => { view().dataset.day = e.target.value; views.settle(); };
      view().onclick = async (e) => {
        const cEl = e.target.closest('[data-c]');
        if (cEl && confirm('تأكيد تحصيل المبلغ كاش من الكابتن؟')) {
          await act(() => api('/admin/settlements/collect', 'POST', { day: r.day, captain_id: Number(cEl.dataset.c) }), 'تم التحصيل');
          views.settle();
        }
      };
    },

    async flags() {
      const rows = await api('/admin/flags');
      view().innerHTML = `<div class="card"><h3>اشتباه الالتفاف على التطبيق</h3><div class="tablewrap"><table><tbody>
      ${rows.map((f) => `<tr><td>${time(f.at)}</td><td>${esc(f.reason)}<div class="mut">الكابتن: ${esc(f.captain_name)} ${badge(f.captain_status)}</div></td>
        <td>${f.resolved ? 'تمت المعالجة' : `<button type="button" class="sec sm" data-r="${f.id}">تمت المراجعة</button> <button type="button" class="bad sm" data-s="${f.captain_id}">إيقاف الكابتن</button>`}</td></tr>`).join('') || '<tr><td class="mut">لا توجد تنبيهات</td></tr>'}</tbody></table></div></div>`;
      view().onclick = async (e) => {
        const rEl = e.target.closest('[data-r]');
        const sEl = e.target.closest('[data-s]');
        if (rEl) { await act(() => api(`/admin/flags/${rEl.dataset.r}/resolve`, 'POST')); views.flags(); }
        if (sEl && confirm('إيقاف حساب الكابتن فوراً؟')) { await act(() => api(`/admin/users/${sEl.dataset.s}`, 'PATCH', { status: 'suspended' }), 'تم الإيقاف'); views.flags(); }
      };
    },

    async settings() {
      const s = await api('/admin/stats');
      view().innerHTML = `<div class="grid"><div class="card"><h3>عمولة الكابتن لكل طلب مسلّم</h3><div class="row"><input id="cm" type="number" min="0" value="${s.commission}"><button type="button" id="cs">حفظ</button></div></div>
        <div class="card"><h3>المناطق</h3><ul>${zones.map((z) => `<li>${esc(z.name)}</li>`).join('')}</ul><div class="row"><input id="zn" placeholder="اسم منطقة جديدة"><button type="button" id="za">إضافة</button></div></div></div>`;
      $('#cs').onclick = () => act(() => api('/admin/settings/commission', 'PUT', { value: Number($('#cm').value) }), 'تم الحفظ');
      $('#za').onclick = async () => { await act(() => api('/admin/zones', 'POST', { name: $('#zn').value }), 'تمت الإضافة'); views.settings(); };
    },
  };

  async function detail(id) {
    const detBox = $('#detail');
    if (!detBox) return;
    const o = await api(`/admin/orders/${id}`);
    const capList = liveCache.captains || [];
    const hasMap = (o.merchant?.lat != null) || (o.customer_lat != null) || (o.captain?.lat != null);
    detBox.innerHTML = `<div class="card"><h3>طلب — الرقم التسلسلي <span dir="ltr">${serialNo(o)}</span> ${badge(o.status)}</h3>
        <p><b>المنشأة:</b> ${esc(o.merchant.name)} — <b>📍 عنوان التوصيل:</b> ${esc(o.customer_address || '—')}</p>
        <div style="margin:10px 0;padding:10px;background:rgba(255,255,255,.04);border-radius:10px">
          <b>🛵 الكابتن المسند للطلب:</b>
          <div style="margin-top:6px">${renderOrderCaptainCell(o, capList)}</div>
        </div>
        <p>العمولة: ${money(o.commission)}${o.liability ? ` — تعويض الكابتن: ${money(o.liability)} ${esc(o.liability_reason || '')}` : ''}</p>
        ${hasMap ? '<div id="dmap" class="map" style="height:300px"></div>' : ''}
        <ol class="timeline">${o.events.map((e) => `<li>${time(e.at)} — ${esc(e.type)} ${esc(e.actor || '')}</li>`).join('')}</ol>
        <div class="row">${o.captain_id !== undefined && o.captain ? `<button type="button" class="bad" id="lb">تحميل الكابتن ثمن المنتج (تلف/تأخير)</button>` : ''}
        ${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? '<button type="button" class="sec" id="ca">إلغاء الطلب نهائياً</button>' : ''}</div></div>`;
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
        L.marker([o.captain.lat, o.captain.lng], { icon: emoji('🛵') }).addTo(dmap).bindTooltip(`🛵 ${o.captain.name}`);
        pts.push([o.captain.lat, o.captain.lng]);
      }
      if (pts.length) fitMapToPoints(dmap, pts);
      if (o.captain?.lat != null && ['accepted', 'picked_up', 'arrived'].includes(o.status)) {
        const dest = o.status === 'accepted' ? [o.merchant?.lat, o.merchant?.lng] : [o.customer_lat, o.customer_lng];
        if (dest[0] != null) makeRoute(dmap, [o.captain.lat, o.captain.lng], dest);
      }
      setTimeout(() => dmap.invalidateSize(), 60);
    }
    $('#lb')?.addEventListener('click', async () => {
      const reason = prompt('سبب التحميل (تلف / تأخير)');
      if (reason) { await act(() => api(`/admin/orders/${id}/liability`, 'POST', { reason }), 'تم التحميل'); detail(id); }
    });
    $('#ca')?.addEventListener('click', async () => {
      if (confirm('إلغاء الطلب نهائياً؟')) {
        await act(() => api(`/admin/orders/${id}/cancel`, 'POST'), 'تم الإلغاء');
        detail(id);
        await refreshCurrentTab();
      }
    });
    detBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadLive() {
    if (tab !== 'live' || !liveMap) return;
    const [s, d] = await Promise.all([api('/admin/stats'), api('/admin/live')]);
    if (tab !== 'live' || !liveMap) return;
    liveCache = d;
    updateShortageBanner(d.shortage || s.shortage);

    const stEl = $('#lstats');
    if (stEl) {
      stEl.innerHTML = [['طلبات حية', s.live], ['كباتن أونلاين', `${s.online}/${s.captains}`], ['منشآت', s.merchants], ['سُلّم اليوم', s.deliveredToday], ['بانتظار الموافقة', s.pending], ['تنبيهات', s.flags]]
        .map(([k, v]) => `<div class="card"><div class="stat">${v}</div><div class="mut">${k}</div></div>`).join('');
    }

    const orders = d.orders || [];
    const captains = d.captains || [];
    const merchants = d.merchants || [];

    const renderLiveOrders = () => {
      const q = $('#liveOrderSearch')?.value || '';
      const pool = q.trim() ? (d.recentOrders || orders) : orders;
      const filtered = pool.filter((o) => matchOrder(o, q));
      const lrows = $('#lrows');
      if (!lrows) return;
      lrows.innerHTML = filtered.map((o) => `<tr>
        <td dir="ltr"><b>${serialNo(o)}</b></td>
        <td><b>${esc(o.merchant?.name || '—')}</b></td>
        <td><b>📍 ${esc(o.customer_address || '—')}</b></td>
        <td>${badge(o.status)}${o.eta_minutes ? ` ~${o.eta_minutes}د` : ''}</td>
        <td>${renderOrderCaptainCell(o, captains)}</td>
        <td><button type="button" class="ghost sm" data-d="${o.id}">تفاصيل</button> ${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? `<button type="button" class="bad sm" data-x="${o.id}">إلغاء الطلب</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="mut">لا توجد طلبات مطابقة</td></tr>';
    };
    renderLiveOrders();
    const lSearch = $('#liveOrderSearch');
    if (lSearch) lSearch.oninput = renderLiveOrders;

    $('#lcaps').innerHTML = captains.map((c) => `<tr>
      <td><a href="#" data-cap="${c.id}" style="color:var(--cy);font-weight:700">🛵 ${esc(c.name)}</a></td>
      <td dir="ltr">${esc(c.phone)}</td>
      <td>${capStatusTag(c)}</td>
      <td>
        <button type="button" class="ok sm" data-add-order="${c.id}">➕ إضافة طلب</button>
        ${c.lat != null ? ` <button type="button" class="ghost sm" data-pan="${c.lat},${c.lng}">📍 تحديد</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="4" class="mut">لا يوجد كباتن</td></tr>';

    $('#lmerchs').innerHTML = merchants.map((m) => `<tr>
      <td><b>🏪 ${esc(m.business_name || m.name)}</b><div class="mut">${esc(m.name)}</div></td>
      <td dir="ltr">${esc(m.phone)}</td>
      <td>${esc(m.address || zname(m.zone_id))}</td>
      <td>${m.lat != null ? `<button type="button" class="ghost sm" data-pan="${m.lat},${m.lng}">📍 تحديد</button>` : '<span class="mut">بلا موقع</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="mut">لا توجد منشآت</td></tr>';

    // Plot all registered merchants
    const seenM = new Set();
    merchants.forEach((m) => {
      if (m.lat == null || m.lng == null) return;
      seenM.add(m.id);
      let mk = merchMarkers.get(m.id);
      if (!mk) {
        mk = L.marker([m.lat, m.lng], { icon: emoji('🏪') }).addTo(liveMap);
        merchMarkers.set(m.id, mk);
      } else {
        mk.setLatLng([m.lat, m.lng]);
      }
      mk.bindTooltip(`🏪 ${m.business_name || m.name}`);
    });
    [...merchMarkers.keys()].filter((k) => !seenM.has(k)).forEach((k) => { merchMarkers.get(k).remove(); merchMarkers.delete(k); });

    // Plot all captains with smooth movement
    const seenC = new Set();
    captains.forEach((c) => {
      if (c.lat == null || c.lng == null) return;
      seenC.add(c.id);
      const label = `🛵 ${c.name} — ${c.busy ? `مشغول #${c.active_order_id}` : c.online ? 'أونلاين متاح' : 'أوفلاين'}`;
      setCap(c.id, c.lat, c.lng, label, c.busy, c.online);
    });
    [...capMarkers.keys()].filter((k) => !seenC.has(k)).forEach((k) => { capMarkers.get(k).remove(); capMarkers.delete(k); });

    // Plot active order destinations & route polylines
    orderMarkers.forEach((m) => m.remove());
    orderMarkers.clear();
    routeLayers.forEach((r) => r.remove());
    routeLayers = [];
    orders.forEach((o) => {
      if (o.customer_lat != null && o.customer_lng != null) {
        const mk = L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') })
          .addTo(liveMap)
          .bindTooltip(`📍 طلب ${serialNo(o)}: ${o.customer_address || ''}`);
        orderMarkers.set('c' + o.id, mk);
      }
      if (o.captain?.lat != null && ['accepted', 'picked_up', 'arrived'].includes(o.status)) {
        const dest = o.status === 'accepted' ? [o.merchant?.lat, o.merchant?.lng] : [o.customer_lat, o.customer_lng];
        if (dest[0] != null) {
          makeRoute(liveMap, [o.captain.lat, o.captain.lng], dest).then((layer) => {
            if (tab === 'live' && liveMap) routeLayers.push(layer);
            else layer.remove();
          });
        }
      }
    });

    if (!liveFitted) {
      const pts = collectAllPoints(d);
      if (pts.length) { fitMapToPoints(liveMap, pts); liveFitted = true; }
    }

    refreshTimer = setTimeout(loadLive, 15000);
  }

  function setCap(id, lat, lng, label, busy, online = true) {
    let m = capMarkers.get(id);
    const icon = busy ? emoji('🛵') : online ? createPulsingDot('#22c55e') : createPulsingDot('#94a3b8');
    if (!m) {
      m = L.marker([lat, lng], { icon }).addTo(liveMap);
      capMarkers.set(id, m);
    } else {
      animateMarker(m, [lat, lng]);
      m.setIcon(icon);
    }
    if (label) m.bindTooltip(label);
  }

  connectWs((m) => {
    if (m.shortage) updateShortageBanner(m.shortage);
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
    if (m.type === 'loc' && tab === 'live' && liveMap) {
      const existing = capMarkers.get(m.captain_id);
      if (existing) animateMarker(existing, [m.lat, m.lng]);
      else setCap(m.captain_id, m.lat, m.lng, null, m.busy, true);
    } else if (['order', 'pending_user', 'flag', 'captain'].includes(m.type)) {
      if (m.type === 'pending_user') toast('طلب تسجيل جديد بانتظار الموافقة');
      if (m.type === 'flag') toast('⚠️ تنبيه أمني جديد');
      if (tab === 'live') { clearTimeout(refreshTimer); loadLive(); }
    }
  });

  go('dash');
});
