/**
 * Local PostgreSQL via embedded-postgres (no Docker required).
 * Keeps the process alive so microservices can connect on PGPORT.
 */
const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DATA_DIR = path.join(__dirname, '../.pgdata');
const PORT = +(process.env.PGPORT || 5432);
const USER = process.env.PGUSER || 'cravedash';
const PASSWORD = process.env.PGPASSWORD || 'cravedash';
const DATABASE = process.env.PGDATABASE || 'cravedash';

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  });

  const marker = path.join(DATA_DIR, 'PG_VERSION');
  if (!fs.existsSync(marker)) {
    console.log('[db] Initialising cluster in', DATA_DIR);
    await pg.initialise();
  }

  console.log(`[db] Starting PostgreSQL on port ${PORT}…`);
  await pg.start();

  try {
    await pg.createDatabase(DATABASE);
    console.log('[db] Created database', DATABASE);
  } catch (e) {
    if (!/already exists/i.test(String(e.message || e))) {
      console.log('[db] createDatabase:', e.message || e);
    }
  }

  console.log(`[db] Ready → postgres://${USER}:****@localhost:${PORT}/${DATABASE}`);
  console.log('[db] Leave this process running. Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\n[db] Stopping…');
    try {
      await pg.stop();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('[db] Failed:', err);
  process.exit(1);
});
