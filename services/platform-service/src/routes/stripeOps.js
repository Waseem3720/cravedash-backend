const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { notFound, badRequest, forbidden } = require('@cravedash/shared/src/errors');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const {
  getStripe,
  loadStripeConfig,
  saveStripeConfig,
  resolveWebhookSecret,
  touchWebhookHealth,
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
      const prevData = order.data && typeof order.data === 'object' ? order.data : {};
      const nextData = {
        ...prevData,
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
      await pool.query(
        `UPDATE orders SET data = $2::jsonb, payment_method = COALESCE(payment_method, 'stripe'), updated_at = NOW()
         WHERE id = $1`,
        [orderId, JSON.stringify(nextData)],
      );
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

    const restaurant = await loadRestaurant(payout.restaurant_id);
    const billing = billingOf(restaurant);
    const amount = +(payout.amount || 0);
    if (!(amount > 0)) throw badRequest('Invalid payout amount');

    const data = payout.data && typeof payout.data === 'object' ? payout.data : {};
    const kind = data.kind || payout.kind || 'request';
    const { stripe } = await getStripe();

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
      });
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
  }),
);

// ---- Refunds via Stripe (Connect-aware / proportional) ----
router.post(
  '/stripe/refunds',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super' && req.user?.role !== 'restaurant') {
      throw forbidden();
    }
    const body = req.body || {};
    const refundRequestId = body.refund_request_id || body.id;
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
      const od = order.data && typeof order.data === 'object' ? order.data : {};
      paymentIntentId = paymentIntentId || od.stripe_payment_intent_id;
      if (amount == null) amount = +order.total;
    }

    if (!order && paymentIntentId) {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE data->>'stripe_payment_intent_id' = $1 LIMIT 1`,
        [paymentIntentId],
      );
      order = rows[0] || null;
    }

    if (!paymentIntentId && !order) {
      throw badRequest('payment_intent_id or order_id with Stripe payment required');
    }

    const { stripe } = await getStripe();
    let result;

    if (order) {
      const restaurant = await loadRestaurant(order.restaurant_id);
      const billing = billingOf(restaurant);
      result = await connect.createConnectRefund(stripe, {
        order,
        amount,
        reason: body.reason || 'requested_by_customer',
        billing,
      });
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

/** Raw-body webhook — mounted from index.js without auth */
async function stripeWebhookHandler(req, res) {
  try {
    const config = await loadStripeConfig();
    const secret = resolveWebhookSecret(config);
    if (!secret) {
      await touchWebhookHealth({ ok: false, last_error: 'webhook secret missing' });
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
      await touchWebhookHealth({ ok: false, last_error: err.message, last_at: new Date().toISOString() });
      return res.status(400).json({ success: false, error: { message: `Webhook signature: ${err.message}` } });
    }

    await handleStripeEvent(event);
    await touchWebhookHealth({
      ok: true,
      last_error: null,
      last_type: event.type,
      last_id: event.id,
      last_at: new Date().toISOString(),
    });

    // Keep event log (bounded) on stripe_config
    const cfg = await loadStripeConfig();
    const log = Array.isArray(cfg.webhook_events_log) ? cfg.webhook_events_log.slice(0, 49) : [];
    log.unshift({ id: event.id, type: event.type, at: new Date().toISOString() });
    await saveStripeConfig({ ...cfg, webhook_events_log: log });

    return res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook]', err);
    try {
      await touchWebhookHealth({ ok: false, last_error: err.message, last_at: new Date().toISOString() });
    } catch {
      /* ignore */
    }
    return res.status(500).json({ success: false, error: { message: err.message || 'Webhook error' } });
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
