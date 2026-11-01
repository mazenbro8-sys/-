import { $, $$, esc, money, time, badge, STATUS, api, act, toast, connectWs, authScreen, header, makeMap, pickLocation, emoji, captainModal } from './shared.js';

authScreen('merchant', (user) => {
  header('المنشأة', user);
  const app = $('#app'); app.classList.remove('hide');
  app.innerHTML = `
  <div class="tabs">
    <button data-tab="order" class="active">طلب كابتن</button>
    <button data-tab="live">الطلبات الحية</button>
    <button data-tab="my">طلباتي</button>
  </div>
  <section id="orderSection" class="tab-section">
    <div class="hero" id="hero">
      <button type="button" class="hero-btn" id="heroBtn">اطلب كابتن الآن</button>
      <div class="hero-sub">اضغط لطلب كابتن في منطقتك</div>
    </div>
    <div class="card hide" id="formCard">
      <h3>طلب كابتن توصيل</h3>
      <form id="of">
        <label>اسم الزبون</label><input name="customer_name" required maxlength="60">
        <label>رقم هاتف الزبون</label><input name="customer_phone" inputmode="tel" required>
        <label>عنوان الزبون</label><input name="customer_address" required maxlength="250">
        <div class="row"><div><label>ثمن المنتج</label><input name="product_amount" type="number" min="0" value="0"></div>
        <div><label>أجرة التوصيل</label><input name="delivery_fee" type="number" min="0" value="0"></div></div>
        <label>ملاحظات (اختياري)</label><input name="notes" maxlength="300">
        <label>موقع الزبون على الخريطة (اختياري، يفعّل وقت الوصول المتوقع)</label>
        <div id="cmap" class="map" style="height:200px"></div>
        <button class="big" id="go">🛵 اطلب كابتن</button>
      </form>
    </div>
  </section>
  <section id="liveSection" class="tab-section hide">
    <div class="card">
      <h3>الطلبات الحالية</h3>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>الزبون</th><th>الحالة</th><th>الكابتن</th><th></th></tr></thead><tbody id="liveRows"></tbody></table></div>
    </div>
    <div class="card">
      <h3>التتبع المباشر</h3>
      <div id="trkinfo" class="mut">اختر طلباً نشطاً لتتبعه</div>
      <div id="tmap" class="map"></div>
    </div>
  </section>
  <section id="mySection" class="tab-section hide">
    <div class="card">
      <h3>طلباتي</h3>
      <div class="tablewrap">
        <table>
          <thead>
            <tr><th>#</th><th>الزبون</th><th>الحالة</th><th>الكابتن</th><th>وقت الطلب</th><th>وقت الإغلاق</th></tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </section>
  `;

  // Tab switching logic
  $('.tabs').onclick = (e) => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    // activate button
    $$('.tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    // show/hide sections
    $('#orderSection').classList.toggle('hide', tab !== 'order');
    $('#liveSection').classList.toggle('hide', tab !== 'live');
    $('#mySection').classList.toggle('hide', tab !== 'my');
    if (tab === 'live') setTimeout(() => tm.invalidateSize(), 50);
    if (tab === 'order') setTimeout(() => cm.invalidateSize(), 50);
  };

  const orders = new Map();
  let cpos = [null, null], cm, selected = null, capMarker, destMarkers = [];
  cm = makeMap('cmap', user.lat ? [user.lat, user.lng] : undefined, 13);
  let cMk; pickLocation(cm, (a, b) => { cpos = [a, b]; });
  const tm = makeMap('tmap', user.lat ? [user.lat, user.lng] : undefined, 14);
  if (user.lat) L.marker([user.lat, user.lng], { icon: emoji('🏪') }).addTo(tm);

  $('#heroBtn').onclick = () => {
    $('#formCard').classList.toggle('hide');
    setTimeout(() => { cm.invalidateSize(); $('#formCard').scrollIntoView({ behavior: 'smooth' }); }, 50);
  };

  $('#of').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.product_amount = Number(f.product_amount || 0);
    f.delivery_fee = Number(f.delivery_fee || 0);
    if (cpos[0] != null) { f.customer_lat = cpos[0]; f.customer_lng = cpos[1]; }
    const btn = $('#go'); btn.disabled = true;
    const o = await act(() => api('/merchant/orders', 'POST', f), 'تم إرسال الطلب، جاري البحث عن كابتن');
    btn.disabled = false;
    if (o) { e.target.reset(); upsert(o); select(o.id); }
  };

  function upsert(o) { orders.set(o.id, o); render(); if (selected === o.id) track(o); }
  const capLink = (o) => o.captain ? `<a href="#" data-cap="${o.id}" style="color:var(--or);font-weight:700">${esc(o.captain.name)}</a>` : '—';
  const LIVE = ['searching', 'offered', 'accepted', 'picked_up', 'arrived'];
  function render() {
    const list = [...orders.values()].sort((a, b) => b.id - a.id);
    $('#liveRows').innerHTML = list.filter((o) => LIVE.includes(o.status)).map((o) => `
      <tr>
        <td>${o.id}</td>
        <td>${esc(o.customer_name)}</td>
        <td>${badge(o.status)}${o.eta_minutes ? `<div class="mut">وصول خلال ~${o.eta_minutes} د</div>` : ''}</td>
        <td>${capLink(o)}</td>
        <td><button class="ghost" data-sel="${o.id}">تتبع</button>${['searching', 'offered'].includes(o.status) ? ` <button class="bad" data-cancel="${o.id}">إلغاء</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="mut">لا توجد طلبات حالية</td></tr>';
    $('#rows').innerHTML = list.map((o) => `
      <tr>
        <td>${o.id}</td>
        <td>${esc(o.customer_name)}<div class="mut">${esc(o.customer_phone)}</div></td>
        <td>${badge(o.status)}</td>
        <td>${capLink(o)}</td>
        <td>${time(o.created_at)}</td>
        <td>${o.closed_at ? time(o.closed_at) : '—'}</td>
      </tr>`).join('');
  }
  const onTbl = (e) => {
    const t = e.target, s = t.dataset.sel, c = t.dataset.cancel, cp = t.dataset.cap;
    if (cp) { e.preventDefault(); captainModal(orders.get(Number(cp))?.captain); }
    if (s) select(Number(s));
    if (c && confirm('إلغاء الطلب؟')) act(() => api(`/merchant/orders/${c}/cancel`, 'POST'), 'تم الإلغاء');
  };
  $('#rows').onclick = onTbl;
  $('#liveRows').onclick = onTbl;
  function select(id) { selected = id; track(orders.get(id)); }
  function track(o) {
    if (!o) return;
    destMarkers.forEach(m => m.remove()); destMarkers = [];
    if (o.customer_lat != null) destMarkers.push(L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(tm));
    $('#trkinfo').innerHTML = `طلب #${o.id}: ${badge(o.status)}${o.eta_minutes ? ` — الوصول خلال ~<b>${o.eta_minutes}</b> دقيقة` : ''}`;
    if (o.captain?.lat != null) moveCaptain(o.captain.lat, o.captain.lng);
    else if (capMarker) { capMarker.remove(); capMarker = null; }
  }
  function moveCaptain(lat, lng) {
    if (!capMarker) capMarker = L.marker([lat, lng], { icon: emoji('🛵') }).addTo(tm);
    else capMarker.setLatLng([lat, lng]);
    tm.panTo([lat, lng]);
  }

  const load = async () => { (await api('/merchant/orders')).forEach(o => orders.set(o.id, o)); render(); };
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
      if (selected === m.order_id) { moveCaptain(m.lat, m.lng); if (o) track(o); }
    }
  });
  setInterval(load, 60_000);
});
