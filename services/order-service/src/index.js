const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { types } = require('pg');
const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const orders = require('./routes/orders');
const customerOrders = require('./routes/customerOrders');
const customerOrderRead = require('./routes/customerOrderRead');
const customerCoupons = require('./routes/customerCoupons');
const publicDelivery = require('./routes/publicDelivery');
const deliveryman = require('./routes/deliveryman');

// NUMERIC (OID 1700) comes back from pg as a string; parse it so dashboard sums stay numeric.
types.setTypeParser(1700, (value) => parseFloat(value));

const app = createApp('order-service');
const PORT = +(process.env.PORT || 4003);
const HOST = listenHost();

// A kitchen (chef) session may read orders and run the kitchen actions only (cheff.md). Everything else stays admin/till.
const KITCHEN_ACTIONS = /^\/[^/]+\/(accept|reject|ready|complete|print|dispatch|status)\/?$/;
function chefOrderGuard(req, res, next) {
  if (req.user?.role !== 'chef') return next();
  if (req.method === 'GET' || KITCHEN_ACTIONS.test(req.path)) return next();
  return next(new (require('@cravedash/shared/src/errors').AppError)('A kitchen session cannot do this order action', 403, 'FORBIDDEN'));
}

app.use('/api/v1/orders', requireAuth, requireRole('super', 'restaurant', 'epos', 'chef'), chefOrderGuard, orders);
// Rider app. Each route checks its own role (a rider, or restaurant staff for the handover confirmation).
app.use('/api/v1/deliveryman', requireAuth, requireRole('driver', 'restaurant', 'super', 'epos'), deliveryman);
// Customer orders (website checkout). The route itself checks the customer token with requireCustomer.
app.use('/api/v1/customer/orders', customerOrders);
// The customer's own order list, details and tracking (read only). Also checks the customer token itself.
app.use('/api/v1/customer/order', customerOrderRead);
// Coupons the website shows and checks (the same rules checkout applies).
app.use('/api/v1/coupon', customerCoupons);
// Postcode and delivery-fee checks for the website. Public (no sign-in): the gateway lists the two GET paths.
app.use('/api/v1/public', publicDelivery);

app.listen(PORT, HOST, () => {
  console.log(`Order service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});

// Retries order side effects that failed, or whose worker stopped while holding them (AUD-P1-2). Each run uses the same
// claims as the order save, so it never repeats an effect that finished.
const { retryOrderEffects } = require('@cravedash/shared/src/orderEngines');
const EFFECT_RETRY_MS = Math.max(10_000, +(process.env.ORDER_EFFECTS_RETRY_MS || 60_000));
setInterval(() => {
  retryOrderEffects().catch((err) => console.error('[order-effects] retry failed', err.message));
}, EFFECT_RETRY_MS);
