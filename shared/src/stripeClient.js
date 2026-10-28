const Stripe = require('stripe');
const pool = require('./db');
const { badRequest } = require('./errors');

let cache = { secret: null, client: null, config: null, mode: null };

async function loadStripeConfig() {
  const { rows } = await pool.query('SELECT data FROM stripe_config WHERE id = 1');
  const data = rows[0]?.data;
  return data && typeof data === 'object' ? data : {};
}

async function saveStripeConfig(data) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_config (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [JSON.stringify(data || {})],
  );
  cache.config = rows[0].data;
  return rows[0].data;
}

function resolveSecret(config) {
  const mode = config.mode === 'live' ? 'live' : 'test';
  const keys = (config.keys && config.keys[mode]) || {};
  return (
    keys.sk ||
    keys.secret ||
    keys.secret_key ||
    config.secret_key ||
    config.sk ||
    process.env.STRIPE_SECRET_KEY ||
    null
  );
}

function resolvePublishable(config) {
  const mode = config.mode === 'live' ? 'live' : 'test';
  const keys = (config.keys && config.keys[mode]) || {};
  return keys.pk || keys.publishable || config.publishable_key || null;
}

function resolveWebhookSecret(config) {
  return (
    (config.webhook && (config.webhook.secret || config.webhook.signing_secret)) ||
    config.webhook_secret ||
    config.webhookSecret ||
    process.env.STRIPE_WEBHOOK_SECRET ||
    null
  );
}

function clearStripeCache() {
  cache = { secret: null, client: null, config: null, mode: null };
}

/**
 * @returns {Promise<{ stripe: import('stripe').Stripe, config: object, mode: string, publishableKey: string|null }>}
 */
async function getStripe() {
  const config = await loadStripeConfig();
  const mode = config.mode === 'live' ? 'live' : 'test';
  const secret = resolveSecret(config);
  if (!secret || String(secret).includes('…')) {
    throw badRequest('Stripe secret key is not configured (Super Admin → Stripe)');
  }
  if (cache.client && cache.secret === secret) {
    return {
      stripe: cache.client,
      config,
      mode,
      publishableKey: resolvePublishable(config),
    };
  }
  const stripe = new Stripe(secret);
  cache = { secret, client: stripe, config, mode };
  return {
    stripe,
    config,
    mode,
    publishableKey: resolvePublishable(config),
  };
}

async function touchWebhookHealth(patch) {
  const config = await loadStripeConfig();
  const next = {
    ...config,
    webhook_health: {
      ...(config.webhook_health || {}),
      ...patch,
      updated_at: new Date().toISOString(),
    },
  };
  await saveStripeConfig(next);
  return next.webhook_health;
}

function appBaseUrl(req) {
  const env =
    process.env.PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    null;
  if (env) return env.replace(/\/$/, '');
  const cors = process.env.CORS_ORIGIN || '';
  const first = cors.split(',').map((s) => s.trim()).find((s) => s && s !== '*');
  if (first) return first.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `${proto}://${host}`;
  }
  return 'http://localhost:5173';
}

function apiBaseUrl(req) {
  const env = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || null;
  if (env) return env.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `${proto}://${host}/api/v1`;
  }
  return 'http://localhost:4000/api/v1';
}

module.exports = {
  getStripe,
  loadStripeConfig,
  saveStripeConfig,
  resolveWebhookSecret,
  resolvePublishable,
  clearStripeCache,
  touchWebhookHealth,
  appBaseUrl,
  apiBaseUrl,
};
