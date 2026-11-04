import { $, $$, esc, time, badge, api, act, toast, connectWs, authScreen, header, makeMap, emoji, captainModal, animateMarker, makeRoute, fitMapToPoints, serialNo } from './shared.js?v=8';

authScreen('merchant', (user) => {
  header('المنشأة', user);
  const app = $('#app'); app.classList.remove('hide');
  app.innerHTML = `
  <div class="tabs">
    <button type="button" data-tab="order" class="active">🛵 طلب كابتن</button>
    <button type="button" data-tab="live" id="liveTabBtn">📡 الطلبات الحية</button>
    <button type="button" data-tab="my">📦 طلباتي</button>
  </div>
  <section id="orderSection" class="tab-section">
    <div class="hero" id="hero">
      <button type="button" class="hero-btn" id="heroBtn">اطلب كابتن الآن</button>
      <div class="hero-sub">اضغط لطلب كابتن توصيل وتحديد عنوان التوصيل</div>
    </div>
    <div class="card hide" id="formCard">
      <h3>🛵 طلب كابتن توصيل</h3>
      <form id="of">
        <label>عنوان التوصيل (مكان التوصيل)</label>
        <input name="customer_address" id="addrInput" placeholder="اكتب عنوان التوصيل هنا..." required minlength="2" maxlength="250" autocomplete="off">
        <button class="big" id="go">🛵 اطلب كابتن</button>
      </form>
    </div>
  </section>
  <section id="liveSection" class="tab-section hide">
    <div class="card">
      <h3>الطلبات الحية الجارية</h3>
      <div class="tablewrap"><table><thead><tr><th>الرقم التسلسلي</th><th>عنوان التوصيل</th><th>الحالة</th><th>الكابتن</th><th></th></tr></thead><tbody id="liveRows"></tbody></table></div>
    </div>
    <div class="card">
      <h3>🗺️ التتبع المباشر على الخريطة</h3>
      <div id="trkinfo" class="mut">اختر طلباً نشطاً لتتبعه مباشرة</div>
      <div id="tmap" class="map" style="height:400px"></div>
    </div>
  </section>
  <section id="mySection" class="tab-section hide">
    <div class="card">
      <h3>سجل طلباتي</h3>
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
  let routeLayer = null, lastRouteTime = 0;

  const homeCenter = user.lat != null && user.lng != null ? [user.lat, user.lng] : undefined;
  const tm = makeMap('tmap', homeCenter, 14);
  if (homeCenter) L.marker(homeCenter, { icon: emoji('🏪') }).addTo(tm).bindTooltip(`🏪 ${user.business_name || user.name}`);

  function switchTab(tab) {
    $$('.tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    $('#orderSection').classList.toggle('hide', tab !== 'order');
    $('#liveSection').classList.toggle('hide', tab !== 'live');
    $('#mySection').classList.toggle('hide', tab !== 'my');
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
    fc.classList.remove('hide');
    setTimeout(() => { inp.focus(); fc.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
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
      upsert(o);
      switchTab('live');
      select(o.id);
    }
  };

  const LIVE = ['searching', 'offered', 'accepted', 'picked_up', 'arrived'];
  function upsert(o) { orders.set(o.id, o); render(); if (selected === o.id) track(o); }
  const capLink = (o) => o.captain ? `<a href="#" data-cap="${o.id}" style="color:var(--or);font-weight:700">🛵 ${esc(o.captain.name)}</a>` : '—';

  function render() {
    const list = [...orders.values()].sort((a, b) => b.id - a.id);
    const liveList = list.filter((o) => LIVE.includes(o.status));
    const liveBtn = $('#liveTabBtn');
    if (liveBtn) liveBtn.textContent = liveList.length ? `📡 الطلبات الحية (${liveList.length})` : '📡 الطلبات الحية';

    $('#liveRows').innerHTML = liveList.map((o) => `
      <tr>
        <td dir="ltr"><b>${serialNo(o)}</b></td>
        <td><b>📍 ${esc(o.customer_address || '—')}</b></td>
        <td>${badge(o.status)}${o.eta_minutes ? `<div class="mut">وصول خلال ~${o.eta_minutes} د</div>` : ''}</td>
        <td>${capLink(o)}</td>
        <td>
          <button type="button" class="ghost sm" data-sel="${o.id}">🗺️ تتبع</button>
          ${['searching', 'offered'].includes(o.status) ? ` <button type="button" class="bad sm" data-cancel="${o.id}">إلغاء</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="mut">لا توجد طلبات حية حالياً</td></tr>';

    $('#rows').innerHTML = list.map((o) => `
      <tr>
        <td dir="ltr"><b>${serialNo(o)}</b></td>
        <td><b>📍 ${esc(o.customer_address || '—')}</b></td>
        <td>${badge(o.status)}</td>
        <td>${capLink(o)}</td>
        <td>${time(o.created_at)}</td>
        <td>${o.closed_at ? time(o.closed_at) : '—'}</td>
        <td>${LIVE.includes(o.status) ? `<button type="button" class="ghost sm" data-sel="${o.id}">🗺️ تتبع</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد طلبات سابقة</td></tr>';
  }

  const onTbl = (e) => {
    const capEl = e.target.closest('[data-cap]');
    if (capEl) { e.preventDefault(); captainModal(orders.get(Number(capEl.dataset.cap))?.captain); return; }
    const selEl = e.target.closest('[data-sel]');
    if (selEl) { switchTab('live'); select(Number(selEl.dataset.sel)); return; }
    const canEl = e.target.closest('[data-cancel]');
    if (canEl && confirm('إلغاء الطلب؟')) act(() => api(`/merchant/orders/${canEl.dataset.cancel}/cancel`, 'POST'), 'تم الإلغاء');
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
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    const pts = [];
    if (o.merchant?.lat != null) {
      destMarkers.push(L.marker([o.merchant.lat, o.merchant.lng], { icon: emoji('🏪') }).addTo(tm).bindTooltip(`🏪 ${o.merchant.name || user.business_name || 'المنشأة'}`));
      pts.push([o.merchant.lat, o.merchant.lng]);
    }
    if (o.customer_lat != null) {
      destMarkers.push(L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(tm).bindTooltip(`📍 ${o.customer_address || ''}`));
      pts.push([o.customer_lat, o.customer_lng]);
    }
    $('#trkinfo').innerHTML = `طلب <b dir="ltr">${serialNo(o)}</b> (📍 ${esc(o.customer_address || '—')}): ${badge(o.status)}${o.eta_minutes ? ` — الوصول خلال ~<b>${o.eta_minutes}</b> دقيقة` : ''}`;
    if (o.captain?.lat != null) {
      moveCaptain(o.captain.lat, o.captain.lng, o.captain.name, false);
      pts.push([o.captain.lat, o.captain.lng]);
      const dest = o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
      if (dest?.lat != null) {
        lastRouteTime = Date.now();
        makeRoute(tm, [o.captain.lat, o.captain.lng], [dest.lat, dest.lng]).then((layer) => { routeLayer = layer; });
      }
    } else if (capMarker) {
      capMarker.remove(); capMarker = null;
    }
    if (pts.length) fitMapToPoints(tm, pts);
  }

  function moveCaptain(lat, lng, name = 'الكابتن', pan = true) {
    if (!capMarker) capMarker = L.marker([lat, lng], { icon: emoji('🛵') }).addTo(tm).bindTooltip(`🛵 ${name}`);
    else animateMarker(capMarker, [lat, lng]);
    if (pan) tm.panTo([lat, lng]);
  }

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

  connectWs((m) => {
    if (m.type === 'order') {
      const prev = orders.get(m.order.id);
      upsert(m.order);
      if (prev && prev.status !== m.order.status && m.order.status === 'accepted') toast(`الكابتن ${m.order.captain?.name} قبل الطلب #${m.order.id}`);
      if (m.order.status === 'expired') toast(`لم يتوفر كابتن للطلب #${m.order.id}`);
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
            makeRoute(tm, [m.lat, m.lng], [dest.lat, dest.lng]).then((layer) => { routeLayer = layer; });
          }
        }
      }
    }
  });
  setInterval(load, 60_000);
});
