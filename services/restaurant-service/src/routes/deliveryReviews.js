/**
 * Delivery man reviews.
 *
 *   POST /delivery-reviews                       customer (OAuth customer login): review an own completed delivery
 *   GET  /deliveryman-reviews?state=visible|hidden   staff: reviews in the caller's scope
 *   POST /deliveryman-reviews/:id/hide           staff: hide a review (a reason is required; the row is kept)
 *   POST /deliveryman-reviews/:id/restore        staff: show a hidden review again
 *
 * A customer may review a delivery only when the order is theirs (same phone number as their account), the order is
 * delivered, and it was delivered by a rider. One review per order. Customer identity is never shown to staff beyond
 * the first name, and hidden reviews are never returned to customers.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireAuth, requireRole, requireCustomer, restaurantId, branchId, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { normalizePhone } = require('@cravedash/shared/src/customerSync');
const { AppError, badRequest, notFound } = require('@cravedash/shared/src/errors');

const customerRouter = express.Router();
const staffRouter = express.Router();

const ORDER_ID_RE = /^\d{1,18}$/;
const DELIVERED = ['delivered', 'completed'];
const STATES = ['visible', 'hidden'];

function actor(req) {
  return req.user?.name || req.user?.email || req.user?.role || 'unknown';
}

function assertStaffManager(req) {
  if (req.user?.role === 'epos' || req.user?.till_id) throw new AppError('EPOS cannot moderate delivery reviews', 403, 'FORBIDDEN');
}

customerRouter.post('/delivery-reviews', requireCustomer, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const orderId = String(body.order_id ?? '');
  if (!ORDER_ID_RE.test(orderId)) throw badRequest('order_id is required');
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('rating must be a whole number from 1 to 5');
  const comment = String(body.comment || '').trim().slice(0, 500);
  const restaurant = req.customer.restaurant_id;

  const { rows: customers } = await pool.query('SELECT id, name, phone FROM customers WHERE id = $1 AND restaurant_id = $2', [req.customer.id, restaurant]);
  const customer = customers[0];
  if (!customer) throw new AppError('Customer account not found', 403, 'FORBIDDEN');
  const customerPhone = normalizePhone(customer.phone);
  if (customerPhone.length < 7) throw new AppError('Add a phone number to your account before reviewing a delivery', 403, 'FORBIDDEN');

  const { rows: orders } = await pool.query(
    `SELECT id, branch_id, status, order_type, customer, data FROM orders WHERE id = $1 AND restaurant_id = $2`,
    [orderId, restaurant],
  );
  const order = orders[0];
  if (!order) throw notFound('Order not found');
  const orderPhone = normalizePhone(order.customer && order.customer.phone);
  if (orderPhone !== customerPhone) throw new AppError('This order is not linked to your account', 403, 'FORBIDDEN');
  if (order.order_type !== 'delivery' || !DELIVERED.includes(order.status)) {
    throw new AppError('You can review a delivery once it has been delivered', 409, 'CONFLICT');
  }
  const riderId = order.data && order.data.delivery_man_id ? String(order.data.delivery_man_id) : null;
  if (!riderId) throw new AppError('This order had no delivery man to review', 409, 'CONFLICT');

  const id = `drv_rev_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
  const firstName = String(customer.name || '').trim().split(/\s+/)[0] || null;
  const { rows } = await pool.query(
    `INSERT INTO delivery_reviews (id, restaurant_id, branch_id, order_id, customer_id, deliveryman_id, customer_name, rating, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (restaurant_id, order_id) DO NOTHING
     RETURNING id, order_id, rating, comment, created_at`,
    [id, restaurant, order.branch_id || null, order.id, customer.id, riderId, firstName, rating, comment],
  );
  if (!rows[0]) throw new AppError('This delivery has already been reviewed', 409, 'CONFLICT');
  created(res, { id: rows[0].id, order_id: String(rows[0].order_id), rating: rows[0].rating, comment: rows[0].comment });
}));

const STAFF_COLS = `r.id, r.order_id, r.branch_id, r.deliveryman_id, d.name AS deliveryman_name, r.customer_name, r.rating, r.comment,
  r.state, r.hidden_reason, r.hidden_by, r.hidden_at, r.created_at`;

function scopeFilter(req, params) {
  const bound = branchId(req);
  if (bound) {
    params.push(bound);
    return ` AND r.branch_id = $${params.length}`;
  }
  if (req.user?.role === 'super') return '';
  return ' AND r.branch_id IS NULL';
}

function mapReview(r) {
  return {
    id: r.id,
    order_id: String(r.order_id),
    branch_id: r.branch_id,
    deliveryman_id: r.deliveryman_id,
    deliveryman_name: r.deliveryman_name,
    customer_name: r.customer_name,
    rating: r.rating,
    comment: r.comment,
    state: r.state,
    hidden_reason: r.hidden_reason,
    hidden_by: r.hidden_by,
    hidden_at: r.hidden_at,
    created_at: r.created_at,
  };
}

staffRouter.get('/deliveryman-reviews', requireAuth, requireRole('super', 'restaurant'), asyncHandler(async (req, res) => {
  assertStaffManager(req);
  const state = req.query.state ? String(req.query.state) : null;
  if (state && !STATES.includes(state)) throw badRequest(`state must be one of ${STATES.join(', ')}`);
  const params = [restaurantId(req), state];
  const scope = scopeFilter(req, params);
  const { rows } = await pool.query(
    `SELECT ${STAFF_COLS} FROM delivery_reviews r LEFT JOIN deliverymen d ON d.id = r.deliveryman_id AND d.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = $1 AND ($2::text IS NULL OR r.state = $2)${scope}
      ORDER BY r.created_at DESC`,
    params,
  );
  ok(res, rows.map(mapReview));
}));

async function scopedReview(client, req, id) {
  const { rows } = await client.query('SELECT branch_id, state FROM delivery_reviews WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, restaurantId(req)]);
  if (!rows[0] || !rowInBranchScope(req, rows[0].branch_id)) throw notFound('Review not found');
  return rows[0];
}

staffRouter.post('/deliveryman-reviews/:id/hide', requireAuth, requireRole('super', 'restaurant'), asyncHandler(async (req, res) => {
  assertStaffManager(req);
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 3 || reason.length > 300) throw badRequest('reason must be 3 to 300 characters');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await scopedReview(client, req, req.params.id);
    if (current.state !== 'visible') throw new AppError('This review is already hidden', 409, 'CONFLICT');
    const { rows } = await client.query(
      `UPDATE delivery_reviews SET state = 'hidden', hidden_reason = $2, hidden_by = $3, hidden_at = NOW()
        WHERE id = $1 AND state = 'visible' RETURNING id, order_id, branch_id, deliveryman_id, customer_name, rating, comment, state, hidden_reason, hidden_by, hidden_at, created_at`,
      [req.params.id, reason, actor(req)],
    );
    await client.query('COMMIT');
    ok(res, mapReview({ ...rows[0], deliveryman_name: null }));
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[delivery-reviews] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

staffRouter.post('/deliveryman-reviews/:id/restore', requireAuth, requireRole('super', 'restaurant'), asyncHandler(async (req, res) => {
  assertStaffManager(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await scopedReview(client, req, req.params.id);
    if (current.state !== 'hidden') throw new AppError('This review is not hidden', 409, 'CONFLICT');
    const { rows } = await client.query(
      `UPDATE delivery_reviews SET state = 'visible', hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL
        WHERE id = $1 AND state = 'hidden' RETURNING id, order_id, branch_id, deliveryman_id, customer_name, rating, comment, state, hidden_reason, hidden_by, hidden_at, created_at`,
      [req.params.id],
    );
    await client.query('COMMIT');
    ok(res, mapReview({ ...rows[0], deliveryman_name: null }));
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[delivery-reviews] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = { customerRouter, staffRouter };
