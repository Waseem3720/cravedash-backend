/**
 * Branch service guard. A restaurant login bound to a branch (role 'restaurant' with branch_id) may only reach API
 * routes whose service key is in its effective branch access:
 *   effective = restaurant.services ∩ branch.services (the branch's own list, when it has one)
 * Differences from frontend/src/lib/branchAccess.js: a restaurant with no services list does not lift a branch's own
 * list, so the branch list is the limit then; and a restaurant row that cannot be found grants nothing.
 * Callers without a branch_id (restaurant owner, super, impersonation without branch) are not affected.
 * Paths not listed in BRANCH_SERVICE_ROUTES are not guarded.
 */
const pool = require('./db');
const { forbidden } = require('./errors');

/** [path prefix, service keys]. The caller needs ANY one of the keys. Whole path segments, case-insensitive. */
const BRANCH_SERVICE_ROUTES = [
  ['/api/v1/orders', ['orders-all', 'pos-orders', 'table-orders-all', 'orders-online']],
  ['/api/v1/products', ['products', 'product-add']],
  ['/api/v1/categories', ['category']],
  ['/api/v1/subcategories', ['sub-category']],
  ['/api/v1/cuisines', ['cuisine']],
  ['/api/v1/addons', ['addon']],
  ['/api/v1/epos/tills', ['epos-devices']],
  ['/api/v1/employees', ['employee-list', 'employee-add']],
  ['/api/v1/chefs', ['chef-list', 'chef-add']],
  ['/api/v1/deliverymen', ['dm-list', 'dm-add']],
  ['/api/v1/coupons', ['coupons']],
  ['/api/v1/customers', ['customers']],
  ['/api/v1/bookings', ['book-table']],
  ['/api/v1/reports/x', ['x-report']],
  ['/api/v1/reports/z', ['z-report']],
  ['/api/v1/reports/orders', ['order-report']],
  ['/api/v1/reports/earnings', ['earning-report']],
  ['/api/v1/reports/products', ['product-report']],
  ['/api/v1/reports/sales', ['sale-report']],
];

/** Service keys that guard this request path, or null when the path is not mapped (longest prefix wins). */
function guardedServiceKeys(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
  let best = null;
  for (const [prefix, keys] of BRANCH_SERVICE_ROUTES) {
    const hit = path === prefix || path.startsWith(prefix + '/');
    if (hit && (!best || prefix.length > best.prefix.length)) best = { prefix, keys };
  }
  return best ? best.keys : null;
}

/**
 * Effective service keys for a branch login, or null when there is no restriction.
 * @param {object} restaurantData restaurants.data
 * @param {string} branchId the branch_id claim
 */
function effectiveBranchServices(restaurantData, branchId) {
  const data = restaurantData && typeof restaurantData === 'object' ? restaurantData : {};
  const own = Array.isArray(data.services) ? data.services.map(String) : null;
  const branches = Array.isArray(data.branch_list) ? data.branch_list : [];
  const branch = branches.find((b) => b && String(b.id) === String(branchId));
  const mine = branch && Array.isArray(branch.services) ? branch.services.map(String) : null;
  if (!mine) return own;
  if (!own) return mine;
  return own.filter((k) => mine.includes(k));
}

/** Loads the effective list once per request (cached on req). */
async function branchServicesFor(req) {
  if (req.branchServices === undefined) {
    const { rows } = await pool.query('SELECT data FROM restaurants WHERE id = $1', [req.user.restaurant_id || null]);
    req.branchServices = rows[0] ? effectiveBranchServices(rows[0].data, req.user.branch_id) : [];
  }
  return req.branchServices;
}

/**
 * Router-level middleware built from a function that returns the service keys guarding this request (or null).
 * Place it after requireAuth (req.user must be set).
 */
function branchServiceGate(keysOf) {
  return function gate(req, res, next) {
    const keys = keysOf(req);
    if (!keys) return next();
    if (req.user?.role !== 'restaurant' || !req.user.branch_id) return next();
    return branchServicesFor(req).then((allowed) => {
      if (allowed === null || keys.some((k) => allowed.includes(k))) return next();
      return next(forbidden('This service is not enabled for this branch'));
    }, next);
  };
}

const requireBranchService = branchServiceGate(guardedServiceKeys);

module.exports = {
  BRANCH_SERVICE_ROUTES,
  guardedServiceKeys,
  effectiveBranchServices,
  branchServiceGate,
  requireBranchService,
};
