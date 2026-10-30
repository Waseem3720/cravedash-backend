const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const { buildCrud } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, tillId, assertTillAccess, branchId, assertBranchAccess } = require('@cravedash/shared/src/authMiddleware');
const { AppError, badRequest, notFound, unauthorized, forbidden } = require('@cravedash/shared/src/errors');
const { createRateLimiter, createLockoutTracker } = require('@cravedash/shared/src/rateLimit');
const { signEposStaff, verifyEposStaff } = require('@cravedash/shared/src/jwt');

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

const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654',
  '1212', '1122', '2121', '1004', '2000', '2020', '2024', '2025', '2026',
]);

/** Global attempt cap (uses Redis in multi-instance prod; falls back to in-memory). */
const pinLimiter = createRateLimiter({
  windowMs: PIN_WINDOW_MS,
  max: 12,
  keyFn: (req) => `pin:${req.ip}:${req.user?.restaurant_id || ''}:${(req.body && req.body.staff_id) || 'x'}`,
});

/** Distributed lockout tracker for consecutive PIN failures (atomic Redis with in-memory fallback). */
const pinLockoutTracker = createLockoutTracker({
  namespace: 'epos_pin',
  windowMs: PIN_WINDOW_MS,
  maxFails: PIN_MAX_FAILS,
});

function rid(req) {
  return restaurantId(req);
}

function requireTillAdmin(req) {
  if (tillId(req)) throw forbidden('Till-bound sessions cannot manage the till registry');
}

/** Restaurant/super unbound sessions only — not till-bound EPOS cashiers. */
function requireRestaurantAdmin(req) {
  if (!['restaurant', 'super'].includes(req.user?.role) || tillId(req)) {
    throw forbidden('Requires restaurant admin session (not till-bound EPOS)');
  }
}

function assertValidPinFormat(pin) {
  const s = String(pin == null ? '' : pin);
  if (!/^\d{4,8}$/.test(s)) throw badRequest('PIN must be 4–8 digits');
  if (WEAK_PINS.has(s) || /^(.)\1+$/.test(s)) throw badRequest('PIN is too weak — choose a less predictable code');
  return s;
}

function pinFailKey(req) {
  const staff = (req.body && req.body.staff_id) || 'unknown';
  return `${req.ip || 'ip'}|${rid(req) || 'r'}|${staff}`;
}

async function assertPinUnlocked(req) {
  const key = pinFailKey(req);
  const status = await pinLockoutTracker.check(key);
  if (status.locked) {
    throw new AppError(`PIN locked — try again in ${status.remainingSeconds}s`, 429, 'PIN_LOCKED');
  }
}

async function recordPinFailure(req) {
  const key = pinFailKey(req);
  await pinLockoutTracker.recordFailure(key);
}

async function clearPinFailures(req) {
  const key = pinFailKey(req);
  await pinLockoutTracker.clear(key);
}

router.get('/tills', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  let rows = await crud.list(rid(req));
  const bound = tillId(req);
  if (bound) rows = rows.filter((t) => String(t.id) === String(bound));
  ok(res, rows);
}));

router.post('/tills', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  const body = { ...req.body, id: req.body.id || `till_${Date.now().toString(36)}` };
  created(res, await crud.create(body, rid(req)));
}));

async function upsertTill(req, res) {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing) throw notFound();
  const data = { ...(existing.data || {}), ...(req.body.data || {}) };
  ok(res, await crud.update(req.params.id, { ...req.body, data }, rid(req)));
}
router.patch('/tills/:id', asyncHandler(upsertTill));
router.put('/tills/:id', asyncHandler(upsertTill));

router.delete('/tills/:id', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const crud = buildCrud(pool, 'epos_tills', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] });
  ok(res, await crud.remove(req.params.id, rid(req)));
}));

router.post('/check-in', asyncHandler(async (req, res) => {
  const { till_id, staff_id, opening_float = 0 } = req.body || {};
  if (!till_id) throw badRequest('till_id required');
  assertTillAccess(req, till_id);
  const id = `ci_${Date.now().toString(36)}`;
  const { rows } = await pool.query(
    `INSERT INTO till_checkins (id, restaurant_id, till_id, staff_id, opening_float, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, rid(req), till_id, staff_id || null, opening_float, JSON.stringify({})],
  );
  await pool.query(
    `INSERT INTO report_counters (restaurant_id, period_start, opening_float, updated_at)
     VALUES ($1, CURRENT_DATE, $2, NOW())
     ON CONFLICT (restaurant_id) DO UPDATE SET opening_float = EXCLUDED.opening_float, updated_at = NOW()`,
    [rid(req), opening_float],
  );
  created(res, rows[0]);
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
  if (till_id) {
    params.push(till_id);
    sql += ` AND till_id = $${params.length}`;
  }
  if (open_only === '1' || open_only === 'true') sql += ' AND checked_out_at IS NULL';
  sql += ' ORDER BY checked_in_at DESC LIMIT 100';
  const { rows } = await pool.query(sql, params);
  ok(res, rows);
}));

router.get('/held-orders', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'held_orders', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const all = await crud.list(rid(req));
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
  const body = {
    ...req.body,
    id: req.body.id || `hold_${Date.now().toString(36)}`,
    till_id,
    label: req.body.label || null,
    payload: req.body.payload || req.body,
  };
  const existing = await crud.getById(body.id, rid(req));
  if (existing) {
    assertTillAccess(req, existing.till_id);
    ok(res, await crud.update(body.id, body, rid(req)));
  } else {
    created(res, await crud.create(body, rid(req)));
  }
}));

router.delete('/held-orders/:id', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'held_orders', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing) throw notFound();
  assertTillAccess(req, existing.till_id);
  ok(res, await crud.remove(req.params.id, rid(req)));
}));

function isApproverStaff(row) {
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return !!(data.can_approve || /manager|supervisor|owner|head\s*chef/i.test(row.role || ''));
}

router.post('/pin/verify', pinLimiter, asyncHandler(async (req, res) => {
  const { pin, staff_id, till_id: bodyTill } = req.body || {};
  if (!pin) throw badRequest('pin required');
  await assertPinUnlocked(req);
  // Format check only — do not apply weak-PIN policy on verify (legacy PINs may still exist)
  if (!/^\d{4,8}$/.test(String(pin))) {
    await recordPinFailure(req);
    throw unauthorized('Invalid PIN');
  }

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

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function parseAndValidateCalendarDate(input) {
  if (typeof input !== 'string') return null;
  const str = input.trim();
  // Match exact YYYY-MM-DD or standard ISO 8601 timestamp
  const isPureDate = /^\d{4}-\d{2}-\d{2}$/.test(str);
  const isIso = /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i.test(str);
  if (!isPureDate && !isIso) return null;

  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const daysInMonth = [31, (isLeapYear(y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > daysInMonth[m - 1]) return null;

  if (isIso) {
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return null;
  }

  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function normalizeDateString(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const m = val.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function reportStateFromRow(row) {
  const data = (row && row.data && typeof row.data === 'object') ? row.data : {};
  const canonicalDate = normalizeDateString(row?.period_start) || normalizeDateString(data.periodStart) || new Date().toISOString().slice(0, 10);
  const canonicalIso = (data.periodStart && normalizeDateString(data.periodStart) === canonicalDate)
    ? data.periodStart
    : `${canonicalDate}T00:00:00.000Z`;

  return {
    x_counter: row?.x_counter || 0,
    z_counter: row?.z_counter || 0,
    opening_float: Number(row?.opening_float) || 0,
    period_start: canonicalDate,
    xCounter: data.xCounter != null ? data.xCounter : (row?.x_counter || 0),
    zCounter: data.zCounter != null ? data.zCounter : (row?.z_counter || 1),
    periodStart: canonicalIso,
    openingFloat: data.openingFloat != null ? Number(data.openingFloat) : (Number(row?.opening_float) || 0),
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

router.get('/counts', asyncHandler(async (req, res) => {
  const row = await ensureReportRow(rid(req));
  ok(res, reportStateFromRow(row));
}));

/** Persist live report period state (cash movements, voids, floats, history). */
router.put('/report-state', asyncHandler(async (req, res) => {
  requireRestaurantAdmin(req);
  const r = rid(req);
  const curRow = await ensureReportRow(r);
  const curState = reportStateFromRow(curRow);
  const body = req.body || {};

  // Check if periodStart or period_start alias was provided
  const inputPeriodStart = body.periodStart !== undefined ? body.periodStart : body.period_start;
  let canonicalDate = null;
  let canonicalIso = null;

  if (inputPeriodStart !== undefined && inputPeriodStart !== null) {
    canonicalDate = parseAndValidateCalendarDate(inputPeriodStart);
    if (!canonicalDate) {
      throw badRequest(`Invalid periodStart "${inputPeriodStart}": expected valid calendar date (YYYY-MM-DD) or ISO timestamp`);
    }
    if (typeof inputPeriodStart === 'string' && inputPeriodStart.includes('T')) {
      canonicalIso = inputPeriodStart;
    } else {
      canonicalIso = `${canonicalDate}T00:00:00.000Z`;
    }
  } else {
    // Partial update: preserve existing reporting period date and ISO timestamp
    canonicalDate = curState.period_start;
    canonicalIso = curState.periodStart;
  }

  const data = {
    xCounter: body.xCounter != null ? body.xCounter : (body.x_counter != null ? body.x_counter : curState.xCounter),
    zCounter: body.zCounter != null ? body.zCounter : (body.z_counter != null ? body.z_counter : curState.zCounter),
    periodStart: canonicalIso,
    openingFloat: body.openingFloat != null ? Number(body.openingFloat) : (body.opening_float != null ? Number(body.opening_float) : curState.openingFloat),
    cashMovements: Array.isArray(body.cashMovements) ? body.cashMovements : curState.cashMovements,
    voids: Array.isArray(body.voids) ? body.voids : curState.voids,
    noSaleCount: body.noSaleCount != null ? body.noSaleCount : curState.noSaleCount,
    history: Array.isArray(body.history) ? body.history : curState.history,
    lastX: body.lastX !== undefined ? body.lastX : curState.lastX,
  };

  const { rows } = await pool.query(
    `UPDATE report_counters SET
       x_counter = $2, z_counter = $3, opening_float = $4,
       period_start = $5::date,
       data = $6::jsonb, updated_at = NOW()
     WHERE restaurant_id = $1 RETURNING *`,
    [
      r,
      data.xCounter,
      data.zCounter,
      data.openingFloat,
      canonicalDate,
      JSON.stringify(data),
    ],
  );
  ok(res, reportStateFromRow(rows[0]));
}));

router.post('/counts/x', asyncHandler(async (req, res) => {
  const r = rid(req);
  const row = await ensureReportRow(r);
  const state = reportStateFromRow(row);
  state.xCounter = (state.xCounter || 0) + 1;
  state.lastX = {
    x_no: state.xCounter,
    at: new Date().toISOString(),
    by: (req.body && req.body.by) || 'Manager',
  };
  const { rows } = await pool.query(
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
  ok(res, reportStateFromRow(rows[0]));
}));

router.post('/counts/z', asyncHandler(async (req, res) => {
  const r = rid(req);
  const body = req.body || {};
  if (body.till_id) assertTillAccess(req, body.till_id);
  else if (tillId(req)) {
    /* bound session may Z their own till without naming it */
  } else {
    requireRestaurantAdmin(req);
  }
  const row = await ensureReportRow(r);
  const state = reportStateFromRow(row);
  const entry = body.entry || {
    z_no: state.zCounter,
    from: body.from,
    to: body.to || new Date().toISOString(),
    generated_at: new Date().toISOString(),
    by: body.by || 'Manager',
    terminal: body.terminal || 'Terminal 1',
    till_id: body.till_id || tillId(req) || null,
    counted_cash: body.counted_cash,
    variance: body.variance,
    report: body.report || null,
  };
  state.history = (state.history || []).concat([entry]);
  state.zCounter = (state.zCounter || 1) + 1;
  state.periodStart = new Date().toISOString();
  state.cashMovements = [];
  state.voids = [];
  state.noSaleCount = 0;
  if (body.opening_float != null) state.openingFloat = Number(body.opening_float) || 0;

  try {
    await pool.query(
      `INSERT INTO z_reports (id, restaurant_id, till_id, z_no, report, counted_cash, variance, generated_at, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        body.id || `z_${r}_${entry.z_no}_${Date.now().toString(36)}`,
        r,
        body.till_id || null,
        entry.z_no,
        JSON.stringify(entry.report || entry),
        entry.counted_cash != null ? entry.counted_cash : null,
        entry.variance != null ? entry.variance : null,
        entry.generated_at || new Date().toISOString(),
        entry.by || null,
      ],
    );
  } catch (_) {
    /* z_reports table optional until migrated */
  }

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  state.periodStart = nowIso;

  const { rows } = await pool.query(
    `UPDATE report_counters SET z_counter = $2, opening_float = $3, period_start = $5::date,
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
    }), todayDate],
  );
  ok(res, { ...reportStateFromRow(rows[0]), entry });
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
    sql += ' AND (branch_id IS NULL OR branch_id = $2)';
  }
  sql += ' ORDER BY name';
  const { rows } = await pool.query(sql, params);
  ok(res, rows.map(mapStaff));
}));

router.post('/staff', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const { name, pin, role = 'cashier', till_id, can_approve, color, tills, active = true } = req.body || {};
  if (!name || !pin) throw badRequest('name and pin required');
  const pinNorm = assertValidPinFormat(pin);
  const id = req.body.id || `ts_${Date.now().toString(36)}`;
  const pin_hash = await bcrypt.hash(pinNorm, 10);
  const data = {
    can_approve: !!can_approve || /manager|supervisor/i.test(role),
    color: color || '#0b84f3',
    tills: tills || (till_id ? [till_id] : []),
  };
  const bound = branchId(req);
  const staffBranch = bound || req.body.branch_id || null;
  if (bound) assertBranchAccess(req, staffBranch, { allowShared: true });
  const { rows } = await pool.query(
    `INSERT INTO till_staff (id, restaurant_id, name, pin_hash, role, till_id, branch_id, status, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, pin_hash=EXCLUDED.pin_hash, role=EXCLUDED.role,
       till_id=EXCLUDED.till_id, branch_id=EXCLUDED.branch_id, status=EXCLUDED.status, data=EXCLUDED.data, updated_at=NOW()
     RETURNING id, restaurant_id, name, role, till_id, branch_id, status, data, pin_hash`,
    [id, rid(req), name, pin_hash, role, till_id || null, staffBranch, active !== false, JSON.stringify(data)],
  );
  created(res, mapStaff(rows[0]));
}));

router.patch('/staff/:id', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const { rows: existing } = await pool.query(
    'SELECT * FROM till_staff WHERE id = $1 AND restaurant_id = $2',
    [req.params.id, rid(req)],
  );
  if (!existing[0]) throw notFound();
  const cur = existing[0];
  const body = req.body || {};
  const data = { ...(cur.data || {}), ...(body.data || {}) };
  if (body.can_approve !== undefined) data.can_approve = body.can_approve;
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
  ok(res, mapStaff(rows[0]));
}));

router.delete('/staff/:id', asyncHandler(async (req, res) => {
  requireTillAdmin(req);
  const { rowCount } = await pool.query('DELETE FROM till_staff WHERE id = $1 AND restaurant_id = $2', [
    req.params.id,
    rid(req),
  ]);
  if (!rowCount) throw notFound();
  ok(res, { deleted: true });
}));

/**
 * Canonical schema provisioning handled by Migration 009 (CD-CON-058).
 * Retained as no-op to preserve function signature for callers.
 */
async function ensureTimeclockTables() {
  return;
}
function readyTimeclock() {
  return Promise.resolve();
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
    clockSql += ' AND (branch_id IS NULL OR branch_id = $2)';
  }
  const { rows } = await pool.query(clockSql, clockParams);
  const eventParams = [r];
  let eventSql = `SELECT id, staff_id, event, at, branch_id, data FROM staff_timeclock_events
     WHERE restaurant_id = $1 AND at >= NOW() - INTERVAL '24 hours'`;
  if (bound) {
    eventParams.push(bound);
    eventSql += ' AND (branch_id IS NULL OR branch_id = $2)';
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
    `INSERT INTO approval_requests (id, restaurant_id, app, action, status, payload, at, created_at, updated_at)
     VALUES ($1,$2,'epos','pin_reset','pending',$3::jsonb,NOW(),NOW(),NOW())
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
