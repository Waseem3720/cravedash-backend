const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, tillId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { forbidden, badRequest } = require('@cravedash/shared/src/errors');
const { requireBranchService } = require('@cravedash/shared/src/branchServiceGuard');

const router = express.Router();

/**
 * Till sessions get no restaurant report. These endpoints aggregate restaurant-wide orders, and orders
 * have no reliable till attribution yet (decision D9-Q4), so no till-scoped total can be produced.
 * Tills use their own X view under /epos/counts instead. Restaurant admin and super are unchanged.
 */
function denyTillSessions(req, res, next) {
  if (req.user?.role === 'epos' || tillId(req)) {
    return next(forbidden('Reports are not available to till sessions'));
  }
  return next();
}
router.use(denyTillSessions);
router.use(requireBranchService);

/** The manager dashboard (revenue and order totals) is for restaurant and platform admins, not tills. */
function assertNotTill(req) {
  if (req.user?.role === 'epos' || req.user?.till_id) {
    throw forbidden('EPOS cannot read the manager dashboard');
  }
}

function rid(req) {
  return restaurantId(req);
}

/** SEC-M18: report windows are validated. A window longer than this is refused, so one request cannot scan years of orders. */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const PRODUCT_ROW_LIMIT = 500;

/** Parses one bound: a date (YYYY-MM-DD, taken as midnight UTC) or an ISO timestamp. Impossible dates are refused. */
function parseBound(value, name) {
  const text = String(value == null ? '' : value).trim();
  if (!ISO_DATE.test(text) && !ISO_DATETIME.test(text)) {
    throw badRequest(`${name} must be an ISO date (YYYY-MM-DD) or timestamp`);
  }
  const when = new Date(ISO_DATE.test(text) ? `${text}T00:00:00.000Z` : text);
  if (Number.isNaN(when.getTime())) throw badRequest(`${name} is not a valid date`);
  if (ISO_DATE.test(text) && when.toISOString().slice(0, 10) !== text) {
    throw badRequest(`${name} is not a valid calendar date`);
  }
  return when;
}

function range(req) {
  const to = req.query.to !== undefined ? parseBound(req.query.to, 'to') : new Date();
  const from = req.query.from !== undefined ? parseBound(req.query.from, 'from') : new Date(to.getTime() - 30 * DAY_MS);
  if (from.getTime() > to.getTime()) throw badRequest('from must be on or before to');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw badRequest(`The report range can be at most ${MAX_RANGE_DAYS} days`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  assertNotTill(req);
  const r = rid(req);
  const { from, to } = range(req);
  // A branch-bound login sees its own branch's orders and customers. Owners (no branch) see the whole restaurant.
  const bound = branchId(req);
  const { rows: orderStats } = await pool.query(
    // BUG-016: cancelled orders are not revenue or orders (the X report and sales report already exclude them).
    `SELECT COUNT(*) FILTER (WHERE status <> 'canceled')::int AS orders,
            COALESCE(SUM(total) FILTER (WHERE status <> 'canceled'), 0)::float AS revenue,
            COUNT(*) FILTER (WHERE status IN ('pending','confirmed','processing','cooking'))::int AS active_orders
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3 AND ($4::text IS NULL OR branch_id = $4)`,
    [r, from, to, bound],
  );
  const { rows: cust } = await pool.query(
    'SELECT COUNT(*)::int AS customers FROM customers WHERE restaurant_id = $1 AND ($2::text IS NULL OR branch_id = $2)',
    [r, bound],
  );
  const { rows: prod } = await pool.query(
    'SELECT COUNT(*)::int AS products FROM products WHERE restaurant_id = $1 AND status = TRUE AND ($2::text IS NULL OR branch_id = $2)',
    [r, bound],
  );
  ok(res, {
    period: { from, to },
    orders: orderStats[0].orders,
    revenue: orderStats[0].revenue,
    active_orders: orderStats[0].active_orders,
    total_customers: cust[0].customers,
    total_products: prod[0].products,
  });
}));

router.get('/reports/x', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float AS gross,
            COALESCE(SUM(discount),0)::float AS discounts,
            COALESCE(SUM(tip),0)::float AS tips
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
       AND status NOT IN ('canceled') AND ($4::text IS NULL OR branch_id = $4)`,
    [r, from, to, branchId(req)],
  );
  const { rows: counters } = await pool.query('SELECT x_counter, z_counter, opening_float FROM report_counters WHERE restaurant_id = $1', [r]);
  ok(res, { type: 'X', period: { from, to }, summary: rows[0], counters: counters[0] || {} });
}));

router.get('/reports/z', asyncHandler(async (req, res) => {
  const r = rid(req);
  let day = new Date().toISOString().slice(0, 10);
  if (req.query.day !== undefined) {
    const parsed = parseBound(req.query.day, 'day');
    if (!ISO_DATE.test(String(req.query.day))) throw badRequest('day must be an ISO date (YYYY-MM-DD)');
    day = parsed.toISOString().slice(0, 10);
  }
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  // BUG-016: gross and order counts leave out cancelled orders. Cancelled orders are still counted on their own line.
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'canceled')::int AS orders,
            COALESCE(SUM(total) FILTER (WHERE status <> 'canceled'),0)::float AS gross,
            COUNT(*) FILTER (WHERE payment_method = 'cash' AND status <> 'canceled')::int AS cash_orders,
            COUNT(*) FILTER (WHERE payment_method IN ('card','stripe') AND status <> 'canceled')::int AS card_orders,
            COUNT(*) FILTER (WHERE status = 'canceled')::int AS cancelled
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3 AND ($4::text IS NULL OR branch_id = $4)`,
    [r, from, to, branchId(req)],
  );
  ok(res, { type: 'Z', day, summary: rows[0] });
}));

router.get('/reports/orders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT status, order_type, COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS total
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3 AND ($4::text IS NULL OR branch_id = $4)
     GROUP BY status, order_type ORDER BY count DESC`,
    [r, from, to, branchId(req)],
  );
  ok(res, { period: { from, to }, breakdown: rows });
}));

/**
 * SEC-M18: the product totals are computed by the database over the order lines (one row per product), not by loading
 * every order into memory. At most PRODUCT_ROW_LIMIT products are returned, and `truncated` says when there were more.
 */
router.get('/reports/products', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `WITH lines AS (
       SELECT COALESCE(NULLIF(it->>'name', ''), NULLIF(it->>'product_id', ''), 'unknown') AS key,
              CASE WHEN jsonb_typeof(it->'qty') = 'number' AND (it->>'qty')::numeric <> 0
                   THEN (it->>'qty')::numeric ELSE 1 END AS qty,
              CASE WHEN jsonb_typeof(it->'price') = 'number' THEN (it->>'price')::numeric ELSE 0 END AS price
         FROM orders o
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END
         ) AS it
        WHERE o.restaurant_id = $1 AND o.created_at BETWEEN $2 AND $3 AND o.status NOT IN ('canceled')
          AND ($5::text IS NULL OR o.branch_id = $5)
     )
     SELECT key AS name, SUM(qty)::float AS qty, SUM(qty * price)::float AS revenue
       FROM lines
      GROUP BY key
      ORDER BY SUM(qty) DESC, key ASC
      LIMIT $4`,
    [r, from, to, PRODUCT_ROW_LIMIT + 1, branchId(req)],
  );
  const truncated = rows.length > PRODUCT_ROW_LIMIT;
  ok(res, {
    period: { from, to },
    products: rows.slice(0, PRODUCT_ROW_LIMIT),
    truncated,
  });
}));

router.get('/reports/sales', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT date_trunc('day', created_at) AS day,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total),0)::float AS revenue
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
       AND status NOT IN ('canceled') AND ($4::text IS NULL OR branch_id = $4)
     GROUP BY 1 ORDER BY 1`,
    [r, from, to, branchId(req)],
  );
  ok(res, { period: { from, to }, series: rows });
}));

router.get('/reports/earnings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(subtotal),0)::float AS subtotal,
            COALESCE(SUM(discount),0)::float AS discounts,
            COALESCE(SUM(delivery_charge),0)::float AS delivery,
            COALESCE(SUM(service_charge),0)::float AS service,
            COALESCE(SUM(tip),0)::float AS tips,
            COALESCE(SUM(total),0)::float AS net
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
       AND status IN ('delivered','completed') AND ($4::text IS NULL OR branch_id = $4)`,
    [r, from, to, branchId(req)],
  );
  ok(res, { period: { from, to }, earnings: rows[0] });
}));

module.exports = router;
