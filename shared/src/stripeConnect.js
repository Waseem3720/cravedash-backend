/**
 * Stripe Connect dual-rail payments + proportional refunds.
 *
 * Option A — platform_first (billing.account === 'cravedash'):
 *   Charge lands on the platform. Vendor Transfer is deferred until
 *   billing.schedule hold elapses (released by releaseDueHeldPayouts).
 *
 * Option B — direct (billing.account === 'own'):
 *   Charge on the connected account with application_fee_amount
 *   (platform fee + commission) taken at charge time.
 */
const crypto = require('crypto');
const pool = require('./db');
const accounting = require('./engines/accounting');

const BILLING_DEF = {
  commission_type: 'percent',
  commission_value: 5,
  commission_per: 'order',
  platform_fee: 0.5,
  account: 'cravedash',
  schedule: '7d',
  /** 'approval' = release day → payout queue for admin Approve; 'automate' = Transfer without approval */
  payout_mode: 'approval',
  channels: { online: true, table_qr: true, pos: false },
};

/** UK card estimate when Stripe balance_transaction not yet available (1.5% + £0.20). */
function estimateStripeFee(amountGbp) {
  return round2(Math.max(0, (+amountGbp || 0) * 0.015 + 0.2));
}

function payoutModeOf(billing) {
  return billing && String(billing.payout_mode).toLowerCase() === 'automate'
    ? 'automate'
    : 'approval';
}

/**
 * Resolve actual Stripe processing fee (vendor-borne) from a Charge / PaymentIntent.
 */
async function resolveStripeFee(stripe, { chargeId, paymentIntentId, amountGbp }) {
  try {
    let charge = null;
    if (chargeId) {
      charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
    } else if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      if (!charge && pi.latest_charge) {
        charge = await stripe.charges.retrieve(pi.latest_charge, { expand: ['balance_transaction'] });
      }
    }
    const bt = charge && charge.balance_transaction;
    if (bt && typeof bt === 'object' && bt.fee != null) {
      return { stripe_fee: fromCents(bt.fee), stripe_fee_source: 'balance_transaction', balance_transaction_id: bt.id };
    }
    if (typeof bt === 'string') {
      const full = await stripe.balanceTransactions.retrieve(bt);
      return { stripe_fee: fromCents(full.fee), stripe_fee_source: 'balance_transaction', balance_transaction_id: full.id };
    }
  } catch (err) {
    logStripe('stripe_fee.resolve_failed', { error: err.message, chargeId, paymentIntentId });
  }
  return {
    stripe_fee: estimateStripeFee(amountGbp),
    stripe_fee_source: 'estimate',
    balance_transaction_id: null,
  };
}

const SCHED_DAYS = { '2d': 2, '7d': 7, month: 30, '6m': 182 };

function toCents(n) {
  return Math.round(Number(n || 0) * 100);
}

function fromCents(n) {
  return Math.round(Number(n || 0)) / 100;
}

function round2(n) {
  return Math.round((+n || 0) * 100) / 100;
}

function chargeModeOf(billing) {
  return billing && billing.account === 'own' ? 'direct' : 'platform_first';
}

function scheduleHoldDays(billing) {
  const key = (billing && billing.schedule) || '7d';
  return SCHED_DAYS[key] != null ? SCHED_DAYS[key] : 7;
}

function releaseAtFrom(billing, fromDate = new Date()) {
  const days = scheduleHoldDays(billing);
  return new Date(fromDate.getTime() + days * 864e5).toISOString();
}

function calcFees(billing, orderTotal, channel = 'online') {
  const ch = channel || 'online';
  const channels = (billing && billing.channels) || {};
  const feeChannels = (billing && billing.platform_fee_channels) || channels;
  let commission = 0;
  if (channels[ch] !== false) {
    if (billing.commission_type === 'fixed') {
      commission = +(billing.commission_value || 0);
    } else {
      commission = (+(orderTotal || 0) * +(billing.commission_value || 0)) / 100;
    }
  }
  const fee =
    feeChannels[ch] === false
      ? 0
      : +(billing.platform_fees?.[ch] ?? billing.platform_fee ?? 0);
  return {
    commission: round2(commission),
    fee: round2(fee),
  };
}

function logStripe(event, detail = {}) {
  const line = {
    at: new Date().toISOString(),
    event,
    ...detail,
  };
  // Structured for container log aggregators
  console.log('[stripe-connect]', JSON.stringify(line));
  return line;
}

/**
 * Build + create a PaymentIntent for either rail.
 * @returns {{ intent, mode, fees, applicationFeeCents, metadata, stripeAccount }}
 */
async function createVendorPaymentIntent(stripe, {
  restaurant,
  billing,
  amount,
  currency = 'gbp',
  orderId = null,
  channel = 'online',
  descriptor = 'CRAVEDASH',
  extraMetadata = {},
}) {
  const mode = chargeModeOf(billing);
  const fees = calcFees(billing, amount, channel);
  const amountCents = toCents(amount);
  // Direct: take fee + commission as application fee. Platform-first: fees retained at Transfer time.
  const applicationFeeCents = mode === 'direct'
    ? Math.max(0, Math.min(toCents(fees.fee + fees.commission), Math.max(0, amountCents - 1)))
    : 0;

  const metadata = {
    restaurant_id: String(restaurant.id || ''),
    order_id: orderId != null ? String(orderId) : '',
    rail: mode === 'direct' ? 'own' : 'cravedash',
    charge_mode: mode,
    platform_fee: String(fees.fee),
    commission: String(fees.commission),
    channel: String(channel || 'online'),
    ...extraMetadata,
  };

  let intent;
  let stripeAccount = null;

  if (mode === 'direct') {
    stripeAccount = billing.stripe_account || restaurant.stripe_account || null;
    if (!stripeAccount) {
      const err = new Error('Restaurant Stripe Connect account is required for direct charges');
      err.status = 400;
      err.code = 'BAD_REQUEST';
      throw err;
    }
    intent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: String(currency).toLowerCase(),
        automatic_payment_methods: { enabled: true },
        application_fee_amount: applicationFeeCents,
        statement_descriptor: String(descriptor).slice(0, 22),
        metadata,
      },
      { stripeAccount },
    );
    logStripe('payment_intent.created', {
      mode,
      intent_id: intent.id,
      restaurant_id: restaurant.id,
      order_id: orderId,
      amount_cents: amountCents,
      application_fee_cents: applicationFeeCents,
      stripe_account: stripeAccount,
    });
  } else {
    intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: String(currency).toLowerCase(),
      automatic_payment_methods: { enabled: true },
      statement_descriptor: String(descriptor).slice(0, 22),
      metadata,
      transfer_group: orderId != null ? `order_${orderId}` : `rest_${restaurant.id}`,
    });
    logStripe('payment_intent.created', {
      mode,
      intent_id: intent.id,
      restaurant_id: restaurant.id,
      order_id: orderId,
      amount_cents: amountCents,
      transfer_group: intent.transfer_group,
      hold_days: scheduleHoldDays(billing),
    });
  }

  return {
    intent,
    mode,
    fees,
    applicationFeeCents,
    metadata,
    stripeAccount,
  };
}

async function ensurePayoutsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      ref TEXT,
      paid_at TIMESTAMPTZ,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * After platform-first PI succeeds: mark order held for a future period payout.
 * Does NOT Transfer and does NOT create a payout row yet — release day builds a
 * batch into the Payouts section for admin approval (or auto if payout_mode=automate).
 */
async function enqueueHeldPayoutForOrder(order, billing, restaurant, stripeFeeInfo = null) {
  const od = order.data && typeof order.data === 'object' ? order.data : {};
  const mode = od.charge_mode || od.stripe_rail || chargeModeOf(billing);
  if (mode === 'direct' || mode === 'own') return null;

  const orderId = order.id;
  if (od.payout_status === 'held' || od.payout_status === 'batched' || od.payout_status === 'paid') {
    return { skipped: true, payout_status: od.payout_status };
  }

  const gross = round2(+order.total || 0);
  const fees = calcFees(billing, gross, od.channel || 'online');
  const commission = round2(od.commission != null ? +od.commission : fees.commission);
  const platformFee = round2(od.platform_fee != null ? +od.platform_fee : fees.fee);
  const stripeFee = round2(
    stripeFeeInfo?.stripe_fee != null
      ? +stripeFeeInfo.stripe_fee
      : (od.stripe_fee != null ? +od.stripe_fee : estimateStripeFee(gross)),
  );
  // Vendor bears Stripe fee + platform commission + platform fee
  const net = round2(Math.max(0, gross - commission - platformFee - stripeFee));
  const releaseAt = od.payout_release_at || releaseAtFrom(billing);

  const patch = {
    charge_mode: 'platform_first',
    payout_status: 'held',
    payout_release_at: releaseAt,
    payout_gross: gross,
    commission,
    platform_fee: platformFee,
    stripe_fee: stripeFee,
    stripe_fee_source: stripeFeeInfo?.stripe_fee_source || od.stripe_fee_source || 'estimate',
    balance_transaction_id: stripeFeeInfo?.balance_transaction_id || od.balance_transaction_id || null,
    payout_net: net,
    payout_refunds: round2(+(od.payout_refunds || order.refund_amount || 0)),
  };

  await pool.query(
    `UPDATE orders
     SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [orderId, JSON.stringify(patch)],
  );

  logStripe('order.held_for_payout', {
    order_id: orderId,
    restaurant_id: order.restaurant_id,
    gross,
    commission,
    platform_fee: platformFee,
    stripe_fee: stripeFee,
    net,
    release_at: releaseAt,
    payout_mode: payoutModeOf(billing),
  });
  return { order_id: orderId, ...patch };
}

/**
 * Apply a refund against a held (not-yet-paid) order so it deducts from the next payout.
 * Also patches any open pending_approval batch that already includes this order.
 */
async function applyRefundToHeldOrder(order, refundAmount, reason = 'refund') {
  const od = order.data && typeof order.data === 'object' ? order.data : {};
  const amt = round2(+refundAmount || 0);
  if (!(amt > 0)) return null;

  const prevRefunds = round2(+(od.payout_refunds || order.refund_amount || 0));
  const nextRefunds = round2(prevRefunds + amt);
  const gross = round2(+(od.payout_gross != null ? od.payout_gross : order.total) || 0);
  const commission = round2(+(od.commission || 0));
  const platformFee = round2(+(od.platform_fee || 0));
  const stripeFee = round2(+(od.stripe_fee || 0));
  // Refunds reduce vendor credit; fees already taken on original sale stay (Stripe rarely rebates full fee)
  const net = round2(Math.max(0, gross - nextRefunds - commission - platformFee - stripeFee));
  const fully = nextRefunds + 0.009 >= gross;

  const ledgerEntry = {
    at: new Date().toISOString(),
    type: 'refund',
    order_id: String(order.id),
    debit: amt,
    credit: 0,
    reason: reason || 'refund',
  };

  const patch = {
    payout_refunds: nextRefunds,
    payout_net: net,
    payout_status: fully ? 'excluded' : (od.payout_status || 'held'),
    payout_ledger: [...(Array.isArray(od.payout_ledger) ? od.payout_ledger : []), ledgerEntry],
  };

  await pool.query(
    `UPDATE orders
     SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [order.id, JSON.stringify(patch)],
  );

  // If already sitting in an approval-queue batch, rebuild its lines/amount
  await ensurePayoutsTable();
  const { rows: batches } = await pool.query(
    `SELECT * FROM payouts
     WHERE restaurant_id = $1
       AND status IN ('pending_approval', 'requested', 'scheduled')
       AND data->>'kind' = 'period_payout'
       AND data->'order_ids' @> to_jsonb($2::text)`,
    [order.restaurant_id, String(order.id)],
  );
  for (const batch of batches) {
    await recalculatePayoutBatch(batch.id);
  }

  logStripe('order.refund_applied_to_payout', {
    order_id: order.id,
    refund: amt,
    payout_net: net,
    payout_status: patch.payout_status,
  });
  return patch;
}

/** @deprecated alias — per-order payout rows no longer used; refunds adjust held orders */
async function cancelHeldPayoutForOrder(orderId, reason = 'refund') {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!rows[0]) return [];
  const order = rows[0];
  const od = order.data || {};
  const left = round2(Math.max(0, (+od.payout_gross || +order.total || 0) - (+od.payout_refunds || 0)));
  await applyRefundToHeldOrder(order, left || +order.total || 0, reason);
  return [{ id: orderId, canceled: true }];
}

function buildOrderPayoutLine(order) {
  const od = order.data && typeof order.data === 'object' ? order.data : {};
  const gross = round2(+(od.payout_gross != null ? od.payout_gross : order.total) || 0);
  const refunds = round2(+(od.payout_refunds || order.refund_amount || 0));
  const commission = round2(+(od.commission || 0));
  const platformFee = round2(+(od.platform_fee || 0));
  const stripeFee = round2(+(od.stripe_fee || 0));
  const net = round2(Math.max(0, gross - refunds - commission - platformFee - stripeFee));
  const lines = [
    {
      order_id: String(order.id),
      type: 'sale',
      credit: gross,
      debit: 0,
      description: `Order #${order.id} card sale`,
      at: order.created_at || od.paid_via_webhook_at || null,
    },
  ];
  if (commission > 0) {
    lines.push({
      order_id: String(order.id),
      type: 'commission',
      credit: 0,
      debit: commission,
      description: `Platform commission — order #${order.id}`,
    });
  }
  if (platformFee > 0) {
    lines.push({
      order_id: String(order.id),
      type: 'platform_fee',
      credit: 0,
      debit: platformFee,
      description: `Platform fee — order #${order.id}`,
    });
  }
  if (stripeFee > 0) {
    lines.push({
      order_id: String(order.id),
      type: 'stripe_fee',
      credit: 0,
      debit: stripeFee,
      description: `Stripe processing fee (vendor) — order #${order.id}`,
      fee_source: od.stripe_fee_source || 'estimate',
    });
  }
  if (refunds > 0) {
    lines.push({
      order_id: String(order.id),
      type: 'refund',
      credit: 0,
      debit: refunds,
      description: `Refund debit — order #${order.id}`,
    });
  }
  return {
    order_id: String(order.id),
    gross,
    refunds,
    commission,
    platform_fee: platformFee,
    stripe_fee: stripeFee,
    net,
    lines,
    payout_status: od.payout_status || 'held',
  };
}

async function recalculatePayoutBatch(payoutId) {
  const { rows } = await pool.query('SELECT * FROM payouts WHERE id = $1', [payoutId]);
  const payout = rows[0];
  if (!payout) return null;
  const data = payout.data || {};
  const orderIds = Array.isArray(data.order_ids) ? data.order_ids : [];
  if (!orderIds.length) return payout;

  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE id = ANY($1::text[]) AND restaurant_id = $2`,
    [orderIds.map(String), payout.restaurant_id],
  );
  // Also try numeric ids
  let list = orders;
  if (!list.length) {
    const nums = orderIds.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (nums.length) {
      const r2 = await pool.query(
        `SELECT * FROM orders WHERE id = ANY($1::bigint[]) AND restaurant_id = $2`,
        [nums, payout.restaurant_id],
      );
      list = r2.rows;
    }
  }

  const summaries = list.map(buildOrderPayoutLine).filter((s) => s.payout_status !== 'excluded' || s.refunds > 0);
  const allLines = summaries.flatMap((s) => s.lines);
  const totals = {
    gross: round2(summaries.reduce((a, s) => a + s.gross, 0)),
    refunds: round2(summaries.reduce((a, s) => a + s.refunds, 0)),
    commission: round2(summaries.reduce((a, s) => a + s.commission, 0)),
    platform_fee: round2(summaries.reduce((a, s) => a + s.platform_fee, 0)),
    stripe_fee: round2(summaries.reduce((a, s) => a + s.stripe_fee, 0)),
    net: round2(summaries.reduce((a, s) => a + s.net, 0)),
    order_count: summaries.length,
  };

  const { rows: updated } = await pool.query(
    `UPDATE payouts
     SET amount = $2,
         data = COALESCE(data,'{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      payoutId,
      totals.net,
      JSON.stringify({
        lines: allLines,
        order_summaries: summaries,
        totals,
        recalculated_at: new Date().toISOString(),
      }),
    ],
  );
  return updated[0];
}

/**
 * Reverse a completed Transfer (Option A post-release refund).
 */
async function reverseVendorTransfer(stripe, transferId, amountCents = null, metadata = {}) {
  if (!transferId) return null;
  const params = { metadata: { ...metadata, reason: metadata.reason || 'order_refund' } };
  if (amountCents != null && amountCents > 0) params.amount = amountCents;
  const reversal = await stripe.transfers.createReversal(transferId, params);
  logStripe('transfer.reversed', {
    transfer_id: transferId,
    reversal_id: reversal.id,
    amount_cents: reversal.amount,
    ...metadata,
  });
  return reversal;
}

/**
 * Create a proportional Connect-aware refund.
 *
 * Direct (Option B): refund on connected account with
 *   refund_application_fee + reverse_transfer.
 * Platform-first (Option A):
 *   - cancel pending held payout if not yet transferred
 *   - reverse Transfer if already paid
 *   - refund the platform charge
 */
async function createConnectRefund(stripe, {
  order,
  amount = null,
  reason = 'requested_by_customer',
  billing = null,
}) {
  const od = order.data && typeof order.data === 'object' ? order.data : {};
  const paymentIntentId = od.stripe_payment_intent_id;
  if (!paymentIntentId) {
    const err = new Error('Order has no Stripe payment_intent');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const mode = od.charge_mode
    || (od.stripe_rail === 'own' ? 'direct' : null)
    || (billing ? chargeModeOf(billing) : 'platform_first');

  const orderTotal = round2(+order.total || 0);
  const refundAmount = amount != null && amount > 0 ? round2(amount) : orderTotal;
  const isPartial = refundAmount + 0.009 < orderTotal;
  const ratio = orderTotal > 0 ? Math.min(1, refundAmount / orderTotal) : 1;
  // BUG-008: a refund may never exceed what is still refundable on the order (the Stripe charge is the hard limit too).
  const alreadyRefunded = round2(+(order.refund_amount || od.refund_amount || 0));
  const remainingRefundable = round2(orderTotal - alreadyRefunded);
  if (refundAmount > remainingRefundable + 0.009) {
    const err = new Error(`Refund exceeds the remaining refundable amount (${remainingRefundable.toFixed(2)})`);
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  // Same key for a retried identical refund, so Stripe returns the first refund instead of making a second one.
  const refundKey = `refund-${order.id}-${alreadyRefunded}-${refundAmount}`;

  const result = {
    mode,
    refund: null,
    transfer_reversal: null,
    canceled_payouts: [],
    refund_application_fee: false,
    reverse_transfer: false,
  };

  if (mode === 'direct') {
    const stripeAccount = od.stripe_account || billing?.stripe_account || null;
    const params = {
      payment_intent: paymentIntentId,
      reason,
      // Pull application fee (platform commission) back from platform → customer
      refund_application_fee: true,
      // Destination-charge compatibility; ignored/retry without if charge has no transfer
      reverse_transfer: true,
    };
    if (isPartial) params.amount = toCents(refundAmount);

    const requestOpts = stripeAccount ? { stripeAccount } : undefined;
    try {
      result.refund = await stripe.refunds.create(params, requestOpts);
      result.reverse_transfer = true;
    } catch (err) {
      // Direct charges often have no Transfer — Stripe rejects reverse_transfer
      if (/reverse_transfer|no transfer/i.test(err.message || '')) {
        delete params.reverse_transfer;
        result.refund = await stripe.refunds.create(params, requestOpts);
        result.reverse_transfer = false;
        logStripe('refund.direct_no_transfer', {
          order_id: order.id,
          note: 'retry without reverse_transfer',
          error: err.message,
        });
      } else {
        throw err;
      }
    }
    result.refund_application_fee = true;

    logStripe('refund.direct', {
      refund_id: result.refund.id,
      payment_intent: paymentIntentId,
      order_id: order.id,
      amount_cents: result.refund.amount,
      partial: isPartial,
      refund_application_fee: true,
      reverse_transfer: result.reverse_transfer,
      stripe_account: stripeAccount,
    });
  } else {
    // Option A — platform charge.
    // The customer refund runs first. If Stripe refuses it, nothing on the vendor side has changed yet (BUG-008).
    const params = {
      payment_intent: paymentIntentId,
      reason,
    };
    if (isPartial) params.amount = toCents(refundAmount);
    result.refund = await stripe.refunds.create(params, { idempotencyKey: refundKey });

    logStripe('refund.platform_first', {
      refund_id: result.refund.id,
      payment_intent: paymentIntentId,
      order_id: order.id,
      amount_cents: result.refund.amount,
      partial: isPartial,
    });

    // Vendor side: deduct from the held payout and reverse a Transfer that was already sent. If this fails the
    // customer has been refunded, so the order is flagged for reconciliation and the refund itself still stands.
    try {
      // 1) Deduct refund from held / pending-approval payout (before funds leave platform)
      if (od.payout_status === 'held' || od.payout_status === 'batched' || !od.payout_status) {
        await applyRefundToHeldOrder(order, refundAmount, reason);
        result.canceled_payouts = [{ id: String(order.id), adjusted: true }];
      }

      // 2) If already paid out in a period batch, reverse vendor Transfer proportionally
      const { rows: paidOut } = await pool.query(
        `SELECT * FROM payouts
         WHERE restaurant_id = $1
           AND data->>'kind' = 'period_payout'
           AND status = 'paid'
           AND data->>'stripe_transfer_id' IS NOT NULL
           AND data->'order_ids' @> to_jsonb($2::text)
         ORDER BY paid_at DESC NULLS LAST
         LIMIT 1`,
        [order.restaurant_id, String(order.id)],
      );
      if (paidOut[0]) {
        const transferId = paidOut[0].data.stripe_transfer_id || paidOut[0].ref;
        const orderShare = (paidOut[0].data.order_summaries || []).find(
          (s) => String(s.order_id) === String(order.id),
        );
        const reverseCents = toCents(
          isPartial
            ? round2((orderShare ? +orderShare.net : +paidOut[0].amount) * ratio)
            : (orderShare ? +orderShare.net : null),
        );
        try {
          result.transfer_reversal = await reverseVendorTransfer(
            stripe,
            transferId,
            reverseCents > 0 ? reverseCents : null,
            { order_id: String(order.id), payout_id: paidOut[0].id, reason: 'order_refund' },
          );
          await pool.query(
            `UPDATE payouts
             SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
             WHERE id = $1`,
            [
              paidOut[0].id,
              JSON.stringify({
                post_pay_refunds: [
                  ...((paidOut[0].data.post_pay_refunds) || []),
                  {
                    order_id: String(order.id),
                    amount: refundAmount,
                    reversal_id: result.transfer_reversal.id,
                    at: new Date().toISOString(),
                  },
                ],
              }),
            ],
          );
        } catch (err) {
          logStripe('transfer.reverse_failed', {
            transfer_id: transferId,
            order_id: order.id,
            error: err.message,
          });
          throw err;
        }
      }
    } catch (err) {
      result.vendor_adjustment_pending = true;
      logStripe('refund.vendor_adjustment_pending', { order_id: order.id, error: err.message });
      await pool.query(
        `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [order.id, JSON.stringify({ vendor_adjustment_pending: { refund_id: result.refund.id, error: String(err.message || '').slice(0, 200) } })],
      ).catch(() => {});
    }
  }

  // Persist refund on order (support partials). refund_amount column may be absent on older DBs.
  const prevRefunded = round2(+(order.refund_amount || od.refund_amount || 0));
  const nextRefunded = round2(prevRefunded + refundAmount);
  const fullyRefunded = nextRefunded + 0.009 >= orderTotal;
  const patch = {
    refund_amount: nextRefunded,
    last_stripe_refund_id: result.refund.id,
    last_refund_at: new Date().toISOString(),
    last_refund_mode: mode,
  };
  try {
    await pool.query(
      `UPDATE orders
       SET payment_status = $2,
           refund_amount = $3,
           data = COALESCE(data,'{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, fullyRefunded ? 'refunded' : 'partially_refunded', nextRefunded, JSON.stringify(patch)],
    );
  } catch (err) {
    if (!/refund_amount/i.test(err.message || '')) throw err;
    await pool.query(
      `UPDATE orders
       SET payment_status = $2,
           data = COALESCE(data,'{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, fullyRefunded ? 'refunded' : 'partially_refunded', JSON.stringify(patch)],
    );
  }

  // BUG-017: the sale in the ledger gives back the refunded share. The customer has already been refunded at this point, so
  // a posting failure is flagged on the order for reconciliation instead of hiding the refund.
  try {
    await accounting.postRefundSale(order.restaurant_id, { ...order, total: orderTotal }, {
      refundAmount,
      refundKey: result.refund.id,
      fullyRefunded,
    });
  } catch (err) {
    result.refund_journal_pending = true;
    await pool.query(
      `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [order.id, JSON.stringify({ refund_journal_pending: { refund_id: result.refund.id, error: String(err.message || '').slice(0, 200) } })],
    ).catch(() => {});
    logStripe('refund.journal_pending', { order_id: order.id, refund_id: result.refund.id, error: err.message });
  }

  return result;
}

/**
 * Build a period payout batch for one restaurant from held orders past release_at.
 * Status:
 *   - pending_approval (default) → shows in Payouts for admin Approve
 *   - paid immediately if billing.payout_mode === 'automate'
 */
/**
 * Builds one period payout from due held orders. The selection, the payout row and the order claim happen in one
 * transaction on `client`. Held orders are locked with SKIP LOCKED, so a concurrent run skips them, and a claimed order
 * is marked `batched` with its payout id before the transaction commits. No order can belong to two payouts.
 */
async function buildPeriodPayoutInTx(client, restaurant, billing) {
  const rid = restaurant.id;
  const { rows: held } = await client.query(
    `SELECT * FROM orders
     WHERE restaurant_id = $1
       AND payment_status IN ('paid', 'partially_refunded')
       AND COALESCE(data->>'charge_mode', data->>'stripe_rail', 'platform_first') IN ('platform_first', 'cravedash')
       AND COALESCE(data->>'payout_status', '') = 'held'
       AND COALESCE(data->>'held_payout_id', '') = ''
       AND COALESCE(data->>'payout_release_at', '') <> ''
       AND (data->>'payout_release_at')::timestamptz <= NOW()
     ORDER BY created_at ASC
     LIMIT 500
     FOR UPDATE SKIP LOCKED`,
    [rid],
  );
  if (!held.length) return null;

  const summaries = held.map(buildOrderPayoutLine).filter((s) => s.net > 0.009 || s.refunds > 0);
  const eligible = summaries.filter((s) => s.net > 0.009);
  if (!eligible.length) {
    // All fully refunded — mark excluded
    for (const o of held) {
      await client.query(
        `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [o.id, JSON.stringify({ payout_status: 'excluded' })],
      );
    }
    return null;
  }

  const allLines = eligible.flatMap((s) => s.lines);
  const totals = {
    gross: round2(eligible.reduce((a, s) => a + s.gross, 0)),
    refunds: round2(eligible.reduce((a, s) => a + s.refunds, 0)),
    commission: round2(eligible.reduce((a, s) => a + s.commission, 0)),
    platform_fee: round2(eligible.reduce((a, s) => a + s.platform_fee, 0)),
    stripe_fee: round2(eligible.reduce((a, s) => a + s.stripe_fee, 0)),
    net: round2(eligible.reduce((a, s) => a + s.net, 0)),
    order_count: eligible.length,
  };
  if (!(totals.net > 0)) return null;

  const automate = payoutModeOf(billing) === 'automate';
  const dest = billing.stripe_account || restaurant.stripe_account || null;
  const id = `po_period_${rid}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const orderIds = eligible.map((s) => s.order_id);
  const data = {
    kind: 'period_payout',
    charge_mode: 'platform_first',
    payout_mode: automate ? 'automate' : 'approval',
    restaurant: restaurant.name || rid,
    restaurant_id: rid,
    order_ids: orderIds,
    order_summaries: eligible,
    lines: allLines,
    totals,
    stripe_account: dest,
    currency: (restaurant.currency || 'gbp').toLowerCase(),
    period: {
      from: held[0].created_at,
      to: held[held.length - 1].created_at,
      release_at: new Date().toISOString(),
    },
    receipt: {
      title: `Payout receipt — ${restaurant.name || rid}`,
      vendor_stripe_fee_note: 'Stripe processing fees are charged to the vendor and deducted from this payout.',
      lines: allLines,
      totals,
    },
  };

  const status = automate ? 'approved' : 'pending_approval';
  const note = automate
    ? `Auto payout (${eligible.length} orders) — Stripe fee £${totals.stripe_fee.toFixed(2)} deducted`
    : `Ready for approval (${eligible.length} orders). Stripe fee £${totals.stripe_fee.toFixed(2)} + commission £${totals.commission.toFixed(2)} deducted.`;

  const { rows } = await client.query(
    `INSERT INTO payouts (id, restaurant_id, amount, status, note, data)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [id, rid, totals.net, status, note, JSON.stringify(data)],
  );

  // Claim the orders for this payout. orders.id is BIGINT, so the comparison is made on text.
  await client.query(
    `UPDATE orders
     SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
     WHERE id::text = ANY($1::text[])`,
    [orderIds, JSON.stringify({ payout_status: 'batched', held_payout_id: id })],
  );

  logStripe('period_payout.created', {
    payout_id: id,
    restaurant_id: rid,
    status,
    net: totals.net,
    stripe_fee: totals.stripe_fee,
    orders: orderIds.length,
    automate,
  });

  return rows[0];
}

/** Stripe errors that mean the Transfer was refused and never created. Any other error may have created it. */
const STRIPE_REJECTED_TYPES = new Set([
  'StripeInvalidRequestError',
  'StripeCardError',
  'StripeAuthenticationError',
  'StripePermissionError',
]);

function isStripeRejection(err) {
  return Boolean(err && STRIPE_REJECTED_TYPES.has(err.type || err.name));
}

/**
 * Builds a period payout and, in automate mode, sends its Transfer. The claim is taken in a transaction first. The
 * Transfer runs after the commit, so no database lock is held during the Stripe call.
 * A refused Transfer releases the orders to `held`. Any other failure keeps the claim, because the Transfer may already
 * exist. A retry with the same payout key returns that Transfer and never sends a second one.
 */
async function buildPeriodPayoutForRestaurant(stripe, restaurant, billing) {
  await ensurePayoutsTable();
  const automate = payoutModeOf(billing) === 'automate';
  if (automate && !(billing.stripe_account || restaurant.stripe_account)) {
    // Checked before anything is claimed, so no order is left batched without a Transfer.
    const err = new Error('Restaurant must complete Stripe Connect before payout');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  let payout;
  try {
    await client.query('BEGIN');
    payout = await buildPeriodPayoutInTx(client, restaurant, billing);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!payout || !automate || !stripe) return payout;

  const orderIds = (Array.isArray(payout.data?.order_ids) ? payout.data.order_ids : []).map(String);
  try {
    return await executePayoutTransfer(stripe, payout, { by: 'automate' });
  } catch (err) {
    if (isStripeRejection(err)) await releaseRefusedPayout(payout.id, orderIds);
    throw err;
  }
}

/** Returns the orders of a refused payout to `held`, so the next run can batch them again. */
async function releaseRefusedPayout(payoutId, orderIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE payouts
       SET status = 'failed', updated_at = NOW(),
           note = COALESCE(note, '') || ' (Stripe refused the transfer; orders released)'
       WHERE id = $1 AND status = 'approved' AND ref IS NULL
       RETURNING id`,
      [payoutId],
    );
    if (rows[0] && orderIds.length) {
      await client.query(
        `UPDATE orders
         SET data = (COALESCE(data,'{}'::jsonb) - 'held_payout_id') || $3::jsonb, updated_at = NOW()
         WHERE id::text = ANY($1::text[]) AND data->>'held_payout_id' = $2`,
        [orderIds, payoutId, JSON.stringify({ payout_status: 'held' })],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stripe Transfer for an approved / automate period payout. The Stripe key is the payout id, so every attempt for the
 * same payout reuses one Transfer.
 */
async function executePayoutTransfer(stripe, payout, { by = 'admin', idempotencyKey } = {}) {
  const data = payout.data && typeof payout.data === 'object' ? payout.data : {};
  const dest = data.stripe_account;
  const amount = +(payout.amount || data.totals?.net || 0);
  if (!dest) {
    const err = new Error('Restaurant must complete Stripe Connect before payout');
    err.status = 400;
    throw err;
  }
  if (!(amount > 0)) {
    const err = new Error('Payout net is zero');
    err.status = 400;
    throw err;
  }
  if (['paid', 'rejected', 'canceled'].includes(String(payout.status).toLowerCase())) {
    const err = new Error(`Payout already ${payout.status}`);
    err.status = 400;
    throw err;
  }

  // The idempotency key is the payout id: a retried execute returns the same Transfer instead of sending a second one.
  const transfer = await stripe.transfers.create({
    amount: toCents(amount),
    currency: String(data.currency || 'gbp').toLowerCase(),
    destination: dest,
    metadata: {
      payout_id: payout.id,
      restaurant_id: payout.restaurant_id,
      kind: 'period_payout',
      stripe_fee: String(data.totals?.stripe_fee || 0),
      order_count: String(data.totals?.order_count || 0),
    },
  }, { idempotencyKey: idempotencyKey || `payout-${payout.id}` });

  const { rows } = await pool.query(
    `UPDATE payouts
     SET status = 'paid', ref = $2, paid_at = NOW(),
         data = COALESCE(data,'{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      payout.id,
      transfer.id,
      JSON.stringify({
        stripe_transfer_id: transfer.id,
        released_at: new Date().toISOString(),
        released_by: by,
      }),
    ],
  );

  const orderIds = Array.isArray(data.order_ids) ? data.order_ids : [];
  if (orderIds.length) {
    await pool.query(
      `UPDATE orders
       SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
       WHERE id = ANY($1::text[])`,
      [
        orderIds.map(String),
        JSON.stringify({
          payout_status: 'paid',
          stripe_transfer_id: transfer.id,
          payout_released_at: new Date().toISOString(),
        }),
      ],
    ).catch(async () => {
      const nums = orderIds.map(Number).filter(Number.isFinite);
      if (nums.length) {
        await pool.query(
          `UPDATE orders
           SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
           WHERE id = ANY($1::bigint[])`,
          [
            nums,
            JSON.stringify({
              payout_status: 'paid',
              stripe_transfer_id: transfer.id,
              payout_released_at: new Date().toISOString(),
            }),
          ],
        );
      }
    });
  }

  logStripe('period_payout.paid', {
    payout_id: payout.id,
    transfer_id: transfer.id,
    amount_cents: transfer.amount,
    stripe_fee: data.totals?.stripe_fee,
    by,
  });
  return rows[0];
}

/**
 * Cron: for each restaurant, build due period payouts into the approval queue
 * (or auto-Transfer when payout_mode=automate).
 */
let releaseInFlight = false;

/**
 * Releases due held orders into payouts. Only one run per process at a time: a cron tick that starts while a run is
 * still going (slow Stripe calls) returns at once. Cross-process safety comes from the order claim in the database.
 */
async function releaseDueHeldPayouts(stripe, options = {}) {
  if (releaseInFlight) return { processed: 0, skipped: 'in_progress', results: [] };
  releaseInFlight = true;
  try {
    return await runReleaseDueHeldPayouts(stripe, options);
  } finally {
    releaseInFlight = false;
  }
}

async function runReleaseDueHeldPayouts(stripe, { limit = 50 } = {}) {
  await ensurePayoutsTable();
  const { rows: restaurants } = await pool.query(
    // restaurants has no currency column (currency lives in data, and defaults to GBP in buildPeriodPayoutForRestaurant).
    `SELECT id, name, data FROM restaurants WHERE status IS DISTINCT FROM FALSE LIMIT $1`,
    [limit],
  );
  const results = [];
  for (const row of restaurants) {
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const billing = {
      ...BILLING_DEF,
      ...(data.billing || {}),
      stripe_account: data.stripe_account || data.billing?.stripe_account,
    };
    billing.platform_fees = {
      online: +(billing.platform_fee || 0),
      table_qr: +(billing.platform_fee || 0),
      pos: +(billing.platform_fee || 0),
      ...(billing.platform_fees || {}),
    };
    if (chargeModeOf(billing) === 'direct') continue;
    try {
      const payout = await buildPeriodPayoutForRestaurant(stripe, { ...row, ...data, id: row.id }, billing);
      if (payout) {
        results.push({
          restaurant_id: row.id,
          payout_id: payout.id,
          status: payout.status,
          amount: +payout.amount,
          ok: true,
        });
      }
    } catch (err) {
      logStripe('period_payout.build_failed', { restaurant_id: row.id, error: err.message });
      results.push({ restaurant_id: row.id, ok: false, error: err.message });
    }
  }
  return { processed: results.length, results };
}

module.exports = {
  BILLING_DEF,
  SCHED_DAYS,
  toCents,
  fromCents,
  round2,
  chargeModeOf,
  payoutModeOf,
  scheduleHoldDays,
  releaseAtFrom,
  calcFees,
  estimateStripeFee,
  resolveStripeFee,
  logStripe,
  createVendorPaymentIntent,
  enqueueHeldPayoutForOrder,
  applyRefundToHeldOrder,
  cancelHeldPayoutForOrder,
  reverseVendorTransfer,
  createConnectRefund,
  buildPeriodPayoutForRestaurant,
  executePayoutTransfer,
  recalculatePayoutBatch,
  buildOrderPayoutLine,
  releaseDueHeldPayouts,
  ensurePayoutsTable,
};
