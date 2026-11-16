/**
 * Live-map fast transfer logic (merchant → captain) for the admin live room.
 * Pure functions only (no DOM), shared by public/admin.js and node tests.
 * The server endpoint POST /api/admin/orders/:id/assign-captain stays the single source of truth.
 */
export const WAITING_STATUSES = ['searching', 'offered'];
export const LOCKED_STATUSES = ['picked_up', 'arrived'];
export const CLOSED_STATUSES = ['delivered', 'cancelled', 'failed', 'expired'];

export const TRANSFER_HINT_TEXT = 'اضغط على كابتن لنقل الطلب إليه';
export const CAPTAIN_OFFLINE_TEXT = 'الكابتن غير متصل';

/** True when an order belongs to the merchant (by merchant_id, falling back to merchant display name). */
export function orderBelongsToMerchant(o, m) {
  if (!o || !m) return false;
  if (o.merchant_id != null) return o.merchant_id === m.id;
  const oName = o.merchant?.name;
  return Boolean(oName && oName === (m.business_name || m.name));
}

/** Open (not closed) orders of a merchant from the live orders list. */
export function getMerchantOpenOrders(m, orders = []) {
  return (orders || []).filter((o) => orderBelongsToMerchant(o, m) && !CLOSED_STATUSES.includes(o.status));
}

/** A waiting order is searching/offered and has no assigned captain yet. */
export const isWaitingOrder = (o) => Boolean(o) && WAITING_STATUSES.includes(o.status) && o.captain_id == null;

/** The merchant's transferable waiting order (searching first, then offered), or null. */
export function getTransferableOrder(m, orders = []) {
  const open = getMerchantOpenOrders(m, orders).filter(isWaitingOrder);
  return open.find((o) => o.status === 'searching') || open.find((o) => o.status === 'offered') || null;
}

/**
 * Decide what tapping a merchant does when no captain is pre-selected.
 * Returns { action: 'clear' | 'select' | 'locked' | 'accepted' | 'none', orderId?, order? }.
 */
export function decideMerchantTap(m, orders = [], selection = null) {
  if (!m) return { action: 'none' };
  if (selection?.kind === 'merchant' && selection.merchantId === m.id) return { action: 'clear' };
  const transferable = getTransferableOrder(m, orders);
  if (transferable) return { action: 'select', orderId: transferable.id, order: transferable };
  const open = getMerchantOpenOrders(m, orders);
  const locked = open.find((o) => LOCKED_STATUSES.includes(o.status));
  if (locked) return { action: 'locked', order: locked };
  const accepted = open.find((o) => o.status === 'accepted');
  if (accepted) return { action: 'accepted', order: accepted };
  return { action: 'none' };
}

/**
 * Decide what tapping a captain does.
 * - No merchant selected → 'details' (open captain details card).
 * - Merchant selected + offline captain → 'offline' (client guard; selection is kept, nothing is sent).
 * - Merchant selected + selected order no longer waiting → 'stale'.
 * - Merchant selected + online captain → 'assign'.
 */
export function decideCaptainTap(captain, selection = null, orders = []) {
  if (!captain) return { action: 'none' };
  if (selection?.kind !== 'merchant') return { action: 'details' };
  if (!captain.online) return { action: 'offline' };
  const order = (orders || []).find((o) => o.id === selection.orderId);
  if (!isWaitingOrder(order)) return { action: 'stale' };
  return { action: 'assign', orderId: order.id, order };
}

export const transferSuccessText = (captainName, warning = null) =>
  warning ? `تم نقل الطلب إلى ${captainName} — ${warning}` : `تم نقل الطلب إلى ${captainName}`;

/**
 * Send exactly one assign request. The server decides; a returned warning never blocks the transfer.
 * Resolves { ok: true, order, warning, message } or { ok: false, status, error }.
 */
export async function performFastTransfer({ api, orderId, captain }) {
  try {
    const res = await api(`/admin/orders/${orderId}/assign-captain`, 'POST', { captain_id: captain.id });
    const warning = res?.warning || null;
    return { ok: true, order: res, warning, message: transferSuccessText(captain.name || 'الكابتن', warning) };
  } catch (err) {
    return { ok: false, status: err?.status ?? null, error: err?.message || 'تعذّر نقل الطلب' };
  }
}

/**
 * Full captain-tap flow: decide, then (only for 'assign') call `onStart` and send one request.
 * Returns the decision, plus `result` when a request was sent.
 */
export async function transferOnCaptainTap({ captain, selection, orders, api, onStart = null }) {
  const decision = decideCaptainTap(captain, selection, orders);
  if (decision.action !== 'assign') return decision;
  onStart?.(decision);
  const result = await performFastTransfer({ api, orderId: decision.orderId, captain });
  return { ...decision, result };
}
