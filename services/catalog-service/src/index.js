const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const { forbidden } = require('@cravedash/shared/src/errors');
const { requireEposStaffSession } = require('@cravedash/shared/src/eposStaffWrite');
const catalog = require('./routes/catalog');
const publicCatalog = require('./routes/publicCatalog');

const app = createApp('catalog-service');
const PORT = +(process.env.PORT || 4002);
const HOST = listenHost();

// EPOS spec: a till may create, change and delete a product or category, with a staff PIN session. Bulk import stays with the admin.
const EPOS_STAFF_WRITE_PATHS = ['/products', '/categories'];

function eposReadOnly(req, res, next) {
  if (req.user?.role === 'epos' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const path = req.path || '';
    const open = path !== '/products/bulk' && EPOS_STAFF_WRITE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
    if (!open) return next(forbidden('EPOS role cannot modify catalogue'));
    try {
      requireEposStaffSession(req);
    } catch (err) {
      return next(err);
    }
  }
  next();
}

// Public read-only catalogue for the website. Mounted before the login check; it has GET routes only.
app.use('/api/v1/public', publicCatalog);

app.use('/api/v1', requireAuth, requireRole('super', 'restaurant', 'epos'), eposReadOnly, catalog);

app.listen(PORT, HOST, () => {
  console.log(`Catalog service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});
