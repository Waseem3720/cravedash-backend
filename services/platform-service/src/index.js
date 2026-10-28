const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const { forbidden } = require('@cravedash/shared/src/errors');
const platform = require('./routes/platform');
const { stripeWebhookHandler } = require('./routes/stripeOps');

const app = createApp('platform-service');
const PORT = +(process.env.PORT || 4005);
const HOST = listenHost();

/**
 * Super: full access.
 * Restaurant / epos (impersonation uses restaurant role):
 *   - GET /plans
 *   - GET platform-meta/terms|remote (read-only)
 *   - support-tickets + refund-requests (tenant-scoped in route handlers)
 *   - Stripe connect / payment intent / subscription checkout / refunds (tenant-scoped)
 */
function platformGate(req, res, next) {
  const role = req.user && req.user.role;
  if (role === 'super') return next();

  const method = (req.method || 'GET').toUpperCase();
  const p = req.path || '';

  if (role === 'restaurant' || role === 'epos') {
    if (/^\/plans(\/|$)/.test(p)) {
      if (method === 'GET') return next();
      return next(forbidden('Plans are read-only for restaurants'));
    }
    if (/^\/platform-meta\/(terms|remote)$/.test(p)) {
      if (method === 'GET') return next();
      return next(forbidden('Platform meta is read-only for restaurants'));
    }
    if (/^\/support-tickets(\/|$)/.test(p) || /^\/refund-requests(\/|$)/.test(p)) {
      return next();
    }
    // Payout requests: restaurant can list own + create requested (scoped in handler)
    if (/^\/payouts(\/|$)/.test(p)) {
      if (method === 'GET' || method === 'POST') return next();
      return next(forbidden('Only platform admins can update payouts'));
    }
    // Dual-rail Stripe: restaurant may onboard, create intents, checkout SaaS, request refunds
    if (
      (method === 'POST' && /^\/stripe\/connect\/onboard$/.test(p)) ||
      (method === 'GET' && /^\/stripe\/connect\/status$/.test(p)) ||
      (method === 'POST' && /^\/stripe\/payments\/intent$/.test(p)) ||
      (method === 'POST' && /^\/stripe\/subscriptions\/checkout$/.test(p)) ||
      (method === 'POST' && /^\/stripe\/refunds$/.test(p))
    ) {
      return next();
    }
  }
  return requireRole('super')(req, res, next);
}

// Stripe webhook: no JWT; signature verified inside handler (rawBody via createApp)
app.post('/api/v1/stripe/webhook', stripeWebhookHandler);

app.use('/api/v1', requireAuth, platformGate, platform);

// Post-mount error handler converting uncaught errors to standard JSON
const { fail } = require('@cravedash/shared/src/response');
const { AppError } = require('@cravedash/shared/src/errors');
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err instanceof AppError)) {
    console.error('[platform-service]', err);
    err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
  }
  fail(res, err);
});

/**
 * Option A held-payout releaser — runs every 5 minutes.
 * Transfers net funds to vendor Connect accounts once billing.schedule elapses.
 * Disable with STRIPE_HELD_PAYOUT_CRON=0
 */
function startHeldPayoutCron() {
  if (process.env.STRIPE_HELD_PAYOUT_CRON === '0') {
    console.log('[stripe] held-payout cron disabled');
    return;
  }
  const intervalMs = Math.max(60_000, +(process.env.STRIPE_HELD_PAYOUT_INTERVAL_MS || 300_000));
  const connect = require('@cravedash/shared/src/stripeConnect');
  const { getStripe } = require('@cravedash/shared/src/stripeClient');
  const tick = async () => {
    try {
      const { stripe } = await getStripe();
      const out = await connect.releaseDueHeldPayouts(stripe, { limit: 25 });
      if (out.processed) {
        console.log('[stripe] held-payout cron', JSON.stringify(out));
      }
    } catch (err) {
      // Missing Stripe keys in local/dev is expected — soft-log only
      if (!/not configured|secret key/i.test(err.message || '')) {
        console.warn('[stripe] held-payout cron error:', err.message);
      }
    }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, intervalMs);
  console.log(`[stripe] held-payout cron every ${Math.round(intervalMs / 1000)}s`);
}

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Platform service on http://${HOST}:${PORT}`);
  });
  startHeldPayoutCron();
}

module.exports = app;
