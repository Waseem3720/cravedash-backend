/**
 * Delivery man joining requests (restaurant admin and super admin only).
 *
 *   GET  /deliveryman-requests?state=pending|approved|rejected   list in the caller's scope
 *   POST /deliveryman-requests                                   record a new application
 *   POST /deliveryman-requests/:id/approve                       create the rider and its login (one transaction)
 *   POST /deliveryman-requests/:id/reject                        reject with a reason
 *
 * There is no public sign-up form in this codebase yet, so applications are recorded by an admin.
 * Approval creates the deliverymen row and a `driver` login whose id is the rider id, the same link the
 * Users & access page uses. A request already approved or rejected cannot be decided again.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, AppError } = require('@cravedash/shared/src/errors');

const router = express.Router();

const STATES = ['pending', 'approved', 'rejected'];
const PHONE_RE = /^\+?\d{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function actor(req) {
  return req.user?.name || req.user?.email || req.user?.role || 'unknown';
}

function assertManager(req) {
  if (req.user?.role === 'epos' || req.user?.till_id) throw new AppError('EPOS cannot manage delivery man requests', 403, 'FORBIDDEN');
}

/** Same scope rule as the rider list: a branch sees its own requests, the owner sees restaurant-level ones, super all. */
function scopeFilter(req, params) {
  const bound = branchId(req);
  if (bound) {
    params.push(bound);
    return ` AND branch_id = $${params.length}`;
  }
  if (req.user?.role === 'super') return '';
  return ' AND branch_id IS NULL';
}

function normalizePhone(value) {
  return String(value || '').replace(/[\s()-]/g, '');
}

function mapRequest(r) {
  return {
    id: r.id,
    branch_id: r.branch_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    vehicle: r.vehicle,
    note: r.note,
    state: r.state,
    reject_reason: r.reject_reason,
    deliveryman_id: r.deliveryman_id,
    created_at: r.created_at,
    created_by: r.created_by,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
  };
}

const COLS = 'id, branch_id, name, phone, email, vehicle, note, state, reject_reason, deliveryman_id, created_at, created_by, decided_at, decided_by';

router.get('/deliveryman-requests', asyncHandler(async (req, res) => {
  assertManager(req);
  const r = restaurantId(req);
  const state = req.query.state ? String(req.query.state) : null;
  if (state && !STATES.includes(state)) throw badRequest(`state must be one of ${STATES.join(', ')}`);
  const params = [r, state];
  const scope = scopeFilter(req, params);
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM deliveryman_requests WHERE restaurant_id = $1 AND ($2::text IS NULL OR state = $2)${scope}
     ORDER BY created_at DESC`,
    params,
  );
  ok(res, rows.map(mapRequest));
}));

router.post('/deliveryman-requests', asyncHandler(async (req, res) => {
  assertManager(req);
  const r = restaurantId(req);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 80) throw badRequest('name must be 2 to 80 characters');
  const phone = normalizePhone(body.phone);
  if (!PHONE_RE.test(phone)) throw badRequest('phone must be 7 to 15 digits, with an optional leading +');
  const email = String(body.email || '').trim().toLowerCase();
  if (email && (!EMAIL_RE.test(email) || email.length > 120)) throw badRequest('email is not valid');
  const vehicle = String(body.vehicle || '').trim().slice(0, 40) || null;
  const note = String(body.note || '').trim().slice(0, 300);
  const bound = branchId(req);
  const id = `dmr_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO deliveryman_requests (id, restaurant_id, branch_id, name, phone, email, vehicle, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [id, r, bound || null, name, phone, email || null, vehicle, note, actor(req)],
    );
    created(res, mapRequest(rows[0]));
  } catch (err) {
    if (err.code === '23505') throw new AppError('A request for this phone number is already waiting for a decision', 409, 'CONFLICT');
    throw err;
  }
}));

/** Loads the request in the caller's scope. Another scope's request is reported as not found. */
async function scopedRequest(client, req, id) {
  const { rows } = await client.query(`SELECT ${COLS}, restaurant_id FROM deliveryman_requests WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`, [id, restaurantId(req)]);
  const row = rows[0];
  if (!row || !rowInBranchScope(req, row.branch_id)) throw notFound('Request not found');
  return row;
}

router.post('/deliveryman-requests/:id/approve', asyncHandler(async (req, res) => {
  assertManager(req);
  const body = req.body || {};
  const password = String(body.password || '');
  if (password.length < 8) throw badRequest('password must be at least 8 characters');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await scopedRequest(client, req, req.params.id);
    if (request.state !== 'pending') throw new AppError(`This request is already ${request.state}`, 409, 'CONFLICT');
    if (!request.email) throw badRequest('The request needs an email address before a login can be created');

    const { rows: dupRider } = await client.query(
      `SELECT id FROM deliverymen WHERE restaurant_id = $1 AND REPLACE(REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', ''), '(', '') IN ($2, $2)`,
      [request.restaurant_id, request.phone],
    );
    if (dupRider[0]) throw new AppError('A delivery man with this phone number already exists', 409, 'CONFLICT');
    const { rows: dupLogin } = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [request.email]);
    if (dupLogin[0]) throw new AppError('This email already has a login', 409, 'CONFLICT');

    const riderId = `drv_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
    await client.query(
      `INSERT INTO deliverymen (id, restaurant_id, name, phone, email, vehicle, status, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
      [riderId, request.restaurant_id, request.name, request.phone, request.email, request.vehicle, request.branch_id || null],
    );
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (id, email, password_hash, role, name, restaurant_id, status, branch_id)
       VALUES ($1,$2,$3,'driver',$4,$5,TRUE,$6)`,
      [riderId, request.email, passwordHash, request.name, request.restaurant_id, request.branch_id || null],
    );
    const { rows } = await client.query(
      `UPDATE deliveryman_requests SET state = 'approved', deliveryman_id = $2, decided_by = $3, decided_at = NOW()
       WHERE id = $1 AND state = 'pending' RETURNING ${COLS}`,
      [request.id, riderId, actor(req)],
    );
    await client.query('COMMIT');
    ok(res, { request: mapRequest(rows[0]), deliveryman: { id: riderId, name: request.name } });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[deliveryman-requests] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/deliveryman-requests/:id/reject', asyncHandler(async (req, res) => {
  assertManager(req);
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 3 || reason.length > 300) throw badRequest('reason must be 3 to 300 characters');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await scopedRequest(client, req, req.params.id);
    if (request.state !== 'pending') throw new AppError(`This request is already ${request.state}`, 409, 'CONFLICT');
    const { rows } = await client.query(
      `UPDATE deliveryman_requests SET state = 'rejected', reject_reason = $2, decided_by = $3, decided_at = NOW()
       WHERE id = $1 AND state = 'pending' RETURNING ${COLS}`,
      [request.id, reason, actor(req)],
    );
    await client.query('COMMIT');
    ok(res, mapRequest(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[deliveryman-requests] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
