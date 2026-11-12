export const CAPTAIN_ACTIVE_STATUSES = ['accepted', 'picked_up', 'arrived'];
const CUSTOMER_STAGE_STATUSES = new Set(['picked_up', 'arrived']);

/**
 * Derive a captain marker's visual state from live order statuses.
 * Rules when online:
 *   - At least one active order in `picked_up` or `arrived`: green, pulsing (priority over blue).
 *   - Active orders only in `accepted`: blue, pulsing.
 *   - No active orders: yellow, pulsing.
 * When offline: gray, not pulsing.
 */
export function getCaptainVisualState(captain, liveOrders = []) {
  if (!captain?.online) {
    return {
      stateKey: 'gray',
      stateClass: 'ops-state-gray ops-offline',
      pulsing: false,
      busy: false,
      activeCount: 0,
      label: 'أوفلاين (غير متاح للنقل)',
    };
  }

  const statusesById = new Map();
  const extraStatuses = [];

  for (const o of liveOrders || []) {
    if (o && o.captain_id === captain.id && CAPTAIN_ACTIVE_STATUSES.includes(o.status)) {
      if (o.id != null) statusesById.set(o.id, o.status);
      else extraStatuses.push(o.status);
    }
  }

  for (const o of captain.active_orders || []) {
    if (!o) continue;
    const st = o.status || (statusesById.has(o.id) ? statusesById.get(o.id) : null);
    if (!st || !CAPTAIN_ACTIVE_STATUSES.includes(st)) continue;
    if (o.id != null) statusesById.set(o.id, st);
    else extraStatuses.push(st);
  }

  const statuses = [...statusesById.values(), ...extraStatuses];
  const activeCount = statuses.length;

  if (statuses.some((s) => CUSTOMER_STAGE_STATUSES.has(s))) {
    return {
      stateKey: 'green',
      stateClass: 'ops-state-green ops-pulsing',
      pulsing: true,
      busy: true,
      activeCount,
      label: 'أونلاين متجه/عند الزبون',
    };
  }

  if (activeCount > 0 || captain.busy) {
    return {
      stateKey: 'blue',
      stateClass: 'ops-state-blue ops-pulsing',
      pulsing: true,
      busy: true,
      activeCount: activeCount || 1,
      label: 'أونلاين متجه للمنشأة',
    };
  }

  return {
    stateKey: 'yellow',
    stateClass: 'ops-state-yellow ops-pulsing',
    pulsing: true,
    busy: false,
    activeCount: 0,
    label: 'أونلاين متاح',
  };
}
