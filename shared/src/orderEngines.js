/**
 * Ledger side effects when an order is paid / completed (ORD-H8, ORD-H9). Shared by the order service and the EPOS
 * offline sync, so an offline paid sale posts the same stock, loyalty and accounting effects as an online one.
 *
 * Each effect (stock, loyalty, sale) is tracked in `order_effects` (see orderEffects.js): it is claimed under a lease,
 * finished as done or failed, and a failed or abandoned effect is retried by retryOrderEffects. A successful effect is
 * never repeated. Failures are recorded and logged; they do not fail the order save.
 */
const pool = require('./db');
const inventory = require('./engines/inventory');
const wallet = require('./engines/wallet');
const accounting = require('./engines/accounting');
const { ensureEffectTable, runEffect, MAX_ATTEMPTS } = require('./orderEffects');
const { applyOrderReversal } = require('./orderReversal');

const ENGINE_EFFECTS = [
  ['stock', (rid, o) => inventory.deductForOrder(rid, o)],
  ['loyalty', (rid, o) => wallet.earnForOrder(rid, o)],
  ['sale', (rid, o) => accounting.postSaleFromOrder(rid, o)],
];

async function applyOrderEngines(restaurantId, order, { prevPayment } = {}) {
  if (!order || !restaurantId) return { effects: {} };
  const paidNow = String(order.payment_status || '').toLowerCase() === 'paid'
    && String(prevPayment || '').toLowerCase() !== 'paid';
  const completed = ['completed', 'delivered'].includes(String(order.status || ''));
  if (!(paidNow || (completed && String(order.payment_status || '').toLowerCase() === 'paid'))) return { effects: {} };
  // Orders posted before per-effect flags existed are complete.
  if (order.data && order.data.engines_posted) return { effects: {} };
  const effects = {};
  for (const [name, run] of ENGINE_EFFECTS) {
    effects[name] = await safeRun(restaurantId, order, { effect: name, flag: `engines_${name}`, run });
  }
  // Every effect done: keep the legacy flag so older readers and checks still see the order as posted.
  if (Object.values(effects).every((state) => state === 'done')) {
    await pool.query(
      `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id::text = $1 AND restaurant_id = $2`,
      [String(order.id), restaurantId, JSON.stringify({ engines_posted: true, engines_at: new Date().toISOString() })],
    ).catch((err) => console.error('[order-effects] could not set engines_posted', err.message));
  }
  return { effects };
}

/**
 * runEffect with its own error boundary. A database error while claiming or recording an effect is logged and reported as
 * 'error'. The order save that triggered it is not failed, and the effect stays claimable for a retry.
 */
async function safeRun(restaurantId, order, options) {
  try {
    return await runEffect(restaurantId, order, options);
  } catch (err) {
    console.error(`[order-effects] ${options.effect} could not be recorded for order ${order.id}: ${err.message}`);
    return 'error';
  }
}

function parseJsonColumns(row) {
  const out = { ...row };
  ['customer', 'items', 'history', 'data'].forEach((k) => {
    if (typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* keep the raw value */ }
    }
  });
  return out;
}

/**
 * Retries order effects that failed, or whose worker died while holding them (the lease ran out). Each order is
 * re-run through the same claim, so an effect that is done or currently held by another worker is not run again.
 */
async function retryOrderEffects({ limit = 20 } = {}) {
  await ensureEffectTable();
  const { rows } = await pool.query(
    `SELECT restaurant_id, order_id, effect FROM order_effects
     WHERE attempts < $1 AND (state = 'failed' OR (state = 'running' AND lease_until <= NOW()))
     ORDER BY updated_at
     LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  const byOrder = new Map();
  for (const row of rows) {
    const key = `${row.restaurant_id}\u0000${row.order_id}`;
    if (!byOrder.has(key)) byOrder.set(key, { restaurantId: row.restaurant_id, orderId: row.order_id, effects: new Set() });
    byOrder.get(key).effects.add(row.effect);
  }
  let retried = 0;
  for (const { restaurantId, orderId, effects } of byOrder.values()) {
    const { rows: found } = await pool.query(
      'SELECT * FROM orders WHERE id::text = $1 AND restaurant_id = $2',
      [orderId, restaurantId],
    );
    if (!found[0]) continue;
    const order = parseJsonColumns(found[0]);
    if ([...effects].some((e) => e.startsWith('reversal_'))) await applyOrderReversal(restaurantId, order);
    if ([...effects].some((e) => !e.startsWith('reversal_'))) await applyOrderEngines(restaurantId, order, { prevPayment: 'unpaid' });
    retried += 1;
  }
  return { orders: retried };
}

module.exports = { applyOrderEngines, retryOrderEffects, ENGINE_EFFECTS };
