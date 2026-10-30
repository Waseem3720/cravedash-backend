const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { optionalAuth } = require('@cravedash/shared/src/authMiddleware');

const app = express();
const PORT = +(process.env.GATEWAY_PORT || process.env.PORT || 4000);

const corsOrigin = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && (!corsOrigin || corsOrigin === '*')) {
  throw new Error('CORS_ORIGIN must be an explicit allowlist in production (not *)');
}
const origin = !corsOrigin || corsOrigin === '*'
  ? true
  : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin, credentials: true }));
app.use(morgan(process.env.LOG_FORMAT || 'dev'));

// Prefer 127.0.0.1 over localhost to avoid IPv6 (::1) mismatch when a service
// is bound only on IPv4 (common cause of intermittent Bad Gateway).
const targets = {
  auth: process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
  catalog: process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:4002',
  order: process.env.ORDER_SERVICE_URL || 'http://127.0.0.1:4003',
  restaurant: process.env.RESTAURANT_SERVICE_URL || 'http://127.0.0.1:4004',
  platform: process.env.PLATFORM_SERVICE_URL || 'http://127.0.0.1:4005',
  epos: process.env.EPOS_SERVICE_URL || 'http://127.0.0.1:4006',
  reporting: process.env.REPORTING_SERVICE_URL || 'http://127.0.0.1:4007',
};

/** Exact prefix match: `/restaurant` must NOT steal `/restaurants`. */
function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function matchesAny(pathname, prefixes) {
  return prefixes.some((p) => matchesPrefix(pathname, p));
}

const pool = require('@cravedash/shared/src/db');

// In-memory cache for API key validation (5-minute TTL)
const apiKeyCache = new Map();
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const trimmed = apiKey.trim();
  if (!trimmed) return null;

  const now = Date.now();
  const cached = apiKeyCache.get(trimmed);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, status, 
              COALESCE(data->>'api_key', '') AS api_key,
              COALESCE((data->>'api_key_status')::boolean, true) AS api_key_active
       FROM restaurants 
       WHERE (data->>'api_key' = $1)
       LIMIT 1`,
      [trimmed]
    );

    let result = null;
    if (rows.length > 0) {
      const r = rows[0];
      if (r.status && r.api_key_active) {
        result = { restaurantId: r.id };
      } else {
        result = { error: 'Restaurant or API key is inactive' };
      }
    }

    apiKeyCache.set(trimmed, {
      result,
      expiresAt: now + API_KEY_CACHE_TTL_MS,
    });
    return result;
  } catch (err) {
    console.error('[gateway] Failed to resolve API key from DB:', err.message);
    return null;
  }
}

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next();

  const resolved = await resolveApiKey(apiKey);
  if (!resolved) {
    return res.status(401).json({
      success: false,
      error: { message: 'Invalid API key', code: 'INVALID_API_KEY' },
    });
  }

  if (resolved.error) {
    return res.status(401).json({
      success: false,
      error: { message: resolved.error, code: 'INACTIVE_API_KEY' },
    });
  }

  req.apiKeyRestaurantId = resolved.restaurantId;
  next();
}

function proxy(name, target, prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    proxyTimeout: 30000,
    timeout: 30000,
    pathFilter: (pathname) => matchesAny(pathname, list),
    // Keep the full /api/v1/... path for downstream services.
    pathRewrite: (_p, req) => req.originalUrl,
    on: {
      proxyReq: (proxyReq, req) => {
        // Strip client-spoofable privilege and tenant headers
        proxyReq.removeHeader('x-user-role');
        proxyReq.removeHeader('x-user-id');
        proxyReq.removeHeader('x-branch-id');
        proxyReq.removeHeader('x-epos-till-id');
        proxyReq.removeHeader('x-impersonator-id');

        if (req.user) {
          proxyReq.setHeader('x-user-id', req.user.sub || req.user.id || '');
          proxyReq.setHeader('x-user-role', req.user.role || '');
          if (req.user.branch_id) {
            proxyReq.setHeader('x-branch-id', req.user.branch_id);
          }
          if (req.user.till_id) {
            proxyReq.setHeader('x-epos-till-id', req.user.till_id);
          }
          // Super may target a restaurant; others must use JWT restaurant_id only
          let rid = req.user.restaurant_id;
          if (req.user.role === 'super') {
            rid = req.headers['x-restaurant-id'] || req.user.restaurant_id || rid;
          }
          if (rid) proxyReq.setHeader('x-restaurant-id', rid);
          else proxyReq.removeHeader('x-restaurant-id');
        } else if (req.apiKeyRestaurantId) {
          // Public request validated via X-API-KEY
          proxyReq.setHeader('x-restaurant-id', req.apiKeyRestaurantId);
        } else {
          // Unauthenticated requests: do NOT trust caller-supplied x-restaurant-id header.
          const p = (req.originalUrl || req.url || '').split('?')[0];
          const isSite1CustomerRoute = /^\/api\/v1\/(auth\/(login|registration|register|otp|oauth|social|email-verification)|config|banners|catalog|categories|products|addons|deals|coupon\/(list|apply)|customer\/order\/(calculate|deal-preview|place|track))(\/|$)/.test(p);
          const defaultRid = (isSite1CustomerRoute ? (process.env.DEFAULT_RESTAURANT_ID || 'r1') : process.env.DEFAULT_RESTAURANT_ID) || null;
          if (defaultRid) {
            proxyReq.setHeader('x-restaurant-id', defaultRid);
          } else {
            proxyReq.removeHeader('x-restaurant-id');
          }
        }
      },
      error: (err, req, res) => {
        console.error(`[gateway] ${name} proxy error → ${target}`, err.message, req.originalUrl);
        if (!res.headersSent) {
          const payload = {
            success: false,
            error: {
              message: 'Bad gateway',
              service: name,
            },
          };
          if (process.env.NODE_ENV !== 'production') {
            payload.error.detail = `${name} unreachable: ${err.message}`;
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
      },
    },
  });
}

app.get('/health', (req, res) => {
  const body = { ok: true, service: 'gateway' };
  // Never expose internal service URLs publicly in production
  if (process.env.NODE_ENV !== 'production' && req.query.detail === '1') {
    body.targets = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, v]));
  }
  res.json(body);
});
app.get('/api/v1/system/status', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'online',
      service: 'gateway',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    },
  });
});
app.get('/', (req, res) => res.json({ service: 'cravedash-gateway', api: '/api/v1' }));

if (process.env.GATEWAY_JWT_VERIFY === 'off') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('GATEWAY_JWT_VERIFY=off is forbidden in production');
  }
  console.warn('[gateway] GATEWAY_JWT_VERIFY=off — JWT edge verify disabled (dev only)');
} else {
  app.use('/api/v1', optionalAuth);
}
app.use('/api/v1', apiKeyAuth);

// Platform FIRST so /api/v1/restaurants never races with /api/v1/restaurant.
app.use(proxy('platform', targets.platform, [
  '/api/v1/platform',
  '/api/v1/platform-meta',
  '/api/v1/restaurants',
  '/api/v1/plans',
  '/api/v1/subscriptions',
  '/api/v1/admins',
  '/api/v1/stripe',
  '/api/v1/support-tickets',
  '/api/v1/support',
  '/api/v1/payouts',
  '/api/v1/refund-requests',
  '/api/v1/audit-events',
]));

app.use(proxy('auth', targets.auth, ['/api/v1/auth']));
app.use(proxy('catalog', targets.catalog, [
  '/api/v1/catalog',
  '/api/v1/categories',
  '/api/v1/subcategories',
  '/api/v1/products',
  '/api/v1/addons',
  '/api/v1/cuisines',
  '/api/v1/deals',
]));
app.use(proxy('order', targets.order, [
  '/api/v1/orders',
  '/api/v1/customer/order',
  '/api/v1/rider',
  '/api/v1/deliveryman',
]));
app.use(proxy('restaurant', targets.restaurant, [
  '/api/v1/restaurant',
  '/api/v1/customer',
  '/api/v1/customers',
  '/api/v1/coupons',
  '/api/v1/coupon',
  '/api/v1/tables',
  '/api/v1/bookings',
  '/api/v1/booking',
  '/api/v1/reservations',
  '/api/v1/approvals',
  '/api/v1/employees',
  '/api/v1/settings',
  '/api/v1/deliverymen',
  '/api/v1/riders',
  '/api/v1/chefs',
  '/api/v1/blobs',
  '/api/v1/domain',
  '/api/v1/domain-meta',
  '/api/v1/inventory',
  '/api/v1/payroll',
  '/api/v1/accounting',
  '/api/v1/integrations',
  '/api/v1/notifications',
  '/api/v1/print',
  '/api/v1/callerid',
  '/api/v1/engines',
  '/api/v1/commerce',
  '/api/v1/ops',
  '/api/v1/subscribers',
  '/api/v1/config',
  '/api/v1/banners',
  '/api/v1/brand',
]));
app.use(proxy('epos', targets.epos, ['/api/v1/epos', '/api/v1/sync']));
app.use(proxy('reporting', targets.reporting, ['/api/v1/reports', '/api/v1/dashboard']));

const { listenHost } = require('@cravedash/shared/src/listenHost');
const HOST = listenHost({ gateway: true });
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Gateway listening on http://${HOST}:${PORT}`);
    console.log('[gateway] platform →', targets.platform);
  });
}

module.exports = app;
