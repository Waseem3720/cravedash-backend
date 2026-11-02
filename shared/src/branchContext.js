/**
 * Branch context for a restaurant admin: "view as branch X" without a new login.
 *
 * The client sends X-Branch-Context: <branch id>. On every authenticated request the server checks that
 *  - the caller is a restaurant admin (not a branch login, not EPOS, not a customer),
 *  - the branch belongs to the caller's own restaurant (the id is never trusted from the client alone),
 * and then the request is scoped as that branch. The caller's identity, role and restaurant do not change.
 *
 * While a branch is being viewed, these are refused and recorded in the security audit:
 *  - any DELETE;
 *  - money and payout routes (refunds, wallet, loyalty, payouts, rider pay and cash, payroll, accounting, bonuses);
 *  - order changes that touch payment or reverse a sale (payment fields, refund amounts, cancel, return, reject).
 * Reads (GET) are allowed, so the admin can inspect the branch.
 */
const pool = require('./db');
const { badRequest, forbidden } = require('./errors');
const { isRestaurantBranch } = require('./branches');

const HEADER = 'x-branch-context';
const BRANCH_RE = /^[A-Za-z0-9_.-]{1,120}$/;

// Matched against the lower-cased path: Express routes are case-insensitive, so "/Engines/Wallet" must be blocked too.
const MONEY_PREFIXES = [
  '/engines/wallet', '/engines/loyalty', '/engines/terminals', '/engines/payroll', '/engines/accounting', '/engines/tips',
  '/commerce', '/domain/commerce', '/payouts', '/payroll', '/accounting',
  '/stripe/refunds', '/stripe/payments', '/stripe/payouts', '/stripe/connect',
  '/drivers', '/refund', '/refunds', '/refund-requests', '/invoices', '/subscriptions', '/billing',
];
const APPROVAL_RESOLVE_RE = /^\/approvals\/[^/]+\/resolve(\/|$)/;
const ORDER_MONEY_FIELDS = ['payment_status', 'payment_method', 'refund_amount', 'refunds', 'tip', 'total', 'discount'];
const ORDER_REVERSAL_STATUSES = ['canceled', 'returned', 'failed_to_deliver'];

/**
 * The path below /api/v1, from the full URL. A service mounts its routers at different prefixes (the order service at
 * /api/v1/orders), so req.path alone is relative to that mount and would miss the rules.
 */
function requestPath(req) {
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  return full.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
}

/** Returns a reason when the request would move money or reverse a sale, otherwise null. */
function blockedReason(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.method === 'DELETE') return 'Deleting is not allowed while viewing a branch';
  const path = requestPath(req).toLowerCase();
  if (MONEY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return 'Money and payout actions are not allowed while viewing a branch';
  if (APPROVAL_RESOLVE_RE.test(path)) return 'Resolving approvals is not allowed while viewing a branch';
  if (/^\/orders\/[^/]+\/(refund|return|reject|cancel)(\/|$)/.test(path)) return 'Refunds, returns, cancels and rejects are not allowed while viewing a branch';
  if (/^\/orders(\/|$)/.test(path)) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    if (ORDER_MONEY_FIELDS.some((f) => body[f] !== undefined) || ORDER_MONEY_FIELDS.some((f) => data[f] !== undefined)) {
      return 'Changing an order payment or total is not allowed while viewing a branch';
    }
    if (ORDER_REVERSAL_STATUSES.includes(body.status) || ORDER_REVERSAL_STATUSES.includes(body.next_status)) {
      return 'Cancelling or returning an order is not allowed while viewing a branch';
    }
  }
  return null;
}

async function auditBlocked(req, reason) {
  await pool.query(
    'INSERT INTO security_audit (restaurant_id, actor, actor_role, event, subject, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [req.user.restaurant_id, req.user.name || req.user.email || req.user.sub, req.user.role, 'branch_context.blocked', req.user.sub,
      JSON.stringify({ method: req.method, path: requestPath(req), branch_id: req.user.branch_id, reason })],
  ).catch((err) => console.error('[branch-context] audit write failed', err));
}

async function applyBranchContext(req) {
  const raw = req.headers && req.headers[HEADER];
  if (raw === undefined || raw === null || raw === '') return;
  if (!req.user || req.user.role !== 'restaurant') throw forbidden('Branch context is for restaurant admin accounts only');
  if (req.user.branch_id) throw forbidden('A branch login cannot change its branch context');
  const branch = String(raw).trim();
  if (!BRANCH_RE.test(branch)) throw badRequest('Invalid branch context');
  if (!req.user.restaurant_id || !(await isRestaurantBranch(pool, req.user.restaurant_id, branch))) {
    throw forbidden('That branch is not part of your restaurant');
  }
  req.user = { ...req.user, branch_id: branch, branch_context: { branch_id: branch, owner_sub: req.user.sub } };
  const reason = blockedReason(req);
  if (reason) {
    await auditBlocked(req, reason);
    throw forbidden(reason);
  }
}

module.exports = { applyBranchContext, blockedReason, BRANCH_CONTEXT_HEADER: HEADER };
