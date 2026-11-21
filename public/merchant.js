import { $, $$, esc, time, badge, api, act, toast, connectWs, authScreen, header, makeMap, emoji, captainModal, animateMarker, makeRoute, fitMapToPoints, serialNo, renderInstallBanner, getNotificationsController } from './shared.js?v=panther2026v36';

authScreen('merchant', (user) => {
  header(user.business_name || user.name || 'المنشأة', user);
  document.querySelector('.panther-header .hdr-user-chip')?.remove();
  document.querySelector('.panther-header [data-install-app]')?.remove();
  const hdrActions = document.querySelector('.panther-header .hdr-right-actions');
  hdrActions?.removeAttribute('style');
  const supportHdrBtn = document.createElement('button');
  supportHdrBtn.type = 'button';
  supportHdrBtn.id = 'merchantSupportBtn';
  supportHdrBtn.className = 'sec sm merchant-support-btn';
  supportHdrBtn.disabled = true;
  supportHdrBtn.setAttribute('aria-label', 'الدعم غير متوفر حالياً');
  supportHdrBtn.title = 'الدعم غير متوفر حالياً';
  supportHdrBtn.innerHTML = '<span aria-hidden="true">📞</span><span>الدعم</span>';
  const notifBellEl = document.getElementById('notifBellBtn');
  if (hdrActions) {
    if (notifBellEl) notifBellEl.after(supportHdrBtn);
    else hdrActions.prepend(supportHdrBtn);
  }
  const app = $('#app'); app.classList.remove('hide');
  app.innerHTML = `
  ${renderInstallBanner('merchant')}
  <div class="tabs">
    <button type="button" data-tab="order" class="active">🛵 طلب كابتن</button>
    <button type="button" data-tab="live" id="liveTabBtn">📡 الطلبات الحية</button>
    <button type="button" data-tab="my">📦 طلباتي</button>
  </div>
  <section id="orderSection" class="tab-section">
    <div class="hero" id="hero">
      <button type="button" class="hero-btn" id="heroBtn">🛵 اطلب كابتن</button>
    </div>
    <div class="card dispatch-form-card hide" id="formCard">
      <form id="of">
        <input name="customer_address" id="addrInput" placeholder="اكتب عنوان التوصيل هنا..." required minlength="2" maxlength="250" autocomplete="off">
        <button class="big" id="go">🛵 اطلب كابتن</button>
      </form>
    </div>
    <div class="card merchant-summary-card" id="merchantOrderSummary">
      <div class="merchant-summary-row">
        <div class="merchant-summary-status">
          <span class="merchant-status-dot" id="merchSummaryDot" aria-hidden="true"></span>
          <span id="merchStatusTxt">لا توجد طلبات نشطة الآن</span>
        </div>
        <div class="merchant-summary-today">
          <span class="mut">طلبات اليوم:</span>
          <b id="merchTodayCount">0</b>
        </div>
      </div>
    </div>
  </section>
  <section id="liveSection" class="tab-section hide">
    <div class="live-split-grid">
      <div class="card live-orders-panel">
        <h3>📡 الطلبات الحية</h3>
        <div class="tablewrap"><table><thead><tr><th>الرقم التسلسلي</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن</th><th></th></tr></thead><tbody id="liveRows"></tbody></table></div>
      </div>
      <div class="card live-map-panel">
        <h3>🗺️ التتبع المباشر</h3>
        <div id="trkinfo" class="mut">اختر طلباً نشطاً لتتبعه على الخريطة</div>
        <div id="tmap" class="map" style="height:410px"></div>
      </div>
    </div>
  </section>
  <section id="mySection" class="tab-section hide">
    <div class="card">
      <h3>📦 سجل طلباتي</h3>
      <div class="tablewrap">
        <table>
          <thead>
            <tr><th>الرقم التسلسلي</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن</th><th>وقت الطلب</th><th>وقت الإغلاق</th><th></th></tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </section>
  `;

  const orders = new Map();
  let selected = null, capMarker = null, destMarkers = [];
  let routeLayer = null, lastRouteTime = 0, routeSeq = 0;

  const homeCenter = user.lat != null && user.lng != null ? [user.lat, user.lng] : undefined;
  const tm = makeMap('tmap', homeCenter, 14);
  if (homeCenter) L.marker(homeCenter, { icon: emoji('🏪') }).addTo(tm).bindTooltip(`🏪 ${esc(user.business_name || user.name || 'المنشأة')}`);

  function switchTab(tab) {
    $$('.tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    $('#orderSection').classList.toggle('hide', tab !== 'order');
    $('#liveSection').classList.toggle('hide', tab !== 'live');
    $('#mySection').classList.toggle('hide', tab !== 'my');
    if (tab === 'order' && !$('#addrInput').value.trim()) {
      $('#formCard').classList.add('hide');
      $('#hero').classList.remove('hide');
    }
    if (tab === 'live') {
      setTimeout(() => {
        tm.invalidateSize();
        if (selected && orders.has(selected)) track(orders.get(selected));
      }, 60);
    }
  }

  $('.tabs').onclick = (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  };

  $('#heroBtn').onclick = () => {
    const fc = $('#formCard');
    const inp = $('#addrInput');
    if (!fc.classList.contains('hide') && inp.value.trim().length >= 2) {
      $('#of').requestSubmit();
      return;
    }
    $('#hero').classList.add('hide');
    fc.classList.remove('hide');
    setTimeout(() => inp.focus(), 40);
  };

  $('#of').onsubmit = async (e) => {
    e.preventDefault();
    const customer_address = $('#addrInput').value.trim();
    if (!customer_address) return;
    const btn = $('#go'); btn.disabled = true;
    const o = await act(() => api('/merchant/orders', 'POST', { customer_address }), 'تم إرسال الطلب، جاري البحث عن كابتن');
    btn.disabled = false;
    if (o) {
      e.target.reset();
      $('#formCard').classList.add('hide');
      $('#hero').classList.remove('hide');
      upsert(o);
      switchTab('live');
      select(o.id);
    }
  };

  const LIVE = ['searching', 'offered', 'accepted', 'picked_up', 'arrived'];
  function upsert(o) {
    const prev = orders.get(o.id);
    if (prev?.status_text && ['searching', 'offered'].includes(o.status) && !o.captain) {
      o.status_text = o.status_text || prev.status_text;
    }
    orders.set(o.id, o);
    render();
    if (selected === o.id) track(o);
  }
  const capLink = (o) => o.captain
    ? `<a href="#" data-cap="${o.id}">🛵 ${esc(o.captain.name)} • 📞</a>`
    : `<span class="mut">${o.status_text ? `🔄 ${esc(o.status_text)}` : '— جاري التعيين —'}</span>`;

  function render() {
    const list = [...orders.values()].sort((a, b) => b.id - a.id);
    const liveList = list.filter((o) => LIVE.includes(o.status));
    const liveBtn = $('#liveTabBtn');
    if (liveBtn) liveBtn.textContent = liveList.length ? `📡 الطلبات الحية (${liveList.length})` : '📡 الطلبات الحية';

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const todayCount = list.filter((o) => Number(o.created_at) >= todayMs).length;
    const summaryCard = $('#merchantOrderSummary');
    const statusTxt = $('#merchStatusTxt');
    const todayCountEl = $('#merchTodayCount');
    const statusDot = $('#merchSummaryDot');
    if (summaryCard && statusTxt && todayCountEl) {
      todayCountEl.textContent = String(todayCount);
      if (liveList.length === 0) {
        statusTxt.textContent = 'لا توجد طلبات نشطة الآن';
        statusDot?.classList.remove('is-live');
      } else {
        statusTxt.textContent = `يوجد ${liveList.length} طلب نشط حالياً`;
        statusDot?.classList.add('is-live');
      }
    }

    const renderOrderCard = (o, isLiveTab) => `
      <tr class="merchant-order-card ${isLiveTab && selected === o.id ? 'is-selected-row' : ''}">
        <td colspan="${isLiveTab ? 5 : 7}" class="merchant-order-card-cell">
          <div class="merchant-order-card-head">
            <div class="merchant-order-serial" dir="ltr"><b>${serialNo(o)}</b></div>
            <div class="merchant-order-status">
              ${badge(o.status)}
              ${isLiveTab && o.delay_until && o.delay_until > Date.now()
                ? `<div class="mut">⏱️ مؤجل (${esc(Math.max(1, Math.ceil((o.delay_until - Date.now()) / 60000)))} د)</div>`
                : isLiveTab && o.eta_minutes
                  ? `<div class="mut">وصول خلال ~${esc(Number(o.eta_minutes) || 0)} د</div>`
                  : ''}
            </div>
          </div>
          <div class="merchant-order-addr">📍 ${esc(o.customer_address || '—')}</div>
          ${!isLiveTab ? `<div class="merchant-order-times mut">الطلب: ${time(o.created_at)}${o.closed_at ? ` • الإغلاق: ${time(o.closed_at)}` : ''}</div>` : ''}
          <div class="merchant-order-meta">
            <div class="merchant-order-cap">${capLink(o)}</div>
            <div class="merchant-order-inline-actions">
              ${isLiveTab
                ? `<button type="button" class="ghost sm" data-sel="${o.id}">🗺️ تتبع حي</button>`
                : LIVE.includes(o.status)
                  ? `<button type="button" class="ghost sm" data-sel="${o.id}">🗺️ تتبع</button>`
                  : ''}
              ${['searching', 'offered'].includes(o.status) ? `<button type="button" class="bad sm" data-cancel="${o.id}">✕ إلغاء</button>` : ''}
            </div>
          </div>
          ${o.status === 'accepted' ? `<button type="button" class="bad merchant-cancel-order-btn" data-cancel-accepted="${o.id}">إلغاء الطلب</button>` : ''}
        </td>
      </tr>`;

    $('#liveRows').innerHTML = liveList.map((o) => renderOrderCard(o, true)).join('')
      || '<tr><td colspan="5" class="mut merchant-orders-empty">لا توجد طلبات حية حالياً</td></tr>';

    $('#rows').innerHTML = list.map((o) => renderOrderCard(o, false)).join('')
      || '<tr><td colspan="7" class="mut merchant-orders-empty">لا توجد طلبات سابقة</td></tr>';
  }

  const CANCEL_ACCEPTED_REASONS = [
    { code: 'unavailable', label: 'المنتج غير متوفر' },
    { code: 'customer_cancelled', label: 'الزبون ألغى الطلب' },
    { code: 'order_error', label: 'خطأ في الطلب' },
    { code: 'captain_late', label: 'تأخر الكابتن' },
    { code: 'other', label: 'سبب آخر' },
  ];

  const cancelDlg = document.createElement('dialog');
  cancelDlg.id = 'merchantCancelAcceptedDialog';
  cancelDlg.className = 'merchant-cancel-dialog';
  cancelDlg.setAttribute('aria-labelledby', 'merchantCancelAcceptedTitle');
  cancelDlg.innerHTML = `
    <form id="merchantCancelForm" class="merchant-cancel-body" novalidate>
      <div class="merchant-cancel-head">
        <h3 id="merchantCancelAcceptedTitle">إلغاء الطلب المقبول</h3>
        <div class="mut merchant-cancel-order-ref" id="cancelAcceptedOrderRef"></div>
      </div>
      <fieldset class="cancel-reason-fieldset">
        <legend class="cancel-reason-legend">اختر سبب إلغاء الطلب</legend>
        <div class="cancel-reason-list">
          ${CANCEL_ACCEPTED_REASONS.map((r) => `
            <div class="cancel-reason-option">
              <input type="radio" id="cancelReason_${r.code}" name="reason_code" value="${r.code}">
              <label for="cancelReason_${r.code}" class="cancel-reason-label">${esc(r.label)}</label>
            </div>
          `).join('')}
        </div>
      </fieldset>
      <div id="cancelReasonOtherWrap" class="cancel-reason-other hide">
        <label for="cancelReasonOtherInput" class="cancel-reason-other-label">سبب الإلغاء (مطلوب، بحد أقصى 200 حرف)</label>
        <textarea id="cancelReasonOtherInput" name="reason_text" rows="2" maxlength="200" placeholder="اكتب سبب الإلغاء هنا..." aria-describedby="cancelReasonCounter cancelReasonError"></textarea>
        <div class="cancel-reason-meta">
          <span id="cancelReasonError" class="cancel-reason-error" aria-live="polite"></span>
          <span id="cancelReasonCounter" class="cancel-reason-counter mut" dir="ltr">0 / 200</span>
        </div>
      </div>
      <div class="merchant-cancel-actions">
        <button type="submit" class="bad" id="merchantCancelConfirmBtn" disabled>تأكيد الإلغاء</button>
        <button type="button" class="sec" id="merchantCancelBackBtn">رجوع</button>
      </div>
    </form>`;
  document.body.appendChild(cancelDlg);

  let cancelTargetOrderId = null;
  let cancelSubmitting = false;
  let otherTouched = false;
  const cancelForm = cancelDlg.querySelector('#merchantCancelForm');
  const cancelOtherWrap = cancelDlg.querySelector('#cancelReasonOtherWrap');
  const cancelOtherInput = cancelDlg.querySelector('#cancelReasonOtherInput');
  const cancelCounterEl = cancelDlg.querySelector('#cancelReasonCounter');
  const cancelErrorEl = cancelDlg.querySelector('#cancelReasonError');
  const cancelConfirmBtn = cancelDlg.querySelector('#merchantCancelConfirmBtn');
  const cancelBackBtn = cancelDlg.querySelector('#merchantCancelBackBtn');
  const cancelOrderRefEl = cancelDlg.querySelector('#cancelAcceptedOrderRef');

  function syncCancelDialogState() {
    const selectedRadio = cancelForm.querySelector('input[name="reason_code"]:checked');
    const code = selectedRadio?.value || '';
    const isOther = code === 'other';
    cancelOtherWrap.classList.toggle('hide', !isOther);
    cancelOtherInput.required = isOther;

    const rawText = cancelOtherInput.value || '';
    const rawLen = Array.from(rawText).length;
    const trimmed = rawText.trim();
    const trimmedLen = Array.from(trimmed).length;
    cancelCounterEl.textContent = `${rawLen} / 200`;
    cancelCounterEl.classList.toggle('is-limit', rawLen >= 180);

    let errMsg = '';
    let valid = Boolean(code);
    if (isOther) {
      if (trimmedLen === 0) {
        valid = false;
        if (otherTouched) errMsg = 'يرجى كتابة سبب الإلغاء';
      } else if (trimmedLen > 200) {
        valid = false;
        errMsg = 'يجب ألا يتجاوز سبب الإلغاء 200 حرف';
      }
    }
    cancelErrorEl.textContent = errMsg;
    cancelOtherInput.setAttribute('aria-invalid', errMsg ? 'true' : 'false');
    cancelConfirmBtn.disabled = cancelSubmitting || !valid;
  }

  function openCancelAcceptedModal(orderId) {
    const o = orders.get(orderId);
    if (!o || o.status !== 'accepted') return;
    cancelTargetOrderId = o.id;
    cancelSubmitting = false;
    otherTouched = false;
    cancelForm.reset();
    cancelConfirmBtn.textContent = 'تأكيد الإلغاء';
    cancelOrderRefEl.innerHTML = `طلب <b dir="ltr">${esc(serialNo(o))}</b> — ${esc(o.customer_address || '—')}`;
    syncCancelDialogState();
    if (!cancelDlg.open) cancelDlg.showModal();
  }

  cancelForm.addEventListener('change', (e) => {
    if (e.target.name === 'reason_code') {
      syncCancelDialogState();
      if (e.target.value === 'other') cancelOtherInput.focus();
    }
  });
  cancelOtherInput.addEventListener('input', () => {
    otherTouched = true;
    syncCancelDialogState();
  });
  cancelOtherInput.addEventListener('blur', () => {
    if (cancelForm.querySelector('input[name="reason_code"]:checked')?.value === 'other') {
      otherTouched = true;
      syncCancelDialogState();
    }
  });
  cancelBackBtn.addEventListener('click', () => {
    if (!cancelSubmitting && cancelDlg.open) cancelDlg.close();
  });
  cancelDlg.addEventListener('click', (e) => {
    if (e.target === cancelDlg && !cancelSubmitting) cancelDlg.close();
  });
  cancelDlg.addEventListener('close', () => {
    cancelTargetOrderId = null;
    cancelSubmitting = false;
  });
  cancelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cancelSubmitting || cancelTargetOrderId == null) return;
    const code = cancelForm.querySelector('input[name="reason_code"]:checked')?.value || '';
    if (code === 'other') otherTouched = true;
    syncCancelDialogState();
    if (cancelConfirmBtn.disabled) return;

    const payload = { reason_code: code };
    if (code === 'other') payload.reason_text = cancelOtherInput.value.trim();

    cancelSubmitting = true;
    cancelConfirmBtn.disabled = true;
    cancelConfirmBtn.textContent = 'جاري الإلغاء...';
    cancelBackBtn.disabled = true;
    try {
      const targetId = cancelTargetOrderId;
      const res = await act(() => api(`/merchant/orders/${targetId}/cancel-accepted`, 'POST', payload), 'تم إلغاء الطلب وإبلاغ الكابتن');
      if (res) {
        cancelSubmitting = false;
        if (cancelDlg.open) cancelDlg.close();
        await load();
      } else {
        await load();
      }
    } finally {
      cancelSubmitting = false;
      cancelBackBtn.disabled = false;
      cancelConfirmBtn.textContent = 'تأكيد الإلغاء';
      syncCancelDialogState();
    }
  });

  const onTbl = (e) => {
    const capEl = e.target.closest('[data-cap]');
    if (capEl) { e.preventDefault(); captainModal(orders.get(Number(capEl.dataset.cap))?.captain); return; }
    const selEl = e.target.closest('[data-sel]');
    if (selEl) { switchTab('live'); select(Number(selEl.dataset.sel)); return; }
    const canEl = e.target.closest('[data-cancel]');
    if (canEl && confirm('إلغاء الطلب؟')) act(() => api(`/merchant/orders/${canEl.dataset.cancel}/cancel`, 'POST'), 'تم الإلغاء');
    const canAccEl = e.target.closest('[data-cancel-accepted]');
    if (canAccEl) openCancelAcceptedModal(Number(canAccEl.dataset.cancelAccepted));
  };
  $('#rows').onclick = onTbl;
  $('#liveRows').onclick = onTbl;

  function select(id) {
    selected = id;
    track(orders.get(id));
  }

  function track(o) {
    if (!o) return;
    destMarkers.forEach((m) => m.remove()); destMarkers = [];
    const seq = ++routeSeq;
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    const pts = [];
    if (o.merchant?.lat != null) {
      destMarkers.push(L.marker([o.merchant.lat, o.merchant.lng], { icon: emoji('🏪') }).addTo(tm).bindTooltip(`🏪 ${esc(o.merchant.name || user.business_name || 'المنشأة')}`));
      pts.push([o.merchant.lat, o.merchant.lng]);
    }
    if (o.customer_lat != null) {
      destMarkers.push(L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(tm).bindTooltip(`📍 ${esc(o.customer_address || '')}`));
      pts.push([o.customer_lat, o.customer_lng]);
    }
    $('#trkinfo').innerHTML = `طلب <b dir="ltr">${esc(serialNo(o))}</b> (📍 ${esc(o.customer_address || '—')}): ${badge(o.status)}${o.eta_minutes ? ` — الوصول خلال ~<b>${esc(Number(o.eta_minutes) || 0)}</b> دقيقة` : ''}`;
    if (o.captain?.lat != null) {
      moveCaptain(o.captain.lat, o.captain.lng, o.captain.name, false);
      pts.push([o.captain.lat, o.captain.lng]);
      const dest = o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
      if (dest?.lat != null) {
        lastRouteTime = Date.now();
        makeRoute(tm, [o.captain.lat, o.captain.lng], [dest.lat, dest.lng]).then((layer) => {
          if (seq !== routeSeq || selected !== o.id) {
            try { layer.remove(); } catch {}
            return;
          }
          if (routeLayer) { try { routeLayer.remove(); } catch {} }
          routeLayer = layer;
        });
      }
    } else if (capMarker) {
      capMarker.remove(); capMarker = null;
    }
    if (pts.length) fitMapToPoints(tm, pts);
  }

  function moveCaptain(lat, lng, name = 'الكابتن', pan = true) {
    const safeCapTip = `🛵 ${esc(name || 'الكابتن')}`;
    if (!capMarker) capMarker = L.marker([lat, lng], { icon: emoji('🛵') }).addTo(tm).bindTooltip(safeCapTip);
    else {
      animateMarker(capMarker, [lat, lng]);
      capMarker.setTooltipContent?.(safeCapTip) || capMarker.bindTooltip(safeCapTip);
    }
    if (pan) tm.panTo([lat, lng]);
  }

  let supportPhone = null;
  const supportBtn = $('#merchantSupportBtn');
  const syncSupportBtn = (phoneVal) => {
    supportPhone = phoneVal && String(phoneVal).trim() ? String(phoneVal).trim() : null;
    if (!supportBtn) return;
    if (supportPhone) {
      const telUri = `tel:${supportPhone.replace(/\s+/g, '')}`;
      supportBtn.disabled = false;
      supportBtn.innerHTML = '<span aria-hidden="true">📞</span><span>الدعم</span>';
      supportBtn.title = '📞 اتصل بالدعم';
      supportBtn.setAttribute('aria-label', '📞 اتصل بالدعم');
      supportBtn.dataset.tel = telUri;
      supportBtn.setAttribute('href', telUri);
    } else {
      supportBtn.disabled = true;
      supportBtn.innerHTML = '<span aria-hidden="true">📞</span><span>الدعم</span>';
      supportBtn.title = 'الدعم غير متوفر حالياً';
      supportBtn.setAttribute('aria-label', 'الدعم غير متوفر حالياً');
      supportBtn.dataset.tel = '';
      supportBtn.removeAttribute('href');
    }
  };
  supportBtn?.addEventListener('click', () => {
    if (supportBtn.disabled || !supportPhone) return;
    const telUri = `tel:${supportPhone.replace(/\s+/g, '')}`;
    window.location.href = telUri;
  });
  const loadSupport = async () => {
    try {
      const s = await api('/merchant/support');
      syncSupportBtn(s?.support_phone);
    } catch {
      syncSupportBtn(null);
    }
  };

  const load = async () => {
    const list = await api('/merchant/orders');
    list.forEach((o) => orders.set(o.id, o));
    render();
    if (!selected) {
      const firstLive = list.find((o) => LIVE.includes(o.status));
      if (firstLive) selected = firstLive.id;
    }
  };
  load();
  loadSupport();

  connectWs((m) => {
    if (m.type === 'notification') {
      getNotificationsController()?.handleWsNotification(m);
    } else if (m.type === 'order') {
      const prev = orders.get(m.order.id);
      upsert(m.order);
      if (prev && prev.status !== m.order.status && m.order.status === 'accepted') toast(`الكابتن ${m.order.captain?.name} قبل الطلب #${m.order.id}`);
      if (m.order.status === 'expired') toast(`لم يتوفر كابتن للطلب #${m.order.id}`);
    } else if (m.type === 'order_update') {
      const o = orders.get(m.order_id);
      const txt = m.status_text || m.message || 'جاري البحث عن كابتن آخر...';
      if (o) {
        o.status_text = txt;
        render();
        if (selected === o.id) track(o);
      }
      toast(txt);
    } else if (m.type === 'admin_notice' && m.message) {
      toast(m.message, 7000);
    } else if (m.type === 'loc') {
      const o = orders.get(m.order_id);
      if (o) { o.captain = { ...o.captain, lat: m.lat, lng: m.lng }; o.eta_minutes = m.eta_minutes; render(); }
      if (selected === m.order_id) {
        moveCaptain(m.lat, m.lng, o?.captain?.name || 'الكابتن');
        if (o && Date.now() - lastRouteTime > 30000) {
          if (routeLayer) { routeLayer.remove(); routeLayer = null; }
          const dest = o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
          if (dest?.lat != null) {
            lastRouteTime = Date.now();
            const seq = ++routeSeq;
            makeRoute(tm, [m.lat, m.lng], [dest.lat, dest.lng]).then((layer) => {
              if (seq !== routeSeq || selected !== o.id) {
                try { layer.remove(); } catch {}
                return;
              }
              if (routeLayer) { try { routeLayer.remove(); } catch {} }
              routeLayer = layer;
            });
          }
        }
      }
    }
  });
  setInterval(load, 60_000);
});
