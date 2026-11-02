const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const { buildCrud } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, tillId, assertTillAccess, branchId, assertBranchAccess, rowInBranchScope, branchScopeFilter } = require('@cravedash/shared/src/authMiddleware');
const { AppError, badRequest, notFound, unauthorized, forbidden } = require('@cravedash/shared/src/errors');
const { createRateLimiter } = require('@cravedash/shared/src/rateLimit');
const { signEposStaff, verifyEposStaff } = require('@cravedash/shared/src/jwt');
const { requireBranchService } = require('@cravedash/shared/src/branchServiceGuard');

const router = express.Router();

/**
 * Phase A.3: when X-Epos-Staff-Token is present, narrow till/branch from staff JWT.
 * Missing / expired staff token → continue with restaurant-admin JWT (check-in / hydrate
 * must still load GET /staff). Invalid token must not wipe the till staff list.
 */
router.use((req, res, next) => {
  const raw = req.headers['x-epos-staff-token'];
  if (!raw) return next();
  // pin/verify issues the token — do not require a prior staff session
  if (req.method === 'POST' && /\/pin\/verify\/?$/.test(req.path)) return next();
  let claims;
  try {
    claims = verifyEposStaff(String(raw));
  } catch {
    // Stale token on splash/check-in — drop staff scope, keep restaurant session
    res.setHeader('X-Epos-Staff-Cleared', '1');
    return next();
  }
  if (claims.restaurant_id && claims.restaurant_id !== rid(req)) {
    return next(forbidden('Staff session restaurant mismatch'));
  }
  req.eposStaff = claims;
  const nextUser = { ...req.user };
  if (claims.till_id) {
    if (nextUser.till_id && String(nextUser.till_id) !== String(claims.till_id)) {
      return next(forbidden('Staff till conflicts with login till'));
    }
    nextUser.till_id = claims.till_id;
  }
  if (claims.branch_id) {
    if (nextUser.branch_id && String(nextUser.branch_id) !== String(claims.branch_id)) {
      return next(forbidden('Staff branch conflicts with login branch'));
    }
    nextUser.branch_id = claims.branch_id;
  }
  req.user = nextUser;
  return next();
});
// After the staff-token narrowing above, so the branch the guard checks is the one the session really uses.
router.use(requireBranchService);

const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654',
  '1212', '1122', '2121', '1004', '2000', '2020', '2024', '2025', '2026',
]);

/** Global attempt cap (in-memory; use Redis in multi-instance prod). */
const pinLimiter = createRateLimiter({
  windowMs: PIN_WINDOW_MS,
  max: 12,
  keyFn: (req) => `pin:${req.ip}:${req.user?.restaurant_id || ''}:${req.body && req.body.action === 'z_report' ? 'z_report' : ((req.body && req.body.staff_id) || 'x')}`,
});

/** Per staff+IP lockout after consecutive failures: stored in the database (see assertPinUnlocked). */

function rid(req) {
  return restaurantId(req);
}

function requireTillAdmin(req) {
  if (tillId(req)) throw forbidden('Till-bound sessions cannot manage the till registry');
}

/** Restaurant/super unbound sessions only — not till-bound EPOS cashiers. */
function requireRestaurantAdmin(req) {
  // Allow-list: only an unbound restaurant or super session (any other role is refused).
  const role = req.user?.role;
  if ((role !== 'restaurant' && role !== 'super') || tillId(req)) {
    throw forbidden('Requires restaurant admin session (not till-bound EPOS)');
  }
}

/** Any EPOS session, or a session bound to a till (not an unbound restaurant or super session). */
function isTillSession(req) {
  return req.user?.role === 'epos' || !!tillId(req);
}

/** Approval lifetime in ms. Provisional: decision D-5 (duration) is not yet approved; "time-limited" is. */
const Z_APPROVAL_TTL_MS = Number(process.env.Z_APPROVAL_TTL_MS) || 120 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** The security tables come from the migration (scripts/init-db.sql, SEC-M10). Kept as a no-op for callers. */
function ensureSecurityTables() {
  return Promise.resolve(true);
}

/** Audit row. Detail must never contain a PIN, token, hash or secret: ids and reason codes only. */
async function audit(req, event, subject, detail = {}) {
  await ensureSecurityTables();
  await pool.query(
    'INSERT INTO security_audit (restaurant_id, actor, actor_role, event, subject, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [rid(req), req.user?.sub || req.user?.email || null, req.user?.role || null, event, subject || null, JSON.stringify(detail)],
  );
}

/** Failed audit writes per event name, since process start (ORD-M5). */
const auditFailureCounts = new Map();

function countAuditFailure(event, err) {
  const n = (auditFailureCounts.get(event) || 0) + 1;
  auditFailureCounts.set(event, n);
  console.error(`[epos] audit write failed: event=${event} failures=${n} error=${err && err.message}`);
  return n;
}

/**
 * Audit write for a security event (a refusal or an approval). It fails closed (ORD-M5): if the row cannot be
 * written, the failure is logged at error level and counted, and the caller must not complete the action.
 */
async function requireAudit(req, event, subject, detail = {}) {
  try {
    await audit(req, event, subject, detail);
  } catch (err) {
    countAuditFailure(event, err);
    throw new AppError('Security audit unavailable; the action was not completed', 503, 'AUDIT_UNAVAILABLE');
  }
}

/** Audit write for a completed, non-refusal event. A failure is logged at error level and counted, but not raised. */
async function auditBestEffort(req, event, subject, detail = {}) {
  try {
    await audit(req, event, subject, detail);
  } catch (err) {
    countAuditFailure(event, err);
  }
}

function assertValidPinFormat(pin) {
  const s = String(pin == null ? '' : pin);
  if (!/^\d{4,8}$/.test(s)) throw badRequest('PIN must be 4–8 digits');
  if (WEAK_PINS.has(s) || /^(.)\1+$/.test(s)) throw badRequest('PIN is too weak — choose a less predictable code');
  return s;
}

/**
 * Throttle key. A Z approval is keyed by IP and restaurant only: the body's staff_id is ignored there,
 * so rotating staff_id values cannot escape the lock (review finding, audit 06 second pass).
 */
function pinFailKey(req) {
  const ip = req.ip || 'ip';
  const restaurant = rid(req) || 'r';
  if (req.body && req.body.action === 'z_report') return `${ip}|${restaurant}|z_report`;
  const staff = (req.body && req.body.staff_id) || 'unknown';
  return `${ip}|${restaurant}|${staff}`;
}

/**
 * PIN lockout is kept in the database (table pin_throttle), so it survives a restart and is shared
 * by every process that uses the same database. The upsert below is a single statement, so two
 * concurrent failures cannot both miss the threshold.
 */
async function assertPinUnlocked(req) {
  await ensureSecurityTables();
  const { rows } = await pool.query('SELECT locked_until FROM pin_throttle WHERE key = $1', [pinFailKey(req)]);
  const until = rows[0] && rows[0].locked_until ? new Date(rows[0].locked_until) : null;
  if (until && until.getTime() > Date.now()) {
    const secs = Math.ceil((until.getTime() - Date.now()) / 1000);
    throw new AppError(`PIN locked — try again in ${secs}s`, 429, 'PIN_LOCKED');
  }
}

async function recordPinFailure(req) {
  await ensureSecurityTables();
  await pool.query(
    `INSERT INTO pin_throttle (key, fails, locked_until, updated_at) VALUES ($1, 1, NULL, NOW())
     ON CONFLICT (key) DO UPDATE SET
       locked_until = CASE WHEN pin_throttle.fails + 1 >= $2
         THEN NOW() + ($3::int * INTERVAL '1 millisecond') ELSE pin_throttle.locked_until END,
       fails = CASE WHEN pin_throttle.fails + 1 >= $2 THEN 0 ELSE pin_throttle.fails + 1 END,
       updated_at = NOW()`,
    [pinFailKey(req), PIN_MAX_FAILS, PIN_WINDOW_MS],
  );
}

async function clearPinFailures(req) {
  await ensureSecurityTables();
  await pool.query('DELETE FROM pin_throttle WHERE key = $1', [pinFailKey(req)]);
}

router.get('/tills', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  let rows = await crud.list(rid(req));
  const bound = tillId(req);
  if (bound) rows = rows.filter((t) => String(t.id) === String(bound));
  if (branchId(req)) rows = rows.filter((t) => String(t.branch_id) === String(branchId(req)));
  else if (req.user?.role !== 'super') rows = rows.filter((t) => t.branch_id === null || t.branch_id === undefined);
  ok(res, rows);
}));

router.post('/tills', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  const body = { ...req.body, id: req.body.id || `till_${Date.now().toString(36)}` };
  body.branch_id = branchId(req) || (req.user?.role === 'super' ? body.branch_id || null : null);
  created(res, await crud.create(body, rid(req)));
}));

async function upsertTill(req, res) {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing || !rowInBranchScope(req, existing.branch_id)) throw notFound();
  const data = { ...(existing.data || {}), ...(req.body.data || {}) };
  const patch = { ...req.body };
  if (req.user?.role !== 'super') delete patch.branch_id; // a till's branch is set by the super admin only
  ok(res, await crud.update(req.params.id, { ...patch, data }, rid(req)));
}
router.patch('/tills/:id', asyncHandler(upsertTill));
router.put('/tills/:id', asyncHandler(upsertTill));

router.delete('/tills/:id', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing || !rowInBranchScope(req, existing.branch_id)) throw notFound();
  ok(res, await crud.remove(req.params.id, rid(req)));
}));

/**
 * Till check-in (ORD-M4). The staff member's PIN is verified, the opening float is stored on this till's own check-in
 * (it no longer overwrites the restaurant-wide float), and a till may hold only one open check-in (partial unique
 * index till_checkins_one_open_idx in init-db.sql).
 */
router.post('/check-in', asyncHandler(async (req, res) => {
  const { till_id, staff_id, pin, opening_float = 0 } = req.body || {};
  if (!till_id) throw badRequest('till_id required');
  if (!staff_id) throw badRequest('staff_id required');
  // The staff member is verified either by PIN, or by the staff session that the PIN step issued for this same
  // staff_id (pin/verify returns it only after a correct PIN). Anything else is refused.
  const sessionForStaff = !!(req.eposStaff && String(req.eposStaff.staff_id) === String(staff_id));
  if (!pin && !sessionForStaff) throw badRequest('pin required');
  assertTillAccess(req, till_id);
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) throw badRequest('opening_float must be a non-negative amount');
  await ensureSecurityTables();
  await assertPinUnlocked(req);
  const r = rid(req);
  const { rows: staffRows } = await pool.query(
    'SELECT id, pin_hash FROM till_staff WHERE id = $1 AND restaurant_id = $2 AND status = TRUE',
    [String(staff_id), r],
  );
  const staff = staffRows[0] || null;
  // A PIN that was sent must be correct; without one, the staff session for this staff_id is the proof.
  const verified = pin
    ? !!(staff && staff.pin_hash && (await bcrypt.compare(String(pin), staff.pin_hash)))
    : sessionForStaff;
  if (!staff || !verified) {
    await recordPinFailure(req);
    throw unauthorized('Invalid PIN');
  }
  await clearPinFailures(req);
  const id = `ci_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO till_checkins (id, restaurant_id, till_id, staff_id, opening_float, data, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT branch_id FROM epos_tills WHERE id = $3 AND restaurant_id = $2)) RETURNING *`,
      [id, r, String(till_id), staff.id, float, JSON.stringify({})],
    );
    row = rows[0];
  } catch (err) {
    if (err && err.code === '23505') throw new AppError('This till already has an open check-in', 409, 'CONFLICT');
    throw err;
  }
  created(res, row);
}));

router.post('/check-out', asyncHandler(async (req, res) => {
  const { checkin_id, closing_counts } = req.body || {};
  if (!checkin_id) throw badRequest('checkin_id required');
  const { rows: curRows } = await pool.query(
    'SELECT * FROM till_checkins WHERE id = $1 AND restaurant_id = $2',
    [checkin_id, rid(req)],
  );
  if (!curRows[0]) throw notFound();
  assertTillAccess(req, curRows[0].till_id);
  const { rows } = await pool.query(
    `UPDATE till_checkins SET checked_out_at = NOW(),
      data = COALESCE(data, '{}'::jsonb) || $3::jsonb
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [checkin_id, rid(req), { closing_counts: closing_counts || {} }],
  );
  if (!rows[0]) throw notFound();
  ok(res, rows[0]);
}));

router.get('/check-ins', asyncHandler(async (req, res) => {
  const bound = tillId(req);
  const till_id = bound || req.query.till_id;
  if (bound && req.query.till_id && String(req.query.till_id) !== String(bound)) {
    throw forbidden('Till out of scope for this session');
  }
  const { open_only } = req.query;
  const params = [rid(req)];
  let sql = 'SELECT * FROM till_checkins WHERE restaurant_id = $1';
  if (branchId(req)) {
    params.push(branchId(req));
    sql += ` AND branch_id = $${params.length}`;
  }
  if (till_id) {
    params.push(till_id);
    sql += ` AND till_id = $${params.length}`;
  }
  if (open_only === '1' || open_only === 'true') sql += ' AND checked_out_at IS NULL';
  sql += ' ORDER BY checked_in_at DESC LIMIT 100';
  const { rows } = await pool.query(sql, params);
  ok(res, rows);
}));

/** The branch a till belongs to (from its till record), or the caller's own branch when the till is unknown. */
async function tillBranchOf(restaurant, till, req) {
  if (till) {
    const { rows } = await pool.query('SELECT branch_id FROM epos_tills WHERE id = $1 AND restaurant_id = $2', [String(till), restaurant]);
    if (rows[0]) return rows[0].branch_id || null;
  }
  return branchId(req) || null;
}

router.get('/held-orders', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'held_orders', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const all = await crud.list(rid(req), branchScopeFilter(req));
  const bound = tillId(req);
  if (bound && req.query.till_id && String(req.query.till_id) !== String(bound)) {
    throw forbidden('Till out of scope for this session');
  }
  const till = bound || req.query.till_id;
  ok(res, till ? all.filter((h) => String(h.till_id) === String(till)) : all);
}));

router.post('/held-orders', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'held_orders', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const bound = tillId(req);
  const till_id = bound || req.body.till_id || null;
  if (bound) assertTillAccess(req, till_id);
  // Only table columns are written. The cart and other fields the till sends belong in the payload.
  const body = {
    id: req.body.id || `hold_${Date.now().toString(36)}`,
    till_id,
    label: req.body.label || null,
    payload: req.body.payload || req.body,
  };
  // A held order belongs to its till's branch (the till record decides, not the request body).
  body.branch_id = await tillBranchOf(rid(req), till_id, req);
  const existing = await crud.getById(body.id, rid(req));
  if (existing) {
    if (!rowInBranchScope(req, existing.branch_id)) throw notFound();
    assertTillAccess(req, existing.till_id);
    ok(res, await crud.update(body.id, body, rid(req)));
  } else {
    created(res, await crud.create(body, rid(req)));
  }
}));

router.delete('/held-orders/:id', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'held_orders', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing || !rowInBranchScope(req, existing.branch_id)) throw notFound();
  assertTillAccess(req, existing.till_id);
  ok(res, await crud.remove(req.params.id, rid(req)));
}));

/** Approver for non-Z till actions (legacy rule, unchanged by this change). */
function isApproverStaff(row) {
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return !!(data.can_approve || /manager|supervisor|owner|head\s*chef/i.test(row.role || ''));
}

/**
 * Approver for the Z Report (decision D-8, approved): role manager or supervisor AND can_approve === true.
 * Owner and head chef are excluded unless separately approved.
 */
function isZApprover(row) {
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return data.can_approve === true && /^(manager|supervisor)$/i.test(String(row.role || '').trim());
}

/**
 * Manager PIN for the Z Report (decisions D-1, D-3, D-8, D-12). Only an unbound restaurant or super
 * session may request it. The approver must be a manager or supervisor with can_approve === true.
 * Returns a one-time token bound to the restaurant, the action and the current Z number. No staff
 * session is returned.
 */
/**
 * Manager approval for a cash drawer open with no sale (SEC-H12). A restaurant manager's PIN gives a single-use token,
 * valid for five minutes. The drawer route consumes it, so one approval opens the drawer once.
 */
async function verifyDrawerApproval(req, res, pin) {
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM till_staff WHERE restaurant_id = $1 AND status = TRUE', [r]);
  let approver = null;
  for (const s of rows) {
    if (!isApproverStaff(s) || !s.pin_hash) continue;
    if (await bcrypt.compare(String(pin), s.pin_hash)) {
      approver = s;
      break;
    }
  }
  if (!approver) {
    await recordPinFailure(req);
    throw unauthorized('Invalid PIN');
  }
  await clearPinFailures(req);
  const row = await ensureReportRow(r);
  const token = crypto.randomBytes(32).toString('hex');
  await ensureSecurityTables();
  const approvalId = `zap_${crypto.randomBytes(8).toString('hex')}`;
  await pool.query(
    `INSERT INTO z_approvals (id, restaurant_id, till_id, action, expected_z_no, token_hash, approver_staff_id, approver_role, requested_by, expires_at)
     VALUES ($1,$2,$3,'drawer_no_sale',$4,$5,$6,$7,$8,$9)`,
    [approvalId, r, tillId(req) || null, Number(row.z_counter) || 1, hashToken(token),
      approver.id, approver.role, req.user?.sub || null, new Date(Date.now() + 5 * 60 * 1000)],
  );
  try {
    await requireAudit(req, 'drawer.approval_issued', approver.id, { till_id: tillId(req) || null });
  } catch (err) {
    // Fail closed: the unaudited approval is revoked before the request fails.
    await pool.query("UPDATE z_approvals SET status = 'revoked' WHERE id = $1", [approvalId]).catch(() => {});
    throw err;
  }
  ok(res, { verified: true, approval_token: token, staff: { id: approver.id, name: approver.name, role: approver.role } });
}

async function verifyZApproval(req, res, pin) {
  // The manager's PIN at the till is the approval. Any authenticated till may take it.
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM till_staff WHERE restaurant_id = $1 AND status = TRUE', [r]);
  let approver = null;
  for (const s of rows) {
    if (!isZApprover(s) || !s.pin_hash) continue;
    if (await bcrypt.compare(String(pin), s.pin_hash)) {
      approver = s;
      break;
    }
  }
  if (!approver) {
    await recordPinFailure(req);
    await requireAudit(req, 'z.approval_refused', null, { reason: 'no_matching_approver' });
    throw unauthorized('Invalid PIN');
  }
  await clearPinFailures(req);
  const row = await ensureReportRow(r);
  const zNo = Number(row.z_counter) || 1;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + Z_APPROVAL_TTL_MS);
  await ensureSecurityTables();
  // One live approval per restaurant: a new approval supersedes earlier unconsumed ones, so only the latest can close the day.
  await pool.query(
    "UPDATE z_approvals SET status = 'superseded' WHERE restaurant_id = $1 AND action = 'z_report' AND status = 'issued'",
    [r],
  );
  const approvalId = `zap_${crypto.randomBytes(8).toString('hex')}`;
  await pool.query(
    `INSERT INTO z_approvals (id, restaurant_id, till_id, action, expected_z_no, token_hash, approver_staff_id, approver_role, requested_by, expires_at)
     VALUES ($1,$2,NULL,'z_report',$3,$4,$5,$6,$7,$8)`,
    [approvalId, r, zNo, hashToken(token), approver.id, approver.role, req.user?.sub || null, expiresAt],
  );
  try {
    await requireAudit(req, 'z.approval_issued', approver.id, { expected_z_no: zNo, expires_at: expiresAt.toISOString() });
  } catch (err) {
    // Fail closed: the unaudited approval is revoked, so its token cannot close the day.
    await pool.query("UPDATE z_approvals SET status = 'revoked' WHERE id = $1", [approvalId]).catch(() => {});
    throw err;
  }
  ok(res, {
    verified: true,
    staff: { id: approver.id, name: approver.name, role: approver.role },
    approval_token: token,
    expires_at: expiresAt.toISOString(),
    z_no: zNo,
  });
}

router.post('/pin/verify', pinLimiter, asyncHandler(async (req, res) => {
  const { pin, staff_id, till_id: bodyTill, action } = req.body || {};
  if (!pin) throw badRequest('pin required');
  await assertPinUnlocked(req);
  // Format check only — do not apply weak-PIN policy on verify (legacy PINs may still exist)
  if (!/^\d{4,8}$/.test(String(pin))) {
    await recordPinFailure(req);
    throw unauthorized('Invalid PIN');
  }
  if (action === 'z_report') return verifyZApproval(req, res, pin);
  if (action === 'drawer_no_sale') return verifyDrawerApproval(req, res, pin);

  let staff = null;
  if (staff_id) {
    const { rows } = await pool.query(
      'SELECT * FROM till_staff WHERE id = $1 AND restaurant_id = $2 AND status = TRUE',
      [staff_id, rid(req)],
    );
    staff = rows[0] || null;
    if (!staff || !staff.pin_hash || !(await bcrypt.compare(String(pin), staff.pin_hash))) {
      await recordPinFailure(req);
      throw unauthorized('Invalid PIN');
    }
  } else {
    // Manager approval pad: only match approver roles (never scan all cashiers)
    const { rows } = await pool.query(
      'SELECT * FROM till_staff WHERE restaurant_id = $1 AND status = TRUE',
      [rid(req)],
    );
    for (const s of rows) {
      if (!isApproverStaff(s) || !s.pin_hash) continue;
      if (await bcrypt.compare(String(pin), s.pin_hash)) {
        staff = s;
        break;
      }
    }
    if (!staff) {
      await recordPinFailure(req);
      throw unauthorized('Invalid PIN');
    }
  }

  await clearPinFailures(req);
  // Seal till into staff JWT: staff assignment > login till > device hint (body) — never widen after
  const loginTill = tillId(req);
  let sealedTill = staff.till_id || loginTill || null;
  if (staff.till_id && bodyTill && String(bodyTill) !== String(staff.till_id)) {
    // Staff is assigned — ignore client invent
    sealedTill = staff.till_id;
  } else if (!sealedTill && bodyTill) {
    sealedTill = String(bodyTill).slice(0, 64);
  }
  const sealedBranch = req.user?.branch_id || null;
  const staffOut = { id: staff.id, name: staff.name, role: staff.role, till_id: sealedTill };
  // Approval pad (no staff_id): return who approved, never a reusable staff session (D1-Z criterion 5).
  if (!staff_id) return ok(res, { verified: true, staff: staffOut });
  // Cryptographic staff session — clients must not invent epos_session_v1 privileges
  const staff_token = signEposStaff({
    staff_id: staff.id,
    staff_name: staff.name,
    staff_role: staff.role,
    restaurant_id: rid(req),
    till_id: sealedTill,
    branch_id: sealedBranch,
    sub: req.user?.sub || null,
  });
  ok(res, { verified: true, staff: staffOut, staff_token });
}));

/** Validate current EPOS staff token (from PIN verify). */
router.get('/staff-session', asyncHandler(async (req, res) => {
  const raw = req.headers['x-epos-staff-token'] || (req.query && req.query.staff_token) || '';
  if (!raw) throw unauthorized('Missing staff session');
  let claims;
  try {
    claims = verifyEposStaff(String(raw));
  } catch {
    throw unauthorized('Staff session expired — check in again');
  }
  if (claims.restaurant_id && claims.restaurant_id !== rid(req)) {
    throw forbidden('Staff session restaurant mismatch');
  }
  ok(res, {
    staff: {
      id: claims.staff_id,
      name: claims.staff_name,
      role: claims.staff_role,
      till_id: claims.till_id || null,
    },
    exp: claims.exp,
  });
}));

router.post('/staff-session/end', asyncHandler(async (req, res) => {
  // Stateless JWT — client discards token; endpoint exists for audit symmetry
  ok(res, { ended: true });
}));

function reportStateFromRow(row) {
  const data = (row && row.data && typeof row.data === 'object') ? row.data : {};
  return {
    x_counter: row?.x_counter || 0,
    z_counter: row?.z_counter || 0,
    opening_float: Number(row?.opening_float) || 0,
    period_start: row?.period_start || data.periodStart || null,
    xCounter: data.xCounter != null ? data.xCounter : (row?.x_counter || 0),
    zCounter: data.zCounter != null ? data.zCounter : (row?.z_counter || 1),
    periodStart: data.periodStart || (row?.period_start ? new Date(row.period_start).toISOString() : new Date().toISOString()),
    openingFloat: data.openingFloat != null ? data.openingFloat : (Number(row?.opening_float) || 0),
    cashMovements: Array.isArray(data.cashMovements) ? data.cashMovements : [],
    voids: Array.isArray(data.voids) ? data.voids : [],
    noSaleCount: data.noSaleCount || 0,
    history: Array.isArray(data.history) ? data.history : [],
    lastX: data.lastX || null,
  };
}

async function ensureReportRow(restaurantId) {
  const { rows } = await pool.query(
    `INSERT INTO report_counters (restaurant_id, period_start, x_counter, z_counter, opening_float, data, updated_at)
     VALUES ($1, CURRENT_DATE, 0, 1, 0, '{}'::jsonb, NOW())
     ON CONFLICT (restaurant_id) DO UPDATE SET updated_at = report_counters.updated_at
     RETURNING *`,
    [restaurantId],
  );
  return rows[0];
}

/** Opening float of the till's own open check-in (D9-Q2). Zero when the till has no open check-in. */
async function ownCheckinFloat(r, till) {
  const { rows } = await pool.query(
    `SELECT opening_float FROM till_checkins
      WHERE restaurant_id = $1 AND till_id = $2 AND checked_out_at IS NULL
      ORDER BY checked_in_at DESC LIMIT 1`,
    [r, till],
  );
  return rows[0] ? Number(rows[0].opening_float) || 0 : 0;
}

/**
 * The report state a session may see (decisions D1, D9, D9-Q1 to D9-Q5).
 * Restaurant admin and super: full state, unchanged. Till sessions: only till-owned values.
 * - Shared X counter number: never shown to a till (D9-Q1). lastX.x_no is therefore not shown.
 * - Restaurant-wide opening float: never shown to a till; the till's own check-in float is shown instead (D9-Q2).
 * - lastX: shown only when it was taken on this till, and only its time and the staff name (D9-Q3).
 * - Cash movements, voids and no-sale counts have no reliable till attribution yet, so they are excluded
 *   from till views (D9-Q4, D9-Q5). Z history entries are shown only when they belong to this till.
 */
async function reportStateForSession(req, row) {
  const full = reportStateFromRow(row);
  if (!isTillSession(req)) return full;
  // A till now gets the shared X and Z numbers and the last X. Its own opening float and its own Z history stay
  // scoped to the till: other tills' cash movements, voids and float are not shown to it.
  const till = tillId(req) || null;
  const floatForTill = till ? await ownCheckinFloat(rid(req), till) : 0;
  return {
    x_counter: full.x_counter,
    xCounter: full.xCounter,
    z_counter: full.z_counter,
    zCounter: full.zCounter,
    opening_float: floatForTill,
    period_start: full.period_start,
    openingFloat: floatForTill,
    periodStart: full.periodStart,
    cashMovements: [],
    voids: [],
    noSaleCount: 0,
    history: till ? full.history.filter((h) => h && String(h.till_id || '') === String(till)) : [],
    // The last X is shown only when this till took it.
    lastX: full.lastX && String(full.lastX.till_id || '') === String(till) ? full.lastX : null,
  };
}

router.get('/counts', asyncHandler(async (req, res) => {
  const row = await ensureReportRow(rid(req));
  ok(res, await reportStateForSession(req, row));
}));

/** Persist live report period state (cash movements, voids, floats, history). */
/** Runs fn with the report row locked, so two concurrent updates cannot overwrite each other (ORD-H16). */
async function withReportLock(restaurantId, fn) {
  await ensureReportRow(restaurantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM report_counters WHERE restaurant_id = $1 FOR UPDATE', [restaurantId]);
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

router.put('/report-state', asyncHandler(async (req, res) => {
  requireRestaurantAdmin(req);
  const r = rid(req);
  const body = req.body || {};
  const updated = await withReportLock(r, async (db, row) => {
    const current = reportStateFromRow(row);
    // Server-owned: the shared X counter, the Z number, Z history and lastX change only through their own
    // routes (counts/x, counts/z). A client write here cannot rewrite them (D1-Z, D9-Q1).
    const data = {
      xCounter: current.xCounter,
      zCounter: current.zCounter,
      periodStart: current.periodStart,
      openingFloat: body.openingFloat != null ? body.openingFloat : current.openingFloat,
      cashMovements: Array.isArray(body.cashMovements) ? body.cashMovements : [],
      voids: Array.isArray(body.voids) ? body.voids : [],
      noSaleCount: body.noSaleCount || 0,
      history: current.history,
      lastX: current.lastX,
    };
    const { rows } = await db.query(
      `UPDATE report_counters SET
         opening_float = $2,
         data = $3::jsonb, updated_at = NOW()
       WHERE restaurant_id = $1 RETURNING *`,
      [r, data.openingFloat, JSON.stringify(data)],
    );
    return rows[0];
  });
  ok(res, reportStateFromRow(updated));
}));

router.post('/counts/x', asyncHandler(async (req, res) => {
  const r = rid(req);
  // Two X counts at once must get different numbers, so the increment happens under the row lock (ORD-H16).
  const updated = await withReportLock(r, async (db, row) => {
    const state = reportStateFromRow(row);
    state.xCounter = (state.xCounter || 0) + 1;
    // The staff name comes from the authenticated staff session when present, not from free text (D9-Q3).
    state.lastX = {
      x_no: state.xCounter,
      at: new Date().toISOString(),
      by: req.eposStaff?.staff_name || String((req.body && req.body.by) || 'Manager').slice(0, 64),
      till_id: tillId(req) || null,
    };
    const { rows } = await db.query(
      `UPDATE report_counters SET x_counter = $2, data = $3::jsonb, updated_at = NOW()
       WHERE restaurant_id = $1 RETURNING *`,
      [r, state.xCounter, JSON.stringify({
        xCounter: state.xCounter,
        zCounter: state.zCounter,
        periodStart: state.periodStart,
        openingFloat: state.openingFloat,
        cashMovements: state.cashMovements,
        voids: state.voids,
        noSaleCount: state.noSaleCount,
        history: state.history,
        lastX: state.lastX,
      })],
    );
    return rows[0];
  });
  ok(res, await reportStateForSession(req, updated));
}));

/**
 * Closes the day. Requires a manager approval token issued by POST /pin/verify with action z_report.
 * The token is consumed in the same transaction that writes the Z (single use, bound to the restaurant,
 * the action and the current Z number). Till sessions cannot close the day (decision D-12).
 *
 * Not yet implemented (open, see audit 09/10): server-side recomputation of totals (D1-Z criterion 4).
 * The report body is still client-supplied and is recorded as such (report_source).
 */
router.post('/counts/z', asyncHandler(async (req, res) => {
  const r = rid(req);
  const body = req.body || {};
  // Any authenticated session may close the day. The single-use manager approval below is still required.
  await ensureSecurityTables();
  await ensureReportRow(r);
  const client = await pool.connect();
  let approverId;
  let entry;
  let saved;
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query('SELECT * FROM report_counters WHERE restaurant_id = $1 FOR UPDATE', [r]);
    const state = reportStateFromRow(locked[0]);
    const zNo = state.zCounter;
    const consumed = await client.query(
      `UPDATE z_approvals SET status = 'consumed', consumed_at = NOW()
        WHERE token_hash = $1 AND restaurant_id = $2 AND action = 'z_report' AND status = 'issued'
          AND expires_at > NOW() AND expected_z_no = $3
        RETURNING id, approver_staff_id`,
      [hashToken(String(body.approval_token || '')), r, zNo],
    );
    if (!consumed.rows[0]) {
      await client.query('ROLLBACK');
      await requireAudit(req, 'z.refused', 'approval', { reason: 'approval_missing_expired_used_or_mismatched' });
      throw forbidden('A valid, unused manager approval is required to close the day');
    }
    approverId = consumed.rows[0].approver_staff_id;
    const now = new Date().toISOString();
    const report = body.entry?.report || body.report || null;
    const countedCash = body.counted_cash ?? body.entry?.counted_cash ?? null;
    const variance = body.variance ?? body.entry?.variance ?? null;
    entry = {
      z_no: zNo,
      from: body.from ?? null,
      to: body.to || now,
      generated_at: now,
      by: body.by || 'Manager',
      terminal: body.terminal || 'Terminal 1',
      till_id: null,
      counted_cash: countedCash,
      variance,
      report,
      report_source: 'client-unverified',
      approved_by_staff_id: approverId,
    };
    // Server-side Z check (ORD-H17, stage 2). The server computes the paid total for the report period, the same way the
    // report does (paid, not canceled or failed). If the client's report disagrees by more than one penny, the close is
    // refused. The transaction rolls back, so the approval token is not used up.
    const fromIso = report && report.from ? new Date(report.from).toISOString() : (state.periodStart || new Date(0).toISOString());
    const toIso = report && report.to ? new Date(report.to).toISOString() : now;
    const { rows: srv } = await client.query(
      `SELECT COALESCE(SUM(total), 0)::float AS total, COUNT(*)::int AS orders FROM orders
        WHERE restaurant_id = $1 AND LOWER(payment_status) = 'paid'
          AND status NOT IN ('canceled', 'failed_to_deliver')
          AND created_at >= $2 AND created_at <= $3`,
      [r, fromIso, toIso],
    );
    const serverPaid = Math.round(srv[0].total * 100) / 100;
    entry.server_totals = { paid_total: serverPaid, order_count: srv[0].orders, period_from: fromIso, period_to: toIso };
    if (report && report.byPay && typeof report.byPay === 'object') {
      const clientPaid = Math.round(Object.values(report.byPay).reduce((sum, v) => sum + (Number(v) || 0), 0) * 100) / 100;
      entry.server_totals.client_paid_total = clientPaid;
      if (Math.abs(serverPaid - clientPaid) > 0.01) {
        const err = new Error(`Report does not match the orders: server paid total ${serverPaid.toFixed(2)}, report ${clientPaid.toFixed(2)}. Refresh the report and try again.`);
        err.status = 409;
        err.code = 'Z_MISMATCH';
        throw err;
      }
    }
    state.history = (state.history || []).concat([entry]);
    state.zCounter = zNo + 1;
    state.periodStart = now;
    state.cashMovements = [];
    state.voids = [];
    state.noSaleCount = 0;
    if (body.opening_float != null) state.openingFloat = Number(body.opening_float) || 0;

    await client.query(
      `INSERT INTO z_reports (id, restaurant_id, till_id, z_no, report, counted_cash, variance, generated_at, generated_by)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
      [
        `z_${r}_${zNo}_${crypto.randomBytes(4).toString('hex')}`,
        r,
        zNo,
        JSON.stringify(report || entry),
        countedCash != null ? Number(countedCash) : null,
        variance != null ? Number(variance) : null,
        now,
        entry.by,
      ],
    );
    const { rows } = await client.query(
      `UPDATE report_counters SET z_counter = $2, opening_float = $3, period_start = CURRENT_DATE,
         data = $4::jsonb, updated_at = NOW()
       WHERE restaurant_id = $1 RETURNING *`,
      [r, state.zCounter, state.openingFloat, JSON.stringify({
        xCounter: state.xCounter,
        zCounter: state.zCounter,
        periodStart: state.periodStart,
        openingFloat: state.openingFloat,
        cashMovements: state.cashMovements,
        voids: state.voids,
        noSaleCount: state.noSaleCount,
        history: state.history,
        lastX: state.lastX,
      })],
    );
    await client.query('COMMIT');
    saved = rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await auditBestEffort(req, 'z.committed', String(entry.z_no), { approver_staff_id: approverId });
  ok(res, { ...reportStateFromRow(saved), entry });
}));

/** Remote support signaling (sessions / commands / screen snapshots) — Postgres-backed. */
router.get('/remote', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'remote_state'`,
    [rid(req)],
  );
  const data = rows[0]?.data || {};
  ok(res, {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    cmds: Array.isArray(data.cmds) ? data.cmds : [],
    screens: data.screens && typeof data.screens === 'object' ? data.screens : {},
  });
}));

router.put('/remote', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const bound = tillId(req);
  const { rows: prevRows } = await pool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'remote_state'`,
    [rid(req)],
  );
  const prev = (prevRows[0] && prevRows[0].data) || {};
  let data;
  if (bound) {
    // Till-bound EPOS may only publish its own screen snapshot — never inject cmds/sessions
    data = {
      sessions: Array.isArray(prev.sessions) ? prev.sessions : [],
      cmds: Array.isArray(prev.cmds) ? prev.cmds : [],
      screens: { ...(prev.screens && typeof prev.screens === 'object' ? prev.screens : {}) },
    };
    if (body.screens && body.screens[bound] !== undefined) {
      data.screens[bound] = body.screens[bound];
    }
  } else {
    requireRestaurantAdmin(req);
    data = {
      sessions: Array.isArray(body.sessions) ? body.sessions : [],
      cmds: Array.isArray(body.cmds) ? body.cmds : [],
      screens: body.screens && typeof body.screens === 'object' ? body.screens : {},
    };
  }
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'remote_state', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [rid(req), JSON.stringify(data)],
  );
  ok(res, data);
}));

function mapStaff(row) {
  if (!row) return row;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    till_id: row.till_id,
    status: row.status,
    active: row.status !== false,
    can_approve: data.can_approve ?? /manager|supervisor/i.test(row.role || ''),
    color: data.color || '#0b84f3',
    tills: data.tills || (row.till_id ? [row.till_id] : []),
    initials: (row.name || '?')
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    has_pin: !!row.pin_hash,
  };
}

router.get('/staff', asyncHandler(async (req, res) => {
  const bound = branchId(req);
  const params = [rid(req)];
  let sql = 'SELECT id, restaurant_id, name, role, till_id, branch_id, status, data, pin_hash FROM till_staff WHERE restaurant_id = $1';
  if (bound) {
    params.push(bound);
    sql += ' AND branch_id = $2';
  } else if (req.user?.role !== 'super') {
    sql += ' AND branch_id IS NULL'; // the owner sees restaurant-level staff only
  }
  sql += ' ORDER BY name';
  const { rows } = await pool.query(sql, params);
  ok(res, rows.map(mapStaff));
}));

/**
 * Legacy approver review (read-only): every staff member with can_approve = true, and whether that
 * flag is valid for Z approval under decision D-8 (role manager or supervisor). Nothing is changed here.
 * Remediation is an explicit admin PATCH per staff member (audited). No bulk update is provided.
 */
router.get('/approvers', asyncHandler(async (req, res) => {
  requireRestaurantAdmin(req);
  const { rows } = await pool.query(
    `SELECT id, name, role, status, data FROM till_staff
      WHERE restaurant_id = $1 AND data->'can_approve' = 'true'::jsonb
      ORDER BY name`,
    [rid(req)],
  );
  ok(res, rows.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    active: s.status !== false,
    z_eligible: isZApprover(s) && s.status !== false,
  })));
}));

router.post('/staff', asyncHandler(async (req, res) => {
  // Creating staff and granting approver permission: restaurant admin or super only (decision D-3).
  requireRestaurantAdmin(req);
  const { name, pin, role = 'cashier', till_id, can_approve, color, tills, active = true } = req.body || {};
  if (!name || !pin) throw badRequest('name and pin required');
  const pinNorm = assertValidPinFormat(pin);
  const id = req.body.id || `ts_${Date.now().toString(36)}`;
  const pin_hash = await bcrypt.hash(pinNorm, 10);
  const data = {
    // Approver permission is granted only by an explicit flag from an admin, never inferred from the role.
    can_approve: can_approve === true,
    color: color || '#0b84f3',
    tills: tills || (till_id ? [till_id] : []),
  };
  const bound = branchId(req);
  const staffBranch = bound || (req.user?.role === 'super' ? req.body.branch_id || null : null);
  const { rows: clash } = await pool.query('SELECT branch_id FROM till_staff WHERE id = $1', [id]);
  if (clash[0] && !rowInBranchScope(req, clash[0].branch_id)) throw badRequest('Staff id is already in use');
  if (bound) assertBranchAccess(req, staffBranch, { allowShared: true });
  const { rows } = await pool.query(
    `INSERT INTO till_staff (id, restaurant_id, name, pin_hash, role, till_id, branch_id, status, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, pin_hash=EXCLUDED.pin_hash, role=EXCLUDED.role,
       till_id=EXCLUDED.till_id, branch_id=EXCLUDED.branch_id, status=EXCLUDED.status, data=EXCLUDED.data, updated_at=NOW()
     WHERE till_staff.restaurant_id = EXCLUDED.restaurant_id
     RETURNING id, restaurant_id, name, role, till_id, branch_id, status, data, pin_hash`,
    [id, rid(req), name, pin_hash, role, till_id || null, staffBranch, active !== false, JSON.stringify(data)],
  );
  // No row means the id already belongs to another restaurant. Nothing was changed (SEC-H ORD-H1).
  if (!rows[0]) throw badRequest('Staff id is already in use');
  if (data.can_approve) await audit(req, 'staff.approver_granted', id, { role });
  created(res, mapStaff(rows[0]));
}));

router.patch('/staff/:id', asyncHandler(async (req, res) => {
  requireRestaurantAdmin(req);
  const { rows: existing } = await pool.query(
    'SELECT * FROM till_staff WHERE id = $1 AND restaurant_id = $2',
    [req.params.id, rid(req)],
  );
  if (!existing[0]) throw notFound();
  if (!rowInBranchScope(req, existing[0].branch_id)) throw notFound();
  const cur = existing[0];
  const body = req.body || {};
  const data = { ...(cur.data || {}), ...(body.data || {}) };
  // Approver permission changes only through an explicit admin flag. body.data cannot grant it (D-3).
  const wasApprover = (cur.data || {}).can_approve === true;
  data.can_approve = body.can_approve !== undefined ? body.can_approve === true : wasApprover;
  if (body.color) data.color = body.color;
  if (body.tills) data.tills = body.tills;
  let pin_hash = cur.pin_hash;
  if (body.pin) pin_hash = await bcrypt.hash(assertValidPinFormat(body.pin), 10);
  const { rows } = await pool.query(
    `UPDATE till_staff SET name=COALESCE($3,name), pin_hash=$4, role=COALESCE($5,role),
      till_id=COALESCE($6,till_id), status=COALESCE($7,status), data=$8, updated_at=NOW()
     WHERE id=$1 AND restaurant_id=$2
     RETURNING id, restaurant_id, name, role, till_id, status, data, pin_hash`,
    [
      req.params.id,
      rid(req),
      body.name || null,
      pin_hash,
      body.role || null,
      body.till_id !== undefined ? body.till_id : cur.till_id,
      body.active !== undefined ? body.active !== false : body.status !== undefined ? body.status : cur.status,
      JSON.stringify(data),
    ],
  );
  if (data.can_approve !== wasApprover) {
    await audit(req, data.can_approve ? 'staff.approver_granted' : 'staff.approver_revoked', req.params.id, {});
  }
  ok(res, mapStaff(rows[0]));
}));

router.delete('/staff/:id', asyncHandler(async (req, res) => {
  // Deleting staff is an admin action, not a till action, and a branch-bound admin stays in its branch (ORD-H18).
  requireRestaurantAdmin(req);
  const { rows: existing } = await pool.query('SELECT branch_id FROM till_staff WHERE id = $1 AND restaurant_id = $2', [
    req.params.id,
    rid(req),
  ]);
  if (!existing[0]) throw notFound();
  if (!rowInBranchScope(req, existing[0].branch_id)) throw notFound();
  const { rowCount } = await pool.query('DELETE FROM till_staff WHERE id = $1 AND restaurant_id = $2', [
    req.params.id,
    rid(req),
  ]);
  if (!rowCount) throw notFound();
  ok(res, { deleted: true });
}));

/** Ensure timeclock tables exist (idempotent). */
async function ensureTimeclockTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_timeclock (
      restaurant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('in','out','break')),
      since TIMESTAMPTZ,
      break_since TIMESTAMPTZ,
      branch_id TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (restaurant_id, staff_id)
    );
    CREATE TABLE IF NOT EXISTS staff_timeclock_events (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at TIMESTAMPTZ DEFAULT NOW(),
      branch_id TEXT,
      data JSONB DEFAULT '{}'::jsonb
    );
    ALTER TABLE staff_timeclock ADD COLUMN IF NOT EXISTS branch_id TEXT;
    ALTER TABLE staff_timeclock_events ADD COLUMN IF NOT EXISTS branch_id TEXT;
  `);
}
let timeclockReady = null;
function readyTimeclock() {
  if (!timeclockReady) timeclockReady = ensureTimeclockTables().catch((e) => {
    timeclockReady = null;
    throw e;
  });
  return timeclockReady;
}

function fmtClockSince(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtElapsed(iso) {
  if (!iso) return '—';
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

router.get('/timeclock', asyncHandler(async (req, res) => {
  await readyTimeclock();
  const r = rid(req);
  const bound = branchId(req);
  const clockParams = [r];
  let clockSql = 'SELECT staff_id, status, since, break_since, branch_id, data, updated_at FROM staff_timeclock WHERE restaurant_id = $1';
  if (bound) {
    clockParams.push(bound);
    clockSql += ' AND branch_id = $2';
  } else if (req.user?.role !== 'super') {
    clockSql += ' AND branch_id IS NULL';
  }
  const { rows } = await pool.query(clockSql, clockParams);
  const eventParams = [r];
  let eventSql = `SELECT id, staff_id, event, at, branch_id, data FROM staff_timeclock_events
     WHERE restaurant_id = $1 AND at >= NOW() - INTERVAL '24 hours'`;
  if (bound) {
    eventParams.push(bound);
    eventSql += ' AND branch_id = $2';
  } else if (req.user?.role !== 'super') {
    eventSql += ' AND branch_id IS NULL';
  }
  eventSql += ' ORDER BY at DESC LIMIT 200';
  const { rows: events } = await pool.query(eventSql, eventParams);
  const state = {};
  rows.forEach((row) => {
    state[row.staff_id] = {
      status: row.status,
      since: row.since ? fmtClockSince(row.since) : '—',
      since_iso: row.since,
      break_since: row.break_since,
      elapsed: row.status === 'out' ? '—' : fmtElapsed(row.status === 'break' && row.break_since ? row.break_since : row.since),
      updated_at: row.updated_at,
    };
  });
  ok(res, { state, events });
}));

router.post('/timeclock', asyncHandler(async (req, res) => {
  await readyTimeclock();
  const r = rid(req);
  const { staff_id, action } = req.body || {};
  if (!staff_id) throw badRequest('staff_id required');
  const act = String(action || '').toLowerCase();
  if (!['in', 'out', 'break', 'end_break'].includes(act)) {
    throw badRequest('action must be in|out|break|end_break');
  }
  const { rows: staffRows } = await pool.query(
    'SELECT id, branch_id FROM till_staff WHERE id = $1 AND restaurant_id = $2',
    [staff_id, r],
  );
  if (!staffRows[0]) throw notFound('Staff not found');
  assertBranchAccess(req, staffRows[0].branch_id, { allowShared: true });
  const clockBranch = branchId(req) || staffRows[0].branch_id || null;

  const { rows: curRows } = await pool.query(
    'SELECT * FROM staff_timeclock WHERE restaurant_id = $1 AND staff_id = $2',
    [r, staff_id],
  );
  const cur = curRows[0] || { status: 'out', since: null, break_since: null, data: {} };
  let nextStatus = cur.status;
  let since = cur.since;
  let breakSince = cur.break_since;
  let eventName = act;

  if (act === 'in') {
    nextStatus = 'in';
    since = new Date();
    breakSince = null;
    eventName = 'clock_in';
  } else if (act === 'out') {
    nextStatus = 'out';
    breakSince = null;
    eventName = 'clock_out';
  } else if (act === 'break') {
    if (cur.status === 'out') throw badRequest('Cannot start break while clocked out');
    nextStatus = 'break';
    breakSince = new Date();
    eventName = 'break_start';
  } else if (act === 'end_break') {
    if (cur.status !== 'break') throw badRequest('Not on break');
    nextStatus = 'in';
    breakSince = null;
    eventName = 'break_end';
  }

  await pool.query(
    `INSERT INTO staff_timeclock (restaurant_id, staff_id, status, since, break_since, branch_id, data, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,NOW())
     ON CONFLICT (restaurant_id, staff_id) DO UPDATE SET
       status = EXCLUDED.status, since = EXCLUDED.since, break_since = EXCLUDED.break_since,
       branch_id = COALESCE(EXCLUDED.branch_id, staff_timeclock.branch_id), updated_at = NOW()`,
    [r, staff_id, nextStatus, since, breakSince, clockBranch],
  );
  const evId = `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await pool.query(
    `INSERT INTO staff_timeclock_events (id, restaurant_id, staff_id, event, at, branch_id, data)
     VALUES ($1,$2,$3,$4,NOW(),$5,$6::jsonb)`,
    [evId, r, staff_id, eventName, clockBranch, JSON.stringify({ by: req.user?.name || null })],
  );

  ok(res, {
    staff_id,
    status: nextStatus,
    since: since ? fmtClockSince(since) : '—',
    since_iso: since,
    elapsed: nextStatus === 'out' ? '—' : fmtElapsed(nextStatus === 'break' && breakSince ? breakSince : since),
    event: eventName,
  });
}));

/** Forgot PIN — creates manager approval request; does not email secrets. */
const forgotPinLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => `forgot-pin:${req.ip}:${req.user?.restaurant_id || ''}`,
});

router.post('/pin/forgot', forgotPinLimiter, asyncHandler(async (req, res) => {
  const { contact, staff_id } = req.body || {};
  const c = String(contact || '').trim();
  if (!c || c.length < 5) throw badRequest('email or phone required');
  if (c.length > 120) throw badRequest('contact too long');
  const r = rid(req);
  let staff = null;
  if (staff_id) {
    const { rows } = await pool.query(
      'SELECT id, name, role FROM till_staff WHERE id = $1 AND restaurant_id = $2',
      [staff_id, r],
    );
    staff = rows[0] || null;
  }
  const id = `apr_pin_${Date.now().toString(36)}`;
  await pool.query(
    `INSERT INTO approval_requests (id, restaurant_id, app, action, status, payload, at, created_at, updated_at, branch_id)
     VALUES ($1,$2,'epos','pin_reset','pending',$3::jsonb,NOW(),NOW(),NOW(),$4)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      r,
      JSON.stringify({
        contact: c,
        staff_id: staff ? staff.id : staff_id || null,
        staff_name: staff ? staff.name : null,
        requested_by: req.user?.name || null,
        at: new Date().toISOString(),
      }),
      branchId(req) || null,
    ],
  );
  // Always succeed with same message (no staff enumeration)
  ok(res, {
    queued: true,
    message: 'If this staff member exists, a manager will be asked to reset their PIN.',
    approval_id: id,
  });
}));

module.exports = router;
