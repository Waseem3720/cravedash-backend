const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const authRoutes = require('./routes/auth');
const customerAccountRoutes = require('./routes/customerAccount');

const app = createApp('auth-service');
const PORT = +(process.env.PORT || 4001);
const HOST = listenHost();

app.use('/api/v1/auth', authRoutes);
// The customer's own profile, saved addresses and wishlist (full /api/v1/customer/... paths).
app.use('/api/v1', customerAccountRoutes);

app.listen(PORT, HOST, () => {
  console.log(`Auth service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});
