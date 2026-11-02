const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { notFound, badRequest, forbidden, AppError } = require('@cravedash/shared/src/errors');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');

function conflictError(message) {
  return new AppError(message, 409, 'CONFLICT');
}
const {
  getStripe,
  loadStripeConfig,
  resolveWebhookSecret,
  appBaseUrl,
  apiBaseUrl,
  clearStripeCache,
} = require('@cravedash/shared/src/stripeClient');
const connect = require('@cravedash/shared/src/stripeConnect');

const router = express.Router();

const BILLING_DEF = {
  ...connect.BILLING_DEF,
  channels: { online: true, table_qr: true, pos: false },
};

const { toCents, fromCents, calcFees, chargeModeOf, logStripe } = connect;

function flattenRestaurant(row) {
  if (!row) return row;
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  return { ...row, ...data, data };
}

async function loadRestaurant(id) {
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Restaurant not found');
  return flattenRestaurant(rows[0]);
}

function billingOf(restaurant) {
  const data = restaurant.data || {};
  const b = { ...BILLING_DEF, ...(data.billing || restaurant.billing || {}) };
  if (!b.schedule) b.schedule = BILLING_DEF.schedule || '7d';
  if (!b.payout_mode) b.payout_mode = BILLING_DEF.payout_mode || 'approval';
  b.channels = { ...BILLING_DEF.channels, ...(b.channels || {}) };
  b.platform_fees = {
    online: +(b.platform_fee || 0),
    table_qr: +(b.platform_fee || 0),
    pos: +(b.platform_fee || 0),
    ...(b.platform_fees || {}),
  };
  const acct = restaurant.stripe_account || data.stripe_account || b.stripe_account || '';
  if (acct) b.stripe_account = acct;
  b.stripe_connected = !!(
    restaurant.stripe_connected ||
    data.stripe_connected ||
    b.stripe_connected ||
    acct
  );
  return b;
}

async function patchRestaurantData(id, patch) {
  const { rows } = await pool.query('SELECT data FROM restaurants WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Restaurant not found');
  const data = { ...(rows[0].data || {}), ...patch };
  if (patch.billing && typeof patch.billing === 'object') {
    data.billing = { ...(rows[0].data?.billing || {}), ...patch.billing };
  }
  const { rows: updated } = await pool.query(
    `UPDATE restaurants SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(data)],
  );
  return flattenRestaurant(updated[0]);
}

function assertRestaurantAccess(req, rid) {
  if (req.user?.role === 'super') return rid;
  const own = restaurantId(req);
  if (!own || own !== rid) throw forbidden('Restaurant scope required');
  return rid;
}

/**
 * A branch login may act only on orders of its own branch (BUG-022). Restaurant-level scope alone is not enough.
 * Super admins and restaurant owners (no branch_id) are not limited here.
 */
function assertOrderBranchScope(req, order) {
  if (req.user?.role === 'super' || !req.user?.branch_id) return;
  if (String(order.branch_id || '') !== String(req.user.branch_id)) throw forbidden('This order belongs to another branch');
}

function resolveTargetRestaurantId(req, bodyRid) {
  if (req.user?.role === 'super') {
    return bodyRid || req.query.restaurant_id || req.headers['x-restaurant-id'] || null;
  }
  return restaurantId(req);
}

/** Only allow redirects back to our own app origin (blocks open-redirect phishing). */
function safeAppRedirect(req, candidate, fallbackPath) {
  const base = appBaseUrl(req).replace(/\/$/, '');
  const fallback = `${base}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}`;
  if (!candidate || typeof candidate !== 'string') return fallback;
  try {
    const allowed = new URL(base);
    const u = new URL(candidate, base);
    if (u.origin !== allowed.origin) return fallback;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

// ---- Connect Express onboard ----
router.post(
  '/stripe/connect/onboard',
  asyncHandler(async (req, res) => {
    const rid = resolveTargetRestaurantId(req, req.body?.restaurant_id);
    if (!rid) throw badRequest('restaurant_id required');
    assertRestaurantAccess(req, rid);

    const restaurant = await loadRestaurant(rid);
    const billing = billingOf(restaurant);
    const { stripe } = await getStripe();

    let accountId = billing.stripe_account || restaurant.stripe_account || '';
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: (restaurant.currency === 'CAD' ? 'CA' : 'GB'),
        email: restaurant.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: restaurant.name || undefined,
        },
        metadata: { restaurant_id: rid },
      });
      accountId = account.id;
      await patchRestaurantData(rid, {
        stripe_account: accountId,
        stripe_connected: false,
        charges_enabled: false,
        payouts_enabled: false,
        billing: { ...billing, stripe_account: accountId, stripe_connected: false },
      });
    }

    const refreshUrl = safeAppRedirect(
      req,
      req.body?.refresh_url,
      '/admin/third-party.html?stripe=refresh',
    );
    const returnUrl = safeAppRedirect(
      req,
      req.body?.return_url,
      '/admin/third-party.html?stripe=return',
    );

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    ok(res, {
      url: link.url,
      stripe_account: accountId,
      expires_at: link.expires_at,
    });
  }),
);

router.get(
  '/stripe/connect/status',
  asyncHandler(async (req, res) => {
    const rid = resolveTargetRestaurantId(req, req.query.restaurant_id);
    if (!rid) throw badRequest('restaurant_id required');
    assertRestaurantAccess(req, rid);

    const restaurant = await loadRestaurant(rid);
    const billing = billingOf(restaurant);
    const accountId = billing.stripe_account || restaurant.stripe_account;
    if (!accountId) {
      return ok(res, {
        stripe_account: null,
        stripe_connected: false,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      });
    }

    const { stripe } = await getStripe();
    const account = await stripe.accounts.retrieve(accountId);
    const connected = !!(account.charges_enabled && account.details_submitted);
    await patchRestaurantData(rid, {
      stripe_account: accountId,
      stripe_connected: connected,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      billing: {
        ...billing,
        stripe_account: accountId,
        stripe_connected: connected,
      },
    });

    ok(res, {
      stripe_account: accountId,
      stripe_connected: connected,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted,
      requirements: account.requirements || null,
    });
  }),
);

// ---- PaymentIntent (dual rail) ----
router.post(
  '/stripe/payments/intent',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const rid = resolveTargetRestaurantId(req, body.restaurant_id);
    if (!rid) throw badRequest('restaurant_id required');
    if (req.user?.role !== 'super') assertRestaurantAccess(req, rid);

    const restaurant = await loadRestaurant(rid);
    const billing = billingOf(restaurant);
    const channel = body.channel || 'online';
    let amount = body.amount != null ? +body.amount : null;
    let orderId = body.order_id || null;
    let order = null;

    if (orderId) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      order = rows[0];
      if (!order) throw notFound('Order not found');
      if (String(order.restaurant_id) !== String(rid)) {
        throw forbidden('Order belongs to another restaurant');
      }
      assertOrderBranchScope(req, order);
      // SEC-M13: no new payment for an order that is paid, refunded or cancelled, and a stored PaymentIntent id is never replaced.
      const paymentState = String(order.payment_status || '').toLowerCase();
      const orderState = String(order.status || '').toLowerCase();
      if (['paid', 'partially_refunded', 'refunded'].includes(paymentState)) {
        throw conflictError('Order is already paid or refunded; no payment can be taken');
      }
      if (['canceled', 'cancelled', 'refunded', 'returned'].includes(orderState)) {
        throw conflictError('Order is cancelled or returned; no payment can be taken');
      }
      if (order.data && order.data.stripe_payment_intent_id) {
        throw conflictError('Order already has a payment intent; it is not replaced');
      }
      // Never trust client amount when order is known — bind to DB total (+ optional tip)
      amount = +order.total || 0;
      const tip = body.tip != null ? +body.tip : 0;
      if (Number.isFinite(tip) && tip > 0 && tip <= Math.max(amount, 50)) {
        amount = Math.round((amount + tip) * 100) / 100;
      }
    }
    if (amount == null || !(amount > 0)) throw badRequest('amount or order_id required');
    // Cap orphan (no order) intents — prevents runaway charges from a stolen session
    if (!orderId && amount > 5000 && req.user?.role !== 'super') {
      throw badRequest('Amount exceeds limit without an order — create the order first');
    }

    const currency = String(body.currency || restaurant.currency || 'gbp').toLowerCase();
    const { stripe, config } = await getStripe();
    const descriptor = (config.statement_descriptor || 'CRAVEDASH').slice(0, 22);

    const {
      intent, mode, fees, applicationFeeCents, metadata, stripeAccount,
    } = await connect.createVendorPaymentIntent(stripe, {
      restaurant: { ...restaurant, id: rid },
      billing,
      amount,
      currency,
      orderId,
      channel,
      descriptor,
    });

    if (orderId) {
      const nextData = {
        stripe_payment_intent_id: intent.id,
        stripe_rail: metadata.rail,
        charge_mode: mode,
        application_fee: fromCents(applicationFeeCents),
        platform_fee: fees.fee,
        commission: fees.commission,
        stripe_account: stripeAccount,
        payout_release_at: mode === 'platform_first'
          ? connect.releaseAtFrom(billing)
          : null,
        transfer_group: intent.transfer_group || (orderId ? `order_${orderId}` : null),
      };
      // Merge only the payment keys, and only while the order is still unpaid with no intent stored (SEC-M13).
      const { rows: stored } = await pool.query(
        `UPDATE orders SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb,
                payment_method = COALESCE(payment_method, 'stripe'), updated_at = NOW()
         WHERE id = $1
           AND NOT (COALESCE(data, '{}'::jsonb) ? 'stripe_payment_intent_id')
           AND LOWER(COALESCE(payment_status, '')) NOT IN ('paid', 'partially_refunded', 'refunded')
         RETURNING id`,
        [orderId, JSON.stringify(nextData)],
      );
      if (!stored[0]) {
        logStripe('payment_intent.not_stored', { order_id: orderId, intent_id: intent.id });
        throw conflictError('Order changed while the payment was being prepared; no payment was stored');
      }
    }

    ok(res, {
      id: intent.id,
      client_secret: intent.client_secret,
      amount: intent.amount,
      currency,
      rail: metadata.rail,
      charge_mode: mode,
      application_fee: fromCents(applicationFeeCents),
      platform_fee: fees.fee,
      commission: fees.commission,
      hold_days: mode === 'platform_first' ? connect.scheduleHoldDays(billing) : 0,
      publishable_key: (await getStripe()).publishableKey,
      stripe_account: stripeAccount,
    });
  }),
);

// ---- Subscription Checkout (platform) ----
router.post(
  '/stripe/subscriptions/checkout',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const rid = resolveTargetRestaurantId(req, body.restaurant_id);
    if (!rid) throw badRequest('restaurant_id required');
    assertRestaurantAccess(req, rid);

    const restaurant = await loadRestaurant(rid);
    const planId = body.plan_id || restaurant.plan_id;
    if (!planId) throw badRequest('plan_id required');

    const { rows: planRows } = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
    const plan = planRows[0];
    if (!plan) throw notFound('Plan not found');

    const cycle = body.billing_cycle || restaurant.billing_cycle || 'monthly';
    const price =
      cycle === 'yearly' ? +(plan.price_yearly || 0) : +(plan.price_monthly || 0);
    if (!(price > 0)) throw badRequest('Plan price must be greater than zero');

    const { stripe } = await getStripe();
    const currency = String(body.currency || restaurant.currency || 'gbp').toLowerCase();

    let customerId =
      restaurant.stripe_customer_id ||
      (restaurant.data && restaurant.data.stripe_customer_id) ||
      null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: restaurant.email || undefined,
        name: restaurant.name || undefined,
        metadata: { restaurant_id: rid },
      });
      customerId = customer.id;
      await patchRestaurantData(rid, { stripe_customer_id: customerId });
    }

    const planData = plan.data && typeof plan.data === 'object' ? plan.data : {};
    let priceId =
      (cycle === 'yearly' ? planData.stripe_price_yearly : planData.stripe_price_monthly) ||
      planData.stripe_price_id ||
      null;

    if (!priceId) {
      const productId = planData.stripe_product_id || undefined;
      let product = productId;
      if (!product) {
        const created = await stripe.products.create({
          name: `CraveDash — ${plan.name}`,
          metadata: { plan_id: plan.id },
        });
        product = created.id;
        await pool.query(
          `UPDATE plans SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
          [plan.id, JSON.stringify({ stripe_product_id: product })],
        );
      }
      const createdPrice = await stripe.prices.create({
        product,
        unit_amount: toCents(price),
        currency,
        recurring: { interval: cycle === 'yearly' ? 'year' : 'month' },
        metadata: { plan_id: plan.id, cycle },
      });
      priceId = createdPrice.id;
      const pricePatch =
        cycle === 'yearly'
          ? { stripe_price_yearly: priceId, stripe_product_id: product }
          : { stripe_price_monthly: priceId, stripe_product_id: product };
      await pool.query(
        `UPDATE plans SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [plan.id, JSON.stringify(pricePatch)],
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: safeAppRedirect(
        req,
        body.success_url,
        '/admin/subscription.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      ),
      cancel_url: safeAppRedirect(
        req,
        body.cancel_url,
        '/admin/subscription.html?checkout=cancel',
      ),
      metadata: {
        restaurant_id: rid,
        plan_id: plan.id,
        billing_cycle: cycle,
      },
      subscription_data: {
        metadata: {
          restaurant_id: rid,
          plan_id: plan.id,
          billing_cycle: cycle,
        },
      },
    });

    ok(res, {
      id: session.id,
      url: session.url,
      customer_id: customerId,
    });
  }),
);

// ---- Payout execute (Transfer on CraveDash rail) ----
router.post(
  '/stripe/payouts/:id/execute',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can execute payouts');

    const { rows } = await pool.query('SELECT * FROM payouts WHERE id = $1', [req.params.id]);
    const payout = rows[0];
    if (!payout) throw notFound('Payout not found');
    if (['paid', 'rejected', 'canceled'].includes(String(payout.status).toLowerCase())) {
      throw badRequest(`Payout already ${payout.status}`);
    }
    // P1: claim the payout before any transfer. Two executes (double click, retry, two admins) cannot both get past this.
    // A claim left 'processing' by a crash is taken over after 10 minutes. The Stripe idempotency key makes that retry safe.
    const { rows: claimed } = await pool.query(
      `UPDATE payouts SET status = 'processing', updated_at = NOW()
       WHERE id = $1 AND (
         LOWER(status) NOT IN ('paid', 'rejected', 'canceled', 'processing')
         OR (LOWER(status) = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
       )
       RETURNING id`,
      [payout.id],
    );
    if (!claimed[0]) throw conflictError('Payout is already being processed or has been paid');
    const restoreTo = String(payout.status).toLowerCase() === 'processing' ? 'pending' : payout.status;
    try {
      return await runPayoutExecution(req, res, { ...payout, status: restoreTo });
    } catch (err) {
      // Release the claim so the payout can be retried.
      await pool.query(`UPDATE payouts SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'processing'`, [payout.id, restoreTo])
        .catch((releaseErr) => console.error('[payouts] could not release claim', releaseErr));
      throw err;
    }
  }),
);

async function runPayoutExecution(req, res, payout) {
    const restaurant = await loadRestaurant(payout.restaurant_id);
    const billing = billingOf(restaurant);
    const amount = +(payout.amount || 0);
    if (!(amount > 0)) throw badRequest('Invalid payout amount');

    const data = payout.data && typeof payout.data === 'object' ? payout.data : {};
    const kind = data.kind || payout.kind || 'request';
    const { stripe } = await getStripe();
    const idempotencyKey = `payout-${payout.id}`;

    // Period batches (held orders) — Transfer via shared helper (order ledger already attached)
    if (kind === 'period_payout' || billing.account === 'cravedash') {
      // Ensure Connect destination on batch
      if (!data.stripe_account) {
        data.stripe_account = billing.stripe_account || restaurant.stripe_account;
        payout.data = data;
      }
      if (kind === 'period_payout' || data.order_ids) {
        const updated = await connect.executePayoutTransfer(stripe, { ...payout, data }, {
          by: req.user?.email || 'super',
          idempotencyKey,
        });
        return ok(res, {
          ...updated,
          restaurant: restaurant.name,
          kind: 'period_payout',
          stripe_transfer_id: updated.ref || updated.data?.stripe_transfer_id,
          totals: updated.data?.totals,
          lines: updated.data?.lines,
          receipt: updated.data?.receipt,
        });
      }
      // Legacy simple request without order lines
      const dest = billing.stripe_account || restaurant.stripe_account;
      if (!dest) throw badRequest('Restaurant must complete Stripe Connect onboarding before payout');
      const transfer = await stripe.transfers.create({
        amount: toCents(amount),
        currency: String(restaurant.currency || 'gbp').toLowerCase(),
        destination: dest,
        metadata: { payout_id: payout.id, restaurant_id: payout.restaurant_id, kind: String(kind) },
      }, { idempotencyKey });
      const { rows: updated } = await pool.query(
        `UPDATE payouts
         SET status = 'paid', ref = $2, paid_at = NOW(), data = $3::jsonb, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          payout.id,
          transfer.id,
          JSON.stringify({
            ...data,
            stripe_transfer_id: transfer.id,
            executed_by: req.user?.email || 'super',
            executed_at: new Date().toISOString(),
            rail: 'cravedash',
          }),
        ],
      );
      return ok(res, { ...updated[0], restaurant: restaurant.name, kind, stripe_transfer_id: transfer.id });
    }

    // Own rail: application fees already on platform — record only
    const ref = payout.ref || (kind === 'commission' ? `comm_${Date.now().toString(36)}` : `own_${Date.now().toString(36)}`);
    const { rows: updated } = await pool.query(
      `UPDATE payouts
       SET status = 'paid', ref = $2, paid_at = NOW(), data = $3::jsonb, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        payout.id,
        ref,
        JSON.stringify({
          ...data,
          executed_by: req.user?.email || 'super',
          executed_at: new Date().toISOString(),
          rail: 'own',
        }),
      ],
    );
    ok(res, { ...updated[0], restaurant: restaurant.name, kind, stripe_transfer_id: null });
}

// ---- Refunds via Stripe (Connect-aware / proportional) ----
router.post(
  '/stripe/refunds',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super' && req.user?.role !== 'restaurant') {
      throw forbidden();
    }
    const body = req.body || {};
    const refundRequestId = body.refund_request_id || body.id;
    // Tenants open refund requests; only platform admins may approve and execute one (SEC-C4).
    if (refundRequestId && req.user?.role !== 'super') {
      throw forbidden('Only platform admins can execute a refund request');
    }
    let orderId = body.order_id;
    let amount = body.amount != null ? +body.amount : null;
    let paymentIntentId = body.payment_intent_id || body.stripe_payment_intent_id;
    let refundRow = null;
    let order = null;

    if (refundRequestId) {
      const { rows } = await pool.query('SELECT * FROM refund_requests WHERE id = $1', [refundRequestId]);
      refundRow = rows[0];
      if (!refundRow) throw notFound('Refund request not found');
      if (req.user?.role !== 'super') {
        assertRestaurantAccess(req, refundRow.restaurant_id);
      }
      orderId = orderId || refundRow.order_id;
      if (amount == null) amount = +refundRow.amount;
      const rd = refundRow.data && typeof refundRow.data === 'object' ? refundRow.data : {};
      paymentIntentId = paymentIntentId || rd.stripe_payment_intent_id;
      if (String(refundRow.status).toLowerCase() === 'approved') {
        throw badRequest('Refund already approved');
      }
    }

    if (orderId) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      order = rows[0];
      if (!order) throw notFound('Order not found');
      if (req.user?.role !== 'super') assertRestaurantAccess(req, order.restaurant_id);
      assertOrderBranchScope(req, order);
      const od = order.data && typeof order.data === 'object' ? order.data : {};
      paymentIntentId = paymentIntentId || od.stripe_payment_intent_id;
      if (amount == null) amount = +order.total;
      // A refund can never exceed the order total (review finding, roadmap 1.1).
      if (amount != null && (!(amount > 0) || amount > +order.total + 0.005)) {
        throw badRequest('Refund amount must be positive and not exceed the order total');
      }
      // Fast pre-check so an over-refund is refused before any Stripe call. The locked check below is the real guard.
      const alreadyRefunded = Number(od.refund_amount || 0);
      const remaining = Math.round((+order.total - alreadyRefunded) * 100) / 100;
      if (amount > remaining + 0.005) {
        throw badRequest(`Only ${Math.max(0, remaining).toFixed(2)} can still be refunded on this order`);
      }
    }

    // Tenants may refund only payments that belong to an order of their own restaurant (audit 06, roadmap 1.1).
    const tenantScoped = req.user?.role !== 'super';
    if (tenantScoped && body.stripe_account) {
      throw forbidden('stripe_account is not allowed for a restaurant refund');
    }
    if (!order && paymentIntentId) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE data->>'stripe_payment_intent_id' = $1 ${tenantScoped ? 'AND restaurant_id = $2' : ''} LIMIT 1`,
        tenantScoped ? [paymentIntentId, req.user.restaurant_id] : [paymentIntentId],
      );
      order = rows[0] || null;
      if (order) assertOrderBranchScope(req, order);
    }
    if (tenantScoped && !order && paymentIntentId) {
      throw notFound('No order with this payment in your restaurant');
    }

    if (!paymentIntentId && !order) {
      throw badRequest('payment_intent_id or order_id with Stripe payment required');
    }

    const { stripe } = await getStripe();
    let result;

    if (order) {
      const restaurant = await loadRestaurant(order.restaurant_id);
      const billing = billingOf(restaurant);
      // Cumulative cap (SEC-H11): the order row is locked so two refunds cannot both pass the check.
      // The amount is reserved in orders.data.refund_amount in the same transaction as the Stripe call.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: locked } = await client.query(
          'SELECT total, data FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
          [order.id, order.restaurant_id],
        );
        if (!locked[0]) throw notFound('Order not found');
        const alreadyRefunded = Number((locked[0].data && locked[0].data.refund_amount) || 0);
        const remaining = Math.round((Number(locked[0].total) - alreadyRefunded) * 100) / 100;
        if (!(amount > 0) || amount > remaining + 0.005) {
          throw badRequest(`Only ${Math.max(0, remaining).toFixed(2)} can still be refunded on this order`);
        }
        result = await connect.createConnectRefund(stripe, {
          order,
          amount,
          reason: body.reason || 'requested_by_customer',
          billing,
        });
        await client.query(
          `UPDATE orders
           SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('refund_amount', $2::numeric), updated_at = NOW()
           WHERE id = $1`,
          [order.id, Math.round((alreadyRefunded + amount) * 100) / 100],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Orphan PI refund (no order row) — still apply Connect flags when account known
      const params = {
        payment_intent: paymentIntentId,
        reason: body.reason || 'requested_by_customer',
        refund_application_fee: body.refund_application_fee !== false,
        reverse_transfer: body.reverse_transfer !== false,
      };
      if (amount != null && amount > 0) params.amount = toCents(amount);
      const stripeAccount = body.stripe_account || null;
      const refund = await stripe.refunds.create(
        params,
        stripeAccount ? { stripeAccount } : undefined,
      );
      result = {
        mode: stripeAccount ? 'direct' : 'platform_first',
        refund,
        refund_application_fee: !!params.refund_application_fee,
        reverse_transfer: !!params.reverse_transfer,
        canceled_payouts: [],
        transfer_reversal: null,
      };
      logStripe('refund.orphan_pi', {
        refund_id: refund.id,
        payment_intent: paymentIntentId,
        stripe_account: stripeAccount,
      });
    }

    if (refundRow) {
      const prev = refundRow.data && typeof refundRow.data === 'object' ? refundRow.data : {};
      await pool.query(
        `UPDATE refund_requests
         SET status = 'approved', note = COALESCE($2, note), data = $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [
          refundRow.id,
          body.note || null,
          JSON.stringify({
            ...prev,
            stripe_refund_id: result.refund.id,
            charge_mode: result.mode,
            refund_application_fee: result.refund_application_fee,
            reverse_transfer: result.reverse_transfer,
            transfer_reversal_id: result.transfer_reversal && result.transfer_reversal.id,
            canceled_payout_ids: (result.canceled_payouts || []).map((p) => p.id),
            decided_by: req.user?.email || 'super',
            decided_at: new Date().toISOString(),
          }),
        ],
      );
    }

    ok(res, {
      id: result.refund.id,
      status: result.refund.status,
      amount: fromCents(result.refund.amount),
      payment_intent: paymentIntentId || (order && order.data && order.data.stripe_payment_intent_id),
      refund_request_id: refundRequestId || null,
      charge_mode: result.mode,
      refund_application_fee: !!result.refund_application_fee,
      reverse_transfer: !!result.reverse_transfer,
      transfer_reversal_id: result.transfer_reversal && result.transfer_reversal.id,
      canceled_payouts: (result.canceled_payouts || []).map((p) => p.id),
    });
  }),
);

// ---- Release due held payouts (Option A cron / manual) ----
router.post(
  '/stripe/payouts/release-due',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can release held payouts');
    const { stripe } = await getStripe();
    const limit = Math.min(100, +(req.body?.limit || 25));
    const out = await connect.releaseDueHeldPayouts(stripe, { limit });
    ok(res, out);
  }),
);

// ---- Webhook endpoint URL helper (auth) ----
router.get(
  '/stripe/webhook-info',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden();
    const config = await loadStripeConfig();
    ok(res, {
      endpoint: `${apiBaseUrl(req)}/stripe/webhook`,
      health: config.webhook_health || null,
      events: (config.webhook && config.webhook.events) || [],
    });
  }),
);

async function applySubscriptionStatus(restaurantId, status, extra = {}) {
  if (!restaurantId) return;
  const access =
    status === 'active' || status === 'trialing'
      ? 'full'
      : status === 'past_due'
        ? 'limited'
        : 'locked';
  const patch = {
    ...extra,
    access_level: extra.access_level || access,
  };
  await pool.query(
    `UPDATE restaurants
     SET sub_status = $2, data = COALESCE(data, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [restaurantId, status, JSON.stringify(patch)],
  );
  if (extra.subscription_id || extra.stripe_subscription_id) {
    /* already in patch */
  }
}

async function handleStripeEvent(event) {
  const type = event.type;
  const obj = event.data?.object || {};

  if (type === 'account.updated') {
    const accountId = obj.id;
    const { rows } = await pool.query(
      `SELECT id, data FROM restaurants
       WHERE data->>'stripe_account' = $1
          OR data->'billing'->>'stripe_account' = $1`,
      [accountId],
    );
    for (const row of rows) {
      const connected = !!(obj.charges_enabled && obj.details_submitted);
      const data = { ...(row.data || {}) };
      data.stripe_account = accountId;
      data.stripe_connected = connected;
      data.charges_enabled = !!obj.charges_enabled;
      data.payouts_enabled = !!obj.payouts_enabled;
      data.billing = {
        ...(data.billing || {}),
        stripe_account: accountId,
        stripe_connected: connected,
      };
      await pool.query(`UPDATE restaurants SET data = $2::jsonb, updated_at = NOW() WHERE id = $1`, [
        row.id,
        JSON.stringify(data),
      ]);
    }
    return;
  }

  if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const rid = obj.metadata?.restaurant_id;
    const planId = obj.metadata?.plan_id;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
    await applySubscriptionStatus(rid, 'active', {
      stripe_subscription_id: subId,
      stripe_customer_id: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
      plan_id_stripe: planId,
      next_charge: null,
    });
    if (rid && planId) {
      await pool.query(`UPDATE restaurants SET plan_id = $2, updated_at = NOW() WHERE id = $1`, [
        rid,
        planId,
      ]);
    }
    return;
  }

  if (
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.deleted'
  ) {
    const rid = obj.metadata?.restaurant_id;
    let status = 'inactive';
    if (type === 'customer.subscription.deleted') status = 'canceled';
    else if (obj.status === 'active') status = 'active';
    else if (obj.status === 'trialing') status = 'trialing';
    else if (obj.status === 'past_due') status = 'past_due';
    else if (obj.status === 'canceled' || obj.status === 'unpaid') status = 'canceled';
    else status = obj.status || 'inactive';
    await applySubscriptionStatus(rid, status, {
      stripe_subscription_id: obj.id,
      stripe_customer_id: typeof obj.customer === 'string' ? obj.customer : undefined,
    });
    return;
  }

  if (type === 'invoice.paid') {
    const rid = obj.metadata?.restaurant_id || obj.subscription_details?.metadata?.restaurant_id;
    if (rid) await applySubscriptionStatus(rid, 'active', {});
    return;
  }

  if (type === 'invoice.payment_failed') {
    const rid = obj.metadata?.restaurant_id || obj.subscription_details?.metadata?.restaurant_id;
    if (rid) await applySubscriptionStatus(rid, 'past_due', { access_level: 'limited' });
    return;
  }

  if (type === 'payment_intent.succeeded') {
    const orderId = obj.metadata?.order_id;
    const chargeMode = obj.metadata?.charge_mode
      || (obj.metadata?.rail === 'own' ? 'direct' : 'platform_first');
    logStripe('webhook.payment_intent.succeeded', {
      intent_id: obj.id,
      order_id: orderId || null,
      charge_mode: chargeMode,
      amount: obj.amount,
    });
    if (orderId) {
      await pool.query(
        `UPDATE orders
         SET payment_status = 'paid',
             data = COALESCE(data, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          orderId,
          JSON.stringify({
            stripe_payment_intent_id: obj.id,
            stripe_charge_id: typeof obj.latest_charge === 'string' ? obj.latest_charge : null,
            charge_mode: chargeMode,
            paid_via_webhook_at: new Date().toISOString(),
          }),
        ],
      );
      // Option A: mark order held — period batch appears in Payouts on release day
      if (chargeMode !== 'direct') {
        try {
          const { stripe } = await getStripe();
          const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
          const order = rows[0];
          if (order) {
            const restaurant = await loadRestaurant(order.restaurant_id);
            const billing = billingOf(restaurant);
            const chargeId = typeof obj.latest_charge === 'string' ? obj.latest_charge : obj.latest_charge?.id;
            const feeInfo = await connect.resolveStripeFee(stripe, {
              chargeId,
              paymentIntentId: obj.id,
              amountGbp: fromCents(obj.amount_received || obj.amount),
            });
            await connect.enqueueHeldPayoutForOrder(order, billing, restaurant, feeInfo);
          }
        } catch (err) {
          logStripe('held_payout.enqueue_failed', { order_id: orderId, error: err.message });
          // Rethrow (SEC-H10): the webhook then returns 500, Stripe retries, and the event is logged only after success.
          // The enqueue is idempotent (payout_status check), so a retry cannot create a second payout.
          throw err;
        }
      }
    }
    return;
  }

  if (type === 'charge.refunded') {
    const pi =
      typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
    const amountRefunded = fromCents(obj.amount_refunded || obj.amount || 0);
    const fully = !!obj.refunded;
    logStripe('webhook.charge.refunded', {
      charge_id: obj.id,
      payment_intent: pi,
      amount_refunded: amountRefunded,
      fully_refunded: fully,
      application_fee: obj.application_fee || null,
    });
    if (pi) {
      const status = fully ? 'refunded' : 'partially_refunded';
      const patch = {
        refund_amount: amountRefunded,
        stripe_charge_refunded_at: new Date().toISOString(),
      };
      try {
        await pool.query(
          `UPDATE orders
           SET payment_status = $2,
               refund_amount = GREATEST(COALESCE(refund_amount,0), $3),
               data = COALESCE(data,'{}'::jsonb) || $4::jsonb,
               updated_at = NOW()
           WHERE data->>'stripe_payment_intent_id' = $1`,
          [pi, status, amountRefunded, JSON.stringify(patch)],
        );
      } catch (err) {
        if (!/refund_amount/i.test(err.message || '')) throw err;
        await pool.query(
          `UPDATE orders
           SET payment_status = $2,
               data = COALESCE(data,'{}'::jsonb) || $3::jsonb,
               updated_at = NOW()
           WHERE data->>'stripe_payment_intent_id' = $1`,
          [pi, status, JSON.stringify(patch)],
        );
      }
    }
    return;
  }

  if (type === 'charge.refund.updated' || type === 'refund.updated' || type === 'refund.created') {
    logStripe(`webhook.${type}`, {
      refund_id: obj.id,
      status: obj.status,
      amount: fromCents(obj.amount),
      payment_intent: typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id,
      refund_application_fee: !!obj.refund_application_fee || obj.refund_application_fee == null,
    });
    return;
  }

  if (type === 'application_fee.created' || type === 'application_fee.refunded') {
    logStripe(`webhook.${type}`, {
      fee_id: obj.id,
      amount: fromCents(obj.amount),
      amount_refunded: fromCents(obj.amount_refunded || 0),
      charge: typeof obj.charge === 'string' ? obj.charge : obj.charge?.id,
      account: obj.account || null,
    });
    return;
  }

  if (
    type === 'transfer.created'
    || type === 'transfer.updated'
    || type === 'transfer.reversed'
    || type === 'transfer.failed'
  ) {
    logStripe(`webhook.${type}`, {
      transfer_id: obj.id,
      amount: fromCents(obj.amount),
      destination: obj.destination,
      transfer_group: obj.transfer_group || null,
      reversed: !!obj.reversed,
      amount_reversed: fromCents(obj.amount_reversed || 0),
      metadata: obj.metadata || {},
    });
    // Mirror transfer.reversed onto payout row when present
    if (type === 'transfer.reversed' && obj.metadata?.payout_id) {
      await pool.query(
        `UPDATE payouts
         SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [
          obj.metadata.payout_id,
          JSON.stringify({
            webhook_transfer_reversed_at: new Date().toISOString(),
            amount_reversed: fromCents(obj.amount_reversed || obj.amount || 0),
          }),
        ],
      );
    }
    return;
  }

  if (type === 'payout.paid' || type === 'payout.failed') {
    logStripe(`webhook.${type}`, {
      payout_id: obj.id,
      amount: fromCents(obj.amount),
      status: obj.status,
      destination: obj.destination,
    });
  }
}

/**
 * SEC-M12: config keys are written with jsonb_set, one key per statement, so a save of another key is not overwritten.
 */
async function ensureStripeConfigRow() {
  await pool.query("INSERT INTO stripe_config (id, data, updated_at) VALUES (1, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING");
}

async function patchWebhookHealth(patch) {
  await ensureStripeConfigRow();
  const { rows } = await pool.query(
    `UPDATE stripe_config
        SET data = jsonb_set(data, '{webhook_health}',
              COALESCE(data->'webhook_health', '{}'::jsonb) || $1::jsonb, true),
            updated_at = NOW()
      WHERE id = 1
      RETURNING data->'webhook_health' AS health`,
    [JSON.stringify({ ...patch, updated_at: new Date().toISOString() })],
  );
  return rows[0]?.health;
}

/** Recent events for display only (the dedupe source is stripe_webhook_events). Bounded to 50 entries. */
async function appendWebhookLog(entry) {
  await ensureStripeConfigRow();
  await pool.query(
    `UPDATE stripe_config
        SET data = jsonb_set(data, '{webhook_events_log}', (
              SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
                FROM (
                  SELECT $1::jsonb AS value, 0 AS ord
                  UNION ALL
                  SELECT v.value, v.ord
                    FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(data->'webhook_events_log') = 'array'
                           THEN data->'webhook_events_log' ELSE '[]'::jsonb END
                    ) WITH ORDINALITY AS v(value, ord)
                   WHERE v.ord <= 49
                ) e
            ), true),
            updated_at = NOW()
      WHERE id = 1`,
    [JSON.stringify(entry)],
  );
}

const WEBHOOK_STALE_CLAIM_SQL = "INTERVAL '5 minutes'";

/**
 * SEC-M12: the event id is claimed with INSERT ... ON CONFLICT DO NOTHING before anything is processed.
 * Returns 'claimed' (process it), 'duplicate' (already done: acknowledge), or 'in_progress' (another delivery is working on it).
 * A claim left 'processing' by a crashed attempt is taken over after WEBHOOK_STALE_CLAIM_SQL.
 */
async function claimStripeEvent(event) {
  const { rows: inserted } = await pool.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, status, claimed_at)
     VALUES ($1, $2, 'processing', NOW())
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.id, event.type || null],
  );
  if (inserted[0]) return 'claimed';
  const { rows } = await pool.query('SELECT status FROM stripe_webhook_events WHERE event_id = $1', [event.id]);
  if (rows[0] && rows[0].status === 'done') return 'duplicate';
  const { rows: taken } = await pool.query(
    `UPDATE stripe_webhook_events SET claimed_at = NOW()
      WHERE event_id = $1 AND status = 'processing' AND claimed_at < NOW() - ${WEBHOOK_STALE_CLAIM_SQL}
     RETURNING event_id`,
    [event.id],
  );
  return taken[0] ? 'claimed' : 'in_progress';
}

/** Raw-body webhook — mounted from index.js without auth */
async function stripeWebhookHandler(req, res) {
  try {
    const config = await loadStripeConfig();
    const secret = resolveWebhookSecret(config);
    if (!secret) {
      await patchWebhookHealth({ ok: false, last_error: 'webhook secret missing' });
      return res.status(400).json({ success: false, error: { message: 'Webhook secret not configured' } });
    }
    const { stripe } = await getStripe();
    const sig = req.headers['stripe-signature'];
    const raw = req.rawBody || req.body;
    const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw));
    let event;
    try {
      event = stripe.webhooks.constructEvent(payload, sig, secret);
    } catch (err) {
      await patchWebhookHealth({ ok: false, last_error: err.message, last_at: new Date().toISOString() });
      return res.status(400).json({ success: false, error: { message: `Webhook signature: ${err.message}` } });
    }

    // Stripe retries deliveries. A processed event is acknowledged without side effects (a replay must not pay an
    // order twice or record fees twice). An event still being processed is answered 409 so Stripe retries later.
    const claim = await claimStripeEvent(event);
    if (claim === 'duplicate') return res.json({ received: true, duplicate: true });
    if (claim === 'in_progress') {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Event is already being processed' } });
    }

    try {
      await handleStripeEvent(event);
    } catch (err) {
      // Release the claim so the next delivery processes the event again.
      await pool.query(
        "DELETE FROM stripe_webhook_events WHERE event_id = $1 AND status = 'processing'",
        [event.id],
      ).catch((e) => console.error('[stripe webhook] could not release the claim', e));
      throw err;
    }
    await pool.query(
      "UPDATE stripe_webhook_events SET status = 'done', processed_at = NOW() WHERE event_id = $1",
      [event.id],
    );
    await patchWebhookHealth({
      ok: true,
      last_error: null,
      last_type: event.type,
      last_id: event.id,
      last_at: new Date().toISOString(),
    });
    await appendWebhookLog({ id: event.id, type: event.type, at: new Date().toISOString() });

    return res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook]', err);
    try {
      await patchWebhookHealth({ ok: false, last_error: err.message, last_at: new Date().toISOString() });
    } catch {
      /* the health write is best effort; the failure is already logged */
    }
    // SEC-M16: no database or provider text goes back to Stripe or to a caller.
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Webhook could not be processed' } });
  }
}

router.post(
  '/stripe/config/reload',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden();
    clearStripeCache();
    const { mode, publishableKey } = await getStripe();
    ok(res, { reloaded: true, mode, publishable_key: publishableKey });
  }),
);

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
