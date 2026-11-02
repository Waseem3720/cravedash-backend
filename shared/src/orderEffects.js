/**
 * Durable state for order side effects (stock, loyalty, sale and their reversals), AUD-P1-2.
 *
 * One row per (restaurant, order, effect) in `order_effects` is the source of truth:
 *   pending  - never claimed (no row) or released after a failure
 *   running  - claimed by one worker; the claim has a lease
 *   done     - finished; never run again
 *   failed   - the last attempt failed; the error is kept in last_error and the effect is retried later
 *
 * A claim is one atomic INSERT ... ON CONFLICT statement. It succeeds only if the row is not done, has attempts left,
 * and is either not running or its lease has run out. A crashed worker's claim therefore expires and can be taken over.
 * Each claim returns an attempt number, and only the holder of that attempt number can finish it (a fencing token), so a
 * stale worker cannot mark a newer attempt as finished. The orders.data flags (engines_* and reversal_*) are kept in step
 * with this table for the existing readers. The table, not the flags, decides what runs.
 */
const pool = require('./db');

const LEASE_SECONDS = 300;
const MAX_ATTEMPTS = 10;

let tableReady = null;

function ensureEffectTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS order_effects (
        restaurant_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        effect TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        lease_until TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (restaurant_id, order_id, effect)
      )
    `).then(() => undefined, (err) => {
      if (err && err.code === '23505') return undefined;
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

/** Claims an effect for one run. Returns the attempt number, or null when another run holds it or it is done. */
async function claimEffect(restaurantId, orderId, effect) {
  await ensureEffectTable();
  const { rows } = await pool.query(
    `INSERT INTO order_effects (restaurant_id, order_id, effect, state, attempts, lease_until, updated_at)
     VALUES ($1, $2, $3, 'running', 1, NOW() + make_interval(secs => $4), NOW())
     ON CONFLICT (restaurant_id, order_id, effect) DO UPDATE SET
       state = 'running',
       attempts = order_effects.attempts + 1,
       lease_until = NOW() + make_interval(secs => $4),
       last_error = NULL,
       updated_at = NOW()
     WHERE order_effects.state <> 'done'
       AND order_effects.attempts < $5
       AND (order_effects.state <> 'running' OR order_effects.lease_until <= NOW())
     RETURNING attempts`,
    [restaurantId, String(orderId), effect, LEASE_SECONDS, MAX_ATTEMPTS],
  );
  return rows[0] ? Number(rows[0].attempts) : null;
}

/** Records the outcome of the attempt this worker holds. Returns false when the claim was taken over meanwhile. */
async function finishEffect(restaurantId, orderId, effect, attempt, state, lastError = null) {
  await ensureEffectTable();
  const { rowCount } = await pool.query(
    `UPDATE order_effects
     SET state = $5, last_error = $6, lease_until = NULL, updated_at = NOW()
     WHERE restaurant_id = $1 AND order_id = $2 AND effect = $3 AND attempts = $4 AND state = 'running'`,
    [restaurantId, String(orderId), effect, attempt, state, lastError],
  );
  return rowCount === 1;
}

/** Reads the stored state of an effect, or null when it has never been claimed. */
async function effectState(restaurantId, orderId, effect) {
  await ensureEffectTable();
  const { rows } = await pool.query(
    'SELECT state FROM order_effects WHERE restaurant_id = $1 AND order_id = $2 AND effect = $3',
    [restaurantId, String(orderId), effect],
  );
  return rows[0] ? rows[0].state : null;
}

/** Marks an effect done when an earlier version of the code already finished it and recorded only the flag. */
async function markLegacyDone(restaurantId, orderId, effect) {
  await ensureEffectTable();
  await pool.query(
    `INSERT INTO order_effects (restaurant_id, order_id, effect, state, attempts, updated_at)
     VALUES ($1, $2, $3, 'done', 0, NOW())
     ON CONFLICT (restaurant_id, order_id, effect) DO NOTHING`,
    [restaurantId, String(orderId), effect],
  );
}

/** Sets or clears one orders.data flag, the legacy view of an effect (`'done'`, or null to clear it). */
async function setOrderFlag(restaurantId, orderId, flag, value) {
  if (value === null) {
    await pool.query(
      `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) - $3::text WHERE id::text = $1 AND restaurant_id = $2`,
      [String(orderId), restaurantId, flag],
    );
    return;
  }
  await pool.query(
    `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || jsonb_build_object($3::text, $4::text), updated_at = NOW()
     WHERE id::text = $1 AND restaurant_id = $2`,
    [String(orderId), restaurantId, flag, value],
  );
}

/**
 * Runs one side effect for an order under its claim. A failure is recorded and the claim is released for a later retry.
 * Returns 'done', 'failed', or 'skipped' (another run holds it, or it was taken over before it finished).
 */
async function runEffect(restaurantId, order, { effect, flag, run }) {
  if (order.data && order.data[flag] === 'done') {
    // Finished by code from before this table existed. Record it, so it is never run again.
    await markLegacyDone(restaurantId, order.id, effect);
    return 'done';
  }
  const attempt = await claimEffect(restaurantId, order.id, effect);
  if (attempt === null) {
    if ((await effectState(restaurantId, order.id, effect)) === 'done') {
      await setOrderFlag(restaurantId, order.id, flag, 'done');
      return 'done';
    }
    return 'skipped';
  }
  try {
    await run(restaurantId, order);
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    console.error(`[order-effects] ${effect} failed for order ${order.id}: ${message}`);
    await finishEffect(restaurantId, order.id, effect, attempt, 'failed', message);
    await setOrderFlag(restaurantId, order.id, flag, null);
    return 'failed';
  }
  if (!(await finishEffect(restaurantId, order.id, effect, attempt, 'done'))) {
    console.warn(`[order-effects] ${effect} for order ${order.id} was taken over by a newer run; that run records the outcome`);
    return 'skipped';
  }
  await setOrderFlag(restaurantId, order.id, flag, 'done');
  return 'done';
}

module.exports = {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  ensureEffectTable,
  claimEffect,
  finishEffect,
  effectState,
  markLegacyDone,
  setOrderFlag,
  runEffect,
};
