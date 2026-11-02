const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { optionalAuth } = require('@cravedash/shared/src/authMiddleware');
const { readCookie, SESSION_COOKIE } = require('@cravedash/shared/src/jwt');
const { resolveTrustProxy } = require('@cravedash/shared/src/createApp');

const app = express();
const PORT = +(process.env.GATEWAY_PORT || process.env.PORT || 4000);

// The gateway sees the real client address on its socket. Only a proxy in front of the gateway (for example a load
// balancer) may be trusted, and only when GATEWAY_TRUST_PROXY names it (SEC-M2).
app.set('trust proxy', process.env.GATEWAY_TRUST_PROXY ? resolveTrustProxy(process.env.GATEWAY_TRUST_PROXY) : false);

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
        // Strip client-spoofable privilege headers; re-set only from verified JWT
        proxyReq.removeHeader('x-user-role');
        proxyReq.removeHeader('x-user-id');
        // Replace any client-supplied forwarding header with the address this gateway saw (SEC-M2).
        proxyReq.setHeader('x-forwarded-for', req.ip || req.socket.remoteAddress || '');
        if (req.user) {
          proxyReq.setHeader('x-user-id', req.user.sub || req.user.id || '');
          proxyReq.setHeader('x-user-role', req.user.role || '');
          // Super may target a restaurant; others must use JWT restaurant_id only
          let rid = req.user.restaurant_id;
          if (req.user.role === 'super') {
            rid = req.headers['x-restaurant-id'] || req.user.restaurant_id || rid;
          }
          if (rid) proxyReq.setHeader('x-restaurant-id', rid);
          else proxyReq.removeHeader('x-restaurant-id');
        } else {
          proxyReq.removeHeader('x-restaurant-id');
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
app.get('/', (req, res) => res.json({ service: 'cravedash-gateway', api: '/api/v1' }));

/**
 * Default-deny for /api/v1 (SEC-M20). Every request needs a verified session unless it matches this list.
 * Each entry is method + exact path (an optional trailing slash is allowed). Nothing else is public.
 *   - sign-in, MFA completion, OTP and social login (no session exists yet), and logout (clears cookies only)
 *   - provider webhooks; each handler verifies its own signature or token
 */
const PUBLIC_API_ROUTES = [
  ['POST', /^\/api\/v1\/auth\/(login|mfa\/verify|otp\/request|otp\/verify|logout|registration|customer\/login)\/?$/],
  // Kitchen (chef) sign-in by PIN and the password reset steps. No session yet, so they are public.
  ['POST', /^\/api\/v1\/auth\/(staff\/pin-login|forgot-password|verify-otp|resend-otp|reset-password)\/?$/],
  // Gateway health for the kitchen app. Read-only.
  ['GET', /^\/api\/v1\/system\/status\/?$/],
  ['POST', /^\/api\/v1\/auth\/oauth\/(google|facebook|apple)\/?$/i],
  ['POST', /^\/api\/v1\/stripe\/webhook\/?$/],
  ['POST', /^\/api\/v1\/callerid\/inbound\/?$/],
  ['POST', /^\/api\/v1\/engines\/marketplaces\/[^/]+\/webhook\/?$/],
  // Public read-only catalogue for the website. GET only: writes to these paths still need a session.
  ['GET', /^\/api\/v1\/public\/(categories|products|deals|config|addons)(\/[^/]+)?\/?$/],
  // Postcode and delivery-fee checks (order service). Read-only, no sign-in.
  ['GET', /^\/api\/v1\/public\/(check-postcode|delivery-fee)\/?$/],
  // Table availability for the website booking form (no login). Booking itself needs a customer session.
  ['GET', /^\/api\/v1\/customer\/reservations\/(availability|settings|tables)\/?$/],
];

function isPublicApiRoute(req) {
  const pathOnly = String(req.originalUrl || '').split('?')[0];
  return PUBLIC_API_ROUTES.some(([method, re]) => method === req.method && re.test(pathOnly));
}

// Browser sessions: the httpOnly session cookie becomes the Bearer token the services already verify (FE-H2).
function sessionCookieToBearer(req, res, next) {
  if (!req.headers.authorization) {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) req.headers.authorization = `Bearer ${token}`;
  }
  next();
}

const verifyAtEdge = process.env.GATEWAY_JWT_VERIFY !== 'off';
if (!verifyAtEdge) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('GATEWAY_JWT_VERIFY=off is forbidden in production');
  }
  console.warn('[gateway] GATEWAY_JWT_VERIFY=off — JWT edge verify disabled (dev only); services still verify tokens');
}

app.use('/api/v1', sessionCookieToBearer);
if (verifyAtEdge) app.use('/api/v1', optionalAuth);

function requireSessionByDefault(req, res, next) {
  if (isPublicApiRoute(req) || req.user) return next();
  // With edge verify off, a Bearer header is required and the service verifies it.
  if (!verifyAtEdge && /^Bearer\s+\S+/.test(req.headers.authorization || '')) return next();
  return res.status(401).json({
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Sign in required' },
  });
}
app.use('/api/v1', requireSessionByDefault);

// Gateway and service health for the kitchen app (SEC: reports only up/down, never internal addresses).
app.get('/api/v1/system/status', async (req, res) => {
  const entries = await Promise.all(Object.entries(targets).map(async ([name, base]) => {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      return [name, r.ok ? 'up' : 'down'];
    } catch {
      return [name, 'down'];
    }
  }));
  const services = Object.fromEntries(entries);
  const healthy = Object.values(services).every((s) => s === 'up');
  res.json({
    success: true,
    data: {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      service: 'cravedash-gateway',
      version: '2.0.0',
      services,
    },
  });
});

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
  '/api/v1/payouts',
  '/api/v1/refund-requests',
  '/api/v1/audit-events',
]));

app.use(proxy('auth', targets.auth, ['/api/v1/auth', '/api/v1/customer/info', '/api/v1/customer/address', '/api/v1/customer/wish-list']));
app.use(proxy('order', targets.order, ['/api/v1/public/check-postcode', '/api/v1/public/delivery-fee']));
app.use(proxy('catalog', targets.catalog, [
  '/api/v1/public',
  '/api/v1/product-assignments',
  '/api/v1/category-assignments',
  '/api/v1/branch-copy',
  '/api/v1/catalog',
  '/api/v1/categories',
  '/api/v1/subcategories',
  '/api/v1/products',
  '/api/v1/addons',
  '/api/v1/cuisines',
  '/api/v1/deals',
]));
app.use(proxy('order', targets.order, ['/api/v1/orders', '/api/v1/customer/orders', '/api/v1/customer/order', '/api/v1/coupon', '/api/v1/deliveryman']));
app.use(proxy('restaurant', targets.restaurant, [
  '/api/v1/restaurant',
  '/api/v1/customers',
  '/api/v1/coupons',
  '/api/v1/tables',
  '/api/v1/bookings',
  '/api/v1/approvals',
  '/api/v1/employees',
  '/api/v1/settings',
  '/api/v1/deliverymen',
  '/api/v1/riders',
  '/api/v1/support',
  '/api/v1/brand',
  '/api/v1/deliveryman-requests',
  '/api/v1/deliveryman-reviews',
  '/api/v1/delivery-reviews',
  '/api/v1/drivers',
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
  '/api/v1/customer/reservations',
]));
app.use(proxy('epos', targets.epos, ['/api/v1/epos', '/api/v1/sync']));
app.use(proxy('reporting', targets.reporting, ['/api/v1/reports', '/api/v1/dashboard']));

const { listenHost } = require('@cravedash/shared/src/listenHost');
const HOST = listenHost({ gateway: true });

// Tests import this module for the app itself; only a direct run (npm run dev:gateway) starts the listener.
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Gateway listening on http://${HOST}:${PORT}`);
    console.log('[gateway] platform →', targets.platform);
  });
}

module.exports = { app };
