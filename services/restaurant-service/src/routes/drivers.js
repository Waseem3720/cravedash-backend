/**
 * Delivery rider pay: pay plans (history of rates) and payments made to riders.
 *
 *   GET  /drivers/pay-policies              all plans for the restaurant (optional ?driver_id=)
 *   POST /drivers/:driverId/pay-policies    add a plan that starts on effective_from
 *   GET  /drivers/payments                  all payments for the restaurant (optional ?driver_id=)
 *   POST /drivers/:driverId/payments        record a payment (payments are never edited or deleted)
 *
 * Plans and payments are rows in their own tables. Rows that older builds saved as restaurant blobs are copied in
 * once, the first time the tables are used.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, notFound } = require('@cravedash/shared/src/errors');
const { cashByRider, round2 } = require('./riderCash');
const { riderSummary } = require('@cravedash/shared/src/engines/driverPay');

const router = express.Router();

const MODES = ['order', 'distance', 'weekly', 'monthly'];
const UNITS = ['mile', 'km'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

// Dates are read as text so they reach the client as YYYY-MM-DD, not as JavaScript Date objects.
// Dates are read as text so they reach the client as YYYY-MM-DD, not as JavaScript Date objects.
const POLICY_COLS = `id, restaurant_id, driver_id, mode, rate, unit, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, created_by, created_at`;
const PAYMENT_COLS = `id, restaurant_id, driver_id, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount, method, note, created_by, created_at`;
const SETTLEMENT_COLS = `id, restaurant_id, driver_id, to_char(settle_date, 'YYYY-MM-DD') AS settle_date, amount, note, created_by, created_at`;

let tablesReady = null;

/**
 * The tables and indexes come from scripts/init-db.sql (SEC-M10: no DDL in request handling). This runs only the
 * one-time copy of legacy blob rows, once per process. A failed copy is logged and fails the request, it is not swallowed.
 */
function ensureTables() {
  if (!tablesReady) {
    tablesReady = migrateBlobs().catch((err) => {
      console.error('[drivers] legacy blob copy failed', err);
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

/** One-time copy of rows saved by the old restaurant_blobs endpoints. Safe to run again (ON CONFLICT DO NOTHING). */
async function migrateBlobs() {
  const { rows } = await pool.query(
    'SELECT restaurant_id, key, data FROM restaurant_blobs WHERE key IN ($1, $2)',
    ['driver_pay_policies', 'driver_payments'],
  );
  for (const blob of rows) {
    const list = Array.isArray(blob.data) ? blob.data : [];
    for (const row of list) {
      if (!row || !row.id || !row.driver_id) continue;
      if (blob.key === 'driver_pay_policies') {
        await pool.query(
          `INSERT INTO driver_pay_policies (id, restaurant_id, driver_id, mode, rate, unit, effective_from, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()))
           ON CONFLICT DO NOTHING`,
          [String(row.id), blob.restaurant_id, String(row.driver_id), row.mode || 'order', Number(row.rate) || 0,
            row.unit || 'mile', String(row.effective_from).slice(0, 10), row.by || null, row.created_at || null],
        );
      } else {
        await pool.query(
          `INSERT INTO driver_payments (id, restaurant_id, driver_id, pay_date, amount, method, note, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, NOW()))
           ON CONFLICT DO NOTHING`,
          [String(row.id), blob.restaurant_id, String(row.driver_id), String(row.date).slice(0, 10),
            Number(row.amount) || 0, row.method || 'Bank transfer', row.note || '', row.by || null, row.at || null],
        );
      }
    }
  }
}

/** Riders see no pay data, and EPOS tills never change it. */
function assertPayAccess(req) {
  if (req.user?.role === 'epos' || req.user?.till_id) {
    throw forbidden('EPOS cannot access rider pay');
  }
}

/**
 * The rider must exist and be inside the caller's scope (a branch sees its own riders; the owner sees restaurant-level
 * riders). Returns the rider's branch, which the pay row takes. Another scope's rider is reported as not found.
 */
async function assertDriver(req, restaurant, driverId) {
  if (!ID_RE.test(driverId)) throw badRequest('Invalid driver id');
  const { rows } = await pool.query('SELECT id, branch_id FROM deliverymen WHERE id = $1 AND restaurant_id = $2', [driverId, restaurant]);
  if (!rows[0] || !rowInBranchScope(req, rows[0].branch_id)) throw notFound('Rider not found');
  return rows[0].branch_id || null;
}

/** SQL scope for rider pay rows: a branch sees its branch's rows, the owner sees restaurant-level rows, super all. */
function payScope(req, params) {
  const bound = branchId(req);
  if (bound) {
    params.push(bound);
    return ` AND branch_id = $${params.length}`;
  }
  if (req.user?.role === 'super') return '';
  return ' AND branch_id IS NULL';
}

function actor(req) {
  return req.user?.name || req.user?.email || req.user?.role || 'unknown';
}

function mapPolicy(r) {
  return {
    id: r.id,
    restaurant_id: r.restaurant_id,
    driver_id: r.driver_id,
    mode: r.mode,
    rate: Number(r.rate),
    unit: r.unit,
    effective_from: String(r.effective_from).slice(0, 10),
    created_at: r.created_at,
    by: r.created_by,
  };
}

function mapPayment(r) {
  return {
    id: r.id,
    restaurant_id: r.restaurant_id,
    driver_id: r.driver_id,
    date: String(r.pay_date).slice(0, 10),
    amount: Number(r.amount),
    method: r.method,
    note: r.note,
    by: r.created_by,
    at: r.created_at,
  };
}

function mapSettlement(r) {
  return {
    id: r.id,
    restaurant_id: r.restaurant_id,
    driver_id: r.driver_id,
    date: String(r.settle_date).slice(0, 10),
    amount: Number(r.amount),
    note: r.note,
    by: r.created_by,
    at: r.created_at,
  };
}

router.use(asyncHandler(async (req, res, next) => {
  assertPayAccess(req);
  await ensureTables();
  next();
}));

router.get('/drivers/pay-policies', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.query.driver_id ? String(req.query.driver_id) : null;
  const params = [r, driverId];
  const scope = payScope(req, params);
  const { rows } = await pool.query(
    `SELECT ${POLICY_COLS} FROM driver_pay_policies WHERE restaurant_id = $1 AND ($2::text IS NULL OR driver_id = $2)${scope}
     ORDER BY driver_id, effective_from`,
    params,
  );
  ok(res, rows.map(mapPolicy));
}));

router.post('/drivers/:driverId/pay-policies', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.params.driverId;
  const riderBranch = await assertDriver(req, r, driverId);
  const body = req.body || {};
  if (!MODES.includes(body.mode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
  const rate = Number(body.rate);
  if (!Number.isFinite(rate) || rate < 0) throw badRequest('rate must be a number, zero or more');
  const unit = body.unit || 'mile';
  if (!UNITS.includes(unit)) throw badRequest('unit must be mile or km');
  if (!DATE_RE.test(String(body.effective_from || ''))) throw badRequest('effective_from must be YYYY-MM-DD');

  const { rows: taken } = await pool.query(
    'SELECT 1 FROM driver_pay_policies WHERE restaurant_id = $1 AND driver_id = $2 AND effective_from = $3',
    [r, driverId, body.effective_from],
  );
  if (taken[0]) {
    const err = badRequest('A pay plan already starts on this date. Choose a new effective date to keep rate history.');
    err.status = 409;
    err.code = 'CONFLICT';
    throw err;
  }

  const id = `dpp_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO driver_pay_policies (id, restaurant_id, driver_id, mode, rate, unit, effective_from, created_by, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${POLICY_COLS}`,
    [id, r, driverId, body.mode, rate, unit, body.effective_from, actor(req), riderBranch],
  );
  created(res, mapPolicy(rows[0]));
}));

router.get('/drivers/payments', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.query.driver_id ? String(req.query.driver_id) : null;
  const params = [r, driverId];
  const scope = payScope(req, params);
  const { rows } = await pool.query(
    `SELECT ${PAYMENT_COLS} FROM driver_payments WHERE restaurant_id = $1 AND ($2::text IS NULL OR driver_id = $2)${scope}
     ORDER BY pay_date, created_at`,
    params,
  );
  ok(res, rows.map(mapPayment));
}));

router.post('/drivers/:driverId/payments', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.params.driverId;
  const riderBranch = await assertDriver(req, r, driverId);
  const body = req.body || {};
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount must be greater than zero');
  if (!DATE_RE.test(String(body.date || ''))) throw badRequest('date must be YYYY-MM-DD');
  const method = String(body.method || '').trim();
  if (!method || method.length > 40) throw badRequest('method is required (40 characters at most)');
  const note = String(body.note || '').trim().slice(0, 500);

  const id = `dp_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO driver_payments (id, restaurant_id, driver_id, pay_date, amount, method, note, created_by, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${PAYMENT_COLS}`,
    [id, r, driverId, body.date, amount, method, note, actor(req), riderBranch],
  );
  created(res, mapPayment(rows[0]));
}));

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Rider earnings and the net position with the restaurant, computed on the server from pay plans, payments, delivered
 * orders and cash handovers. `from` is inclusive and `to` exclusive. The net is display only: nothing is posted.
 *   net_with_restaurant = cash in hand - outstanding pay. Positive: the rider owes the restaurant more than it owes them.
 */
router.get('/drivers/earnings', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const today = new Date().toISOString().slice(0, 10);
  const to = req.query.to ? String(req.query.to) : addDays(today, 1);
  const from = req.query.from ? String(req.query.from) : addDays(to, -30);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from >= to) throw badRequest('from and to must be dates, with from before to');

  const { rows: allRiders } = await pool.query('SELECT id, name, branch_id FROM deliverymen WHERE restaurant_id = $1 ORDER BY name', [r]);
  const riders = allRiders.filter((d) => rowInBranchScope(req, d.branch_id));
  const riderIds = new Set(riders.map((d) => d.id));

  const planParams = [r];
  const planScope = payScope(req, planParams);
  const { rows: planRows } = await pool.query(
    `SELECT driver_id, mode, rate, unit, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM driver_pay_policies WHERE restaurant_id = $1${planScope}`,
    planParams,
  );
  const payParams = [r];
  const payScopeSql = payScope(req, payParams);
  const { rows: payRows } = await pool.query(
    `SELECT driver_id, to_char(pay_date, 'YYYY-MM-DD') AS date, amount FROM driver_payments WHERE restaurant_id = $1${payScopeSql}`,
    payParams,
  );
  const { rows: orderRows } = await pool.query(
    `SELECT data->>'delivery_man_id' AS driver, status, to_char(created_at, 'YYYY-MM-DD') AS day, data->>'driver_distance_km' AS km
       FROM orders WHERE restaurant_id = $1 AND status = 'delivered' AND data->>'delivery_man_id' IS NOT NULL`,
    [r],
  );
  const cash = await cashByRider(pool, r);

  const byRider = riders.map((rider) => {
    const plans = planRows
      .filter((p) => p.driver_id === rider.id)
      .map((p) => ({ mode: p.mode, rate: Number(p.rate), unit: p.unit, effective_from: p.effective_from, effective_to: null }));
    const orders = orderRows.filter((o) => o.driver === rider.id).map((o) => ({ status: o.status, day: o.day, km: o.km }));
    const payments = payRows.filter((p) => p.driver_id === rider.id).map((p) => ({ date: p.date, amount: Number(p.amount) }));
    const summary = riderSummary({ policies: plans, orders, payments, from, to });
    const held = cash.get(rider.id)?.in_hand || 0;
    return {
      driver_id: rider.id,
      name: rider.name,
      ...summary,
      cash_in_hand: round2(held),
      net_with_restaurant: round2(held - summary.outstanding),
    };
  });
  ok(res, { from, to, riders: byRider.filter((x) => riderIds.has(x.driver_id)) });
}));

router.get('/drivers/cash-settlements', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.query.driver_id ? String(req.query.driver_id) : null;
  const params = [r, driverId];
  const scope = payScope(req, params);
  const { rows } = await pool.query(
    `SELECT ${SETTLEMENT_COLS} FROM driver_cash_settlements WHERE restaurant_id = $1 AND ($2::text IS NULL OR driver_id = $2)${scope}
     ORDER BY settle_date, created_at`,
    params,
  );
  ok(res, rows.map(mapSettlement));
}));

/**
 * Records cash a rider hands in. It cannot exceed the cash the rider holds; the check and the insert run under a lock
 * on the rider so two handovers cannot both pass it.
 */
router.post('/drivers/:driverId/cash-settlements', asyncHandler(async (req, res) => {
  const r = restaurantId(req);
  const driverId = req.params.driverId;
  const riderBranch = await assertDriver(req, r, driverId);
  const body = req.body || {};
  const amount = round2(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount must be greater than zero');
  if (!DATE_RE.test(String(body.date || ''))) throw badRequest('date must be YYYY-MM-DD');
  const note = String(body.note || '').trim().slice(0, 500);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cash:${r}:${driverId}`]);
    const held = await cashByRider(client, r, driverId);
    const inHand = held.get(driverId)?.in_hand || 0;
    if (amount > inHand + 0.001) throw badRequest(`Only £${inHand.toFixed(2)} is in hand for this rider.`);
    const id = `dcs_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
    const { rows } = await client.query(
      `INSERT INTO driver_cash_settlements (id, restaurant_id, driver_id, settle_date, amount, note, created_by, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${SETTLEMENT_COLS}`,
      [id, r, driverId, body.date, amount, note, actor(req), riderBranch],
    );
    await client.query('COMMIT');
    created(res, mapSettlement(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[drivers] cash settlement rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
