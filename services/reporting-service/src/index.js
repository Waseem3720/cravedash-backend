const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createApp } = require('@cravedash/shared/src/createApp');
const { listenHost } = require('@cravedash/shared/src/listenHost');
const { requireAuth } = require('@cravedash/shared/src/authMiddleware');
const reports = require('./routes/reports');

const app = createApp('reporting-service');
const PORT = +(process.env.PORT || 4007);
const HOST = listenHost();

app.use('/api/v1', requireAuth, reports);

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Reporting service on http://${HOST}:${PORT}`);
  });
}

module.exports = app;
