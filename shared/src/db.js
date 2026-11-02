const { Pool } = require('pg');
require('dotenv').config({ path: process.env.DOTENV_PATH || require('path').join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'cravedash',
  password: process.env.PGPASSWORD || 'cravedash',
  database: process.env.PGDATABASE || 'cravedash',
  max: +(process.env.PGPOOL_MAX || 10),
  // pg closes idle connections after 10s by default. Each new connection costs about a second on the local embedded
  // database, and the admin screens poll every 30s, so every poll paid that cost. Keep idle connections for 5 minutes.
  idleTimeoutMillis: +(process.env.PG_IDLE_TIMEOUT_MS || 300_000),
  keepAlive: true,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected error', err);
});

/**
 * Opens a few connections at boot, one after another, and returns them to the pool. A new connection is slow on the local
 * embedded database, so without this the first burst of requests after a restart waits for every connection to open.
 */
async function warmPool(count = +(process.env.PGPOOL_WARM || 6)) {
  const clients = [];
  try {
    for (let i = 0; i < count; i += 1) clients.push(await pool.connect());
  } catch (err) {
    console.warn('[pg] pool warm-up skipped:', err.message || err.code);
  } finally {
    clients.forEach((client) => client.release());
  }
}

module.exports = pool;
module.exports.warmPool = warmPool;
