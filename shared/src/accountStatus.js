/**
 * Live account check for bearer tokens (SEC-H4). A token is signed once, so a deactivated account or a changed role
 * would otherwise keep working until the token expires. Each request checks the account in the database.
 *
 * Rules (the same ones login uses):
 *   - super, restaurant, epos: users.status must be TRUE, and users.role must equal the role in the token.
 *   - chef: chefs.status must not be false.   driver: deliverymen.status must be 'active'.
 *   - Any account that is missing, inactive or has a different role is refused.
 *
 * Results are cached for ACCOUNT_STATUS_CACHE_MS (default 30000). A deactivation therefore applies within that window.
 * Set ACCOUNT_STATUS_CACHE_MS=0 to check on every request.
 */
const pool = require('./db');

const STAFF_TABLES = { chef: 'chefs', driver: 'deliverymen' };
const CACHE_MS = Number.isFinite(+process.env.ACCOUNT_STATUS_CACHE_MS)
  ? +process.env.ACCOUNT_STATUS_CACHE_MS
  : 30000;
const cache = new Map();

/**
 * Current state of an account: `ok` (active, same role) and `tokenVersion` (users.token_version, or 0 when the
 * account has no users row). Staff roles are also checked in their own table.
 */
async function loadAccount(sub, role) {
  const { rows: userRows } = await pool.query('SELECT role, status, token_version FROM users WHERE id = $1', [sub]);
  const user = userRows[0] || null;
  const tokenVersion = user ? Number(user.token_version) : 0;

  if (STAFF_TABLES[role]) {
    const { rows } = await pool.query(`SELECT status FROM ${STAFF_TABLES[role]} WHERE id = $1`, [sub]);
    const row = rows[0];
    if (!row) return { ok: false, tokenVersion };
    const active = role === 'chef' ? row.status !== false : String(row.status).toLowerCase() === 'active';
    if (!active) return { ok: false, tokenVersion };
    if (user && (user.status !== true || user.role !== role)) return { ok: false, tokenVersion };
    return { ok: true, tokenVersion };
  }
  if (!user || user.status !== true || user.role !== role) return { ok: false, tokenVersion };
  return { ok: true, tokenVersion };
}

/**
 * Checks the account behind a bearer token. A token must still match the account's current token version.
 * An impersonation token belongs to the super admin who issued it, so that super account is checked instead.
 */
async function checkClaims(claims) {
  if (claims.impersonating) {
    const acct = await loadAccount(String(claims.impersonator_id || ''), 'super');
    return acct.ok && (claims.tv == null ? 0 : Number(claims.tv)) === acct.tokenVersion;
  }
  const acct = await loadAccount(String(claims.sub), claims.role);
  return acct.ok && (claims.tv == null ? 0 : Number(claims.tv)) === acct.tokenVersion;
}

/** Resolves to true when the account in the token is still active and the token is not stale. Fails closed on error. */
async function isAccountActive(claims) {
  if (!claims || !claims.sub || !claims.role) return false;
  const key = `${claims.role}:${claims.sub}:${claims.impersonating ? 'imp' : ''}:${claims.tv == null ? 0 : claims.tv}`;
  const now = Date.now();
  if (CACHE_MS > 0) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.active;
  }
  let active;
  try {
    active = await checkClaims(claims);
  } catch (err) {
    console.error('[auth] account status check failed:', err.message);
    return false;
  }
  if (CACHE_MS > 0) cache.set(key, { active, at: now });
  return active;
}

/** Forget cached results for an account, for example right after it is changed. */
function forgetAccount(sub, role) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${role}:${sub}:`)) cache.delete(key);
  }
}

module.exports = { isAccountActive, forgetAccount };
