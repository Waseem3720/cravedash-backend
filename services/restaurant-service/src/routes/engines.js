/**
 * Proper business engines — inventory, wallet/loyalty, accounting, payroll.
 * Config stays in domain_docs; ledgers post via these endpoints.
 */
const express = require('express');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { AppError, badRequest, forbidden, notFound } = require('@cravedash/shared/src/errors');
const pool = require('@cravedash/shared/src/db');
const {
  inventory, wallet, accounting, payroll, couriers, tips,
} = require('@cravedash/shared/src/engines');
const { getStripe } = require('@cravedash/shared/src/stripeClient');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

function assertNotEposSensitive(req) {
  if (req.user?.role === 'epos' || req.user?.till_id) {
    throw forbidden('EPOS cannot run back-office engine posts — use restaurant admin');
  }
}

function actor(req) {
  return req.user?.name || req.user?.email || req.user?.sub || null;
}

function mapEngineError(err) {
  if (err.status) throw err;
  throw badRequest(err.message || 'Engine error');
}

// ─── Inventory ───────────────────────────────────────────────
router.get('/engines/inventory/balances', asyncHandler(async (req, res) => {
  ok(res, await inventory.balances(rid(req)));
}));

router.post('/engines/inventory/stock-moves', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await inventory.postStockMove(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/inventory/wastage', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await inventory.postWastage(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/inventory/stock-take', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    ok(res, await inventory.postStockTake(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/inventory/grn', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await inventory.postGrn(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/inventory/deduct-order', asyncHandler(async (req, res) => {
  // Called by order-service / EPOS after accept/pay
  const order = req.body?.order || req.body;
  if (!order || !order.id) throw badRequest('order required');
  ok(res, await inventory.deductForOrder(rid(req), order));
}));

// ─── Wallet / loyalty ────────────────────────────────────────
router.get('/engines/wallet/report', asyncHandler(async (req, res) => {
  ok(res, await wallet.walletReport(rid(req), branchId(req)));
}));

router.get('/engines/loyalty/report', asyncHandler(async (req, res) => {
  ok(res, await wallet.loyaltyReport(rid(req), branchId(req)));
}));

router.post('/engines/wallet/credit', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await wallet.creditWallet(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/wallet/debit', asyncHandler(async (req, res) => {
  try {
    created(res, await wallet.debitWallet(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/loyalty/earn', asyncHandler(async (req, res) => {
  try {
    const result = await wallet.earnLoyalty(rid(req), { ...req.body, by: actor(req) });
    ok(res, result);
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/loyalty/redeem', asyncHandler(async (req, res) => {
  try {
    created(res, await wallet.redeemLoyalty(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

// ─── Accounting ──────────────────────────────────────────────
router.get('/engines/accounting/reports', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  ok(res, await accounting.reports(rid(req)));
}));

/** Sources the manual journal screens send (the Journals and Manual Journal tabs). Anything else is refused. */
const MANUAL_JOURNAL_SOURCES = new Set(['manual', 'journals']);

/** The manual journal source: missing or empty means 'manual'. Case and surrounding spaces are ignored. */
function manualJournalSource(value) {
  const text = value == null ? '' : String(value).trim().toLowerCase();
  const source = text === '' ? 'manual' : text;
  if (!MANUAL_JOURNAL_SOURCES.has(source)) {
    throw badRequest(`Unknown journal source "${source}". Manual journals use "manual" or "journals".`);
  }
  return source;
}

router.post('/engines/accounting/journals', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  // A manual journal carries only its own fields. Tax snapshots are never taken from the client. Protected sources
  // (sale, sale_reversal) are refused by the source allowlist here, and again by postJournal.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const source = manualJournalSource(body.source);
  try {
    created(res, await accounting.postJournal(rid(req), {
      date: body.date,
      description: body.description,
      lines: body.lines,
      ref: body.ref,
      source,
      by: actor(req),
    }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/accounting/expenses', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await accounting.postExpense(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

// ─── Payroll ─────────────────────────────────────────────────
router.get('/engines/payroll/report', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  ok(res, await payroll.report(rid(req)));
}));

router.post('/engines/payroll/attendance', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await payroll.postAttendance(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/payroll/runs/close', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await payroll.closeRun(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

// ─── Couriers / marketplaces ─────────────────────────────────
router.post('/engines/couriers/dispatch', asyncHandler(async (req, res) => {
  try {
    created(res, await couriers.dispatch(pool, rid(req), { ...req.body, by: actor(req) }, branchId(req) || null));
  } catch (e) { mapEngineError(e); }
}));

router.post('/engines/marketplaces/ingest', asyncHandler(async (req, res) => {
  const source = req.body?.source || req.query.source || 'unknown';
  created(res, await couriers.ingestMarketplaceOrder(rid(req), source, req.body || {}));
}));

router.post('/engines/marketplaces/:source/webhook', asyncHandler(async (req, res) => {
  // Public-ish: validated by integration secret header when present
  // Unverified duplicate of the signed route in marketplaceWebhook.js (SEC-C2). Refused outright.
  throw forbidden('Use the signed marketplace webhook route');
  const source = req.params.source;
  const restaurantHint = req.body?.restaurant_id || req.headers['x-restaurant-id'] || req.query.restaurant_id || rid(req);
  if (!restaurantHint) throw badRequest('restaurant_id required');
  created(res, await couriers.ingestMarketplaceOrder(String(restaurantHint), source, {
    ...req.body,
    external_id: req.body?.id || req.body?.orderId || req.body?.external_id,
  }));
}));

// ─── Tips ────────────────────────────────────────────────────
router.get('/engines/tips/report', asyncHandler(async (req, res) => {
  ok(res, await tips.report(rid(req)));
}));

router.post('/engines/tips/allocate', asyncHandler(async (req, res) => {
  assertNotEposSensitive(req);
  try {
    created(res, await tips.allocate(rid(req), { ...req.body, by: actor(req) }));
  } catch (e) { mapEngineError(e); }
}));

// ─── Card terminal charge (Stripe Terminal — dual-rail Connect) ────
router.post('/engines/terminals/charge', asyncHandler(async (req, res) => {
  const { amount, currency, reader_id, order_id, description, channel } = req.body || {};
  const pence = Math.round((+amount || 0) * 100);
  if (pence < 1) throw badRequest('amount required');
  // Every terminal charge must be tied to an order, so it can never take an amount with no sale behind it (SEC-H2).
  if (!order_id) throw badRequest('order_id is required for a terminal charge');
  // The charge must belong to an order of this restaurant, and its amount must match that order (audit 04 S-02, roadmap 1.2).
  // The allowed range is the order total up to the total plus the tip recorded on the order.
  if (order_id) {
    const { rows: ord } = await pool.query(
      'SELECT id, total, tip, payment_status FROM orders WHERE id = $1 AND restaurant_id = $2',
      [order_id, rid(req)],
    );
    if (!ord[0]) throw notFound('Order not found for this restaurant');
    if (String(ord[0].payment_status || '').toLowerCase() === 'paid') throw badRequest('Order is already paid');
    const total = Math.round(Number(ord[0].total) * 100);
    const tip = Math.max(0, Math.round(Number(ord[0].tip || 0) * 100));
    if (pence < total || pence > total + tip) {
      throw badRequest('Charge amount does not match the order total');
    }
  }
  try {
    const connect = require('@cravedash/shared/src/stripeConnect');
    const { stripe, config } = await getStripe();
    const restaurantId = rid(req);
    const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    const restaurant = rows[0] || { id: restaurantId };
    const data = restaurant.data && typeof restaurant.data === 'object' ? restaurant.data : {};
    const billing = {
      ...connect.BILLING_DEF,
      ...(data.billing || {}),
      stripe_account: data.stripe_account || data.billing?.stripe_account || restaurant.stripe_account,
    };
    billing.platform_fees = {
      online: +(billing.platform_fee || 0),
      table_qr: +(billing.platform_fee || 0),
      pos: +(billing.platform_fee || 0),
      ...(billing.platform_fees || {}),
    };
    const mode = connect.chargeModeOf(billing);
    const fees = connect.calcFees(billing, +amount, channel || 'pos');
    const applicationFeeCents = mode === 'direct'
      ? Math.max(0, Math.min(connect.toCents(fees.fee + fees.commission), Math.max(0, pence - 1)))
      : 0;
    const metadata = {
      restaurant_id: String(restaurantId),
      order_id: order_id ? String(order_id) : '',
      rail: mode === 'direct' ? 'own' : 'cravedash',
      charge_mode: mode,
      platform_fee: String(fees.fee),
      commission: String(fees.commission),
      channel: channel || 'pos',
      source: 'epos_terminal',
    };
    const params = {
      amount: pence,
      currency: (currency || restaurant.currency || 'gbp').toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: description || (order_id ? `Order ${order_id}` : 'EPOS charge'),
      metadata,
      statement_descriptor: String(config.statement_descriptor || 'CRAVEDASH').slice(0, 22),
    };
    let intent;
    let stripeAccount = null;
    if (mode === 'direct') {
      stripeAccount = billing.stripe_account;
      if (!stripeAccount) throw badRequest('Connect account required for direct terminal charges');
      params.application_fee_amount = applicationFeeCents;
      intent = await stripe.paymentIntents.create(params, { stripeAccount });
    } else {
      params.transfer_group = order_id ? `order_${order_id}` : `rest_${restaurantId}`;
      intent = await stripe.paymentIntents.create(params);
    }
    if (order_id) {
      await pool.query(
        `UPDATE orders
         SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb,
             payment_method = COALESCE(payment_method, 'card'),
             updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $3`,
        [
          order_id,
          JSON.stringify({
            stripe_payment_intent_id: intent.id,
            stripe_rail: metadata.rail,
            charge_mode: mode,
            application_fee: connect.fromCents(applicationFeeCents),
            platform_fee: fees.fee,
            commission: fees.commission,
            stripe_account: stripeAccount,
            payout_release_at: mode === 'platform_first' ? connect.releaseAtFrom(billing) : null,
          }),
          restaurantId,
        ],
      ).catch((err) => {
        // SEC-M15: a charge that is not linked to its order is refused before the reader takes the card (no fake success).
        console.error(`[terminal] order link failed: intent=${intent.id} order=${order_id} error=${err.message}`);
        throw new AppError('Card payment could not be linked to the order; the card was not charged', 503, 'LINK_FAILED');
      });
    }
    connect.logStripe('terminal.payment_intent.created', {
      intent_id: intent.id,
      mode,
      restaurant_id: restaurantId,
      order_id: order_id || null,
      application_fee_cents: applicationFeeCents,
    });
    if (reader_id) {
      const processOpts = stripeAccount ? { stripeAccount } : undefined;
      const processed = await stripe.terminal.readers.processPaymentIntent(
        reader_id,
        { payment_intent: intent.id },
        processOpts,
      );
      return ok(res, {
        payment_intent: intent,
        reader: processed,
        charge_mode: mode,
        application_fee: connect.fromCents(applicationFeeCents),
        stripe_account: stripeAccount,
      });
    }
    ok(res, {
      payment_intent: intent,
      client_secret: intent.client_secret,
      charge_mode: mode,
      application_fee: connect.fromCents(applicationFeeCents),
      stripe_account: stripeAccount,
    });
  } catch (e) {
    mapEngineError(e);
  }
}));

module.exports = router;
