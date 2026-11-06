import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, tx, addEvent, audit, commission, setSetting } from './db.js';
import { config, dayOf } from './config.js';
import { auth, signToken, sendTo, sendToAdmins } from './realtime.js';
import { ACTIVE, viewOrder, notifyOrder, dispatchOrder, releaseOffer, closeOrder, haversineKm, computeShortage } from './dispatch.js';

export const api = express.Router();

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const toEnDigits = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0);

const str = (v, name, min, max) => {
  if (typeof v !== 'string') throw bad(`الحقل غير صالح: ${name}`);
  const s = toEnDigits(v).trim();
  if (s.length < min || s.length > max) throw bad(`الحقل غير صالح: ${name}`);
  return s;
};
const optStr = (v, name, max) => (v == null || v === '' ? null : str(v, name, 1, max));
const int = (v, name, min, max) => {
  const n = Number(typeof v === 'string' ? toEnDigits(v) : v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`قيمة غير صالحة: ${name}`);
  return n;
};
const coord = (lat, lng, required = false) => {
  if (lat == null && lng == null && !required) return [null, null];
  const a = Number(typeof lat === 'string' ? toEnDigits(lat) : lat);
  const b = Number(typeof lng === 'string' ? toEnDigits(lng) : lng);
  if (!(a >= -90 && a <= 90 && b >= -180 && b <= 180) || lat === '' || lng === '') throw bad('إحداثيات غير صالحة');
  return [a, b];
};
const phone = (v) => {
  const p = toEnDigits(v).replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!/^\d{9,15}$/.test(p)) throw bad('رقم الهاتف غير صالح');
  return p;
};
const oid = (req) => int(req.params.id, 'id', 1, 2 ** 31);

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, phone: u.phone, zone_id: u.zone_id, status: u.status, business_name: u.business_name, address: u.address, lat: u.lat, lng: u.lng, online: !!u.online });

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول لاحقاً' } });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات تسجيل كثيرة، حاول لاحقاً' } });
const orderLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة، تمهل قليلاً' } });

// ---------- public / auth ----------
api.get('/zones', wrap(async (_req, res) => res.json(await db.all('SELECT id,name FROM zones WHERE active=1 ORDER BY name'))));

// Map tile & OSRM route proxy fallback (zero API key, immune to adblockers / Brave Shields / ISP blocks)
const tileCache = new Map();
const TILE_URLS = {
  gm: (z, x, y) => `https://mt${(x + y) & 3}.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${z}&hl=ar`,
  gh: (z, x, y) => `https://mt${(x + y) & 3}.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}&hl=ar`,
  dark: (z, x, y) => `https://${'abcd'[(x + y) & 3]}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
  osm: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
};
api.get('/tile/:style/:z/:x/:y', async (req, res) => {
  try {
    const style = req.params.style;
    const buildUrl = TILE_URLS[style];
    if (!buildUrl) return res.status(400).json({ error: 'نمط خريطة غير صالح' });
    const z = int(req.params.z, 'z', 0, 21);
    const maxIdx = (2 ** z) - 1;
    const x = int(req.params.x, 'x', 0, maxIdx);
    const y = int(String(req.params.y).replace(/\.(png|jpg|jpeg)$/i, ''), 'y', 0, maxIdx);
    const key = `${style}:${z}:${x}:${y}`;
    let hit = tileCache.get(key);
    if (!hit) {
      const upstream = await fetch(buildUrl(z, x, y), {
        headers: { 'User-Agent': 'MashwarDelivery/1.0 (+https://localhost)', 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) return res.status(502).end();
      const buf = Buffer.from(await upstream.arrayBuffer());
      const ct = upstream.headers.get('content-type') || 'image/png';
      hit = { buf, ct };
      if (tileCache.size >= 400) tileCache.delete(tileCache.keys().next().value);
      tileCache.set(key, hit);
    }
    res.set('Content-Type', hit.ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(hit.buf);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    res.status(502).end();
  }
});

api.get('/route', async (req, res) => {
  try {
    const [fLat, fLng] = String(req.query.from ?? '').split(',');
    const [tLat, tLng] = String(req.query.to ?? '').split(',');
    const [lat1, lng1] = coord(fLat, fLng, true);
    const [lat2, lng2] = coord(tLat, tLng, true);
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const r = await fetch(url, { headers: { 'User-Agent': 'MashwarDelivery/1.0' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return res.status(502).json({ code: 'UpstreamError' });
    const data = await r.json();
    res.set('Cache-Control', 'public, max-age=30');
    res.json(data);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    res.status(502).json({ code: 'RouteUnavailable' });
  }
});

// Accounts are created by the admin only (no public self-registration)
api.post('/auth/register', registerLimiter, (_req, res) => res.status(403).json({ error: 'التسجيل عن طريق الإدارة فقط' }));
const createAccount = wrap(async (req, res) => {
  const b = req.body ?? {};
  const role = b.role;
  if (!['merchant', 'captain'].includes(role)) throw bad('نوع الحساب غير صالح');
  const p = phone(b.phone);
  const name = str(b.name, 'الاسم', 2, 60);
  const pass = str(b.password, 'كلمة المرور', 6, 72);
  if (!/[A-Za-z\u0600-\u06FF]/.test(pass) || !/\d/.test(pass)) throw bad('كلمة المرور يجب أن تحتوي حروفاً وأرقاماً');
  const zone = int(b.zone_id, 'المنطقة', 1, 2 ** 31);
  if (!(await db.get('SELECT 1 FROM zones WHERE id=? AND active=1', zone))) throw bad('المنطقة غير موجودة');
  let business = null, address = null, lat = null, lng = null;
  if (role === 'merchant') {
    business = str(b.business_name, 'اسم المنشأة', 2, 80);
    address = str(b.address, 'العنوان', 3, 200);
    [lat, lng] = coord(b.lat, b.lng);
  }
  if (await db.get('SELECT 1 FROM users WHERE phone=?', p)) throw new HttpError(409, 'رقم الهاتف مسجل مسبقاً');
  await db.run(
    'INSERT INTO users(role,phone,name,pass_hash,zone_id,status,business_name,address,lat,lng,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    role, p, name, bcrypt.hashSync(pass, 12), zone, 'active', business, address, lat, lng, Date.now()
  );
  await audit(req.user.id, 'create_user', { role, phone: p });
  res.status(201).json({ ok: true, message: 'تم إنشاء الحساب' });
});

const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', 12);
api.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const p = phone(req.body?.phone);
  const pass = str(req.body?.password, 'كلمة المرور', 1, 72);
  const u = await db.get('SELECT * FROM users WHERE phone=?', p);
  const now = Date.now();
  if (u && u.locked_until > now) {
    const mins = Math.max(1, Math.ceil((u.locked_until - now) / 60_000));
    throw new HttpError(429, `الحساب مقفل مؤقتاً بسبب محاولات فاشلة، حاول بعد ${mins} دقيقة`);
  }
  const ok = bcrypt.compareSync(pass, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const f = u.failed_logins + 1;
      await db.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', f >= 5 ? 0 : f, f >= 5 ? now + 5 * 60_000 : 0, u.id);
    }
    throw new HttpError(401, 'رقم الهاتف أو كلمة المرور غير صحيحة');
  }
  if (u.status === 'pending') throw new HttpError(403, 'حسابك بانتظار موافقة الإدارة');
  if (u.status === 'suspended') throw new HttpError(403, 'حسابك موقوف، تواصل مع الإدارة');
  await db.run('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?', u.id);
  res.json({ token: signToken(u), user: publicUser(u) });
}));

api.get('/me', auth(), (req, res) => res.json(publicUser(req.user)));

api.post('/auth/logout-all', auth(), wrap(async (req, res) => {
  await db.run('UPDATE users SET token_version=token_version+1 WHERE id=?', req.user.id);
  res.json({ ok: true });
}));

api.post('/auth/password', auth(), wrap(async (req, res) => {
  const old = str(req.body?.old_password, 'كلمة المرور الحالية', 1, 72);
  const nw = str(req.body?.new_password, 'كلمة المرور الجديدة', 6, 72);
  if (!/\d/.test(nw) || !/[A-Za-z\u0600-\u06FF]/.test(nw)) throw bad('كلمة المرور يجب أن تحتوي حروفاً وأرقاماً');
  if (!bcrypt.compareSync(old, req.user.pass_hash)) throw new HttpError(403, 'كلمة المرور الحالية خاطئة');
  await db.run('UPDATE users SET pass_hash=?, token_version=token_version+1 WHERE id=?', bcrypt.hashSync(nw, 12), req.user.id);
  res.json({ ok: true });
}));

// ---------- merchant ----------
const M = express.Router();
api.use('/merchant', auth('merchant'), M);

M.post('/orders', orderLimiter, wrap(async (req, res) => {
  const b = req.body ?? {};
  const m = req.user;
  const [clat, clng] = coord(b.customer_lat, b.customer_lng);
  const o = {
    name: b.customer_name ? str(b.customer_name, 'اسم الزبون', 1, 60) : '—',
    phone: b.customer_phone ? phone(b.customer_phone) : '',
    address: str(b.customer_address, 'عنوان التوصيل', 2, 250),
    amount: int(b.product_amount ?? 0, 'ثمن المنتج', 0, 100_000_000),
    fee: int(b.delivery_fee ?? 0, 'أجرة التوصيل', 0, 10_000_000),
    notes: optStr(b.notes, 'ملاحظات', 300),
  };
  const open = (await db.get("SELECT COUNT(*) c FROM orders WHERE merchant_id=? AND status IN ('searching','offered')", m.id)).c;
  if (open >= 10) throw bad('لديك طلبات كثيرة قيد البحث عن كابتن');
  const r = await tx(async () => {
    const ins = await db.run(
      'INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,product_amount,delivery_fee,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      m.id, m.zone_id, o.name, o.phone, o.address, clat, clng, o.amount, o.fee, o.notes, Date.now()
    );
    await addEvent(ins.lastInsertRowid, 'created', m.id);
    return ins.lastInsertRowid;
  });
  await dispatchOrder(r);
  await notifyOrder(r);
  res.status(201).json(await viewOrder(await db.get('SELECT * FROM orders WHERE id=?', r), 'merchant'));
}));

M.get('/orders', wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM orders WHERE merchant_id=? ORDER BY id DESC LIMIT 200', req.user.id);
  res.json(await Promise.all(rows.map((o) => viewOrder(o, 'merchant'))));
}));

const ownOrder = async (req) => {
  const o = await db.get('SELECT * FROM orders WHERE id=? AND merchant_id=?', oid(req), req.user.id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  return o;
};
M.get('/orders/:id', wrap(async (req, res) => {
  const o = await ownOrder(req);
  const [view, events] = await Promise.all([
    viewOrder(o, 'merchant'),
    db.all('SELECT type,at,data FROM order_events WHERE order_id=? ORDER BY id', o.id),
  ]);
  res.json({ ...view, events });
}));
M.post('/orders/:id/cancel', wrap(async (req, res) => {
  const o = await ownOrder(req);
  if (!['searching', 'offered'].includes(o.status)) throw bad('لا يمكن إلغاء الطلب بعد قبول الكابتن، تواصل مع الإدارة');
  await closeOrder(o.id, 'cancelled', { actor: req.user.id, reason: 'merchant_cancelled' });
  res.json({ ok: true });
}));
M.get('/captain/:id/location', wrap(async (req, res) => {
  const cid = int(req.params.id, 'id', 1, 2 ** 31);
  const o = await db.get("SELECT 1 FROM orders WHERE merchant_id=? AND captain_id=? AND status IN ('accepted','picked_up','arrived')", req.user.id, cid);
  if (!o) throw new HttpError(404, 'غير متاح');
  const c = await db.get('SELECT last_lat lat,last_lng lng,last_loc_at at FROM users WHERE id=?', cid);
  res.json(c);
}));

// ---------- captain ----------
const C = express.Router();
api.use('/captain', auth('captain'), C);
const lastPing = new Map();

const activeOrder = (cid) => db.get("SELECT * FROM orders WHERE captain_id=? AND status IN ('accepted','picked_up','arrived') ORDER BY id ASC LIMIT 1", cid);
const activeOrders = (cid) => db.all("SELECT * FROM orders WHERE captain_id=? AND status IN ('accepted','picked_up','arrived') ORDER BY id ASC", cid);
const pendingOffer = (cid) => db.get("SELECT * FROM orders WHERE offered_captain_id=? AND status='offered' LIMIT 1", cid);

C.get('/state', wrap(async (req, res) => {
  const [allAct, off, comm] = await Promise.all([
    activeOrders(req.user.id),
    pendingOffer(req.user.id),
    commission(),
  ]);
  const [actViews, offView] = await Promise.all([
    Promise.all(allAct.map((x) => viewOrder(x, 'captain'))),
    off ? viewOrder(off, 'captain') : null,
  ]);
  res.json({
    online: !!req.user.online,
    active: actViews[0] || null,
    activeOrders: actViews,
    offer: offView,
    commission: comm,
    intervals: { active: config.activeLocIntervalMs, idle: config.idleLocIntervalMs },
  });
}));

C.post('/online', wrap(async (req, res) => {
  const on = req.body?.online === true;
  if (!on) {
    if (await activeOrder(req.user.id)) throw bad('لا يمكنك الخروج وعندك طلب نشط');
    const off = await pendingOffer(req.user.id);
    if (off) await releaseOffer(off.id, 'rejected');
  }
  await db.run('UPDATE users SET online=? WHERE id=?', on ? 1 : 0, req.user.id);
  sendToAdmins({ type: 'captain', id: req.user.id, online: on, shortage: await computeShortage() });
  res.json({ online: on });
}));

C.post('/location', wrap(async (req, res) => {
  const u = req.user;
  if (!u.online) return res.status(204).end(); // offline: no tracking at all
  const [lat, lng] = coord(req.body?.lat, req.body?.lng, true);
  const now = Date.now();
  const act = await activeOrder(u.id);
  const minGap = (act ? config.activeLocIntervalMs : config.idleLocIntervalMs) * 0.8;
  if (now - (lastPing.get(u.id) ?? 0) < minGap) return res.status(204).end();
  lastPing.set(u.id, now);
  // basic anti-teleport sanity (>200 km/h between pings is ignored)
  if (u.last_lat != null && u.last_loc_at) {
    const hrs = (now - u.last_loc_at) / 3.6e6;
    if (hrs > 0 && haversineKm(u.last_lat, u.last_lng, lat, lng) / hrs > 200) return res.status(204).end();
  }
  await db.run('UPDATE users SET last_lat=?, last_lng=?, last_loc_at=? WHERE id=?', lat, lng, now, u.id);
  await db.run('INSERT INTO locations(captain_id,lat,lng,order_id,at) VALUES(?,?,?,?,?)', u.id, lat, lng, act?.id ?? null, now);
  if (act) {
    const m = { type: 'loc', order_id: act.id, lat, lng, at: now };
    const v = await viewOrder(await db.get('SELECT * FROM orders WHERE id=?', act.id), 'merchant');
    sendTo(act.merchant_id, { ...m, eta_minutes: v.eta_minutes });
  } else {
    await detectBypass(u, lat, lng, now);
  }
  sendToAdmins({ type: 'loc', captain_id: u.id, lat, lng, at: now, busy: !!act });
  res.status(204).end();
}));

/** Anti-bypass: an idle captain (no order through the app) lingering at a merchant of his zone. */
async function detectBypass(u, lat, lng, now) {
  const near = (await db.all("SELECT id,business_name,lat,lng FROM users WHERE role='merchant' AND status='active' AND zone_id=? AND lat IS NOT NULL", u.zone_id))
    .filter((m) => haversineKm(lat, lng, m.lat, m.lng) < 0.06);
  for (const m of near) {
    const [prev, recent, hasOrderRecently] = await Promise.all([
      db.get('SELECT 1 FROM locations WHERE captain_id=? AND order_id IS NULL AND at BETWEEN ? AND ? LIMIT 1', u.id, now - 6 * 60_000, now - 90_000),
      db.get('SELECT 1 FROM flags WHERE captain_id=? AND merchant_id=? AND at>?', u.id, m.id, now - 3 * 3600_000),
      db.get('SELECT 1 FROM orders WHERE captain_id=? AND merchant_id=? AND closed_at>?', u.id, m.id, now - 30 * 60_000),
    ]);
    if (prev && !recent && !hasOrderRecently) {
      await db.run(
        'INSERT INTO flags(captain_id,merchant_id,reason,at) VALUES(?,?,?,?)',
        u.id, m.id, `اشتباه التفاف: الكابتن متواجد قرب «${m.business_name}» بدون طلب عبر التطبيق`, now
      );
      sendToAdmins({ type: 'flag' });
    }
  }
}

C.post('/offers/:id/:action', wrap(async (req, res) => {
  const id = oid(req), act = req.params.action;
  if (!['accept', 'reject'].includes(act)) throw new HttpError(404, 'غير موجود');
  const o = await db.get("SELECT * FROM orders WHERE id=? AND status='offered' AND offered_captain_id=?", id, req.user.id);
  if (!o) throw new HttpError(409, 'العرض لم يعد متاحاً');
  if (act === 'reject') { await releaseOffer(id, 'rejected'); return res.json({ ok: true }); }
  if (o.offer_expires_at < Date.now()) { await releaseOffer(id, 'timeout'); throw new HttpError(409, 'انتهت مهلة العرض'); }
  await tx(async () => {
    const now = Date.now();
    const r = await db.run(
      "UPDATE orders SET status='accepted', captain_id=?, accepted_at=?, offered_captain_id=NULL, offer_expires_at=NULL WHERE id=? AND status='offered' AND offered_captain_id=?",
      req.user.id, now, id, req.user.id
    );
    if (!r.changes) throw new HttpError(409, 'العرض لم يعد متاحاً');
    await db.run("UPDATE offers SET outcome='accepted' WHERE order_id=? AND captain_id=? AND outcome='pending'", id, req.user.id);
    await db.run('UPDATE users SET last_assigned_at=? WHERE id=?', now, req.user.id);
    await addEvent(id, 'accepted', req.user.id);
  });
  await notifyOrder(id);
  res.json(await viewOrder(await db.get('SELECT * FROM orders WHERE id=?', id), 'captain'));
}));

const NEXT = { accepted: 'picked_up', picked_up: 'arrived', arrived: 'delivered' };
C.post('/orders/:id/status', wrap(async (req, res) => {
  const id = oid(req);
  const o = await db.get('SELECT * FROM orders WHERE id=? AND captain_id=?', id, req.user.id);
  if (!o || !ACTIVE.includes(o.status)) throw new HttpError(404, 'الطلب غير موجود أو مغلق');
  const to = req.body?.status;
  if (to === 'failed_customer') {
    if (o.status === 'accepted') throw bad('لا يمكن الإبلاغ قبل استلام الطلب');
    await closeOrder(id, 'failed', { actor: req.user.id, reason: 'customer_unreachable_or_wrong_address' });
    return res.json({ ok: true });
  }
  if (NEXT[o.status] !== to) throw bad('انتقال حالة غير صالح');
  if (to === 'delivered') {
    await closeOrder(id, 'delivered', { actor: req.user.id, withCommission: true });
  } else {
    await db.run('UPDATE orders SET status=?, picked_at=COALESCE(picked_at, ?) WHERE id=?', to, to === 'picked_up' ? Date.now() : null, id);
    await addEvent(id, to, req.user.id);
    await notifyOrder(id);
  }
  res.json({ ok: true });
}));

C.get('/summary', wrap(async (req, res) => {
  const day = dayOf();
  const [r, delRow, failRow, earnRow, totRow, setRow] = await Promise.all([
    db.get("SELECT COUNT(*) n, COALESCE(SUM(commission),0) c, COALESCE(SUM(liability),0) l FROM orders WHERE captain_id=? AND day=? AND status IN ('delivered','failed')", req.user.id, day),
    db.get("SELECT COUNT(*) n FROM orders WHERE captain_id=? AND day=? AND status='delivered'", req.user.id, day),
    db.get("SELECT COUNT(*) n FROM orders WHERE captain_id=? AND day=? AND status='failed'", req.user.id, day),
    db.get("SELECT COALESCE(SUM(delivery_fee),0) s FROM orders WHERE captain_id=? AND day=? AND status='delivered'", req.user.id, day),
    db.get("SELECT COUNT(*) n FROM orders WHERE captain_id=? AND status='delivered'", req.user.id),
    db.get('SELECT 1 FROM settlements WHERE captain_id=? AND day=?', req.user.id, day),
  ]);
  res.json({
    day,
    delivered: delRow.n,
    failed: failRow.n,
    earnings_today: earnRow.s,
    total_delivered: totRow.n,
    settled: !!setRow,
    commission: r.c,
    liability: r.l,
    due: r.c + r.l,
  });
}));
C.get('/history', wrap(async (req, res) => {
  const rows = await db.all("SELECT * FROM orders WHERE captain_id=? AND status IN ('delivered','failed') ORDER BY id DESC LIMIT 100", req.user.id);
  res.json(await Promise.all(rows.map((o) => viewOrder(o, 'captain'))));
}));

// ---------- admin ----------
const A = express.Router();
api.use('/admin', auth('admin'), A);

A.get('/stats', wrap(async (_req, res) => {
  const one = async (q, ...a) => (await db.get(q, ...a)).n;
  const day = dayOf();
  const [merchants, captains, online, pending, live, deliveredToday, flags, comm, shortage] = await Promise.all([
    one("SELECT COUNT(*) n FROM users WHERE role='merchant' AND status='active'"),
    one("SELECT COUNT(*) n FROM users WHERE role='captain' AND status='active'"),
    one("SELECT COUNT(*) n FROM users WHERE role='captain' AND online=1"),
    one("SELECT COUNT(*) n FROM users WHERE status='pending'"),
    one("SELECT COUNT(*) n FROM orders WHERE status IN ('searching','offered','accepted','picked_up','arrived')"),
    one("SELECT COUNT(*) n FROM orders WHERE day=? AND status='delivered'", day),
    one('SELECT COUNT(*) n FROM flags WHERE resolved=0'),
    commission(),
    computeShortage(),
  ]);
  res.json({ merchants, captains, online, pending, live, deliveredToday, flags, commission: comm, shortage });
}));

A.get('/live', wrap(async (_req, res) => {
  const [liveRows, recentRows, capRows, merchants, shortage] = await Promise.all([
    db.all("SELECT * FROM orders WHERE status IN ('searching','offered','accepted','picked_up','arrived') ORDER BY id DESC"),
    db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 100'),
    db.all("SELECT id,name,phone,zone_id,status,online,last_lat lat,last_lng lng,last_loc_at at FROM users WHERE role='captain' ORDER BY online DESC, (status='active') DESC, id DESC"),
    db.all("SELECT id,name,business_name,phone,address,zone_id,status,lat,lng FROM users WHERE role='merchant' ORDER BY (status='active') DESC, id DESC"),
    computeShortage(),
  ]);
  const [orders, recentOrders, captains] = await Promise.all([
    Promise.all(liveRows.map((o) => viewOrder(o, 'admin'))),
    Promise.all(recentRows.map((o) => viewOrder(o, 'admin'))),
    Promise.all(capRows.map(async (c) => {
      const acts = await activeOrders(c.id);
      const act = acts[0] || null;
      return {
        ...c,
        online: !!c.online,
        busy: acts.length > 0,
        active_order_id: act?.id ?? null,
        active_orders: acts.map((x) => ({ id: x.id, serial_no: String(x.id).padStart(4, '0'), customer_address: x.customer_address, status: x.status })),
      };
    })),
  ]);
  res.json({ orders, recentOrders, captains, merchants, shortage });
}));

A.post('/users', createAccount);
A.get('/users', wrap(async (req, res) => {
  const role = ['merchant', 'captain'].includes(req.query.role) ? req.query.role : null;
  const rows = await db.all(
    `SELECT id,role,phone,name,business_name,address,zone_id,status,online,lat,lng,last_lat,last_lng,created_at FROM users WHERE role IN ('merchant','captain') ${role ? 'AND role=?' : ''} ORDER BY (status='pending') DESC, id DESC LIMIT 500`,
    ...(role ? [role] : [])
  );
  res.json(rows);
}));
A.patch('/users/:id', wrap(async (req, res) => {
  const id = oid(req);
  const u = await db.get("SELECT * FROM users WHERE id=? AND role IN ('merchant','captain')", id);
  if (!u) throw new HttpError(404, 'المستخدم غير موجود');
  const b = req.body ?? {};
  if (b.status != null) {
    if (!['active', 'suspended', 'pending'].includes(b.status)) throw bad('حالة غير صالحة');
    await db.run("UPDATE users SET status=?, token_version=token_version+1, failed_logins=0, locked_until=0, online=CASE WHEN ?='active' THEN online ELSE 0 END WHERE id=?", b.status, b.status, id);
    if (b.status === 'suspended' && u.role === 'captain') {
      const off = await pendingOffer(id); if (off) await releaseOffer(off.id, 'cancelled');
    }
  }
  if (b.zone_id != null) {
    const z = int(b.zone_id, 'zone', 1, 2 ** 31);
    if (!(await db.get('SELECT 1 FROM zones WHERE id=?', z))) throw bad('المنطقة غير موجودة');
    await db.run('UPDATE users SET zone_id=? WHERE id=?', z, id);
  }
  if (b.lat != null) { const [la, ln] = coord(b.lat, b.lng, true); await db.run('UPDATE users SET lat=?, lng=? WHERE id=?', la, ln, id); }
  await audit(req.user.id, 'user_update', { id, ...b });
  res.json({ ok: true });
}));
A.post('/users/:id/reset-password', wrap(async (req, res) => {
  const id = oid(req);
  const pw = str(req.body?.password, 'كلمة المرور', 6, 72);
  await db.run("UPDATE users SET pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0 WHERE id=? AND role IN ('merchant','captain')", bcrypt.hashSync(pw, 12), id);
  await audit(req.user.id, 'reset_password', { id });
  res.json({ ok: true });
}));

A.get('/zones', wrap(async (_req, res) => res.json(await db.all('SELECT * FROM zones ORDER BY id'))));
A.post('/zones', wrap(async (req, res) => {
  const name = str(req.body?.name, 'اسم المنطقة', 2, 60);
  try {
    const r = await db.run('INSERT INTO zones(name) VALUES(?)', name);
    res.status(201).json({ id: Number(r.lastInsertRowid), name });
  } catch {
    throw new HttpError(409, 'المنطقة موجودة مسبقاً');
  }
}));

A.get('/orders', wrap(async (req, res) => {
  const st = req.query.status;
  const rows = st
    ? await db.all('SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT 300', String(st))
    : await db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 300');
  res.json(await Promise.all(rows.map((o) => viewOrder(o, 'admin'))));
}));
A.post('/orders', wrap(async (req, res) => {
  const b = req.body ?? {};
  let m = null;
  if (b.merchant_id != null && b.merchant_id !== '') {
    m = await db.get("SELECT * FROM users WHERE id=? AND role='merchant'", int(b.merchant_id, 'المنشأة', 1, 2 ** 31));
  } else {
    m = await db.get("SELECT * FROM users WHERE role='merchant' ORDER BY (status='active') DESC, id ASC LIMIT 1");
  }
  if (!m) throw bad('يرجى إضافة منشأة أولاً');
  const address = str(b.customer_address, 'عنوان التوصيل', 2, 250);
  let cap = null;
  if (b.captain_id != null && b.captain_id !== '') {
    cap = await db.get("SELECT * FROM users WHERE id=? AND role='captain'", int(b.captain_id, 'الكابتن', 1, 2 ** 31));
    if (!cap) throw bad('الكابتن غير موجود');
  }
  const now = Date.now();
  const orderId = await tx(async () => {
    const st = cap ? 'accepted' : 'searching';
    const r = await db.run(
      'INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,product_amount,delivery_fee,status,captain_id,accepted_at,created_at) VALUES(?,?,?,?,?,0,0,?,?,?,?)',
      m.id, m.zone_id || 1, '—', '', address, st, cap ? cap.id : null, cap ? now : null, now
    );
    await addEvent(r.lastInsertRowid, 'created', req.user.id);
    if (cap) {
      await db.run("UPDATE users SET online=1, status='active', last_assigned_at=? WHERE id=?", now, cap.id);
      await addEvent(r.lastInsertRowid, 'admin_assigned', req.user.id, { captain_id: cap.id });
    }
    return Number(r.lastInsertRowid);
  });
  await audit(req.user.id, 'admin_create_order', { id: orderId, merchant_id: m.id, captain_id: cap?.id ?? null });
  if (!cap) await dispatchOrder(orderId);
  await notifyOrder(orderId);
  res.status(201).json(await viewOrder(await db.get('SELECT * FROM orders WHERE id=?', orderId), 'admin'));
}));
A.post('/orders/:id/assign-captain', wrap(async (req, res) => {
  const id = oid(req);
  const o = await db.get('SELECT * FROM orders WHERE id=?', id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  if (['delivered', 'cancelled', 'failed'].includes(o.status)) throw bad('لا يمكن تعيين كابتن لطلب مغلق');
  const capId = int(req.body?.captain_id, 'الكابتن', 1, 2 ** 31);
  const cap = await db.get("SELECT * FROM users WHERE id=? AND role='captain'", capId);
  if (!cap) throw new HttpError(404, 'الكابتن غير موجود');
  const oldCapId = o.captain_id;
  const oldOfferedId = o.offered_captain_id;
  const now = Date.now();
  await tx(async () => {
    const newStatus = ['picked_up', 'arrived'].includes(o.status) ? o.status : 'accepted';
    await db.run("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'", id);
    await db.run(
      'UPDATE orders SET status=?, captain_id=?, accepted_at=COALESCE(accepted_at, ?), offered_captain_id=NULL, offer_expires_at=NULL, closed_at=NULL, close_reason=NULL WHERE id=?',
      newStatus, cap.id, now, id
    );
    await db.run("UPDATE users SET online=1, status='active', last_assigned_at=? WHERE id=?", now, cap.id);
    await addEvent(id, 'admin_assigned', req.user.id, { captain_id: cap.id, from_captain: oldCapId });
  });
  await audit(req.user.id, 'assign_captain', { order_id: id, captain_id: cap.id });
  const freshOrder = await db.get('SELECT * FROM orders WHERE id=?', id);
  if (oldOfferedId && oldOfferedId !== cap.id) sendTo(oldOfferedId, { type: 'offer_end', order_id: id, reason: 'admin_reassigned' });
  if (oldCapId && oldCapId !== cap.id) sendTo(oldCapId, { type: 'order', order: await viewOrder(freshOrder, 'captain') });
  await notifyOrder(id);
  res.json(await viewOrder(freshOrder, 'admin'));
}));
A.post('/orders/:id/unassign-captain', wrap(async (req, res) => {
  const id = oid(req);
  const o = await db.get('SELECT * FROM orders WHERE id=?', id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  if (['delivered', 'cancelled', 'failed'].includes(o.status)) throw bad('الطلب مغلق بالفعل');
  const oldCapId = o.captain_id;
  const oldOfferedId = o.offered_captain_id;
  if (!oldCapId && !oldOfferedId) throw bad('الطلب ليس مسنداً لأي كابتن حالياً');
  await tx(async () => {
    await db.run("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'", id);
    await db.run(
      "UPDATE orders SET status='searching', captain_id=NULL, offered_captain_id=NULL, offer_expires_at=NULL, accepted_at=NULL, picked_at=NULL, created_at=? WHERE id=?",
      Date.now(), id
    );
    await addEvent(id, 'admin_unassigned', req.user.id, { from_captain: oldCapId || oldOfferedId });
  });
  await audit(req.user.id, 'unassign_captain', { order_id: id, from_captain: oldCapId || oldOfferedId });
  const freshOrder = await db.get('SELECT * FROM orders WHERE id=?', id);
  if (oldOfferedId) sendTo(oldOfferedId, { type: 'offer_end', order_id: id, reason: 'admin_unassigned' });
  if (oldCapId) sendTo(oldCapId, { type: 'order', order: await viewOrder(freshOrder, 'captain') });
  await notifyOrder(id);
  res.json(await viewOrder(freshOrder, 'admin'));
}));
A.get('/orders/:id', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', oid(req));
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  const [view, events] = await Promise.all([
    viewOrder(o, 'admin'),
    db.all('SELECT e.type,e.at,e.data,u.name actor FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE order_id=? ORDER BY e.id', o.id),
  ]);
  res.json({ ...view, events });
}));
A.post('/orders/:id/redispatch', wrap(async (req, res) => {
  const id = oid(req);
  const o = await db.get('SELECT * FROM orders WHERE id=?', id);
  if (!o || !['searching', 'expired'].includes(o.status)) throw bad('الطلب ليس في حالة انتظار');
  await tx(async () => {
    await db.run('DELETE FROM offers WHERE order_id=?', id);
    await db.run("UPDATE orders SET status='searching', closed_at=NULL, close_reason=NULL, created_at=? WHERE id=?", Date.now(), id);
  });
  await dispatchOrder(id);
  await notifyOrder(id);
  res.json(await viewOrder(await db.get('SELECT * FROM orders WHERE id=?', id), 'admin'));
}));
A.post('/orders/:id/cancel', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', oid(req));
  if (!o || ['delivered', 'cancelled', 'failed', 'expired'].includes(o.status)) throw bad('لا يمكن إلغاء الطلب');
  await closeOrder(o.id, 'cancelled', { actor: req.user.id, reason: 'admin_cancelled' });
  await audit(req.user.id, 'order_cancel', { id: o.id });
  res.json({ ok: true });
}));
/** Dispute resolution: captain at fault (damage / delay) → liability = product amount (or custom). */
A.post('/orders/:id/liability', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id=?', oid(req));
  if (!o || !o.captain_id) throw bad('الطلب بلا كابتن');
  const amount = int(req.body?.amount ?? o.product_amount, 'المبلغ', 0, 100_000_000);
  const reason = str(req.body?.reason, 'السبب', 3, 200);
  await db.run('UPDATE orders SET liability=?, liability_reason=? WHERE id=?', amount, reason, o.id);
  await addEvent(o.id, 'liability', req.user.id, { amount, reason });
  await audit(req.user.id, 'liability', { id: o.id, amount, reason });
  await notifyOrder(o.id);
  res.json({ ok: true });
}));

A.get('/settlements', wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day)) ? req.query.day : dayOf();
  const rows = await db.all(
    `SELECT o.captain_id, u.name, u.phone,
       SUM(o.status='delivered') orders_count, SUM(o.commission) commission_total, SUM(o.liability) liability_total
     FROM orders o JOIN users u ON u.id=o.captain_id
     WHERE o.day=? AND o.status IN ('delivered','failed') GROUP BY o.captain_id`,
    day
  );
  const out = await Promise.all(rows.map(async (r) => {
    const s = await db.get('SELECT collected_at FROM settlements WHERE captain_id=? AND day=?', r.captain_id, day);
    return { ...r, total: r.commission_total + r.liability_total, collected_at: s?.collected_at ?? null };
  }));
  res.json({ day, rows: out });
}));
A.post('/settlements/collect', wrap(async (req, res) => {
  const day = String(req.body?.day), cid = int(req.body?.captain_id, 'captain', 1, 2 ** 31);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('تاريخ غير صالح');
  const r = await db.get("SELECT SUM(status='delivered') n, COALESCE(SUM(commission),0) c, COALESCE(SUM(liability),0) l FROM orders WHERE captain_id=? AND day=? AND status IN ('delivered','failed')", cid, day);
  if (!r.n && !r.l) throw bad('لا توجد تسوية لهذا اليوم');
  await db.run(
    'INSERT OR IGNORE INTO settlements(captain_id,day,orders_count,commission_total,liability_total,total,collected_at,collected_by) VALUES(?,?,?,?,?,?,?,?)',
    cid, day, r.n, r.c, r.l, r.c + r.l, Date.now(), req.user.id
  );
  await audit(req.user.id, 'settlement_collect', { cid, day, total: r.c + r.l });
  res.json({ ok: true });
}));

A.get('/flags', wrap(async (_req, res) => res.json(await db.all(`
  SELECT f.id,f.reason,f.at,f.resolved,f.captain_id,c.name captain_name,c.status captain_status
  FROM flags f JOIN users c ON c.id=f.captain_id ORDER BY f.resolved, f.id DESC LIMIT 200`))));
A.post('/flags/:id/resolve', wrap(async (req, res) => {
  await db.run('UPDATE flags SET resolved=1 WHERE id=?', oid(req));
  res.json({ ok: true });
}));
A.get('/captains/:id/track', wrap(async (req, res) => {
  const rows = await db.all('SELECT lat,lng,order_id,at FROM locations WHERE captain_id=? ORDER BY id DESC LIMIT 300', int(req.params.id, 'id', 1, 2 ** 31));
  res.json(rows.reverse());
}));

A.put('/settings/commission', wrap(async (req, res) => {
  const v = int(req.body?.value, 'العمولة', 0, 1_000_000);
  await setSetting('commission', v);
  await audit(req.user.id, 'commission', { v });
  res.json({ commission: v });
}));

// ---------- errors ----------
api.use((_req, res) => res.status(404).json({ error: 'غير موجود' }));
api.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'طلب غير صالح' });
  console.error(err);
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
});
