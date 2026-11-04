import { $, esc, money, time, badge, api, act, toast, connectWs, authScreen, header, makeMap, emoji, animateMarker, makeRoute, fitMapToPoints, DAMASCUS } from './shared.js?v=4';

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

authScreen('captain', (user) => {
  header('الكابتن', user);
  const app = $('#app'); app.classList.remove('hide');
  app.innerHTML = `
  <div class="card"><div class="row"><div><b id="onl">أوفلاين</b><div class="mut" id="gps"></div><label style="display:flex;gap:6px;align-items:center;margin:6px 0 0"><input type="checkbox" id="simc" style="width:auto"> وضع المحاكاة (موقع وهمي للتجربة)</label></div>
    <button type="button" id="tog" class="ok">ابدأ العمل</button></div>
    <div class="mut" id="sum" style="margin-top:8px"></div></div>
  <div class="card" id="sndbox"><button type="button" id="snd" class="bad" style="width:100%">🔇 اضغط هنا لتفعيل صوت التنبيه (مطلوب مرة واحدة بعد كل تحديث للصفحة)</button></div>
  <div id="offer"></div>
  <div id="active"></div>
  <div class="card" id="idleMapCard">
    <h3>🗺️ الخريطة الحية — موقعك</h3>
    <div id="imap" class="map" style="height:300px"></div>
  </div>
  <div class="card"><h3>آخر الطلبات</h3><div class="tablewrap"><table><tbody id="hist"></tbody></table></div></div>`;

  let st = { online: false, active: null, offer: null, intervals: { active: 10000, idle: 60000 } };
  let sim = false, simTimer = null, pos = null, watchId = null, lastSent = 0, map = null, mk = [], me = null, idleMe = null, wake, cd;
  let routeLayer = null, lastRouteTime = 0;

  const initCenter = user.lat != null && user.lng != null ? [user.lat, user.lng] : DAMASCUS;
  const idleMap = makeMap('imap', initCenter, 13);

  // Loud two-tone siren that repeats until the offer is answered, rejected or expires.
  let actx = null, alarmTimer = null, alarmGain = null, alarmOsc = null;
  const unlockAudio = () => { try { actx ??= new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch {} };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
  function testSound() {
    unlockAudio();
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; g.gain.value = 1; o.connect(g); g.connect(actx.destination);
    o.frequency.setValueAtTime(1050, actx.currentTime); o.frequency.setValueAtTime(700, actx.currentTime + 0.35);
    o.start(); o.stop(actx.currentTime + 0.7);
  }
  const updateSndBtn = () => {
    const ok = actx && actx.state === 'running', b = $('#snd');
    if (!b) return;
    b.textContent = ok ? '🔊 صوت التنبيه مفعّل (اضغط للتجربة)' : '🔇 اضغط هنا لتفعيل صوت التنبيه (مطلوب مرة واحدة بعد كل تحديث للصفحة)';
    b.className = ok ? 'ok' : 'bad';
  };
  $('#snd').onclick = () => { testSound(); setTimeout(updateSndBtn, 300); };
  setInterval(updateSndBtn, 1500);
  function startAlarm() {
    if (alarmTimer) return;
    unlockAudio();
    if (!actx) return;
    alarmOsc = actx.createOscillator(); alarmGain = actx.createGain();
    alarmOsc.type = 'square'; alarmGain.gain.value = 1;
    alarmOsc.connect(alarmGain); alarmGain.connect(actx.destination); alarmOsc.start();
    let hi = false;
    const step = () => {
      hi = !hi; alarmOsc.frequency.setValueAtTime(hi ? 1050 : 700, actx.currentTime);
      navigator.vibrate?.(hi ? [250] : [0]);
    };
    step(); alarmTimer = setInterval(step, 350);
    setTimeout(stopAlarm, 60_000);
  }
  function stopAlarm() {
    clearInterval(alarmTimer); alarmTimer = null;
    try { alarmOsc?.stop(); alarmOsc?.disconnect(); alarmGain?.disconnect(); } catch {}
    alarmOsc = alarmGain = null; navigator.vibrate?.(0);
  }

  async function refresh() {
    st = await api('/captain/state');
    renderAll();
    const s = await api('/captain/summary');
    $('#sum').textContent = `اليوم: ${s.delivered} طلب مسلّم — المستحق للمنصة: ${money(s.due)} (عمولة ${money(s.commission)}${s.liability ? ` + تعويضات ${money(s.liability)}` : ''})`;
    const hist = await api('/captain/history');
    $('#hist').innerHTML = hist.slice(0, 15).map((o) => `<tr><td><b>#${o.id}</b></td><td>${esc(o.merchant.name)}</td><td>${badge(o.status)}</td><td>${time(o.closed_at)}</td></tr>`).join('') || '<tr><td class="mut">لا توجد طلبات مسلّمة بعد</td></tr>';
  }

  function renderAll() {
    $('#onl').textContent = st.online ? '🟢 أونلاين' : '⚪ أوفلاين';
    $('#tog').textContent = st.online ? 'إيقاف العمل' : 'ابدأ العمل';
    $('#tog').className = st.online ? 'bad' : 'ok';
    renderOffer(); renderActive();
    st.online ? startGps() : stopGps();
  }

  function renderOffer() {
    clearInterval(cd);
    const o = st.offer, box = $('#offer');
    if (!o) { box.innerHTML = ''; stopAlarm(); return; }
    startAlarm();
    box.innerHTML = `<div class="card offer"><h3>🔔 طلب جديد #${o.id}</h3>
      <p><b>من:</b> ${esc(o.merchant.name)}<br><span class="mut">${esc(o.merchant.address)}</span></p>
      <p><b>أجرة التوصيل:</b> ${money(o.delivery_fee)} &nbsp; <b>عمولة المنصة:</b> ${money(st.commission)}</p>
      <p>الوقت المتبقي: <b id="cd"></b> ث</p>
      <div class="row"><button type="button" class="ok" id="acc">قبول</button><button type="button" class="bad" id="rej">رفض</button></div></div>`;
    const tick = () => { const s = Math.max(0, Math.round((o.offer_expires_at - Date.now()) / 1000)); const e = $('#cd'); if (e) e.textContent = s; if (!s) { clearInterval(cd); setTimeout(refresh, 1500); } };
    tick(); cd = setInterval(tick, 1000);
    $('#acc').onclick = async () => { await act(() => api(`/captain/offers/${o.id}/accept`, 'POST'), 'تم قبول الطلب'); await refresh(); };
    $('#rej').onclick = async () => { await act(() => api(`/captain/offers/${o.id}/reject`, 'POST')); await refresh(); };
  }

  const NEXT = { accepted: ['picked_up', 'استلمت الطلب من المنشأة'], picked_up: ['arrived', 'وصلت عند الزبون'], arrived: ['delivered', 'تم التسليم'] };
  function renderActive() {
    const o = st.active, box = $('#active'), idleCard = $('#idleMapCard');
    if (!o) {
      box.innerHTML = ''; map = null;
      idleCard.classList.remove('hide');
      setTimeout(() => idleMap.invalidateSize(), 60);
      return;
    }
    idleCard.classList.add('hide');
    const toMerchant = o.status === 'accepted';
    const dest = toMerchant ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng };
    const n = NEXT[o.status];
    box.innerHTML = `<div class="card"><h3>طلب نشط #${o.id} ${badge(o.status)}</h3>
      <p><b>المنشأة:</b> ${esc(o.merchant.name)} — ${esc(o.merchant.address)}${o.merchant.phone ? ` — <a href="tel:${esc(o.merchant.phone)}">📞 اتصال</a>` : ''}</p>
      <p><b>📍 عنوان التوصيل:</b> ${esc(o.customer_address || '—')}</p>
      ${o.customer_name && o.customer_name !== '—' ? `<p><b>الزبون:</b> ${esc(o.customer_name)}${o.customer_phone ? ` — <a href="tel:${esc(o.customer_phone)}" dir="ltr">📞 ${esc(o.customer_phone)}</a>` : ''}</p>` : ''}
      ${(o.product_amount || o.delivery_fee) ? `<p>💵 ادفع للمنشأة ثمن المنتج: <b>${money(o.product_amount)}</b><br>💵 استلم من الزبون: <b>${money(o.product_amount + o.delivery_fee)}</b> (منتج + توصيل ${money(o.delivery_fee)})</p>` : ''}
      ${o.notes ? `<p class="mut">ملاحظات: ${esc(o.notes)}</p>` : ''}
      ${dest.lat != null ? `<a class="btn-nav sec" style="width:100%;margin-bottom:8px" href="https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}" target="_blank" rel="noopener noreferrer">🧭 افتح الملاحة في خرائط قوقل</a>` : ''}
      <div id="amap" class="map" style="height:320px"></div>
      <button type="button" class="big ok" id="nx">${n[1]}</button>
      ${o.status !== 'accepted' ? '<button type="button" class="big bad" id="fl">الزبون لا يرد / العنوان خطأ</button>' : ''}</div>`;
    map = makeMap('amap', dest.lat != null ? [dest.lat, dest.lng] : undefined, 14);
    mk.forEach((m) => m.remove()); mk = [];
    if (routeLayer) { routeLayer.remove(); routeLayer = null; }
    if (o.merchant.lat != null) mk.push(L.marker([o.merchant.lat, o.merchant.lng], { icon: emoji('🏪') }).addTo(map).bindTooltip(`🏪 ${o.merchant.name}`));
    if (o.customer_lat != null) mk.push(L.marker([o.customer_lat, o.customer_lng], { icon: emoji('📍') }).addTo(map).bindTooltip(`📍 الزبون: ${o.customer_name}`));
    me = null; if (pos) showMe();
    const pts = [];
    if (o.merchant.lat != null) pts.push([o.merchant.lat, o.merchant.lng]);
    if (o.customer_lat != null) pts.push([o.customer_lat, o.customer_lng]);
    if (pos) pts.push([pos.lat, pos.lng]);
    if (pts.length) fitMapToPoints(map, pts);
    if (pos && dest.lat != null) {
      lastRouteTime = Date.now();
      makeRoute(map, [pos.lat, pos.lng], [dest.lat, dest.lng]).then((layer) => { routeLayer = layer; });
    }
    $('#nx').onclick = async () => { if (n[0] === 'delivered' && !confirm('تأكيد التسليم واستلام المبلغ؟')) return; await act(() => api(`/captain/orders/${o.id}/status`, 'POST', { status: n[0] })); await refresh(); };
    $('#fl')?.addEventListener('click', async () => { if (!confirm('الإبلاغ عن فشل التسليم؟ ستخسر أجرة التوصيل.')) return; await act(() => api(`/captain/orders/${o.id}/status`, 'POST', { status: 'failed_customer' })); await refresh(); });
  }

  function showMe() {
    if (!pos) return;
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

  // ----- GPS: 10-15s with active order, 60s idle, nothing when offline -----
  function startGps() {
    if (sim) return startSim();
    if (watchId != null) return;
    if (!navigator.geolocation) { $('#gps').textContent = 'المتصفح لا يدعم GPS'; return; }
    watchId = navigator.geolocation.watchPosition(
      (p) => { pos = { lat: p.coords.latitude, lng: p.coords.longitude }; $('#gps').textContent = 'GPS يعمل ✓'; showMe(); maybeSend(); },
      () => { $('#gps').textContent = 'فعّل صلاحية الموقع (GPS) أو جرّب وضع المحاكاة'; },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    navigator.wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
  }
  function startSim() {
    if (simTimer) return;
    const baseLat = st.active?.merchant?.lat ?? user.lat ?? DAMASCUS[0];
    const baseLng = st.active?.merchant?.lng ?? user.lng ?? DAMASCUS[1];
    pos ??= { lat: baseLat + (Math.random() - 0.5) * 0.008, lng: baseLng + (Math.random() - 0.5) * 0.008 };
    $('#gps').textContent = 'محاكاة GPS تعمل 🧪';
    showMe(); maybeSend();
    simTimer = setInterval(() => {
      const o = st.active;
      const d = o && (o.status === 'accepted' ? o.merchant : { lat: o.customer_lat, lng: o.customer_lng });
      if (d && d.lat != null) {
        const dx = d.lat - pos.lat, dy = d.lng - pos.lng, n = Math.hypot(dx, dy), step = 0.0004;
        pos = n < step ? { lat: d.lat, lng: d.lng } : { lat: pos.lat + (dx / n) * step, lng: pos.lng + (dy / n) * step };
      } else {
        pos = { lat: pos.lat + (Math.random() - 0.5) * 0.0004, lng: pos.lng + (Math.random() - 0.5) * 0.0004 };
      }
      showMe(); maybeSend();
    }, 2000);
  }
  function stopGps() {
    clearInterval(simTimer); simTimer = null;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    wake?.release().catch(() => {}); wake = null; $('#gps').textContent = ''; pos = null;
  }
  function maybeSend() {
    if (!st.online || !pos) return;
    const gap = st.active ? st.intervals.active : st.intervals.idle;
    if (Date.now() - lastSent < gap) return;
    lastSent = Date.now();
    api('/captain/location', 'POST', pos).catch(() => {});
  }
  setInterval(maybeSend, 3000);

  $('#simc').onchange = (e) => { sim = e.target.checked; stopGps(); pos = null; if (st.online) startGps(); };
  $('#tog').onclick = async () => {
    const r = await act(() => api('/captain/online', 'POST', { online: !st.online }));
    if (r) { lastSent = 0; await refresh(); }
  };

  connectWs((m) => {
    if (m.type === 'offer' || m.type === 'offer_end' || m.type === 'order') refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      if (st.online && watchId != null) navigator.wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
    }
  });
  refresh();
});
