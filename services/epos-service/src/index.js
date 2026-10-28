const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth } = require('@cravedash/shared/src/authMiddleware');
const epos = require('./routes/epos');
const sync = require('./routes/sync');

const app = createApp('epos-service');
const PORT = +(process.env.PORT || 4006);
const HOST = listenHost();

app.use('/api/v1/epos', requireAuth, epos);
app.use('/api/v1/sync', requireAuth, sync);

// Post-mount error handler converting uncaught errors to standard JSON
const { fail } = require('@cravedash/shared/src/response');
const { AppError } = require('@cravedash/shared/src/errors');
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err instanceof AppError)) {
    console.error('[epos-service]', err);
    err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
  }
  fail(res, err);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`EPOS service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
