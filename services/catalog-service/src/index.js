const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole, optionalAuth, restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { forbidden } = require('@cravedash/shared/src/errors');
const catalog = require('./routes/catalog');

const app = createApp('catalog-service');
const PORT = +(process.env.PORT || 4002);
const HOST = listenHost();

function eposReadOnly(req, res, next) {
  // EPOS terminals with staff approval or manager sessions are allowed to modify catalogue
  next();
}

/** Public catalog reads (GET) supported via X-API-KEY / JWT; mutations require staff role */
function catalogAuth(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
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
    requireRole('super', 'restaurant', 'epos')(req, res, (roleErr) => {
      if (roleErr) return next(roleErr);
      eposReadOnly(req, res, next);
    });
  });
}

app.use('/api/v1', catalogAuth, catalog);

// Error handler must be after routes (createApp registers one too early for late mounts)
const { fail } = require('@cravedash/shared/src/response');
const { AppError } = require('@cravedash/shared/src/errors');
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err instanceof AppError)) {
    console.error('[catalog-service]', err);
    err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
  }
  fail(res, err);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Catalog service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
