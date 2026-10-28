const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const authRoutes = require('./routes/auth');

const app = createApp('auth-service');
const PORT = +(process.env.PORT || 4001);
const HOST = listenHost();

app.use('/api/v1/auth', authRoutes);

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Auth service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
