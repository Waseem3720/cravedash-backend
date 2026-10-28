const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

function range(req) {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();
  return { from, to };
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows: orderStats } = await pool.query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(total), 0)::float AS revenue,
            COUNT(*) FILTER (WHERE status IN ('pending','confirmed','processing','cooking'))::int AS active_orders
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3`,
    [r, from, to],
  );
  const { rows: cust } = await pool.query(
    'SELECT COUNT(*)::int AS customers FROM customers WHERE restaurant_id = $1',
    [r],
  );
  const { rows: prod } = await pool.query(
    'SELECT COUNT(*)::int AS products FROM products WHERE restaurant_id = $1 AND status = TRUE',
    [r],
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
       AND status NOT IN ('canceled')`,
    [r, from, to],
  );
  const { rows: counters } = await pool.query('SELECT x_counter, z_counter, opening_float FROM report_counters WHERE restaurant_id = $1', [r]);
  ok(res, { type: 'X', period: { from, to }, summary: rows[0], counters: counters[0] || {} });
}));

router.get('/reports/z', asyncHandler(async (req, res) => {
  const r = rid(req);
  const day = req.query.day || new Date().toISOString().slice(0, 10);
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float AS gross,
            COUNT(*) FILTER (WHERE payment_method = 'cash')::int AS cash_orders,
            COUNT(*) FILTER (WHERE payment_method IN ('card','stripe'))::int AS card_orders,
            COUNT(*) FILTER (WHERE status = 'canceled')::int AS cancelled
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3`,
    [r, from, to],
  );
  ok(res, { type: 'Z', day, summary: rows[0] });
}));

router.get('/reports/orders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT status, order_type, COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS total
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
     GROUP BY status, order_type ORDER BY count DESC`,
    [r, from, to],
  );
  ok(res, { period: { from, to }, breakdown: rows });
}));

router.get('/reports/products', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT items FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
       AND status NOT IN ('canceled')`,
    [r, from, to],
  );
  const counts = {};
  rows.forEach(({ items }) => {
    let list = items;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { list = []; }
    }
    (list || []).forEach((it) => {
      const key = it.name || it.product_id || 'unknown';
      if (!counts[key]) counts[key] = { name: key, qty: 0, revenue: 0 };
      counts[key].qty += it.qty || 1;
      counts[key].revenue += (it.price || 0) * (it.qty || 1);
    });
  });
  ok(res, { period: { from, to }, products: Object.values(counts).sort((a, b) => b.qty - a.qty) });
}));

router.get('/reports/sales', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { from, to } = range(req);
  const { rows } = await pool.query(
    `SELECT date_trunc('day', created_at) AS day,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total),0)::float AS revenue
     FROM orders WHERE restaurant_id = $1 AND created_at BETWEEN $2 AND $3
       AND status NOT IN ('canceled')
     GROUP BY 1 ORDER BY 1`,
    [r, from, to],
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
       AND status IN ('delivered','completed')`,
    [r, from, to],
  );
  ok(res, { period: { from, to }, earnings: rows[0] });
}));

module.exports = router;
