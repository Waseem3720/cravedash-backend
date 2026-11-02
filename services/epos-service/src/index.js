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

app.listen(PORT, HOST, () => {
  console.log(`EPOS service on http://${HOST}:${PORT}`);
  require('@cravedash/shared/src/db').warmPool();
});
