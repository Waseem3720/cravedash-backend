#!/usr/bin/env node
/**
 * Read-only sale journal reconciliation report. Prints JSON. It creates nothing and changes nothing.
 *
 * Usage: RECONCILE_EXPECTED_DATABASE=<database name> node scripts/reconcile-sales.js [restaurant_id]
 *
 * It fails closed:
 *  - RECONCILE_EXPECTED_DATABASE must be set. There is no default and no guessed name.
 *  - The connected database name must equal RECONCILE_EXPECTED_DATABASE, or the script refuses.
 *  - The report runs inside a READ ONLY transaction, which refuses any write.
 *  - Every path after BEGIN READ ONLY attempts ROLLBACK before the client is released.
 *
 * Exit codes: 0 report printed, 1 unexpected error, 2 expected database not set, 3 database mismatch.
 */
const { reconcileSales } = require('../shared/src/engines/saleReconciliation');

/**
 * Runs the reconciliation. The pool, environment, arguments and output streams are injected, so the exit-code and
 * rollback contract can be tested without a database.
 */
async function main({
  pool,
  env = process.env,
  argv = process.argv,
  stdout = console.log,
  stderr = console.error,
  reconcile = reconcileSales,
}) {
  const expected = String(env.RECONCILE_EXPECTED_DATABASE || '').trim();
  if (!expected) {
    stderr('refusing to run: set RECONCILE_EXPECTED_DATABASE to the name of the database you intend to read');
    return 2;
  }
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN READ ONLY');
    inTransaction = true;
    const { rows } = await client.query('SELECT current_database() AS db');
    const actual = rows[0].db;
    stderr(`connected database: ${actual}`);
    if (actual !== expected) {
      stderr(`refusing to run: connected database "${actual}" does not match RECONCILE_EXPECTED_DATABASE "${expected}"`);
      return 3;
    }
    const report = await reconcile(client, { restaurantId: argv[2] || null });
    stdout(JSON.stringify({ database: actual, ...report }, null, 2));
    return 0;
  } catch (err) {
    stderr(`reconciliation failed: ${err.message}`);
    return 1;
  } finally {
    if (inTransaction) {
      // Roll back on every path, including errors. A failed rollback is reported, but the client is still released.
      await client.query('ROLLBACK').catch((err) => stderr(`rollback failed: ${err.message}`));
    }
    client.release();
  }
}

module.exports = { main };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const pool = require('../shared/src/db');
  main({ pool })
    .then((code) => { process.exitCode = code; })
    .finally(() => pool.end());
}
