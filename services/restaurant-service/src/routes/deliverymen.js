const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const {
  badRequest,
  notFound,
  forbidden,
  unauthorized,
  conflict,
} = require('@cravedash/shared/src/errors');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * POST /api/v1/deliverymen/requests
 * Submit a deliveryman joining request / registration application.
 * Accessible to public applicant (via trusted API-key context) and authenticated users.
 */
router.post('/requests', asyncHandler(async (req, res) => {
  const r = rid(req);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) {
    throw badRequest('Deliveryman applicant name is required');
  }

  const rawEmail = String(body.email || '').trim().toLowerCase();
  const email = rawEmail ? (isValidEmail(rawEmail) ? rawEmail : null) : null;
  if (rawEmail && !email) {
    throw badRequest('Provided email format is invalid');
  }

  const phone = body.phone ? String(body.phone).trim() : null;
  const vehicle = body.vehicle ? String(body.vehicle).trim() : 'bike';
  const branchId = body.branch_id ? String(body.branch_id).trim() : null;
  const customData = typeof body.data === 'object' && body.data !== null ? body.data : {};

  // Check for existing pending request with same email for this tenant
  if (email) {
    const { rows: existingPending } = await pool.query(
      `SELECT id FROM deliveryman_requests
       WHERE restaurant_id = $1 AND lower(email) = lower($2) AND status = 'pending'`,
      [r, email]
    );
    if (existingPending.length > 0) {
      throw conflict('A pending registration request already exists for this email address');
    }
  }

  const reqId = `dm_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { rows } = await pool.query(
    `INSERT INTO deliveryman_requests (
      id, restaurant_id, branch_id, name, phone, email, vehicle, status, data, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, NOW(), NOW())
    RETURNING *`,
    [reqId, r, branchId, name, phone, email, vehicle, JSON.stringify(customData)]
  );

  created(res, rows[0]);
}));

/**
 * GET /api/v1/deliverymen/requests
 * List deliveryman registration requests with optional status filtering.
 * Restricted to restaurant and super admin roles.
 */
router.get('/requests', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { status, q, limit = 50, offset = 0 } = req.query;

  const validStatuses = new Set(['pending', 'approved', 'rejected']);
  const filterStatus = status && validStatuses.has(status.toLowerCase()) ? status.toLowerCase() : null;

  const params = [r];
  let whereClauses = 'WHERE restaurant_id = $1';

  if (filterStatus) {
    params.push(filterStatus);
    whereClauses += ` AND status = $${params.length}`;
  }

  if (q && typeof q === 'string' && q.trim()) {
    params.push(`%${q.trim()}%`);
    const pIdx = params.length;
    whereClauses += ` AND (name ILIKE $${pIdx} OR email ILIKE $${pIdx} OR phone ILIKE $${pIdx})`;
  }

  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  params.push(parsedLimit, parsedOffset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_requests
     ${whereClauses}
     ORDER BY created_at DESC, id ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  ok(res, rows);
}));

/**
 * GET /api/v1/deliverymen/requests/:id
 * Retrieve details of a specific deliveryman request.
 * Restricted to authorized admin roles.
 */
router.get('/requests/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query(
    'SELECT * FROM deliveryman_requests WHERE id = $1 AND restaurant_id = $2',
    [req.params.id, r]
  );
  if (!rows[0]) throw notFound('Deliveryman request not found');
  ok(res, rows[0]);
}));

/**
 * POST /api/v1/deliverymen/requests/:id/approve
 * Approves a pending deliveryman application transactionally,
 * creates or activates the corresponding deliveryman record,
 * and emits an audit event.
 */
router.post('/requests/:id/approve', asyncHandler(async (req, res) => {
  const r = rid(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: reqRows } = await client.query(
      'SELECT * FROM deliveryman_requests WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.params.id, r]
    );

    if (!reqRows[0]) {
      throw notFound('Deliveryman request not found');
    }

    const reqData = reqRows[0];
    if (reqData.status === 'approved') {
      throw conflict('Request is already approved');
    }
    if (reqData.status === 'rejected') {
      throw conflict('Cannot approve a rejected request');
    }
    if (reqData.status !== 'pending') {
      throw badRequest(`Cannot approve request in "${reqData.status}" status`);
    }

    // Determine or provision deliverymen account (avoiding duplication)
    let dmId = null;
    if (reqData.email || reqData.phone) {
      const { rows: existingCouriers } = await client.query(
        `SELECT id, status FROM deliverymen
         WHERE restaurant_id = $1 AND (
           (email IS NOT NULL AND lower(email) = lower($2)) OR
           (phone IS NOT NULL AND phone = $3)
         )
         LIMIT 1`,
        [r, reqData.email || '', reqData.phone || '']
      );

      if (existingCouriers.length > 0) {
        dmId = existingCouriers[0].id;
        await client.query(
          `UPDATE deliverymen
           SET status = 'active', vehicle = COALESCE($3, vehicle), branch_id = COALESCE($4, branch_id), updated_at = NOW()
           WHERE id = $1 AND restaurant_id = $2`,
          [dmId, r, reqData.vehicle || null, reqData.branch_id || null]
        );
      }
    }

    if (!dmId) {
      dmId = `dm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(
        `INSERT INTO deliverymen (
          id, restaurant_id, branch_id, name, phone, email, vehicle, status, data, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb, NOW(), NOW())`,
        [
          dmId,
          r,
          reqData.branch_id || null,
          reqData.name,
          reqData.phone || null,
          reqData.email || null,
          reqData.vehicle || 'bike',
          JSON.stringify(reqData.data || {}),
        ]
      );
    }

    const actor = req.user?.name || req.user?.email || 'admin';
    const { rows: updatedRows } = await client.query(
      `UPDATE deliveryman_requests
       SET status = 'approved', deliveryman_id = $1, resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4
       RETURNING *`,
      [dmId, actor, reqData.id, r]
    );

    // Audit trail
    const auditId = `ae_dm_app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await client.query(
      `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data, created_at)
       VALUES ($1, $2, 'DELIVERYMAN_REQUEST_APPROVED', 'deliveryman_request', $3, $4, $5, $6::jsonb, NOW())`,
      [
        auditId,
        actor,
        reqData.id,
        r,
        `Deliveryman application approved for "${reqData.name}" (${dmId})`,
        JSON.stringify({ deliveryman_id: dmId, request_id: reqData.id }),
      ]
    );

    await client.query('COMMIT');
    ok(res, { request: updatedRows[0], deliveryman_id: dmId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * POST /api/v1/deliverymen/requests/:id/deny
 * Rejects a pending deliveryman application, recording the decision and reason.
 */
router.post('/requests/:id/deny', asyncHandler(async (req, res) => {
  const r = rid(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: reqRows } = await client.query(
      'SELECT * FROM deliveryman_requests WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.params.id, r]
    );

    if (!reqRows[0]) {
      throw notFound('Deliveryman request not found');
    }

    const reqData = reqRows[0];
    if (reqData.status === 'rejected') {
      throw conflict('Request is already rejected');
    }
    if (reqData.status === 'approved') {
      throw conflict('Cannot reject an approved request');
    }
    if (reqData.status !== 'pending') {
      throw badRequest(`Cannot reject request in "${reqData.status}" status`);
    }

    const reason = String(req.body?.reason || req.body?.rejection_reason || 'Application declined')
      .trim()
      .slice(0, 500);

    const actor = req.user?.name || req.user?.email || 'admin';
    const { rows: updatedRows } = await client.query(
      `UPDATE deliveryman_requests
       SET status = 'rejected', rejection_reason = $1, resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4
       RETURNING *`,
      [reason, actor, reqData.id, r]
    );

    // Audit trail
    const auditId = `ae_dm_rej_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await client.query(
      `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data, created_at)
       VALUES ($1, $2, 'DELIVERYMAN_REQUEST_DENIED', 'deliveryman_request', $3, $4, $5, $6::jsonb, NOW())`,
      [
        auditId,
        actor,
        reqData.id,
        r,
        `Deliveryman application rejected for "${reqData.name}"`,
        JSON.stringify({ request_id: reqData.id, reason }),
      ]
    );

    await client.query('COMMIT');
    ok(res, { request: updatedRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * POST /api/v1/deliverymen/reviews
 * Record order-linked deliveryman review & rating.
 * Accessible to the customer who placed the order (or restaurant/super admins).
 */
router.post('/reviews', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { deliveryman_id, order_id, rating, review_note, comment, data } = req.body || {};

  if (!deliveryman_id || typeof deliveryman_id !== 'string') {
    throw badRequest('deliveryman_id is required');
  }

  const numericRating = Number(rating);
  if (rating === undefined || isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
    throw badRequest('rating must be a numeric value between 1 and 5');
  }

  if (!order_id) {
    throw badRequest('order_id is required for deliveryman review');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify deliveryman belongs to this restaurant
    const { rows: dmRows } = await client.query(
      'SELECT id, name FROM deliverymen WHERE id = $1 AND restaurant_id = $2',
      [deliveryman_id, r]
    );
    if (!dmRows[0]) {
      throw notFound('Deliveryman not found for this restaurant');
    }

    // 2. Verify order belongs to this restaurant, was delivered by this deliveryman, and is delivered
    const { rows: orderRows } = await client.query(
      `SELECT id, restaurant_id, customer_id, delivery_man_id, status
       FROM orders
       WHERE id = $1 AND restaurant_id = $2`,
      [order_id, r]
    );
    if (!orderRows[0]) {
      throw notFound('Order not found for this restaurant');
    }

    const order = orderRows[0];
    if (order.delivery_man_id !== deliveryman_id) {
      throw badRequest('Order was not assigned to or delivered by this deliveryman');
    }

    const orderStatus = String(order.status || '').toLowerCase();
    if (!['delivered', 'completed'].includes(orderStatus)) {
      throw badRequest(`Order does not qualify for review (current status: ${order.status})`);
    }

    // Customer role authorization check: customer can only review their own orders
    if (req.user?.role === 'customer') {
      if (order.customer_id && String(order.customer_id) !== String(req.user.sub)) {
        throw forbidden('Customers can only review orders they placed');
      }
    }

    // 3. Prevent duplicate reviews for the same order and deliveryman
    const { rows: existingReviews } = await client.query(
      'SELECT id FROM deliveryman_reviews WHERE order_id = $1 AND deliveryman_id = $2',
      [order.id, deliveryman_id]
    );
    if (existingReviews.length > 0) {
      throw conflict('A review for this order and deliveryman has already been submitted');
    }

    // 4. Sanitize review note
    const rawNote = review_note || comment || '';
    const cleanNote = String(rawNote)
      .replace(/<[^>]*>?/gm, '')
      .trim()
      .slice(0, 500);

    const revId = `dm_rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveCustomerId = req.user?.role === 'customer' ? req.user.sub : (order.customer_id || null);

    const { rows: newReview } = await client.query(
      `INSERT INTO deliveryman_reviews (
        id, restaurant_id, deliveryman_id, order_id, customer_id, rating, review_note, data, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
      RETURNING *`,
      [
        revId,
        r,
        deliveryman_id,
        order.id,
        effectiveCustomerId,
        numericRating,
        cleanNote,
        JSON.stringify(typeof data === 'object' && data !== null ? data : {}),
      ]
    );

    // 5. Update aggregate rating on deliverymen table data JSONB
    const { rows: aggRows } = await client.query(
      `SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*)::int AS review_count
       FROM deliveryman_reviews
       WHERE deliveryman_id = $1 AND restaurant_id = $2`,
      [deliveryman_id, r]
    );

    const avgRating = Number(aggRows[0]?.avg_rating || numericRating);
    const revCount = parseInt(aggRows[0]?.review_count || 1, 10);

    await client.query(
      `UPDATE deliverymen
       SET data = jsonb_set(
         jsonb_set(COALESCE(data, '{}'::jsonb), '{avg_rating}', to_jsonb($3::numeric)),
         '{review_count}', to_jsonb($4::int)
       ), updated_at = NOW()
       WHERE id = $1 AND restaurant_id = $2`,
      [deliveryman_id, r, avgRating, revCount]
    );

    await client.query('COMMIT');
    created(res, newReview[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * GET /api/v1/deliverymen/reviews
 * List reviews for the tenant with optional deliveryman filtering.
 */
router.get('/reviews', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { deliveryman_id, limit = 50, offset = 0 } = req.query;

  const params = [r];
  let whereClauses = 'WHERE r.restaurant_id = $1';

  if (deliveryman_id && typeof deliveryman_id === 'string' && deliveryman_id.trim()) {
    params.push(deliveryman_id.trim());
    whereClauses += ` AND r.deliveryman_id = $${params.length}`;
  }

  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  params.push(parsedLimit, parsedOffset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const { rows } = await pool.query(
    `SELECT r.*, d.name AS deliveryman_name
     FROM deliveryman_reviews r
     LEFT JOIN deliverymen d ON r.deliveryman_id = d.id AND r.restaurant_id = d.restaurant_id
     ${whereClauses}
     ORDER BY r.created_at DESC, r.id ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  ok(res, rows);
}));

/**
 * GET /api/v1/deliverymen/:id/reviews
 * Route alias to list reviews for a specific deliveryman.
 */
router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const r = rid(req);
  const deliverymanId = req.params.id;

  const { rows: dmCheck } = await pool.query(
    'SELECT id FROM deliverymen WHERE id = $1 AND restaurant_id = $2',
    [deliverymanId, r]
  );
  if (!dmCheck[0]) {
    throw notFound('Deliveryman not found');
  }

  const { rows } = await pool.query(
    `SELECT r.*, d.name AS deliveryman_name
     FROM deliveryman_reviews r
     LEFT JOIN deliverymen d ON r.deliveryman_id = d.id AND r.restaurant_id = d.restaurant_id
     WHERE r.restaurant_id = $1 AND r.deliveryman_id = $2
     ORDER BY r.created_at DESC, r.id ASC`,
    [r, deliverymanId]
  );

  ok(res, rows);
}));

module.exports = router;
