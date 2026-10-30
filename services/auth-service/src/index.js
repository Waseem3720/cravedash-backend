const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const authRoutes = require('./routes/auth');

const app = createApp('auth-service');
const PORT = +(process.env.PORT || 4001);
const HOST = listenHost();

app.use('/api/v1/auth', authRoutes);

// Error handler must be after routes
const { fail } = require('@cravedash/shared/src/response');
const { AppError } = require('@cravedash/shared/src/errors');
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err instanceof AppError)) {
    console.error('[auth-service]', err);
    err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
  }
  fail(res, err);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Auth service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
