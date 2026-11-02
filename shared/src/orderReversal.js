/**
 * Reverses the ledger effects of a paid order that is cancelled or returned after its refund is recorded (ORD-H7,
 * phase 2). Each reversal (stock, loyalty, sale) is tracked in `order_effects` under the name `reversal_<effect>`, the same
 * way as the forward effects (see orderEffects.js). A reversal that fails or whose worker dies is retried by
 * retryOrderEffects, and a reversal that is done is never repeated. Only orders whose forward effects were posted are
 * reversed.
 */
const inventory = require('./engines/inventory');
const wallet = require('./engines/wallet');
const accounting = require('./engines/accounting');
const { runEffect } = require('./orderEffects');

const REVERSALS = [
  ['stock', (rid, o) => inventory.deductForOrder(rid, o, { reverse: true })],
  ['loyalty', (rid, o) => wallet.reverseLoyaltyForOrder(rid, o)],
  ['sale', (rid, o) => accounting.postSaleFromOrder(rid, o, { reverse: true })],
];

async function applyOrderReversal(restaurantId, order) {
  if (!order || !restaurantId) return;
  const d = order.data || {};
  const posted = d.engines_posted || ['engines_stock', 'engines_loyalty', 'engines_sale'].every((k) => d[k] === 'done');
  if (!posted) return;
  for (const [name, run] of REVERSALS) {
    try {
      await runEffect(restaurantId, order, { effect: `reversal_${name}`, flag: `reversal_${name}`, run });
    } catch (err) {
      // A database error while claiming or recording is logged; the reversal stays claimable for a retry.
      console.error(`[order-reversal] ${name} could not be recorded for order ${order.id}: ${err.message}`);
    }
  }
}

module.exports = { applyOrderReversal, REVERSALS };
