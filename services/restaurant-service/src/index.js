const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const express = require('express');
const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole, optionalAuth, restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { forbidden } = require('@cravedash/shared/src/errors');
const restaurant = require('./routes/restaurant');
const integrations = require('./routes/integrations');
const engines = require('./routes/engines');
const subscribers = require('./routes/subscribers');

const app = createApp('restaurant-service');
const PORT = +(process.env.PORT || 4004);
const HOST = listenHost();

/** EPOS may read settings/blobs; mutations reserved for restaurant/super (prefs OK). */
function eposReadOnly(req, res, next) {
  if (req.user?.role === 'epos' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const open = [
      '/print/', '/callerid/', '/notifications/', '/integrations/',
      '/engines/inventory/deduct', '/engines/wallet/debit', '/engines/loyalty/',
      '/engines/terminals/charge', '/engines/couriers/', '/engines/marketplaces/',
      '/rating',
    ];
    if (open.some((p) => req.path.includes(p) || req.originalUrl.includes(p))) {
      return next();
    }
    if (req.path === '/settings/prefs' || req.originalUrl.indexOf('/settings/prefs') >= 0) {
      return next();
    }
    if (
      req.originalUrl.includes('/blobs/calls_live')
      || req.originalUrl.includes('/blobs/call_log')
      || req.originalUrl.includes('/blobs/call_seq')
      || req.originalUrl.includes('/blobs/print_log')
      || req.originalUrl.includes('/blobs/print_queue')
    ) {
      return next();
    }
    return next(forbidden('EPOS role cannot modify restaurant admin data'));
  }
  next();
}

// Twilio / PBX caller-ID webhook — no JWT; validated inside the route
app.post(
  '/api/v1/callerid/inbound',
  express.urlencoded({ extended: true }),
  optionalAuth,
  integrations.inboundHandler,
);

// Marketplace webhooks (Uber Eats / Just Eat / Deliveroo style) — restaurant_id in query/header/body
const { ingestMarketplaceOrder } = require('@cravedash/shared/src/engines/couriers');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { created } = require('@cravedash/shared/src/response');
const { badRequest } = require('@cravedash/shared/src/errors');
app.post('/api/v1/engines/marketplaces/:source/webhook', optionalAuth, asyncHandler(async (req, res) => {
  const source = req.params.source;
  const restaurantHint = req.body?.restaurant_id || req.headers['x-restaurant-id'] || req.query.restaurant_id;
  if (!restaurantHint) throw badRequest('restaurant_id required');
  created(res, await ingestMarketplaceOrder(String(restaurantHint), source, {
    ...req.body,
    external_id: req.body?.id || req.body?.orderId || req.body?.external_id,
  }));
}));

/** Public storefront requests supported for config, banners, and coupon endpoints */
const PUBLIC_PREFIXES = ['/config', '/banners', '/coupon', '/brand'];
function restaurantAuth(req, res, next) {
  // Allow public storefront access to /subscribers/events and /deliverymen/requests via trusted API-key context
  const isSubscriberEvent = req.method === 'POST' && (
    req.path === '/events' ||
    req.path === '/subscribers/events' ||
    req.originalUrl.includes('/subscribers/events')
  );

  const isDmRequestSubmit = req.method === 'POST' && (
    (req.path === '/deliverymen/requests' || req.originalUrl.includes('/deliverymen/requests')) &&
    !req.path.includes('/approve') && !req.path.includes('/deny') &&
    !req.originalUrl.includes('/approve') && !req.originalUrl.includes('/deny')
  );

  const isPublic = isSubscriberEvent || isDmRequestSubmit || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p) || req.originalUrl.includes(p));
  if (isPublic && ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return optionalAuth(req, res, () => {
      try {
        restaurantId(req);
        next();
      } catch (err) {
        next(err);
      }
    });
  }
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.path.startsWith('/customer') || req.originalUrl.includes('/customer')) {
      return requireRole('customer', 'super', 'restaurant', 'epos')(req, res, (roleErr) => {
        if (roleErr) return next(roleErr);
        eposReadOnly(req, res, next);
      });
    }
    // Subscribers admin endpoints (listing, details, GDPR deletion) strictly restricted to restaurant and super admins
    if (req.path.startsWith('/subscribers') || req.baseUrl.endsWith('/subscribers') || req.originalUrl.includes('/subscribers')) {
      return requireRole('super', 'restaurant')(req, res, next);
    }
    // Deliveryman reviews creation allowed for customers (reviewing their orders) and admins
    const isDmReviewSubmit = req.method === 'POST' && (
      req.path.includes('/deliverymen/reviews') || req.originalUrl.includes('/deliverymen/reviews')
    );
    if (isDmReviewSubmit) {
      return requireRole('customer', 'super', 'restaurant')(req, res, next);
    }
    // Deliveryman requests administrative workflow (listing, details, approval, rejection) strictly restricted to restaurant and super admins
    if (req.path.includes('/deliverymen/requests') || req.originalUrl.includes('/deliverymen/requests')) {
      return requireRole('super', 'restaurant')(req, res, next);
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return requireRole('super', 'restaurant', 'epos', 'rider', 'chef')(req, res, next);
    }
    requireRole('super', 'restaurant', 'epos')(req, res, (roleErr) => {
      if (roleErr) return next(roleErr);
      eposReadOnly(req, res, next);
    });
  });
}

app.use('/api/v1', (req, res, next) => {
  if (req.path.startsWith('/engines') || req.originalUrl.includes('/engines')) {
    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      requireRole('super', 'restaurant', 'epos')(req, res, (roleErr) => {
        if (roleErr) return next(roleErr);
        eposReadOnly(req, res, () => engines(req, res, next));
      });
    });
  }
  next();
});

app.use('/api/v1', (req, res, next) => {
  const isIntegration = ['/integrations', '/notifications', '/print', '/callerid'].some((p) => req.path.startsWith(p) || req.originalUrl.includes(p));
  if (isIntegration) {
    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      requireRole('super', 'restaurant', 'epos', 'chef')(req, res, (roleErr) => {
        if (roleErr) return next(roleErr);
        eposReadOnly(req, res, () => integrations(req, res, next));
      });
    });
  }
  next();
});

app.use('/api/v1/subscribers', restaurantAuth, subscribers);
app.use('/api/v1', restaurantAuth, restaurant);

// Error handler must be after routes (createApp registers one too early for late mounts)
const { fail } = require('@cravedash/shared/src/response');
const { AppError } = require('@cravedash/shared/src/errors');
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err instanceof AppError)) {
    console.error('[restaurant-service]', err);
    err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
  }
  fail(res, err);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Restaurant service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
