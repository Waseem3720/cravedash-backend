/**
 * Keys inside an order's `data` that only the server writes (engines, payments, payouts). Clients, including offline
 * tills, cannot set them (ORD-H5, BUG-009). Shared by the order service and the EPOS sync so both apply the same rule.
 */
const SERVER_OWNED_DATA_KEYS = [
  'engines_posted', 'engines_at', 'engines_stock', 'engines_loyalty', 'engines_sale',
  'stripe_payment_intent_id', 'stripe_charge_id', 'stripe_refund_id',
  'refund_amount', 'payout_status', 'payout_release_at', 'charge_mode', 'paid_via_webhook_at',
  'commission', 'platform_fee', 'stripe_fee',
];

/** Client data with server-owned keys removed. */
function withoutServerKeys(data) {
  const out = { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) };
  SERVER_OWNED_DATA_KEYS.forEach((k) => delete out[k]);
  return out;
}

module.exports = { SERVER_OWNED_DATA_KEYS, withoutServerKeys };
