const { verify } = require('./jwt');
const { unauthorized, forbidden, badRequest } = require('./errors');
const { isAccountActive } = require('./accountStatus');
const { applyBranchContext } = require('./branchContext');

/** MFA pending tickets and EPOS staff JWTs must not authenticate as a full session. */
function assertFullSession(claims) {
  if (!claims || typeof claims !== 'object') {
    throw unauthorized('Invalid or expired token');
  }
  // Phase D.1: mfa_pending is only valid on POST /auth/mfa/verify (body), never as Bearer
  if (claims.mfa_pending) {
    throw unauthorized('MFA required — complete TOTP before using the API');
  }
  if (claims.typ === 'epos_staff') {
    throw unauthorized('EPOS staff token is not a login session');
  }
  return claims;
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    req.user = assertFullSession(verify(token));
  } catch {
    /* ignore invalid / pending token at optional edge */
    req.user = undefined;
  }
  next();
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Missing token'));
  try {
    req.user = assertFullSession(verify(token));
  } catch (e) {
    if (e && e.status === 401) return next(e);
    return next(unauthorized('Invalid or expired token'));
  }
  // Customer tokens (from the OAuth customer login) are not staff sessions. No customer-facing route exists yet,
  // so the staff APIs refuse them (SEC-C3). Add a customer-only guard when those routes are built.
  if (req.user.role === 'customer') return next(forbidden('Customer accounts cannot use staff APIs'));
  // A signed token is not enough: the account must still exist, be active and keep the same role (SEC-H4).
  isAccountActive(req.user).then(async (active) => {
    if (!active) return next(unauthorized('Account is disabled or its role changed. Please sign in again.'));
    try {
      await applyBranchContext(req);
    } catch (err) {
      return next(err);
    }
    return next();
  });
  return undefined;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(unauthorized('Invalid role'));
    next();
  };
}

/**
 * Resolve tenant restaurant id.
 * - super: may override via query/header (explicit impersonation / admin tools)
 * - restaurant/epos: JWT restaurant_id only — never trust client headers
 */
function restaurantId(req) {
  if (req.user?.role === 'super') {
    const fromQuery = req.query.restaurant_id || req.headers['x-restaurant-id'];
    const id = fromQuery || req.user.restaurant_id;
    if (!id) throw badRequest('restaurant_id required (send x-restaurant-id)');
    return id;
  }
  if (!req.user?.restaurant_id) {
    throw badRequest('restaurant_id missing from session');
  }
  return req.user.restaurant_id;
}

/** Safe wrapper that returns null instead of throwing (for optional list scopes). */
function restaurantIdOrNull(req) {
  try {
    return restaurantId(req);
  } catch {
    return null;
  }
}

/**
 * Till / branch-panel scope from JWT.
 * - epos (or any role) with till_id claim: locked to that till
 * - restaurant/super without till_id: null = all tills in the restaurant
 * Client query/body till_id must never widen this scope.
 */
function tillId(req) {
  const claimed = req.user?.till_id || null;
  if (!claimed) return null;
  if (req.user?.role === 'super' && !req.user?.impersonating) return null;
  return claimed;
}

function assertTillAccess(req, candidateTillId) {
  const bound = tillId(req);
  if (!bound) return;
  if (!candidateTillId || String(candidateTillId) !== String(bound)) {
    throw forbidden('Till out of scope for this session');
  }
}

/**
 * Branch ACL from JWT (Phase 4).
 * - epos/staff with branch_id: locked to that branch
 * - restaurant/super without branch_id: null = all branches
 */
function branchId(req) {
  const claimed = req.user?.branch_id || null;
  if (!claimed) return null; // restaurant owner / unbound = all branches
  if (req.user?.role === 'super' && !req.user?.impersonating) return null;
  // Phase C: any non-super JWT with branch_id is branch-scoped (incl. restaurant managers)
  return claimed;
}

/**
 * @param {{ allowShared?: boolean }} [opts] — if allowShared, null/empty candidate is HQ-shared (visible to all branches).
 */
function assertBranchAccess(req, candidateBranchId, opts = {}) {
  const bound = branchId(req);
  if (!bound) return;
  if (opts.allowShared && (candidateBranchId == null || candidateBranchId === '')) return;
  if (!candidateBranchId || String(candidateBranchId) !== String(bound)) {
    throw forbidden('Branch out of scope for this session');
  }
}

/**
 * Row scope for branch-owned tenant data (a row's branch_id: NULL means restaurant-level).
 * - branch login: its own branch's rows only.
 * - restaurant owner, or an EPOS session with no branch: restaurant-level rows only (never another branch's rows).
 * - super admin: every row.
 */
function branchScopeFilter(req) {
  const bound = branchId(req);
  if (bound) return { branch_id: bound };
  if (req.user?.role === 'super') return {};
  return { $null: ['branch_id'] };
}

/** True when a row with this branch_id is inside the caller's scope (see branchScopeFilter). */
function rowInBranchScope(req, rowBranchId) {
  const bound = branchId(req);
  if (bound) return rowBranchId !== null && rowBranchId !== undefined && String(rowBranchId) === String(bound);
  if (req.user?.role === 'super') return true;
  return rowBranchId === null || rowBranchId === undefined || rowBranchId === '';
}

function requireRestaurantScope(req, res, next) {
  try {
    const rid = restaurantId(req);
    if (!rid && req.user?.role !== 'super') return next(forbidden('No restaurant scope'));
    req.restaurantId = rid;
    return next();
  } catch (e) {
    return next(e);
  }
}


/**
 * Customer-only guard for customer-facing routes (the OAuth customer login). Staff tokens are refused here, and
 * customer tokens are refused by requireAuth, so the two can never be mixed up. The customer row is checked by the route.
 */
function requireCustomer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Missing token'));
  let claims;
  try {
    claims = verify(token);
  } catch (e) {
    return next(unauthorized('Invalid or expired token'));
  }
  if (claims.role !== 'customer' || !claims.sub || !claims.restaurant_id) return next(forbidden('Customer sign-in required'));
  req.customer = { id: String(claims.sub), restaurant_id: String(claims.restaurant_id), name: claims.name || null };
  next();
}

module.exports = {
  optionalAuth,
  requireCustomer,
  requireAuth,
  requireRole,
  restaurantId,
  restaurantIdOrNull,
  tillId,
  assertTillAccess,
  branchId,
  assertBranchAccess,
  branchScopeFilter,
  rowInBranchScope,
  requireRestaurantScope,
};
