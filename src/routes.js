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
const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

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
api.get('/zones', (_req, res) => res.json(db.prepare('SELECT id,name FROM zones WHERE active=1 ORDER BY name').all()));

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
api.post('/auth/register', (_req, res) => res.status(403).json({ error: 'التسجيل عن طريق الإدارة فقط' }));
const createAccount = wrap((req, res) => {
  const b = req.body ?? {};
  const role = b.role;
  if (!['merchant', 'captain'].includes(role)) throw bad('نوع الحساب غير صالح');
  const p = phone(b.phone);
  const name = str(b.name, 'الاسم', 2, 60);
  const pass = str(b.password, 'كلمة المرور', 6, 72);
  if (!/[A-Za-z\u0600-\u06FF]/.test(pass) || !/\d/.test(pass)) throw bad('كلمة المرور يجب أن تحتوي حروفاً وأرقاماً');
  const zone = int(b.zone_id, 'المنطقة', 1, 2 ** 31);
  if (!db.prepare('SELECT 1 FROM zones WHERE id=? AND active=1').get(zone)) throw bad('المنطقة غير موجودة');
  let business = null, address = null, lat = null, lng = null;
  if (role === 'merchant') {
    business = str(b.business_name, 'اسم المنشأة', 2, 80);
    address = str(b.address, 'العنوان', 3, 200);
    [lat, lng] = coord(b.lat, b.lng);
  }
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(p)) throw new HttpError(409, 'رقم الهاتف مسجل مسبقاً');
  db.prepare('INSERT INTO users(role,phone,name,pass_hash,zone_id,status,business_name,address,lat,lng,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(role, p, name, bcrypt.hashSync(pass, 12), zone, 'active', business, address, lat, lng, Date.now());
  audit(req.user.id, 'create_user', { role, phone: p });
  res.status(201).json({ ok: true, message: 'تم إنشاء الحساب' });
});

const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', 12);
api.post('/auth/login', loginLimiter, wrap((req, res) => {
  const p = phone(req.body?.phone);
  const pass = str(req.body?.password, 'كلمة المرور', 1, 72);
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  const now = Date.now();
  if (u && u.locked_until > now) {
    const mins = Math.max(1, Math.ceil((u.locked_until - now) / 60_000));
    throw new HttpError(429, `الحساب مقفل مؤقتاً بسبب محاولات فاشلة، حاول بعد ${mins} دقيقة`);
  }
  const ok = bcrypt.compareSync(pass, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const f = u.failed_logins + 1;
      db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(f >= 5 ? 0 : f, f >= 5 ? now + 5 * 60_000 : 0, u.id);
    }
    throw new HttpError(401, 'رقم الهاتف أو كلمة المرور غير صحيحة');
  }
  if (u.status === 'pending') throw new HttpError(403, 'حسابك بانتظار موافقة الإدارة');
  if (u.status === 'suspended') throw new HttpError(403, 'حسابك موقوف، تواصل مع الإدارة');
  db.prepare('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?').run(u.id);
  res.json({ token: signToken(u), user: publicUser(u) });
}));

api.get('/me', auth(), (req, res) => res.json(publicUser(req.user)));

api.post('/auth/logout-all', auth(), wrap((req, res) => {
  db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(req.user.id);
  res.json({ ok: true });
}));

api.post('/auth/password', auth(), wrap((req, res) => {
  const old = str(req.body?.old_password, 'كلمة المرور الحالية', 1, 72);
  const nw = str(req.body?.new_password, 'كلمة المرور الجديدة', 6, 72);
  if (!/\d/.test(nw) || !/[A-Za-z\u0600-\u06FF]/.test(nw)) throw bad('كلمة المرور يجب أن تحتوي حروفاً وأرقاماً');
  if (!bcrypt.compareSync(old, req.user.pass_hash)) throw new HttpError(403, 'كلمة المرور الحالية خاطئة');
  db.prepare('UPDATE users SET pass_hash=?, token_version=token_version+1 WHERE id=?').run(bcrypt.hashSync(nw, 12), req.user.id);
  res.json({ ok: true });
}));

// ---------- merchant ----------
const M = express.Router();
api.use('/merchant', auth('merchant'), M);

M.post('/orders', orderLimiter, wrap((req, res) => {
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
  const open = db.prepare("SELECT COUNT(*) c FROM orders WHERE merchant_id=? AND status IN ('searching','offered')").get(m.id).c;
  if (open >= 10) throw bad('لديك طلبات كثيرة قيد البحث عن كابتن');
  const r = tx(() => {
    const r = db.prepare('INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,product_amount,delivery_fee,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(m.id, m.zone_id, o.name, o.phone, o.address, clat, clng, o.amount, o.fee, o.notes, Date.now());
    addEvent(r.lastInsertRowid, 'created', m.id);
    return r.lastInsertRowid;
  });
  dispatchOrder(r);
  notifyOrder(r);
  res.status(201).json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(r), 'merchant'));
}));

M.get('/orders', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE merchant_id=? ORDER BY id DESC LIMIT 200').all(req.user.id);
  res.json(rows.map((o) => viewOrder(o, 'merchant')));
}));

const ownOrder = (req) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(oid(req), req.user.id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  return o;
};
M.get('/orders/:id', wrap((req, res) => {
  const o = ownOrder(req);
  const events = db.prepare('SELECT type,at,data FROM order_events WHERE order_id=? ORDER BY id').all(o.id);
  res.json({ ...viewOrder(o, 'merchant'), events });
}));
M.post('/orders/:id/cancel', wrap((req, res) => {
  const o = ownOrder(req);
  if (!['searching', 'offered'].includes(o.status)) throw bad('لا يمكن إلغاء الطلب بعد قبول الكابتن، تواصل مع الإدارة');
  closeOrder(o.id, 'cancelled', { actor: req.user.id, reason: 'merchant_cancelled' });
  res.json({ ok: true });
}));
M.get('/captain/:id/location', wrap((req, res) => {
  const o = db.prepare("SELECT 1 FROM orders WHERE merchant_id=? AND captain_id=? AND status IN ('accepted','picked_up','arrived')").get(req.user.id, int(req.params.id, 'id', 1, 2 ** 31));
  if (!o) throw new HttpError(404, 'غير متاح');
  const c = db.prepare('SELECT last_lat lat,last_lng lng,last_loc_at at FROM users WHERE id=?').get(req.params.id);
  res.json(c);
}));

// ---------- captain ----------
const C = express.Router();
api.use('/captain', auth('captain'), C);
const lastPing = new Map();

const activeOrder = (cid) => db.prepare("SELECT * FROM orders WHERE captain_id=? AND status IN ('accepted','picked_up','arrived') ORDER BY id ASC LIMIT 1").get(cid);
const activeOrders = (cid) => db.prepare("SELECT * FROM orders WHERE captain_id=? AND status IN ('accepted','picked_up','arrived') ORDER BY id ASC").all(cid);
const pendingOffer = (cid) => db.prepare("SELECT * FROM orders WHERE offered_captain_id=? AND status='offered' LIMIT 1").get(cid);

C.get('/state', wrap((req, res) => {
  const allAct = activeOrders(req.user.id), a = allAct[0] || null, off = pendingOffer(req.user.id);
  res.json({
    online: !!req.user.online,
    active: a ? viewOrder(a, 'captain') : null,
    activeOrders: allAct.map((x) => viewOrder(x, 'captain')),
    offer: off ? viewOrder(off, 'captain') : null,
    commission: commission(),
    intervals: { active: config.activeLocIntervalMs, idle: config.idleLocIntervalMs },
  });
}));

C.post('/online', wrap((req, res) => {
  const on = req.body?.online === true;
  if (!on) {
    if (activeOrder(req.user.id)) throw bad('لا يمكنك الخروج وعندك طلب نشط');
    const off = pendingOffer(req.user.id);
    if (off) releaseOffer(off.id, 'rejected');
  }
  db.prepare('UPDATE users SET online=? WHERE id=?').run(on ? 1 : 0, req.user.id);
  sendToAdmins({ type: 'captain', id: req.user.id, online: on, shortage: computeShortage() });
  res.json({ online: on });
}));

C.post('/location', wrap((req, res) => {
  const u = req.user;
  if (!u.online) return res.status(204).end(); // offline: no tracking at all
  const [lat, lng] = coord(req.body?.lat, req.body?.lng, true);
  const now = Date.now();
  const act = activeOrder(u.id);
  const minGap = (act ? config.activeLocIntervalMs : config.idleLocIntervalMs) * 0.8;
  if (now - (lastPing.get(u.id) ?? 0) < minGap) return res.status(204).end();
  lastPing.set(u.id, now);
  // basic anti-teleport sanity (>200 km/h between pings is ignored)
  if (u.last_lat != null && u.last_loc_at) {
    const hrs = (now - u.last_loc_at) / 3.6e6;
    if (hrs > 0 && haversineKm(u.last_lat, u.last_lng, lat, lng) / hrs > 200) return res.status(204).end();
  }
  db.prepare('UPDATE users SET last_lat=?, last_lng=?, last_loc_at=? WHERE id=?').run(lat, lng, now, u.id);
  db.prepare('INSERT INTO locations(captain_id,lat,lng,order_id,at) VALUES(?,?,?,?,?)').run(u.id, lat, lng, act?.id ?? null, now);
  if (act) {
    const m = { type: 'loc', order_id: act.id, lat, lng, at: now };
    const v = viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(act.id), 'merchant');
    sendTo(act.merchant_id, { ...m, eta_minutes: v.eta_minutes });
  } else {
    detectBypass(u, lat, lng, now);
  }
  sendToAdmins({ type: 'loc', captain_id: u.id, lat, lng, at: now, busy: !!act });
  res.status(204).end();
}));

/** Anti-bypass: an idle captain (no order through the app) lingering at a merchant of his zone. */
function detectBypass(u, lat, lng, now) {
  const near = db.prepare("SELECT id,business_name,lat,lng FROM users WHERE role='merchant' AND status='active' AND zone_id=? AND lat IS NOT NULL").all(u.zone_id)
    .filter((m) => haversineKm(lat, lng, m.lat, m.lng) < 0.06);
  for (const m of near) {
    const prev = db.prepare("SELECT 1 FROM locations WHERE captain_id=? AND order_id IS NULL AND at BETWEEN ? AND ? LIMIT 1").get(u.id, now - 6 * 60_000, now - 90_000);
    const recent = db.prepare('SELECT 1 FROM flags WHERE captain_id=? AND merchant_id=? AND at>?').get(u.id, m.id, now - 3 * 3600_000);
    const hasOrderRecently = db.prepare("SELECT 1 FROM orders WHERE captain_id=? AND merchant_id=? AND closed_at>?").get(u.id, m.id, now - 30 * 60_000);
    if (prev && !recent && !hasOrderRecently) {
      db.prepare('INSERT INTO flags(captain_id,merchant_id,reason,at) VALUES(?,?,?,?)')
        .run(u.id, m.id, `اشتباه التفاف: الكابتن متواجد قرب «${m.business_name}» بدون طلب عبر التطبيق`, now);
      sendToAdmins({ type: 'flag' });
    }
  }
}

C.post('/offers/:id/:action', wrap((req, res) => {
  const id = oid(req), act = req.params.action;
  if (!['accept', 'reject'].includes(act)) throw new HttpError(404, 'غير موجود');
  const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='offered' AND offered_captain_id=?").get(id, req.user.id);
  if (!o) throw new HttpError(409, 'العرض لم يعد متاحاً');
  if (act === 'reject') { releaseOffer(id, 'rejected'); return res.json({ ok: true }); }
  if (o.offer_expires_at < Date.now()) { releaseOffer(id, 'timeout'); throw new HttpError(409, 'انتهت مهلة العرض'); }
  tx(() => {
    const now = Date.now();
    const r = db.prepare("UPDATE orders SET status='accepted', captain_id=?, accepted_at=?, offered_captain_id=NULL, offer_expires_at=NULL WHERE id=? AND status='offered' AND offered_captain_id=?").run(req.user.id, now, id, req.user.id);
    if (!r.changes) throw new HttpError(409, 'العرض لم يعد متاحاً');
    db.prepare("UPDATE offers SET outcome='accepted' WHERE order_id=? AND captain_id=? AND outcome='pending'").run(id, req.user.id);
    db.prepare('UPDATE users SET last_assigned_at=? WHERE id=?').run(now, req.user.id);
    addEvent(id, 'accepted', req.user.id);
  });
  notifyOrder(id);
  res.json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'captain'));
}));

const NEXT = { accepted: 'picked_up', picked_up: 'arrived', arrived: 'delivered' };
C.post('/orders/:id/status', wrap((req, res) => {
  const id = oid(req);
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND captain_id=?').get(id, req.user.id);
  if (!o || !ACTIVE.includes(o.status)) throw new HttpError(404, 'الطلب غير موجود أو مغلق');
  const to = req.body?.status;
  if (to === 'failed_customer') {
    if (o.status === 'accepted') throw bad('لا يمكن الإبلاغ قبل استلام الطلب');
    closeOrder(id, 'failed', { actor: req.user.id, reason: 'customer_unreachable_or_wrong_address' });
    return res.json({ ok: true });
  }
  if (NEXT[o.status] !== to) throw bad('انتقال حالة غير صالح');
  if (to === 'delivered') {
    closeOrder(id, 'delivered', { actor: req.user.id, withCommission: true });
  } else {
    db.prepare('UPDATE orders SET status=?, picked_at=COALESCE(picked_at, ?) WHERE id=?').run(to, to === 'picked_up' ? Date.now() : null, id);
    addEvent(id, to, req.user.id);
    notifyOrder(id);
  }
  res.json({ ok: true });
}));

C.get('/summary', wrap((req, res) => {
  const day = dayOf();
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(commission),0) c, COALESCE(SUM(liability),0) l FROM orders WHERE captain_id=? AND day=? AND status IN ('delivered','failed')").get(req.user.id, day);
  const delivered = db.prepare("SELECT COUNT(*) n FROM orders WHERE captain_id=? AND day=? AND status='delivered'").get(req.user.id, day).n;
  res.json({ day, delivered, commission: r.c, liability: r.l, due: r.c + r.l });
}));
C.get('/history', wrap((req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE captain_id=? AND status IN ('delivered','failed') ORDER BY id DESC LIMIT 100").all(req.user.id).map((o) => viewOrder(o, 'captain')));
}));

// ---------- admin ----------
const A = express.Router();
api.use('/admin', auth('admin'), A);

A.get('/stats', wrap((_req, res) => {
  const one = (q, ...a) => db.prepare(q).get(...a).n;
  const day = dayOf();
  res.json({
    merchants: one("SELECT COUNT(*) n FROM users WHERE role='merchant' AND status='active'"),
    captains: one("SELECT COUNT(*) n FROM users WHERE role='captain' AND status='active'"),
    online: one("SELECT COUNT(*) n FROM users WHERE role='captain' AND online=1"),
    pending: one("SELECT COUNT(*) n FROM users WHERE status='pending'"),
    live: one("SELECT COUNT(*) n FROM orders WHERE status IN ('searching','offered','accepted','picked_up','arrived')"),
    deliveredToday: one("SELECT COUNT(*) n FROM orders WHERE day=? AND status='delivered'", day),
    flags: one('SELECT COUNT(*) n FROM flags WHERE resolved=0'),
    commission: commission(),
    shortage: computeShortage(),
  });
}));

A.get('/live', wrap((_req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE status IN ('searching','offered','accepted','picked_up','arrived') ORDER BY id DESC").all().map((o) => viewOrder(o, 'admin'));
  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all().map((o) => viewOrder(o, 'admin'));
  const captains = db.prepare("SELECT id,name,phone,zone_id,status,online,last_lat lat,last_lng lng,last_loc_at at FROM users WHERE role='captain' ORDER BY online DESC, (status='active') DESC, id DESC").all()
    .map((c) => {
      const acts = activeOrders(c.id);
      const act = acts[0] || null;
      return {
        ...c,
        online: !!c.online,
        busy: acts.length > 0,
        active_order_id: act?.id ?? null,
        active_orders: acts.map((x) => ({ id: x.id, serial_no: String(x.id).padStart(4, '0'), customer_address: x.customer_address, status: x.status })),
      };
    });
  const merchants = db.prepare("SELECT id,name,business_name,phone,address,zone_id,status,lat,lng FROM users WHERE role='merchant' ORDER BY (status='active') DESC, id DESC").all();
  res.json({ orders, recentOrders, captains, merchants, shortage: computeShortage() });
}));

A.post('/users', createAccount);
A.get('/users', wrap((req, res) => {
  const role = ['merchant', 'captain'].includes(req.query.role) ? req.query.role : null;
  const rows = db.prepare(`SELECT id,role,phone,name,business_name,address,zone_id,status,online,lat,lng,last_lat,last_lng,created_at FROM users WHERE role IN ('merchant','captain') ${role ? 'AND role=?' : ''} ORDER BY (status='pending') DESC, id DESC LIMIT 500`).all(...(role ? [role] : []));
  res.json(rows);
}));
A.patch('/users/:id', wrap((req, res) => {
  const id = oid(req);
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role IN ('merchant','captain')").get(id);
  if (!u) throw new HttpError(404, 'المستخدم غير موجود');
  const b = req.body ?? {};
  if (b.status != null) {
    if (!['active', 'suspended', 'pending'].includes(b.status)) throw bad('حالة غير صالحة');
    db.prepare('UPDATE users SET status=?, token_version=token_version+1, failed_logins=0, locked_until=0, online=CASE WHEN ?=\'active\' THEN online ELSE 0 END WHERE id=?').run(b.status, b.status, id);
    if (b.status === 'suspended' && u.role === 'captain') {
      const off = pendingOffer(id); if (off) releaseOffer(off.id, 'cancelled');
    }
  }
  if (b.zone_id != null) {
    const z = int(b.zone_id, 'zone', 1, 2 ** 31);
    if (!db.prepare('SELECT 1 FROM zones WHERE id=?').get(z)) throw bad('المنطقة غير موجودة');
    db.prepare('UPDATE users SET zone_id=? WHERE id=?').run(z, id);
  }
  if (b.lat != null) { const [la, ln] = coord(b.lat, b.lng, true); db.prepare('UPDATE users SET lat=?, lng=? WHERE id=?').run(la, ln, id); }
  audit(req.user.id, 'user_update', { id, ...b });
  res.json({ ok: true });
}));
A.post('/users/:id/reset-password', wrap((req, res) => {
  const id = oid(req);
  const pw = str(req.body?.password, 'كلمة المرور', 6, 72);
  db.prepare("UPDATE users SET pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0 WHERE id=? AND role IN ('merchant','captain')").run(bcrypt.hashSync(pw, 12), id);
  audit(req.user.id, 'reset_password', { id });
  res.json({ ok: true });
}));

A.get('/zones', wrap((_req, res) => res.json(db.prepare('SELECT * FROM zones ORDER BY id').all())));
A.post('/zones', wrap((req, res) => {
  const name = str(req.body?.name, 'اسم المنطقة', 2, 60);
  try { const r = db.prepare('INSERT INTO zones(name) VALUES(?)').run(name); res.status(201).json({ id: Number(r.lastInsertRowid), name }); }
  catch { throw new HttpError(409, 'المنطقة موجودة مسبقاً'); }
}));

A.get('/orders', wrap((req, res) => {
  const st = req.query.status;
  const rows = st
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT 300').all(String(st))
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
  res.json(rows.map((o) => viewOrder(o, 'admin')));
}));
A.post('/orders', wrap((req, res) => {
  const b = req.body ?? {};
  let m = null;
  if (b.merchant_id != null && b.merchant_id !== '') {
    m = db.prepare("SELECT * FROM users WHERE id=? AND role='merchant'").get(int(b.merchant_id, 'المنشأة', 1, 2 ** 31));
  } else {
    m = db.prepare("SELECT * FROM users WHERE role='merchant' ORDER BY (status='active') DESC, id ASC LIMIT 1").get();
  }
  if (!m) throw bad('يرجى إضافة منشأة أولاً');
  const address = str(b.customer_address, 'عنوان التوصيل', 2, 250);
  let cap = null;
  if (b.captain_id != null && b.captain_id !== '') {
    cap = db.prepare("SELECT * FROM users WHERE id=? AND role='captain'").get(int(b.captain_id, 'الكابتن', 1, 2 ** 31));
    if (!cap) throw bad('الكابتن غير موجود');
  }
  const now = Date.now();
  const orderId = tx(() => {
    const st = cap ? 'accepted' : 'searching';
    const r = db.prepare('INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,product_amount,delivery_fee,status,captain_id,accepted_at,created_at) VALUES(?,?,?,?,?,0,0,?,?,?,?)')
      .run(m.id, m.zone_id || 1, '—', '', address, st, cap ? cap.id : null, cap ? now : null, now);
    addEvent(r.lastInsertRowid, 'created', req.user.id);
    if (cap) {
      db.prepare("UPDATE users SET online=1, status='active', last_assigned_at=? WHERE id=?").run(now, cap.id);
      addEvent(r.lastInsertRowid, 'admin_assigned', req.user.id, { captain_id: cap.id });
    }
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'admin_create_order', { id: orderId, merchant_id: m.id, captain_id: cap?.id ?? null });
  if (!cap) dispatchOrder(orderId);
  notifyOrder(orderId);
  res.status(201).json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), 'admin'));
}));
A.post('/orders/:id/assign-captain', wrap((req, res) => {
  const id = oid(req);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  if (['delivered', 'cancelled', 'failed'].includes(o.status)) throw bad('لا يمكن تعيين كابتن لطلب مغلق');
  const capId = int(req.body?.captain_id, 'الكابتن', 1, 2 ** 31);
  const cap = db.prepare("SELECT * FROM users WHERE id=? AND role='captain'").get(capId);
  if (!cap) throw new HttpError(404, 'الكابتن غير موجود');
  const oldCapId = o.captain_id;
  const oldOfferedId = o.offered_captain_id;
  const now = Date.now();
  tx(() => {
    const newStatus = ['picked_up', 'arrived'].includes(o.status) ? o.status : 'accepted';
    db.prepare("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'").run(id);
    db.prepare('UPDATE orders SET status=?, captain_id=?, accepted_at=COALESCE(accepted_at, ?), offered_captain_id=NULL, offer_expires_at=NULL, closed_at=NULL, close_reason=NULL WHERE id=?')
      .run(newStatus, cap.id, now, id);
    db.prepare("UPDATE users SET online=1, status='active', last_assigned_at=? WHERE id=?").run(now, cap.id);
    addEvent(id, 'admin_assigned', req.user.id, { captain_id: cap.id, from_captain: oldCapId });
  });
  audit(req.user.id, 'assign_captain', { order_id: id, captain_id: cap.id });
  if (oldOfferedId && oldOfferedId !== cap.id) sendTo(oldOfferedId, { type: 'offer_end', order_id: id, reason: 'admin_reassigned' });
  if (oldCapId && oldCapId !== cap.id) sendTo(oldCapId, { type: 'order', order: viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'captain') });
  notifyOrder(id);
  res.json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'admin'));
}));
A.post('/orders/:id/unassign-captain', wrap((req, res) => {
  const id = oid(req);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  if (['delivered', 'cancelled', 'failed'].includes(o.status)) throw bad('الطلب مغلق بالفعل');
  const oldCapId = o.captain_id;
  const oldOfferedId = o.offered_captain_id;
  if (!oldCapId && !oldOfferedId) throw bad('الطلب ليس مسنداً لأي كابتن حالياً');
  tx(() => {
    db.prepare("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'").run(id);
    db.prepare("UPDATE orders SET status='searching', captain_id=NULL, offered_captain_id=NULL, offer_expires_at=NULL, accepted_at=NULL, picked_at=NULL, created_at=? WHERE id=?")
      .run(Date.now(), id);
    addEvent(id, 'admin_unassigned', req.user.id, { from_captain: oldCapId || oldOfferedId });
  });
  audit(req.user.id, 'unassign_captain', { order_id: id, from_captain: oldCapId || oldOfferedId });
  if (oldOfferedId) sendTo(oldOfferedId, { type: 'offer_end', order_id: id, reason: 'admin_unassigned' });
  if (oldCapId) sendTo(oldCapId, { type: 'order', order: viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'captain') });
  notifyOrder(id);
  res.json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'admin'));
}));
A.get('/orders/:id', wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(oid(req));
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  const events = db.prepare('SELECT e.type,e.at,e.data,u.name actor FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE order_id=? ORDER BY e.id').all(o.id);
  res.json({ ...viewOrder(o, 'admin'), events });
}));
A.post('/orders/:id/redispatch', wrap((req, res) => {
  const id = oid(req);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || !['searching', 'expired'].includes(o.status)) throw bad('الطلب ليس في حالة انتظار');
  tx(() => {
    db.prepare('DELETE FROM offers WHERE order_id=?').run(id);
    db.prepare("UPDATE orders SET status='searching', closed_at=NULL, close_reason=NULL, created_at=? WHERE id=?").run(Date.now(), id);
  });
  dispatchOrder(id);
  notifyOrder(id);
  res.json(viewOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(id), 'admin'));
}));
A.post('/orders/:id/cancel', wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(oid(req));
  if (!o || ['delivered', 'cancelled', 'failed', 'expired'].includes(o.status)) throw bad('لا يمكن إلغاء الطلب');
  closeOrder(o.id, 'cancelled', { actor: req.user.id, reason: 'admin_cancelled' });
  audit(req.user.id, 'order_cancel', { id: o.id });
  res.json({ ok: true });
}));
/** Dispute resolution: captain at fault (damage / delay) → liability = product amount (or custom). */
A.post('/orders/:id/liability', wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(oid(req));
  if (!o || !o.captain_id) throw bad('الطلب بلا كابتن');
  const amount = int(req.body?.amount ?? o.product_amount, 'المبلغ', 0, 100_000_000);
  const reason = str(req.body?.reason, 'السبب', 3, 200);
  db.prepare('UPDATE orders SET liability=?, liability_reason=? WHERE id=?').run(amount, reason, o.id);
  addEvent(o.id, 'liability', req.user.id, { amount, reason });
  audit(req.user.id, 'liability', { id: o.id, amount, reason });
  notifyOrder(o.id);
  res.json({ ok: true });
}));

A.get('/settlements', wrap((req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day)) ? req.query.day : dayOf();
  const rows = db.prepare(`
    SELECT o.captain_id, u.name, u.phone,
      SUM(o.status='delivered') orders_count, SUM(o.commission) commission_total, SUM(o.liability) liability_total
    FROM orders o JOIN users u ON u.id=o.captain_id
    WHERE o.day=? AND o.status IN ('delivered','failed') GROUP BY o.captain_id`).all(day);
  const out = rows.map((r) => {
    const s = db.prepare('SELECT collected_at FROM settlements WHERE captain_id=? AND day=?').get(r.captain_id, day);
    return { ...r, total: r.commission_total + r.liability_total, collected_at: s?.collected_at ?? null };
  });
  res.json({ day, rows: out });
}));
A.post('/settlements/collect', wrap((req, res) => {
  const day = String(req.body?.day), cid = int(req.body?.captain_id, 'captain', 1, 2 ** 31);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('تاريخ غير صالح');
  const r = db.prepare("SELECT SUM(status='delivered') n, COALESCE(SUM(commission),0) c, COALESCE(SUM(liability),0) l FROM orders WHERE captain_id=? AND day=? AND status IN ('delivered','failed')").get(cid, day);
  if (!r.n && !r.l) throw bad('لا توجد تسوية لهذا اليوم');
  db.prepare('INSERT OR IGNORE INTO settlements(captain_id,day,orders_count,commission_total,liability_total,total,collected_at,collected_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(cid, day, r.n, r.c, r.l, r.c + r.l, Date.now(), req.user.id);
  audit(req.user.id, 'settlement_collect', { cid, day, total: r.c + r.l });
  res.json({ ok: true });
}));

A.get('/flags', wrap((_req, res) => res.json(db.prepare(`
  SELECT f.id,f.reason,f.at,f.resolved,f.captain_id,c.name captain_name,c.status captain_status
  FROM flags f JOIN users c ON c.id=f.captain_id ORDER BY f.resolved, f.id DESC LIMIT 200`).all())));
A.post('/flags/:id/resolve', wrap((req, res) => {
  db.prepare('UPDATE flags SET resolved=1 WHERE id=?').run(oid(req));
  res.json({ ok: true });
}));
A.get('/captains/:id/track', wrap((req, res) => {
  res.json(db.prepare('SELECT lat,lng,order_id,at FROM locations WHERE captain_id=? ORDER BY id DESC LIMIT 300').all(int(req.params.id, 'id', 1, 2 ** 31)).reverse());
}));

A.put('/settings/commission', wrap((req, res) => {
  const v = int(req.body?.value, 'العمولة', 0, 1_000_000);
  setSetting('commission', v);
  audit(req.user.id, 'commission', { v });
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

