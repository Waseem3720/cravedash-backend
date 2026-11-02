const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const reports = require('./routes/reports');

const app = createApp('reporting-service');
const PORT = +(process.env.PORT || 4007);
const HOST = listenHost();

// Reports are for restaurant admins and platform admins only. Chef, driver and customer tokens are refused (SEC-H3).
app.use('/api/v1', requireAuth, requireRole('super', 'restaurant'), reports);

app.listen(PORT, HOST, () => {
  console.log(`Reporting service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});
