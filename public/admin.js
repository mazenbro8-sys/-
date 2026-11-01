import { $, $$, esc, money, time, badge, STATUS, api, act, toast, connectWs, authScreen, header, makeMap, pickLocation, emoji, DAMASCUS, captainModal } from './shared.js';

authScreen('admin', (user) => {
  header('الإدارة', user);
  const app = $('#app'); app.classList.remove('hide');
  const TABS = { dash: '📊 لوحة التحكم', live: '📡 غرفة العمليات', users: '🏪 المنشآت والكباتن', orders: '📦 الطلبات', settle: '💰 الخزينة', flags: '⚠️ التنبيهات الأمنية', settings: '⚙️ المناطق والإعدادات' };
  app.innerHTML = `<aside class="sb"><div class="logo"><i>🛵</i>مشوار</div>
    <nav class="nav tabs">${Object.entries(TABS).map(([k, v]) => `<button data-t="${k}">${v}</button>`).join('')}</nav>
    <div class="sbfoot"><div class="av">${esc((user.name || 'A').slice(0, 1))}</div><b>${esc(user.name || 'المدير')}</b><button id="lo2">خروج</button></div></aside>
    <section class="main"><div class="topbar2"><h2 id="ptitle"></h2><div class="clock"><b id="clk"></b><span id="dt"></span></div></div><div id="view" class="view"></div></section>`;
  $('#lo2').onclick = () => $('#lo').click();
  const tick = () => { const d = new Date(); $('#clk').textContent = d.toLocaleTimeString('en-GB'); $('#dt').textContent = d.toLocaleDateString('ar-SY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); };
  tick(); setInterval(tick, 1000);
  const feed = [];
  let tab = 'dash', zones = [], liveMap, capMarkers = new Map(), refreshTimer;
  const zname = (id) => zones.find((z) => z.id === id)?.name || '—';

  $('.tabs').onclick = (e) => { if (e.target.dataset.t) go(e.target.dataset.t); };
  async function go(t) {
    tab = t; clearTimeout(refreshTimer); liveMap = null; capMarkers.clear();
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('#ptitle').textContent = TABS[t].replace(/^\S+\s/, '');
    zones = await api('/admin/zones');
    await views[t]();
  }
  const view = () => $('#view');

  const views = {
    async dash() {
      const s = await api('/admin/stats');
      const cards = [['🗺️', zones.length, 'المناطق'], ['🏪', s.merchants, 'المنشآت'], ['🛵', `${s.online}/${s.captains}`, 'الكباتن أونلاين'], ['📦', s.deliveredToday, 'طلبات اليوم المسلّمة']];
      view().innerHTML = `<div class="stats4">${cards.map(([i, n, l]) => `<div class="card sc"><div class="ic">${i}</div><div><div class="n">${n}</div><div class="mut">${l}</div></div></div>`).join('')}</div>
        <div class="dgrid"><div class="card radar"><span>الخريطة الحية للكباتن قريباً<br><small>تابعها الآن من «غرفة العمليات»</small></span></div>
        <div class="card" style="padding:16px"><h3 style="margin-top:0">آخر النشاطات</h3><ul class="feed">${feed.slice(0, 5).map((f) => `<li>${esc(f.t)}<small>${f.at}</small></li>`).join('') || '<li class="mut">لا نشاط بعد</li>'}</ul></div></div>`;
    },
    async live() {
      const s = await api('/admin/stats');
      view().innerHTML = `<div class="stats">
        ${[['طلبات حية', s.live], ['كباتن أونلاين', `${s.online}/${s.captains}`], ['منشآت', s.merchants], ['سُلّم اليوم', s.deliveredToday], ['بانتظار الموافقة', s.pending], ['تنبيهات', s.flags]].map(([k, v]) => `<div class="card"><div class="stat">${v}</div><div class="mut">${k}</div></div>`).join('')}
        </div>
        <div class="card"><h3>الخريطة الحية</h3><div id="lmap" class="map" style="height:380px"></div></div>
        <div class="card"><h3>الطلبات الحية</h3><div class="tablewrap"><table><thead><tr><th>#</th><th>المنشأة</th><th>الزبون</th><th>الحالة</th><th>الكابتن</th><th></th></tr></thead><tbody id="lrows"></tbody></table></div></div>`;
      liveMap = makeMap('lmap', DAMASCUS, 12);
      await loadLive();
    },
    async users() {
      const rows = await api('/admin/users');
      view().innerHTML = `<div class="card"><div class="row"><h3 style="flex:3;margin:0">إضافة حساب</h3><button id="addb">➕ منشأة / كابتن جديد</button></div><form id="nu" class="hide">
        <div class="row"><div><label>النوع</label><select name="role" id="nrole"><option value="merchant">🏪 منشأة</option><option value="captain">🛵 كابتن</option></select></div>
        <div><label>المنطقة</label><select name="zone_id">${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div></div>
        <div class="row"><div><label>الاسم</label><input name="name" required minlength="2"></div><div><label>رقم الهاتف</label><input name="phone" inputmode="tel" required></div></div>
        <label>كلمة المرور (8 أحرف على الأقل، حروف وأرقام)</label><input name="password" type="text" minlength="8" required autocomplete="off">
        <div id="mfields"><label>اسم المنشأة</label><input name="business_name"><label>العنوان</label><input name="address"><label>موقع المنشأة (اضغط على الخريطة)</label><div id="nmap" class="map"></div></div>
        <button class="big ok">إنشاء الحساب</button></form></div><div class="card"><div class="tablewrap"><table><thead><tr><th>النوع</th><th>الاسم</th><th>الهاتف</th><th>المنطقة</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${u.role === 'merchant' ? '🏪 منشأة' : '🛵 كابتن'}</td><td>${esc(u.business_name || u.name)}<div class="mut">${esc(u.role === 'merchant' ? u.name + ' — ' + (u.address || '') : '')}</div></td>
        <td>${esc(u.phone)}</td>
        <td><select data-zone="${u.id}">${zones.map((z) => `<option value="${z.id}" ${z.id === u.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></td>
        <td>${badge(u.status)}${u.online ? ' 🟢' : ''}</td>
        <td>${u.status !== 'active' ? `<button class="ok" data-st="active" data-id="${u.id}">تفعيل</button>` : ''}
        ${u.status !== 'suspended' ? `<button class="bad" data-st="suspended" data-id="${u.id}">إيقاف</button>` : ''}
        <button class="sec" data-pw="${u.id}">كلمة مرور</button></td></tr>`).join('')}</tbody></table></div></div>`;
      let npos = [null, null], nmap;
      $('#addb').onclick = () => { $('#nu').classList.toggle('hide'); if (!nmap && !$('#nu').classList.contains('hide')) { nmap = makeMap('nmap', DAMASCUS, 12); pickLocation(nmap, (a, b) => (npos = [a, b])); } setTimeout(() => nmap?.invalidateSize(), 50); };
      $('#nrole').onchange = (e) => $('#mfields').classList.toggle('hide', e.target.value !== 'merchant');
      $('#nu').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target)); f.zone_id = Number(f.zone_id);
        if (f.role === 'merchant') { if (npos[0] == null) return toast('حدّد موقع المنشأة على الخريطة'); [f.lat, f.lng] = npos; } else { delete f.business_name; delete f.address; }
        if (await act(() => api('/admin/users', 'POST', f), 'تم إنشاء الحساب')) views.users();
      };
      view().onclick = async (e) => {
        const d = e.target.dataset;
        if (d.st) { if (d.st === 'suspended' && !confirm('إيقاف الحساب فوراً؟')) return; await act(() => api(`/admin/users/${d.id}`, 'PATCH', { status: d.st }), 'تم'); views.users(); }
        if (d.pw) { const p = prompt('كلمة مرور جديدة (8 أحرف على الأقل، حروف وأرقام)'); if (p) act(() => api(`/admin/users/${d.pw}/reset-password`, 'POST', { password: p }), 'تم التغيير'); }
      };
      view().onchange = (e) => { if (e.target.dataset.zone) act(() => api(`/admin/users/${e.target.dataset.zone}`, 'PATCH', { zone_id: Number(e.target.value) }), 'تم نقل المنطقة'); };
    },
    async orders() {
      const rows = await api('/admin/orders');
      view().innerHTML = `<div class="card"><div class="tablewrap"><table><thead><tr><th>#</th><th>المنشأة</th><th>الزبون</th><th>المبلغ</th><th>الحالة</th><th>الكابتن</th><th>الوقت</th><th></th></tr></thead><tbody>
      ${rows.map((o) => `<tr><td>${o.id}</td><td>${esc(o.merchant.name)}</td><td>${esc(o.customer_name)}</td><td>${money(o.product_amount)}<div class="mut">توصيل ${money(o.delivery_fee)}</div></td><td>${badge(o.status)}</td><td>${o.captain ? `<a href="#" data-cap="${o.id}" style="color:var(--cy);font-weight:700">${esc(o.captain.name)}</a>` : '—'}</td><td>${time(o.created_at)}${o.closed_at ? `<div class="mut">أُغلق ${time(o.closed_at)}</div>` : ''}</td><td><button class="ghost" data-d="${o.id}">تفاصيل</button></td></tr>`).join('')}</tbody></table></div></div><div id="detail"></div>`;
      view().onclick = (e) => { if (e.target.dataset.d) detail(e.target.dataset.d); if (e.target.dataset.cap) { e.preventDefault(); captainModal(rows.find((r) => r.id === Number(e.target.dataset.cap))?.captain); } };
    },
    async settle() {
      const day = view().dataset.day || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' });
      const r = await api(`/admin/settlements?day=${day}`);
      const total = r.rows.reduce((a, x) => a + x.total, 0);
      view().innerHTML = `<div class="card"><div class="row"><input type="date" id="sd" value="${r.day}"><b>إجمالي المستحق: ${money(total)}</b></div>
        <div class="tablewrap"><table><thead><tr><th>الكابتن</th><th>الهاتف</th><th>طلبات مسلّمة</th><th>العمولة</th><th>تعويضات</th><th>الإجمالي</th><th></th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td>${x.orders_count}</td><td>${money(x.commission_total)}</td><td>${money(x.liability_total)}</td><td><b>${money(x.total)}</b></td>
        <td>${x.collected_at ? `<span class="badge b-active">تم التحصيل ${time(x.collected_at)}</span>` : `<button class="ok" data-c="${x.captain_id}">تم التحصيل</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">لا توجد بيانات لهذا اليوم</td></tr>'}</tbody></table></div></div>`;
      $('#sd').onchange = (e) => { view().dataset.day = e.target.value; views.settle(); };
      view().onclick = async (e) => { if (e.target.dataset.c && confirm('تأكيد تحصيل المبلغ كاش من الكابتن؟')) { await act(() => api('/admin/settlements/collect', 'POST', { day: r.day, captain_id: Number(e.target.dataset.c) }), 'تم'); views.settle(); } };
    },
    async flags() {
      const rows = await api('/admin/flags');
      view().innerHTML = `<div class="card"><h3>اشتباه الالتفاف على التطبيق</h3><div class="tablewrap"><table><tbody>
      ${rows.map((f) => `<tr><td>${time(f.at)}</td><td>${esc(f.reason)}<div class="mut">الكابتن: ${esc(f.captain_name)} ${badge(f.captain_status)}</div></td>
        <td>${f.resolved ? 'تمت المعالجة' : `<button class="sec" data-r="${f.id}">تمت المراجعة</button> <button class="bad" data-s="${f.captain_id}">إيقاف الكابتن</button>`}</td></tr>`).join('') || '<tr><td class="mut">لا توجد تنبيهات</td></tr>'}</tbody></table></div></div>`;
      view().onclick = async (e) => {
        if (e.target.dataset.r) { await act(() => api(`/admin/flags/${e.target.dataset.r}/resolve`, 'POST')); views.flags(); }
        if (e.target.dataset.s && confirm('إيقاف حساب الكابتن فوراً؟')) { await act(() => api(`/admin/users/${e.target.dataset.s}`, 'PATCH', { status: 'suspended' }), 'تم الإيقاف'); views.flags(); }
      };
    },
    async settings() {
      const s = await api('/admin/stats');
      view().innerHTML = `<div class="grid"><div class="card"><h3>عمولة الكابتن لكل طلب مسلّم</h3><div class="row"><input id="cm" type="number" min="0" value="${s.commission}"><button id="cs">حفظ</button></div></div>
        <div class="card"><h3>المناطق</h3><ul>${zones.map((z) => `<li>${esc(z.name)}</li>`).join('')}</ul><div class="row"><input id="zn" placeholder="اسم منطقة جديدة"><button id="za">إضافة</button></div></div></div>`;
      $('#cs').onclick = () => act(() => api('/admin/settings/commission', 'PUT', { value: Number($('#cm').value) }), 'تم الحفظ');
      $('#za').onclick = async () => { await act(() => api('/admin/zones', 'POST', { name: $('#zn').value }), 'تمت الإضافة'); views.settings(); };
    },
  };

  async function detail(id) {
    const o = await api(`/admin/orders/${id}`);
    $('#detail').innerHTML = `<div class="card"><h3>طلب #${o.id} ${badge(o.status)}</h3>
        <p>المنشأة: ${esc(o.merchant.name)} — الزبون: ${esc(o.customer_name)} (${esc(o.customer_phone)})<br>${esc(o.customer_address)}</p>
        <p>ثمن المنتج: ${money(o.product_amount)} — التوصيل: ${money(o.delivery_fee)} — العمولة: ${money(o.commission)} — تعويض الكابتن: ${money(o.liability)} ${esc(o.liability_reason || '')}</p>
        <ol class="timeline">${o.events.map((e) => `<li>${time(e.at)} — ${esc(e.type)} ${esc(e.actor || '')}</li>`).join('')}</ol>
        <div class="row">${o.captain_id !== undefined && o.captain ? `<button class="bad" id="lb">تحميل الكابتن ثمن المنتج (تلف/تأخير)</button>` : ''}
        ${!['delivered', 'cancelled', 'failed', 'expired'].includes(o.status) ? '<button class="sec" id="ca">إلغاء الطلب</button>' : ''}</div></div>`;
    $('#lb')?.addEventListener('click', async () => { const reason = prompt('سبب التحميل (تلف / تأخير)'); if (reason) { await act(() => api(`/admin/orders/${id}/liability`, 'POST', { reason }), 'تم'); detail(id); } });
    $('#ca')?.addEventListener('click', async () => { if (confirm('إلغاء؟')) { await act(() => api(`/admin/orders/${id}/cancel`, 'POST'), 'تم'); detail(id); } });
    $('#detail').scrollIntoView();
  }

  async function loadLive() {
    if (tab !== 'live' || !liveMap) return;
    const d = await api('/admin/live');
    $('#lrows').innerHTML = d.orders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.merchant.name)}</td><td>${esc(o.customer_name || '—')}</td><td>${badge(o.status)}${o.eta_minutes ? ` ~${o.eta_minutes}د` : ''}</td><td>${esc(o.captain_name || '—')}</td><td><button class="sec" data-x="${o.id}">إلغاء</button> <button class="ok" data-d="${o.id}">تفاصيل</button></td></tr>`).join('') || '<tr><td colspan="6" class="mut">لا توجد طلبات حية</td></tr>';
    $('#lrows').onclick = async (e) => { if (e.target.dataset.x && confirm('إلغاء الطلب؟')) { await act(() => api(`/admin/orders/${e.target.dataset.x}/cancel`, 'POST')); loadLive(); } else if (e.target.dataset.d) { detail(e.target.dataset.d); } };
    const seen = new Set();
    d.captains.forEach((c) => { seen.add(c.id); if (c.lat != null) setCap(c.id, c.lat, c.lng, `${c.name}${c.busy ? ' (مشغول)' : ' (متاح)'}`, c.busy); });
    [...capMarkers.keys()].filter((k) => !seen.has(k)).forEach((k) => { capMarkers.get(k).remove(); capMarkers.delete(k); });
    refreshTimer = setTimeout(loadLive, 20000);
  }
  function setCap(id, lat, lng, label, busy) {
    let m = capMarkers.get(id);
    if (!m) { m = L.marker([lat, lng], { icon: emoji(busy ? '🛵' : '🟢') }).addTo(liveMap); capMarkers.set(id, m); } else m.setLatLng([lat, lng]);
    if (label) m.bindTooltip(label);
  }

  connectWs((m) => {
    const lbl = { order: 'تحديث على طلب' + (m.order ? ` #${m.order.id}` : ''), pending_user: 'طلب تسجيل جديد', flag: 'تنبيه أمني جديد', captain: 'تحديث على كابتن' }[m.type];
    if (lbl) { feed.unshift({ t: lbl, at: new Date().toLocaleTimeString('en-GB') }); feed.length = Math.min(feed.length, 20); if (tab === 'dash') views.dash(); }
    if (m.type === 'loc' && tab === 'live' && liveMap && capMarkers.has(m.captain_id)) setCap(m.captain_id, m.lat, m.lng);
    else if (['order', 'pending_user', 'flag', 'captain'].includes(m.type)) {
      if (m.type === 'pending_user') toast('طلب تسجيل جديد بانتظار الموافقة');
      if (m.type === 'flag') toast('⚠️ تنبيه أمني جديد');
      if (tab === 'live') { clearTimeout(refreshTimer); views.live(); }
    }
  });
  go('dash');
});
