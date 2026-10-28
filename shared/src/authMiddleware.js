const { verify } = require('./jwt');
const { unauthorized, forbidden, badRequest } = require('./errors');

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
    return next();
  } catch (e) {
    if (e && e.status === 401) return next(e);
    return next(unauthorized('Invalid or expired token'));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Invalid role'));
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
    return fromQuery || req.user.restaurant_id || null;
  }
  if (req.user?.restaurant_id) {
    return req.user.restaurant_id;
  }
  // Public storefront / edge requests validated via X-API-KEY set x-restaurant-id downstream
  if (req.headers && req.headers['x-restaurant-id']) {
    return req.headers['x-restaurant-id'];
  }
  throw badRequest('restaurant_id missing from session');
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

module.exports = {
  optionalAuth,
  requireAuth,
  requireRole,
  restaurantId,
  restaurantIdOrNull,
  tillId,
  assertTillAccess,
  branchId,
  assertBranchAccess,
  requireRestaurantScope,
};
