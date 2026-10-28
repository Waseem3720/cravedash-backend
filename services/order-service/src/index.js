const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const orders = require('./routes/orders');
const customerOrders = require('./routes/customerOrders');
const riderOrders = require('./routes/riderOrders');

const app = createApp('order-service');
const PORT = +(process.env.PORT || 4003);
const HOST = listenHost();

app.use('/api/v1/orders', requireAuth, requireRole('super', 'restaurant', 'epos', 'rider', 'chef'), orders);
app.use('/api/v1/customer/order', customerOrders);
app.use('/api/v1/rider', riderOrders);

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Order service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;

