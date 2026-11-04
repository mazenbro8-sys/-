import { db, tx, addEvent, commission } from './db.js';
import { config, dayOf } from './config.js';
import { sendTo, sendToAdmins, isConnected } from './realtime.js';

export const ACTIVE = ['accepted', 'picked_up', 'arrived'];

export function haversineKm(a, b, c, d) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(c - a), dLng = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Order as seen by each role. Customer details are hidden from captains until they accept. */
export function viewOrder(o, role) {
  if (!o) return null;
  const m = db.prepare('SELECT id,name,business_name,address,lat,lng,phone FROM users WHERE id=?').get(o.merchant_id);
  const cap = o.captain_id ? db.prepare('SELECT id,name,phone,last_lat,last_lng,last_loc_at FROM users WHERE id=?').get(o.captain_id) : null;
  const v = {
    id: o.id, serial_no: String(o.id).padStart(4, '0'),
    status: o.status, zone_id: o.zone_id, created_at: o.created_at,
    customer_address: o.customer_address, customer_lat: o.customer_lat, customer_lng: o.customer_lng,
    product_amount: o.product_amount, delivery_fee: o.delivery_fee, notes: o.notes,
    merchant: { name: m.business_name || m.name, address: m.address, lat: m.lat, lng: m.lng, phone: role === 'captain' && !o.captain_id ? undefined : m.phone },
    offer_expires_at: o.offer_expires_at, commission: o.commission, liability: o.liability,
    liability_reason: o.liability_reason, close_reason: o.close_reason, closed_at: o.closed_at,
  };
  const showCustomer = role !== 'captain' || (o.captain_id && ACTIVE.concat(['delivered', 'failed']).includes(o.status));
  if (showCustomer) {
    Object.assign(v, { customer_name: o.customer_name, customer_phone: o.customer_phone });
  }
  if (role !== 'captain' && cap && ACTIVE.includes(o.status)) {
    const target = o.status === 'accepted' ? m : { lat: o.customer_lat, lng: o.customer_lng };
    let eta = null;
    if (cap.last_lat != null && target.lat != null)
      eta = Math.max(1, Math.round((haversineKm(cap.last_lat, cap.last_lng, target.lat, target.lng) / config.etaSpeedKmh) * 60));
    v.captain = { id: cap.id, name: cap.name, phone: cap.phone, lat: cap.last_lat, lng: cap.last_lng, at: cap.last_loc_at };
    v.eta_minutes = eta;
  } else if (role !== 'captain' && cap) {
    v.captain = { id: cap.id, name: cap.name, phone: cap.phone };
  }
  if (role === 'admin') {
    v.captain_id = o.captain_id;
    v.offered_captain_id = o.offered_captain_id;
    if (cap) v.captain_name = cap.name;
    if (o.offered_captain_id) {
      const offCap = db.prepare('SELECT id,name,phone FROM users WHERE id=?').get(o.offered_captain_id);
      if (offCap) v.offered_captain = offCap;
    }
  }
  return v;
}

export function computeShortage() {
  const searchingRows = db.prepare("SELECT * FROM orders WHERE status='searching' ORDER BY id ASC").all();
  const escalatedOrders = searchingRows.filter((o) => {
    const untriedCap = db.prepare(`
      SELECT 1 FROM users u
      WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
        AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)
      LIMIT 1
    `).get(o.zone_id, o.id);
    return !untriedCap;
  }).map((o) => viewOrder(o, 'admin'));

  const freeOnlineCaptains = db.prepare(`
    SELECT COUNT(*) c FROM users u
    WHERE u.role='captain' AND u.status='active' AND u.online=1
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.captain_id=u.id AND o.status IN ('accepted','picked_up','arrived'))
  `).get().c;
  const onlineCaptains = db.prepare("SELECT COUNT(*) c FROM users WHERE role='captain' AND status='active' AND online=1").get().c;
  const alert = escalatedOrders.length > 0;
  return {
    alert,
    searchingCount: escalatedOrders.length,
    unassignedCount: escalatedOrders.length,
    freeOnlineCaptains,
    onlineCaptains,
    orders: escalatedOrders,
  };
}

export function notifyOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) return;
  sendTo(o.merchant_id, { type: 'order', order: viewOrder(o, 'merchant') });
  sendToAdmins({ type: 'order', order: viewOrder(o, 'admin'), shortage: computeShortage() });
  if (o.captain_id) sendTo(o.captain_id, { type: 'order', order: viewOrder(o, 'captain') });
}

/**
 * Round-robin dispatch in 2 passes before escalating to Admin:
 * Pass 1: Free online captains in the zone who haven't been offered this order.
 * Pass 2: Busy online captains in the zone (with an active order, but no current pending offer) who haven't been offered this order.
 * If neither Pass 1 nor Pass 2 finds a captain, returns null → order remains in 'searching' and escalates to Admin.
 */
function pickCaptain(order) {
  const freeRows = db.prepare(`
    SELECT u.id FROM users u
    WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE (o.captain_id=u.id AND o.status IN ('accepted','picked_up','arrived')) OR (o.offered_captain_id=u.id AND o.status='offered'))
      AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)
    ORDER BY u.last_assigned_at ASC, u.id ASC`).all(order.zone_id, order.id);
  const freePick = freeRows.find((r) => isConnected(r.id)) ?? freeRows[0];
  if (freePick) return freePick;

  const busyRows = db.prepare(`
    SELECT u.id FROM users u
    WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.offered_captain_id=u.id AND o.status='offered')
      AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)
    ORDER BY u.last_assigned_at ASC, u.id ASC`).all(order.zone_id, order.id);
  return busyRows.find((r) => isConnected(r.id)) ?? busyRows[0] ?? null;
}

export function dispatchOrder(orderId) {
  let offered = null;
  tx(() => {
    const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='searching'").get(orderId);
    if (!o) return;
    const c = pickCaptain(o);
    if (!c) return;
    const exp = Date.now() + config.offerTimeoutMs;
    db.prepare("UPDATE orders SET status='offered', offered_captain_id=?, offer_expires_at=? WHERE id=?").run(c.id, exp, o.id);
    db.prepare("INSERT INTO offers(order_id,captain_id,outcome,at) VALUES(?,?, 'pending', ?)").run(o.id, c.id, Date.now());
    addEvent(o.id, 'offered', c.id, { expires_at: exp });
    offered = { captain: c.id };
  });
  if (offered) {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    sendTo(offered.captain, { type: 'offer', order: viewOrder(o, 'captain') });
    notifyOrder(orderId);
  }
  return !!offered;
}

/** Offer → back to the pool (rejected / timed out). */
export function releaseOffer(orderId, outcome) {
  tx(() => {
    const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='offered'").get(orderId);
    if (!o) return;
    db.prepare("UPDATE offers SET outcome=? WHERE order_id=? AND captain_id=? AND outcome='pending'").run(outcome, o.id, o.offered_captain_id);
    db.prepare("UPDATE orders SET status='searching', offered_captain_id=NULL, offer_expires_at=NULL WHERE id=?").run(o.id);
    addEvent(o.id, outcome, o.offered_captain_id);
    sendTo(o.offered_captain_id, { type: 'offer_end', order_id: o.id, reason: outcome });
  });
  dispatchOrder(orderId);
  notifyOrder(orderId);
}

export function closeOrder(orderId, status, { actor, reason, withCommission = false, liability = 0, liabilityReason = null } = {}) {
  tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    const now = Date.now();
    db.prepare(`UPDATE orders SET status=?, closed_at=?, day=?, close_reason=?, commission=?, liability=?, liability_reason=?, offered_captain_id=NULL, offer_expires_at=NULL WHERE id=?`)
      .run(status, now, dayOf(now), reason ?? null, withCommission ? commission() : 0, liability, liabilityReason, orderId);
    if (o.status === 'offered') {
      db.prepare("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'").run(orderId);
      sendTo(o.offered_captain_id, { type: 'offer_end', order_id: orderId, reason: 'cancelled' });
    }
    addEvent(orderId, status, actor, { reason });
  });
  notifyOrder(orderId);
}

/** Periodic tick: expire offers, (re)dispatch waiting orders, expire stale searches. */
export function startDispatcher() {
  setInterval(() => {
    try {
      const now = Date.now();
      for (const o of db.prepare("SELECT id FROM orders WHERE status='offered' AND offer_expires_at<?").all(now)) releaseOffer(o.id, 'timeout');
      for (const o of db.prepare("SELECT id, created_at FROM orders WHERE status='searching'").all()) {
        if (now - o.created_at > config.searchMaxMs) closeOrder(o.id, 'expired', { reason: 'no_captain_available' });
        else dispatchOrder(o.id);
      }
    } catch (e) { console.error('dispatcher', e); }
  }, 5_000);
}
