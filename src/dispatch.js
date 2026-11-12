import { db, tx, addEvent, commission, orderCostPoints, walletEnforcement, applyPointsEntry } from './db.js';
import { config, dayOf } from './config.js';
import { sendTo, sendToAdmins, isConnected } from './realtime.js';

export const ACTIVE = ['accepted', 'picked_up', 'arrived'];

export function haversineKm(a, b, c, d) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(c - a), dLng = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Resolve effective point cost & source for a captain accepting/assigned an order at `now`.
 * Precedence: active temporary exemption -> permanent override (0) -> custom positive override -> global default.
 */
export function resolveOrderCost(captain, defaultCost = config.defaultOrderCostPoints, now = Date.now()) {
  const baseDefault = Number.isInteger(Number(defaultCost)) && Number(defaultCost) >= 0 ? Number(defaultCost) : config.defaultOrderCostPoints;
  const hasFrom = captain?.exempt_from != null;
  const hasUntil = captain?.exempt_until != null;
  if (hasFrom || hasUntil) {
    const fromOk = !hasFrom || now >= Number(captain.exempt_from);
    const untilOk = !hasUntil || now <= Number(captain.exempt_until);
    if (fromOk && untilOk) {
      return { cost_points: 0, cost_source: 'exempt_temporary' };
    }
  }
  if (captain?.cost_override === 0) {
    return { cost_points: 0, cost_source: 'exempt_permanent' };
  }
  if (captain?.cost_override != null && Number.isInteger(Number(captain.cost_override)) && Number(captain.cost_override) > 0) {
    return { cost_points: Number(captain.cost_override), cost_source: 'override' };
  }
  return { cost_points: baseDefault, cost_source: 'default' };
}

/** Available spendable points for a captain after subtracting reserved open-order costs. */
export const captainAvailablePoints = (captain) =>
  Number(captain?.balance_points ?? 0) - Number(captain?.reserved_cost ?? 0);

function isWalletEligible(captain, defaultCost, enforced, now = Date.now()) {
  if (!enforced) return true;
  const { cost_points } = resolveOrderCost(captain, defaultCost, now);
  if (cost_points === 0) return true;
  return captainAvailablePoints(captain) >= cost_points;
}

/** Order as seen by each role. Customer details are hidden from captains until they accept. */
export async function viewOrder(o, role) {
  if (!o) return null;
  const [m, cap] = await Promise.all([
    db.get('SELECT id,name,business_name,address,lat,lng,phone FROM users WHERE id=?', o.merchant_id),
    o.captain_id ? db.get('SELECT id,name,phone,last_lat,last_lng,last_loc_at,last_loc_vis FROM users WHERE id=?', o.captain_id) : null,
  ]);
  const v = {
    id: o.id, serial_no: String(o.id).padStart(4, '0'),
    status: o.status, zone_id: o.zone_id, created_at: o.created_at,
    customer_address: o.customer_address, customer_lat: o.customer_lat, customer_lng: o.customer_lng,
    product_amount: o.product_amount, delivery_fee: o.delivery_fee, notes: o.notes,
    merchant: { name: m.business_name || m.name, address: m.address, lat: m.lat, lng: m.lng, phone: role === 'captain' && !o.captain_id ? undefined : m.phone },
    offer_expires_at: o.offer_expires_at, delay_until: o.delay_until ?? null, commission: o.commission, liability: o.liability,
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
    v.captain = { id: cap.id, name: cap.name, phone: cap.phone, lat: cap.last_lat, lng: cap.last_lng, at: cap.last_loc_at, last_loc_at: cap.last_loc_at, last_loc_vis: cap.last_loc_vis ?? null };
    v.eta_minutes = eta;
  } else if (role !== 'captain' && cap) {
    v.captain = { id: cap.id, name: cap.name, phone: cap.phone, at: cap.last_loc_at, last_loc_at: cap.last_loc_at, last_loc_vis: cap.last_loc_vis ?? null };
  }
  if (role !== 'merchant') {
    v.cost_points = o.cost_points ?? null;
    v.cost_source = o.cost_source ?? null;
  }
  if (role === 'admin') {
    v.captain_id = o.captain_id;
    v.offered_captain_id = o.offered_captain_id;
    if (cap) v.captain_name = cap.name;
    if (o.offered_captain_id) {
      const offCap = await db.get('SELECT id,name,phone FROM users WHERE id=?', o.offered_captain_id);
      if (offCap) v.offered_captain = offCap;
    }
  }
  return v;
}

export async function computeShortage(zoneId = null) {
  const hasZ = zoneId != null;
  const now = Date.now();
  const [defaultCost, enforced] = await Promise.all([orderCostPoints(), walletEnforcement()]);
  const waitingRows = hasZ
    ? await db.all("SELECT * FROM orders WHERE status IN ('searching','offered') AND (delay_until IS NULL OR delay_until <= ?) AND zone_id=? ORDER BY id ASC", now, zoneId)
    : await db.all("SELECT * FROM orders WHERE status IN ('searching','offered') AND (delay_until IS NULL OR delay_until <= ?) ORDER BY id ASC", now);
  const checked = await Promise.all(
    waitingRows.map(async (o) => {
      const effectiveStart = o.delay_until && o.delay_until > o.created_at ? o.delay_until : o.created_at;
      const isTimedOut = now - effectiveStart >= config.shortageTimeoutMs;
      if (isTimedOut) return viewOrder(o, 'admin');
      if (o.status !== 'searching') return null;
      const untriedCaps = await db.all(
        `SELECT u.id, u.balance_points, u.cost_override, u.exempt_from, u.exempt_until,
           COALESCE((SELECT SUM(o2.cost_points) FROM orders o2 WHERE o2.captain_id=u.id AND o2.status IN ('accepted','picked_up','arrived') AND o2.cost_points > 0), 0) reserved_cost
         FROM users u
         WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
           AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)`,
        o.zone_id,
        o.id
      );
      const hasEligible = untriedCaps.some((c) => isWalletEligible(c, defaultCost, enforced, now));
      return hasEligible ? null : viewOrder(o, 'admin');
    })
  );
  const escalatedOrders = checked.filter(Boolean);

  const onlineRows = await (hasZ
    ? db.all(`
        SELECT u.id, u.balance_points, u.cost_override, u.exempt_from, u.exempt_until,
          COALESCE((SELECT SUM(o2.cost_points) FROM orders o2 WHERE o2.captain_id=u.id AND o2.status IN ('accepted','picked_up','arrived') AND o2.cost_points > 0), 0) reserved_cost,
          EXISTS (SELECT 1 FROM orders o WHERE o.captain_id=u.id AND o.status IN ('accepted','picked_up','arrived')) is_busy
        FROM users u
        WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
      `, zoneId)
    : db.all(`
        SELECT u.id, u.balance_points, u.cost_override, u.exempt_from, u.exempt_until,
          COALESCE((SELECT SUM(o2.cost_points) FROM orders o2 WHERE o2.captain_id=u.id AND o2.status IN ('accepted','picked_up','arrived') AND o2.cost_points > 0), 0) reserved_cost,
          EXISTS (SELECT 1 FROM orders o WHERE o.captain_id=u.id AND o.status IN ('accepted','picked_up','arrived')) is_busy
        FROM users u
        WHERE u.role='captain' AND u.status='active' AND u.online=1
      `));
  const eligibleRows = onlineRows.filter((r) => isWalletEligible(r, defaultCost, enforced, now));
  const freeOnlineCaptains = eligibleRows.filter((r) => !r.is_busy).length;
  const onlineCaptains = eligibleRows.length;
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

export async function notifyOrder(orderId) {
  const o = await db.get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return;
  const [mOrder, aOrder, shortage, zoneShortage, cOrder] = await Promise.all([
    viewOrder(o, 'merchant'),
    viewOrder(o, 'admin'),
    computeShortage(),
    o.zone_id != null ? computeShortage(o.zone_id) : null,
    o.captain_id ? viewOrder(o, 'captain') : null,
  ]);
  sendTo(o.merchant_id, { type: 'order', order: mOrder });
  sendToAdmins({ type: 'order', order: aOrder, shortage, zoneShortage }, o.zone_id);
  if (o.captain_id) sendTo(o.captain_id, { type: 'order', order: cOrder });
}

/**
 * Round-robin dispatch in 2 passes before escalating to Admin:
 * Pass 1: Free online captains in the zone who haven't been offered this order.
 * Pass 2: Busy online captains in the zone (with an active order, but no current pending offer) who haven't been offered this order.
 * If neither Pass 1 nor Pass 2 finds a captain, returns null → order remains in 'searching' and escalates to Admin.
 */
async function pickCaptain(order) {
  const [defaultCost, enforced] = await Promise.all([orderCostPoints(), walletEnforcement()]);
  const now = Date.now();
  const freeAll = await db.all(
    `SELECT u.id, u.balance_points, u.cost_override, u.exempt_from, u.exempt_until,
       COALESCE((SELECT SUM(o2.cost_points) FROM orders o2 WHERE o2.captain_id=u.id AND o2.status IN ('accepted','picked_up','arrived') AND o2.cost_points > 0), 0) reserved_cost
     FROM users u
     WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE (o.captain_id=u.id AND o.status IN ('accepted','picked_up','arrived')) OR (o.offered_captain_id=u.id AND o.status='offered'))
       AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)
     ORDER BY u.last_assigned_at ASC, u.id ASC`,
    order.zone_id,
    order.id
  );
  const freeRows = freeAll.filter((r) => isWalletEligible(r, defaultCost, enforced, now));
  const freePick = freeRows.find((r) => isConnected(r.id)) ?? freeRows[0];
  if (freePick) return freePick;

  const busyAll = await db.all(
    `SELECT u.id, u.balance_points, u.cost_override, u.exempt_from, u.exempt_until,
       COALESCE((SELECT SUM(o2.cost_points) FROM orders o2 WHERE o2.captain_id=u.id AND o2.status IN ('accepted','picked_up','arrived') AND o2.cost_points > 0), 0) reserved_cost
     FROM users u
     WHERE u.role='captain' AND u.status='active' AND u.online=1 AND u.zone_id=?
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.offered_captain_id=u.id AND o.status='offered')
       AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id=? AND f.captain_id=u.id)
     ORDER BY u.last_assigned_at ASC, u.id ASC`,
    order.zone_id,
    order.id
  );
  const busyRows = busyAll.filter((r) => isWalletEligible(r, defaultCost, enforced, now));
  return busyRows.find((r) => isConnected(r.id)) ?? busyRows[0] ?? null;
}

export async function dispatchOrder(orderId) {
  let offered = null;
  await tx(async () => {
    const now = Date.now();
    const o = await db.get("SELECT * FROM orders WHERE id=? AND status='searching' AND (delay_until IS NULL OR delay_until <= ?)", orderId, now);
    if (!o) return;
    const c = await pickCaptain(o);
    if (!c) return;
    const exp = Date.now() + config.offerTimeoutMs;
    await db.run("UPDATE orders SET status='offered', offered_captain_id=?, offer_expires_at=? WHERE id=?", c.id, exp, o.id);
    await db.run("INSERT INTO offers(order_id,captain_id,outcome,at) VALUES(?,?, 'pending', ?)", o.id, c.id, Date.now());
    await addEvent(o.id, 'offered', c.id, { expires_at: exp });
    offered = { captain: c.id };
  });
  if (offered) {
    const o = await db.get('SELECT * FROM orders WHERE id=?', orderId);
    sendTo(offered.captain, { type: 'offer', order: await viewOrder(o, 'captain') });
    await notifyOrder(orderId);
  }
  return !!offered;
}

/** Offer → back to the pool (rejected / timed out). Silently redispatches to next available captain. */
export async function releaseOffer(orderId, outcome) {
  let prevCaptainId = null;
  let merchantId = null;
  await tx(async () => {
    const o = await db.get("SELECT * FROM orders WHERE id=? AND status='offered'", orderId);
    if (!o) return;
    prevCaptainId = o.offered_captain_id;
    merchantId = o.merchant_id;
    await db.run("UPDATE offers SET outcome=? WHERE order_id=? AND captain_id=? AND outcome='pending'", outcome, o.id, o.offered_captain_id);
    await db.run("UPDATE orders SET status='searching', offered_captain_id=NULL, offer_expires_at=NULL WHERE id=?", o.id);
    await addEvent(o.id, outcome, o.offered_captain_id);
  });
  if (prevCaptainId) sendTo(prevCaptainId, { type: 'offer_end', order_id: orderId, reason: outcome });
  const reoffered = await dispatchOrder(orderId);
  if (reoffered) {
    if (merchantId) {
      sendTo(merchantId, {
        type: 'order_update',
        order_id: orderId,
        status: 'offered',
        status_text: 'جاري البحث عن كابتن آخر...',
        message: 'جاري البحث عن كابتن بديل...',
      });
    }
  } else {
    await notifyOrder(orderId);
  }
}

export async function closeOrder(orderId, status, { actor, reason, withCommission = false, liability = 0, liabilityReason = null } = {}) {
  const comm = withCommission ? await commission() : 0;
  let cancelledOfferedId = null;
  let deductionRes = null;
  let orderZoneId = null;
  await tx(async () => {
    const o = await db.get('SELECT * FROM orders WHERE id=?', orderId);
    orderZoneId = o.zone_id;
    const now = Date.now();
    await db.run(
      `UPDATE orders SET status=?, closed_at=?, day=?, close_reason=?, commission=?, liability=?, liability_reason=?, offered_captain_id=NULL, offer_expires_at=NULL WHERE id=?`,
      status,
      now,
      dayOf(now),
      reason ?? null,
      comm,
      liability,
      liabilityReason,
      orderId
    );
    if (o.status === 'offered') {
      await db.run("UPDATE offers SET outcome='cancelled' WHERE order_id=? AND outcome='pending'", orderId);
      cancelledOfferedId = o.offered_captain_id;
    }
    if (status === 'delivered' && o.captain_id && Number(o.cost_points) > 0) {
      deductionRes = await applyPointsEntry({
        captainId: o.captain_id,
        kind: 'deduction',
        amount: -Number(o.cost_points),
        orderId: o.id,
        actorId: actor ?? o.captain_id,
        note: `خصم توصيل طلب #${String(o.id).padStart(4, '0')}`,
      });
    }
    await addEvent(orderId, status, actor, { reason });
  });
  if (cancelledOfferedId) sendTo(cancelledOfferedId, { type: 'offer_end', order_id: orderId, reason: 'cancelled' });
  if (deductionRes && !deductionRes.duplicate) {
    sendTo(deductionRes.entry.captain_id, { type: 'balance', balance_points: deductionRes.balance_points, entry: deductionRes.entry });
    sendToAdmins({ type: 'balance', captain_id: deductionRes.entry.captain_id, balance_points: deductionRes.balance_points }, orderZoneId);
  }
  await notifyOrder(orderId);
}

/** Periodic tick: expire offers, (re)dispatch waiting orders, trigger 5m shortage timeout, expire stale searches. */
export function startDispatcher() {
  let running = false;
  const alertedTimeouts = new Set();
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const o of await db.all("SELECT id FROM orders WHERE status='offered' AND offer_expires_at<?", now)) {
        await releaseOffer(o.id, 'timeout');
      }
      for (const o of await db.all("SELECT id, status, created_at, delay_until FROM orders WHERE status IN ('searching','offered')")) {
        if (o.delay_until && o.delay_until > now) continue;
        const effectiveStart = o.delay_until && o.delay_until > o.created_at ? o.delay_until : o.created_at;
        const elapsed = now - effectiveStart;
        if (o.status === 'searching') {
          if (elapsed > config.searchMaxMs) {
            await closeOrder(o.id, 'expired', { reason: 'no_captain_available' });
            alertedTimeouts.delete(o.id);
            continue;
          }
          await dispatchOrder(o.id);
        }
        if (elapsed >= config.shortageTimeoutMs && !alertedTimeouts.has(o.id)) {
          alertedTimeouts.add(o.id);
          await notifyOrder(o.id);
        }
      }
    } catch (e) { console.error('dispatcher', e); }
    finally { running = false; }
  }, 5_000);
}
