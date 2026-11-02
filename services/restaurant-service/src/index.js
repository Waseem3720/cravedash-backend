const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const express = require('express');
const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole, optionalAuth } = require('@cravedash/shared/src/authMiddleware');
const { forbidden } = require('@cravedash/shared/src/errors');
const restaurant = require('./routes/restaurant');
const integrations = require('./routes/integrations');
const engines = require('./routes/engines');
const drivers = require('./routes/drivers');
const deliverymanRequests = require('./routes/deliverymanRequests');
const deliveryReviews = require('./routes/deliveryReviews');
const customerReservations = require('./routes/customerReservations');
const marketplaceWebhook = require('./routes/marketplaceWebhook');
const kitchen = require('./routes/kitchen');

const app = createApp('restaurant-service');
const PORT = +(process.env.PORT || 4004);
const HOST = listenHost();

// EPOS write guard lives in ./eposGuard.js (path-only matching; integrations closed to EPOS, D2).
const { eposReadOnly } = require('./eposGuard');

// Twilio / PBX caller-ID webhook — no JWT; validated inside the route
app.post(
  '/api/v1/callerid/inbound',
  express.urlencoded({ extended: true }),
  optionalAuth,
  integrations.inboundHandler,
);

// Marketplace webhooks (no JWT; ownership checks and signature status in ./routes/marketplaceWebhook.js)
app.use('/api/v1', marketplaceWebhook);

// Customer routes use their own guard. They must come before the staff chains below, which refuse customer tokens.
app.use('/api/v1', deliveryReviews.customerRouter);
// Website table booking (customer routes). They check the customer token themselves, before the staff guards below.
app.use('/api/v1', customerReservations.customerReservations);
// Staff chains. Each one runs for every /api/v1 request, so the chef role is refused here unless a route opens it.
// The chef role may send a kitchen docket to a printer (cheff.md reprint). Only POST /print/jobs is opened to it.
function staffRole(...roles) {
  const check = requireRole(...roles);
  return (req, res, next) => {
    if (req.user?.role === 'chef' && req.method === 'POST' && req.path === '/print/jobs') return next();
    return check(req, res, next);
  };
}
// Kitchen (chef) routes come first.
app.use('/api/v1', requireAuth, requireRole('super', 'restaurant', 'epos', 'chef'), eposReadOnly, kitchen);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, engines);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, integrations);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, restaurant);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, drivers);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, deliverymanRequests);
app.use('/api/v1', requireAuth, staffRole('super', 'restaurant', 'epos'), eposReadOnly, deliveryReviews.staffRouter);

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

app.listen(PORT, HOST, () => {
  console.log(`Restaurant service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});
