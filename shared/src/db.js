const { Pool } = require('pg');
require('dotenv').config({ path: process.env.DOTENV_PATH || require('path').join(__dirname, '../../.env') });

// PRECEDENCE: Discrete parameters (PGHOST, PGPORT, etc.) take highest precedence when PGHOST is set.
// This prevents DATABASE_URL (which often points to localhost for local dev) from overriding PGHOST=postgres in Docker.
const poolConfig = process.env.PGHOST
  ? {
    host: process.env.PGHOST,
    port: +(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'cravedash',
    password: process.env.PGPASSWORD || 'cravedash',
    database: process.env.PGDATABASE || 'cravedash',
    max: +(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: +(process.env.PG_IDLE_TIMEOUT_MS || 300_000),
    keepAlive: true,
  }
  : {
    connectionString: process.env.DATABASE_URL || 'postgres://cravedash:cravedash@localhost:5432/cravedash',
    max: +(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: +(process.env.PG_IDLE_TIMEOUT_MS || 300_000),
    keepAlive: true,
  };

const pool = new Pool(poolConfig);

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
