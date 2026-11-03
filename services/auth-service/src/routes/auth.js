const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const {
  sign,
  signImpersonation,
  signMfaPending,
  verify,
  readCookie,
  SESSION_COOKIE,
  RESTORE_COOKIE,
} = require('@cravedash/shared/src/jwt');
const { verifyAppleIdToken, fetchAppleKeys } = require('@cravedash/shared/src/identityTokens');
const { ok, fail } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { AppError, badRequest, unauthorized, forbidden } = require('@cravedash/shared/src/errors');
const { requireAuth, requireRole, requireCustomer, assertBranchAccess } = require('@cravedash/shared/src/authMiddleware');
const { forgetAccount } = require('@cravedash/shared/src/accountStatus');
const { createRateLimiter } = require('@cravedash/shared/src/rateLimit');
const { encryptSecret, decryptSecret, decryptKeysObject, isEncrypted } = require('@cravedash/shared/src/secretsCrypto');
const {
  generateSecret,
  otpauthUrl,
  matchTotpStep,
  claimTotpStep,
  hashBackupCodeSecure,
  matchBackupCode,
  generateBackupCodes,
  hasLegacyBackupEntries,
} = require('@cravedash/shared/src/mfa');

const router = express.Router();
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyFn: (req) => `${req.ip}:${String((req.body && req.body.email) || '').toLowerCase()}`,
});

/**
 * Staff login roles and the table that holds their record. users.id equals that row's id, so a login
 * stays linked to the chef or deliveryman it was created for.
 */
const STAFF_TABLES = { chef: 'chefs', driver: 'deliverymen', rider: 'deliverymen' };
const ACCOUNT_ROLES = ['super', 'restaurant', 'epos', 'rider', ...Object.keys(STAFF_TABLES)];

/** A chef or driver can sign in only while their record is active. Status is edited on the staff page. */
async function staffIsActive(user) {
  const table = STAFF_TABLES[user.role];
  if (!table) return true;
  const { rows } = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [user.id]);
  const row = rows[0];
  if (!row) return false;
  return user.role === 'chef' ? row.status !== false : String(row.status).toLowerCase() === 'active';
}

/** Confirms the chef or driver record exists in the restaurant before an account is linked to it. */
async function assertStaffRecord(role, staffId, restaurantId) {
  if (!staffId) throw badRequest('staff_id is required for chef and driver accounts');
  const { rows } = await pool.query(`SELECT restaurant_id FROM ${STAFF_TABLES[role]} WHERE id = $1`, [staffId]);
  if (!rows[0] || rows[0].restaurant_id !== restaurantId) {
    throw badRequest('Staff record not found for this restaurant');
  }
}

/* ---------- Browser session cookies (FE-H2) ---------- */

const SESSION_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

function bearerOf(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** httpOnly so page scripts cannot read the token; Secure in production; SameSite=Lax blocks cross-site POSTs. */
function cookieOptions(path) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path,
  };
}

/** Sets the session cookie to the token, lasting as long as the token itself. */
function setSessionCookie(res, token) {
  let maxAge = SESSION_FALLBACK_MS;
  try {
    const claims = verify(token);
    if (claims.exp) maxAge = Math.max(0, claims.exp * 1000 - Date.now());
  } catch {
    /* keep the fallback; the token is verified again on every request */
  }
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions('/api/v1'), maxAge });
}

function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions('/api/v1'));
  res.clearCookie(RESTORE_COOKIE, cookieOptions('/api/v1/auth'));
}

/* ---------- Login ---------- */

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password, role: requestedRole, scope } = req.body || {};
  if (!email || !password) throw badRequest('email and password are required');
  // Riders (deliveryman app) may send role "rider", "driver", or no role at all. Their accounts in DB have role "rider".
  const isRiderLookup = requestedRole === 'rider' || requestedRole === 'driver';
  let role = requestedRole;
  if (!role) {
    const { rows: couriers } = await pool.query(
      "SELECT role FROM users WHERE LOWER(email) = LOWER($1) AND role IN ('rider', 'driver') AND status = TRUE LIMIT 1",
      [email],
    );
    if (!couriers[0]) throw badRequest('role is required');
    role = couriers[0].role;
  }
  if (!ACCOUNT_ROLES.includes(role)) throw badRequest('Invalid role');
  // scope: 'branch' (Branch login link) or 'restaurant' (Restaurant login link). Each link only signs in its own accounts.
  if (scope !== undefined && scope !== 'branch' && scope !== 'restaurant') throw badRequest('Invalid scope');

  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND (role = $2 OR ($3 = TRUE AND role IN (\'rider\', \'driver\'))) AND status = TRUE LIMIT 1',
    [email, role, isRiderLookup],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw unauthorized('Invalid credentials');
  }
  if (scope === 'branch' && role === 'restaurant' && !user.branch_id) {
    throw unauthorized('This account signs in through the Restaurant login');
  }
  if (scope === 'restaurant' && role === 'restaurant' && user.branch_id) {
    throw unauthorized('This account signs in through the Branch login');
  }
  if (!(await staffIsActive(user))) throw unauthorized('Invalid credentials');

  // Super MFA: password OK → pending ticket until TOTP verified
  if (user.role === 'super' && user.mfa_enabled && user.mfa_secret) {
    const mfa_token = signMfaPending({
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });
    ok(res, {
      mfa_required: true,
      mfa_token,
      user: { id: user.id, email: user.email, role: user.role, name: user.name, mfa_required: true },
    });
    return;
  }

  await pool.query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);

  // Delivery rider accounts use role 'driver' in session tokens for the deliveryman app
  const sessionRole = (user.role === 'rider' || isRiderLookup) ? 'driver' : user.role;

  const token = sign({
    sub: user.id,
    email: user.email,
    role: sessionRole,
    name: user.name,
    restaurant_id: user.restaurant_id,
    till_id: user.till_id,
    branch_id: user.branch_id || null,
    tv: user.token_version ?? 0,
    mfa_ok: user.role === 'super' ? !user.mfa_enabled : undefined,
  });
  setSessionCookie(res, token);

  ok(res, {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: sessionRole,
      name: user.name,
      restaurant_id: user.restaurant_id,
      till_id: user.till_id,
      branch_id: user.branch_id || null,
      mfa_enabled: !!user.mfa_enabled,
    },
  });
}));

/* ---------- MFA (super admin) ---------- */

/** The account a pending MFA ticket belongs to, or null when the ticket is missing or not a pending ticket. */
function pendingSubject(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const claims = verify(token);
    return claims.mfa_pending ? String(claims.sub) : null;
  } catch {
    return null;
  }
}

/**
 * SEC-M3: the budget belongs to the account, not to one login. A fresh mfa_token per password check used to reset
 * it. Requests that cannot name an account share one bucket per IP.
 */
function mfaSubject(req) {
  if (req.user && req.user.sub) return String(req.user.sub);
  const pending = pendingSubject(req.body && req.body.mfa_token);
  return pending || `anon:${req.ip}`;
}

const MFA_WINDOW_MS = 15 * 60 * 1000;
const mfaSubjectLimiter = createRateLimiter({
  windowMs: MFA_WINDOW_MS,
  max: 20,
  keyFn: (req) => `mfa-sub:${mfaSubject(req)}`,
});
const mfaIpLimiter = createRateLimiter({
  windowMs: MFA_WINDOW_MS,
  max: 60,
  keyFn: (req) => `mfa-ip:${req.ip}`,
});
const mfaLimiters = [mfaSubjectLimiter, mfaIpLimiter];

function sessionPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    restaurant_id: user.restaurant_id,
    till_id: user.till_id,
    branch_id: user.branch_id || null,
    tv: user.token_version ?? 0,
    mfa_ok: true,
  };
}

/**
 * Rewrites a legacy plain-text MFA secret as encrypted once it has been used successfully (SEC-M5).
 * The WHERE clause keeps a concurrent change from being overwritten.
 */
async function upgradeMfaSecret(userId, stored, plain) {
  if (isEncrypted(stored)) return;
  await pool.query(
    'UPDATE users SET mfa_secret = $2 WHERE id = $1 AND mfa_secret = $3',
    [userId, encryptSecret(plain), stored],
  );
}

/** TOTP check for an account: the code must match and its time step must not have been used before. */
async function acceptTotp(user, code) {
  const plain = decryptSecret(user.mfa_secret);
  const step = matchTotpStep(plain, code);
  if (step === null) return false;
  if (!claimTotpStep(user.id, step)) return false;
  await upgradeMfaSecret(user.id, user.mfa_secret, plain);
  return true;
}

/** Complete super login with TOTP / backup code. */
router.post('/mfa/verify', ...mfaLimiters, asyncHandler(async (req, res) => {
  const { mfa_token, code } = req.body || {};
  if (!mfa_token || !code) throw badRequest('mfa_token and code required');
  let pending;
  try {
    pending = verify(mfa_token);
  } catch {
    throw unauthorized('MFA session expired — sign in again');
  }
  if (!pending.mfa_pending || pending.role !== 'super') throw unauthorized('Invalid MFA session');
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND role = $2 AND status = TRUE LIMIT 1',
    [pending.sub, 'super'],
  );
  const user = rows[0];
  if (!user || !user.mfa_enabled || !user.mfa_secret) throw unauthorized('MFA not enabled');

  // A 6-digit code is a TOTP attempt (a replayed code is refused). Any other code is tried as a backup code.
  let okCode = false;
  let usedBackup = false;
  if (matchTotpStep(decryptSecret(user.mfa_secret), code) !== null) {
    okCode = await acceptTotp(user, code);
  } else {
    const backups = Array.isArray(user.mfa_backup_codes) ? user.mfa_backup_codes : [];
    const idx = await matchBackupCode(code, backups, { acceptLegacy: legacyBackupCodesAccepted() });
    if (idx >= 0) {
      okCode = true;
      usedBackup = true;
      const next = backups.filter((_, i) => i !== idx);
      await pool.query('UPDATE users SET mfa_backup_codes = $2::jsonb, updated_at = NOW() WHERE id = $1', [
        user.id,
        JSON.stringify(next),
      ]);
    }
  }
  if (!okCode) throw unauthorized('Invalid authentication code');

  await pool.query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  const token = sign(sessionPayload(user));
  setSessionCookie(res, token);
  ok(res, {
    token,
    used_backup: usedBackup,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      restaurant_id: user.restaurant_id,
      mfa_enabled: true,
    },
  });
}));

/** Start MFA enrollment (super only) — returns secret + otpauth URL. */
router.post('/mfa/enroll', requireAuth, requireRole('super'), asyncHandler(async (req, res) => {
  if (req.user.impersonating) throw forbidden('Cannot enroll MFA while impersonating');
  // P1: enrolling replaces the secret and drops MFA to disabled. While MFA is on, only /mfa/disable (current code + password) may change it.
  const { rows: current } = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [req.user.sub]);
  if (current[0]?.mfa_enabled) throw new AppError('MFA is already enabled. Disable it with a current code and password first.', 409, 'CONFLICT');
  const secret = generateSecret();
  await pool.query(
    `UPDATE users SET mfa_secret = $2, mfa_enabled = FALSE, updated_at = NOW() WHERE id = $1`,
    [req.user.sub, encryptSecret(secret)],
  );
  ok(res, {
    secret,
    otpauth_url: otpauthUrl({ secret, email: req.user.email || 'super' }),
    message: 'Scan with an authenticator app, then confirm with a 6-digit code.',
  });
}));

/** Confirm enrollment with first TOTP code → enable MFA + backup codes. */
router.post('/mfa/confirm', requireAuth, requireRole('super'), ...mfaLimiters, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (!code) throw badRequest('code required');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !user.mfa_secret) throw badRequest('Call /mfa/enroll first');
  if (!(await acceptTotp(user, code))) throw unauthorized('Invalid code — try again');
  const backups = generateBackupCodes(8);
  const hashed = await Promise.all(backups.map((c) => hashBackupCodeSecure(c)));
  await pool.query(
    `UPDATE users SET mfa_enabled = TRUE, mfa_backup_codes = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [user.id, JSON.stringify(hashed)],
  );
  ok(res, {
    enabled: true,
    backup_codes: backups,
    message: 'MFA enabled. Store backup codes offline — they are shown once.',
  });
}));

/** Disable MFA (requires current TOTP + password). */
router.post('/mfa/disable', requireAuth, requireRole('super'), ...mfaLimiters, asyncHandler(async (req, res) => {
  const { code, password } = req.body || {};
  if (!code || !password) throw badRequest('code and password required');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user) throw unauthorized();
  if (!(await bcrypt.compare(password, user.password_hash))) throw unauthorized('Invalid password');
  if (user.mfa_enabled && user.mfa_secret && !(await acceptTotp(user, code))) {
    throw unauthorized('Invalid authentication code');
  }
  await pool.query(
    `UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_backup_codes = '[]'::jsonb, updated_at = NOW() WHERE id = $1`,
    [user.id],
  );
  ok(res, { enabled: false });
}));

/** Legacy SHA-256 backup codes stop working after this moment (SEC-M5). Override with LEGACY_BACKUP_CODE_CUTOFF. */
const LEGACY_BACKUP_CODE_CUTOFF = new Date(process.env.LEGACY_BACKUP_CODE_CUTOFF || '2026-11-26T00:00:00Z');
function legacyBackupCodesAccepted() {
  return Date.now() < LEGACY_BACKUP_CODE_CUTOFF.getTime();
}

router.get('/mfa/status', requireAuth, requireRole('super'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT mfa_enabled, (mfa_secret IS NOT NULL) AS has_secret, mfa_backup_codes FROM users WHERE id = $1',
    [req.user.sub],
  );
  const legacy = !!(rows[0] && hasLegacyBackupEntries(rows[0].mfa_backup_codes));
  ok(res, {
    enabled: !!(rows[0] && rows[0].mfa_enabled),
    pending_enroll: !!(rows[0] && rows[0].has_secret && !rows[0].mfa_enabled),
    legacy_backup_codes: legacy,
    legacy_backup_codes_until: legacy ? LEGACY_BACKUP_CODE_CUTOFF.toISOString() : null,
  });
}));

/**
 * Replaces all backup codes with new bcrypt-hashed ones (SEC-M5). Needs a current TOTP code, so a stolen session
 * alone cannot mint new codes. The new codes are shown once.
 */
router.post('/mfa/backup-codes/regenerate', requireAuth, requireRole('super'), asyncHandler(async (req, res) => {
  if (req.user.impersonating) throw forbidden('Cannot change MFA backup codes while impersonating');
  const { code } = req.body || {};
  if (!code) throw badRequest('code required');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND role = $2 LIMIT 1', [req.user.sub, 'super']);
  const user = rows[0];
  if (!user || !user.mfa_enabled || !user.mfa_secret) throw badRequest('MFA is not enabled');
  if (!(await acceptTotp(user, code))) throw unauthorized('Invalid authentication code');
  const backups = generateBackupCodes(8);
  const hashed = await Promise.all(backups.map((c) => hashBackupCodeSecure(c)));
  await pool.query('UPDATE users SET mfa_backup_codes = $2::jsonb, updated_at = NOW() WHERE id = $1', [
    user.id,
    JSON.stringify(hashed),
  ]);
  ok(res, { backup_codes: backups, message: 'New backup codes created. The old codes no longer work.' });
}));

/* ---------- Session and logout ---------- */

router.post('/logout', (req, res) => {
  clearSessionCookies(res);
  ok(res, { logged_out: true });
});

router.get('/session', requireAuth, asyncHandler(async (req, res) => {
  // A bearer token that reaches this route is valid, so it becomes the browser session cookie. Browsers that still
  // hold a token from before cookies were introduced move over with one call to this route (FE-H2).
  const bearer = bearerOf(req);
  if (bearer) setSessionCookie(res, bearer);
  // Impersonation: trust JWT claims (DB row is still the super admin)
  if (req.user.impersonating && req.user.role === 'restaurant' && req.user.restaurant_id) {
    ok(res, {
      user: {
        id: req.user.sub,
        email: req.user.email,
        role: 'restaurant',
        name: req.user.name,
        restaurant_id: req.user.restaurant_id,
        till_id: req.user.till_id || null,
        branch_id: req.user.branch_id || null,
        impersonating: true,
        impersonator_id: req.user.impersonator_id || req.user.sub,
        restaurant_name: req.user.restaurant_name || null,
      },
    });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, email, role, name, restaurant_id, till_id, branch_id FROM users WHERE id = $1',
    [req.user.sub],
  );
  if (!rows[0]) throw unauthorized();
  ok(res, { user: rows[0] });
}));

/* ---------- Staff and restaurant login management ---------- */

/** Best-effort audit row for refused attempts (never blocks the refusal itself). */
async function auditRefusal(req, restaurantId, subject, reason) {
  await writeAudit(req, restaurantId, 'user_overwrite_refused', subject, { reason }).catch((err) => {
    console.error('[auth] could not write refusal audit', err.message);
  });
}

/** Audit row for a login change. Must succeed before the change is applied (fail closed). */
async function writeAudit(req, restaurantId, event, subject, detail) {
  await pool.query(
    'INSERT INTO security_audit (restaurant_id, actor, actor_role, event, subject, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [
      restaurantId || null,
      req.user?.sub || req.user?.email || null,
      req.user?.role || null,
      event,
      subject ? String(subject) : null,
      JSON.stringify(detail || {}),
    ],
  );
}

/**
 * Create / update login users. Super: any role. Restaurant admin: only own restaurant.
 * SEC-M4: an existing login is only updated (for example a password reset) when its role and staff link match.
 * Anything else is refused and recorded in security_audit; a successful overwrite is recorded before it is applied.
 */
router.post('/users', requireAuth, requireRole('super', 'restaurant'), asyncHandler(async (req, res) => {
  let { email, password, role, name, restaurant_id, till_id, branch_id, status = true } = req.body || {};
  if (!email || !password || !role || !name) throw badRequest('email, password, role and name are required');
  if (!ACCOUNT_ROLES.includes(role)) throw badRequest('Invalid role');
  if (String(password).length < 8) throw badRequest('Password must be at least 8 characters');
  const isStaff = Boolean(STAFF_TABLES[role]);
  if (req.user.role === 'restaurant') {
    restaurant_id = req.user.restaurant_id;
    if (!restaurant_id) throw badRequest('restaurant_id required');
    if (role === 'super') throw badRequest('Invalid role');
    if (!isStaff) role = 'restaurant';
  }
  if (role !== 'super' && !restaurant_id) throw badRequest('restaurant_id required for restaurant/epos users');
  if (isStaff) await assertStaffRecord(role, req.body.staff_id, restaurant_id);

  // Branch binding: undefined keeps the login's current branch, null or '' makes it HQ-wide (all branches).
  // A branch-bound caller can only set its own branch, and the branch must belong to the target restaurant.
  // Without an explicit branch, a branch-bound caller's new login stays in its own branch, never HQ-wide.
  if (req.user.branch_id) {
    // A branch login creates logins for its own branch only. Another branch, or an HQ-wide login, is refused.
    if (branch_id !== undefined && String(branch_id || '') !== String(req.user.branch_id)) {
      throw forbidden('A branch login can only create logins for its own branch');
    }
    branch_id = req.user.branch_id;
  }
  const branchGiven = branch_id !== undefined;
  const branchValue = branch_id === null || branch_id === '' ? null : String(branch_id);
  if (branchGiven) {
    assertBranchAccess(req, branchValue);
    if (branchValue) {
      if (role === 'super') throw badRequest('branch_id is not allowed for super accounts');
      // Super Admin sets the branch list on the restaurant record; the restaurant panel may keep its own copy.
      const { rows: restRows } = await pool.query('SELECT data FROM restaurants WHERE id = $1', [restaurant_id]);
      const { rows: branchDocs } = await pool.query(
        "SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'branches'",
        [restaurant_id],
      );
      const fromRestaurant = Array.isArray(restRows[0]?.data?.branch_list) ? restRows[0].data.branch_list : [];
      const fromPanel = Array.isArray(branchDocs[0]?.data) ? branchDocs[0].data : [];
      const branches = [...fromRestaurant, ...fromPanel];
      if (!branches.some((b) => b && String(b.id) === branchValue)) throw badRequest('Branch not found for this restaurant');
    }
  }

  const emailNorm = email.toLowerCase().trim();
  const { rows: existing } = await pool.query(
    'SELECT id, role, restaurant_id, branch_id FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [emailNorm],
  );
  // A branch-bound caller can only change logins in its own branch (no password reset on another branch's login).
  if (req.user.branch_id && existing[0] && String(existing[0].branch_id || '') !== String(req.user.branch_id)) {
    await auditRefusal(req, restaurant_id, existing[0].id, 'other_branch');
    throw forbidden('Email already in use');
  }
  const rowBranch = branchGiven ? branchValue : (existing[0]?.branch_id || null);
  const requestedId = req.body.id ? String(req.body.id) : null;
  if (requestedId) {
    // A caller-chosen id must not point at another account's row (it would fail on the primary key).
    const { rows: byId } = await pool.query('SELECT email FROM users WHERE id = $1', [requestedId]);
    if (byId[0] && String(byId[0].email).toLowerCase() !== emailNorm) {
      await auditRefusal(req, restaurant_id, requestedId, 'id_in_use');
      throw forbidden('Email already in use');
    }
  }

  if (existing[0]) {
    const ex = existing[0];
    if (ex.role === 'super' && req.user.role !== 'super') {
      throw forbidden('Cannot modify a platform admin account');
    }
    if (req.user.role === 'restaurant' && (ex.restaurant_id !== restaurant_id || ex.role === 'super')) {
      await auditRefusal(req, restaurant_id, ex.id, 'other_restaurant');
      throw forbidden('Email already in use');
    }
    // Role change: the login would change what it can do.
    if (ex.role !== role) {
      await auditRefusal(req, restaurant_id, ex.id, 'role_change');
      throw forbidden('Email already in use');
    }
    // Staff link: a chef or driver login belongs to its record. Another record cannot be linked to it, and a
    // staff-linked login cannot be taken over by a non-staff request.
    const exIsStaff = Boolean(STAFF_TABLES[ex.role]);
    if ((exIsStaff || isStaff) && String(ex.id) !== String(req.body.staff_id || '')) {
      await auditRefusal(req, restaurant_id, ex.id, 'staff_link');
      throw forbidden('Email already in use');
    }
    await writeAudit(req, restaurant_id, 'user_overwrite', ex.id, { role, password_reset: true, branch_id: rowBranch });
  }

  const id = isStaff ? req.body.staff_id : req.body.id || existing[0]?.id || `u_${Date.now().toString(36)}`;
  const password_hash = await bcrypt.hash(String(password), 10);
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id, status, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$10)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       name = EXCLUDED.name,
       restaurant_id = EXCLUDED.restaurant_id,
       till_id = EXCLUDED.till_id,
       status = EXCLUDED.status,
       branch_id = EXCLUDED.branch_id,
       token_version = users.token_version + 1,
       updated_at = NOW()
     WHERE users.role <> 'super' OR $9::text = 'super'
     RETURNING id, email, role, name, restaurant_id, till_id, status, branch_id`,
    [id, emailNorm, password_hash, role, name, restaurant_id || null, till_id || null, status !== false, req.user.role, rowBranch],
  );
  if (!rows[0]) throw forbidden('Cannot modify that account');
  // Existing tokens for this account are now stale (token_version was bumped). Drop the cached check.
  forgetAccount(rows[0].id, rows[0].role);
  ok(res, { user: rows[0] });
}));

/* ---------- Impersonation ---------- */

/** Super admin: short-lived JWT acting as a restaurant. */
router.post('/impersonate', requireAuth, requireRole('super'), asyncHandler(async (req, res) => {
  const { restaurant_id } = req.body || {};
  if (!restaurant_id) throw badRequest('restaurant_id required');
  const { rows } = await pool.query('SELECT id, name, email FROM restaurants WHERE id = $1', [restaurant_id]);
  if (!rows[0]) throw badRequest('Restaurant not found');
  const r = rows[0];
  const token = signImpersonation({
    sub: req.user.sub,
    email: req.user.email,
    role: 'restaurant',
    name: req.user.name || 'Super Admin',
    restaurant_id: r.id,
    impersonating: true,
    impersonator_id: req.user.sub,
    tv: req.user.tv ?? 0,
    restaurant_name: r.name,
  });
  // The super session is kept in an httpOnly cookie that only the auth routes receive, so "end" can restore it
  // without the browser script ever holding the token.
  const superToken = bearerOf(req);
  if (superToken) res.cookie(RESTORE_COOKIE, superToken, { ...cookieOptions('/api/v1/auth'), maxAge: SESSION_FALLBACK_MS });
  setSessionCookie(res, token);
  ok(res, {
    token,
    user: {
      id: req.user.sub,
      email: req.user.email,
      role: 'restaurant',
      name: req.user.name,
      restaurant_id: r.id,
      impersonating: true,
      restaurant_name: r.name,
    },
  });
}));

/**
 * End impersonation. A stolen short-lived impersonation JWT alone must NOT mint a
 * full super session — require the original super JWT as restore_token proof.
 * The proof is read from the restore cookie (browsers) or from body / x-restore-token (other clients).
 */
router.post('/end-impersonate', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user.impersonating || !req.user.impersonator_id) {
    throw badRequest('Not impersonating');
  }
  const restoreToken =
    (req.body && req.body.restore_token) ||
    req.get('x-restore-token') ||
    readCookie(req.headers.cookie, RESTORE_COOKIE) ||
    null;
  if (!restoreToken || typeof restoreToken !== 'string') {
    throw unauthorized('restore_token required to end impersonation');
  }

  let restored;
  try {
    restored = verify(restoreToken);
  } catch {
    throw unauthorized('Invalid or expired restore token — please log in again');
  }
  if (restored.impersonating) throw unauthorized('Invalid restore token');
  // Only a full login session may restore. MFA-pending tickets and other token types are refused (SEC-H5).
  if (restored.mfa_pending || restored.typ) throw unauthorized('Invalid restore token');
  if (restored.role !== 'super') throw unauthorized('Invalid restore token');
  if (String(restored.sub) !== String(req.user.impersonator_id)) {
    throw unauthorized('Restore token does not match impersonator');
  }

  const { rows } = await pool.query(
    'SELECT id, email, role, name, restaurant_id, till_id, branch_id, token_version FROM users WHERE id = $1 AND status = TRUE',
    [restored.sub],
  );
  if (!rows[0] || rows[0].role !== 'super') throw unauthorized('Cannot restore super admin session');
  const user = rows[0];
  const token = sign({
    sub: user.id,
    email: user.email,
    tv: user.token_version ?? 0,
    role: user.role,
    name: user.name,
    restaurant_id: user.restaurant_id,
    till_id: user.till_id,
    branch_id: user.branch_id || null,
  });
  setSessionCookie(res, token);
  res.clearCookie(RESTORE_COOKIE, cookieOptions('/api/v1/auth'));
  ok(res, {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      restaurant_id: user.restaurant_id,
      till_id: user.till_id,
      branch_id: user.branch_id || null,
    },
  });
}));

/* ---------- Phone OTP ---------- */

const crypto = require('crypto');
const smsProvider = require('@cravedash/shared/src/providers/sms');
const { setOtp, verifyOtp } = require('@cravedash/shared/src/otpStore');
const { verifyRecaptcha, loadRecaptchaSecret } = require('@cravedash/shared/src/recaptcha');

/**
 * Phone in international form (+447700900123). Accepts 07..., 00... and +... numbers, ignoring spaces, dashes and brackets.
 * Anything else is refused.
 */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  else if (/^0\d{9,10}$/.test(p)) p = `+44${p.slice(1)}`;
  if (!/^\+\d{8,15}$/.test(p)) throw badRequest('phone must be a valid international number, for example +447700900123');
  return p;
}

/**
 * Dev-only SMS mock: the code is stored and printed on this server, and nothing is sent.
 * It is never active in production, whatever SMS_MOCK says.
 */
function smsMockEnabled() {
  return process.env.SMS_MOCK === '1' && process.env.NODE_ENV !== 'production';
}

function otpKey(restaurantId, phone) {
  return `${restaurantId || 'platform'}:${String(phone || '').replace(/\D/g, '')}`;
}

/** The restaurant's customer with this verified phone number, or a new one. */
async function findOrCreatePhoneCustomer(restaurantId, phone) {
  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND phone = $2 ORDER BY created_at ASC LIMIT 1',
    [restaurantId, phone],
  );
  if (rows[0]) return rows[0];
  const id = `cust_${crypto.randomBytes(8).toString('hex')}`;
  const { rows: inserted } = await pool.query(
    `INSERT INTO customers (id, restaurant_id, name, phone, data, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4::jsonb, NOW(), NOW()) RETURNING *`,
    [id, restaurantId, phone, JSON.stringify({ phone_verified: true })],
  );
  return inserted[0];
}

async function loadSmsKeys(restaurantId) {
  if (process.env.SMS_ACCOUNT_SID && process.env.SMS_AUTH_TOKEN) {
    return {
      account_sid: process.env.SMS_ACCOUNT_SID,
      auth_token: process.env.SMS_AUTH_TOKEN,
      from: process.env.SMS_FROM || process.env.SMS_SENDER,
    };
  }
  if (!restaurantId) return null;
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'integrations'],
  );
  const entry = rows[0]?.data?.sms;
  if (!entry?.enabled || !entry.keys) return null;
  return decryptKeysObject(entry.keys, ['auth_token']);
}

/** Pre-login OTP is billed to the platform's own SMS account, never to a tenant's (SEC-H6). */
function platformSmsKeys() {
  if (!process.env.SMS_ACCOUNT_SID || !process.env.SMS_AUTH_TOKEN) return null;
  return {
    account_sid: process.env.SMS_ACCOUNT_SID,
    auth_token: process.env.SMS_AUTH_TOKEN,
    from: process.env.SMS_FROM || process.env.SMS_SENDER,
  };
}

async function assertCaptcha(req, restaurantId) {
  const secret = await loadRecaptchaSecret(pool, restaurantId || req.headers['x-restaurant-id']);
  if (!secret) {
    // In production every pre-login OTP needs a CAPTCHA proof, so a missing secret refuses the request (SEC-H6).
    if (process.env.NODE_ENV === 'production') throw badRequest('reCAPTCHA is not configured');
    return;
  }
  const token = req.body?.recaptcha_token || req.body?.captcha || req.headers['x-recaptcha-token'];
  const result = await verifyRecaptcha(token, secret, req.ip);
  if (!result.ok) throw badRequest(`reCAPTCHA failed: ${result.error || 'invalid'}`);
}

// SMS pumping limits (SEC-H6): per client IP, per tenant whose SMS account would be billed, and per phone number.
// Defaults can be changed with OTP_IP_MAX (per 15 min), OTP_TENANT_MAX (per hour) and OTP_PHONE_MAX (per 15 min).
// The IP limit is high on purpose: the client address is the forwarded one (TRUST_PROXY, SEC-M2) but many users share a NAT.
const otpIpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: +(process.env.OTP_IP_MAX || 300),
  keyFn: (req) => `otp-ip:${req.ip}`,
});
const otpTenantLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: +(process.env.OTP_TENANT_MAX || 200),
  keyFn: (req) => `otp-tenant:${req.body?.restaurant_id || req.headers['x-restaurant-id'] || 'platform'}`,
});
const otpPhoneLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: +(process.env.OTP_PHONE_MAX || 10),
  keyFn: (req) => `otp-phone:${req.body?.phone}`,
});

router.post('/otp/request', otpIpLimiter, otpTenantLimiter, otpPhoneLimiter, asyncHandler(async (req, res) => {
  const { phone: rawPhone, restaurant_id: restaurantId } = req.body || {};
  if (!rawPhone) throw badRequest('phone is required');
  const phone = normalizePhone(rawPhone);
  const tenant = restaurantId || req.headers['x-restaurant-id'] || null;
  // The SMS account used belongs to this tenant, so the restaurant must exist before any of its keys are read.
  if (tenant) {
    const { rows: known } = await pool.query('SELECT id FROM restaurants WHERE id = $1', [String(tenant)]);
    if (!known[0]) throw badRequest('Unknown restaurant');
  }
  await assertCaptcha(req, restaurantId);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = otpKey(restaurantId, phone);
  if (smsMockEnabled()) {
    await setOtp(key, code, 300);
    console.log(`[sms-mock] OTP for ...${phone.slice(-4)} (restaurant ${restaurantId || 'platform'}): ${code}`);
    return ok(res, { sent: true, expires_in: 300 });
  }
  const keys = platformSmsKeys();
  if (!keys || !keys.account_sid) throw badRequest('SMS is not configured for this restaurant');
  await setOtp(key, code, 300);
  await smsProvider.send(keys, {
    to: phone,
    body: `Your CraveDash code is ${code}. It expires in 5 minutes.`,
  });
  ok(res, { sent: true, expires_in: 300 });
}));

router.post('/otp/verify', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyFn: (req) => `${req.ip}:${req.body?.phone}` }), asyncHandler(async (req, res) => {
  const { phone: rawPhone, code, restaurant_id: restaurantId } = req.body || {};
  if (!rawPhone || !code) throw badRequest('phone and code are required');
  // The customer belongs to one restaurant, so the restaurant is required and must exist.
  if (!restaurantId) throw badRequest('restaurant_id is required');
  const { rows: known } = await pool.query('SELECT id FROM restaurants WHERE id = $1', [String(restaurantId)]);
  if (!known[0]) throw badRequest('Unknown restaurant');
  const phone = normalizePhone(rawPhone);
  const result = await verifyOtp(otpKey(restaurantId, phone), code, 5);
  if (!result.ok) {
    if (result.reason === 'expired') throw unauthorized('OTP expired — request a new code');
    if (result.reason === 'locked') throw unauthorized('Too many attempts');
    throw unauthorized('Invalid code');
  }
  const customer = await findOrCreatePhoneCustomer(String(restaurantId), phone);
  if (customer.status === false) throw unauthorized('This account is disabled');
  // A customer token: role 'customer'. Staff APIs refuse it (shared/src/authMiddleware.js).
  const token = sign({
    sub: customer.id,
    role: 'customer',
    name: customer.name || null,
    restaurant_id: String(restaurantId),
    phone,
    otp: true,
  });
  ok(res, {
    token,
    user: { id: customer.id, name: customer.name || null, phone, role: 'customer', restaurant_id: String(restaurantId) },
  });
}));

/**
 * Customer registration with an e-mail address and a password (website "Create account"). Public, like OTP sign-in.
 * The account belongs to one restaurant. A phone or an e-mail that is already used there is refused (409), so the same
 * customer is not created twice. The reply is a customer session, so the website signs the new customer in at once.
 */
const REGISTRATION_PASSWORD_MIN = 8;
const REGISTRATION_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

router.post('/registration', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyFn: (req) => `reg:${req.ip}` }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const restaurantId = String(body.restaurant_id || '').trim();
  const firstName = String(body.f_name || '').trim();
  const lastName = String(body.l_name || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!restaurantId) throw badRequest('restaurant_id is required');
  if (!firstName) throw badRequest('First name is required');
  if (!REGISTRATION_EMAIL_RE.test(email)) throw badRequest('Enter a valid e-mail address');
  if (password.length < REGISTRATION_PASSWORD_MIN) {
    throw badRequest(`Password must be at least ${REGISTRATION_PASSWORD_MIN} characters`);
  }
  const phone = normalizePhone(body.phone);

  const { rows: known } = await pool.query('SELECT id FROM restaurants WHERE id = $1', [restaurantId]);
  if (!known[0]) throw badRequest('Unknown restaurant');

  const { rows: taken } = await pool.query(
    'SELECT email, phone FROM customers WHERE restaurant_id = $1 AND (LOWER(email) = LOWER($2) OR phone = $3) LIMIT 1',
    [restaurantId, email, phone],
  );
  if (taken[0]) {
    const sameEmail = taken[0].email && taken[0].email.toLowerCase() === email.toLowerCase();
    throw new AppError(sameEmail ? 'An account with this e-mail already exists' : 'An account with this phone number already exists', 409);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = `cust_${crypto.randomBytes(8).toString('hex')}`;
  const name = lastName ? `${firstName} ${lastName}` : firstName;
  const { rows } = await pool.query(
    `INSERT INTO customers (id, restaurant_id, name, email, phone, password_hash, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW()) RETURNING id, name, email, phone`,
    [id, restaurantId, name, email, phone, passwordHash, JSON.stringify({ marketing_consent: body.marketing_consent === true })],
  );
  const customer = rows[0];
  const token = sign({
    sub: customer.id,
    role: 'customer',
    name: customer.name,
    restaurant_id: restaurantId,
    phone: customer.phone,
  });
  ok(res, {
    token,
    user: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, role: 'customer', restaurant_id: restaurantId },
  });
}));

/**
 * Customer sign-in with e-mail and password (website "Sign in"). A customer with no password (a phone-code customer)
 * cannot use this route. Every failure gives the same message, so an e-mail address cannot be checked this way.
 */
const CUSTOMER_LOGIN_FAILED = 'Invalid e-mail or password';
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/customer/login', loginLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const restaurantId = String(body.restaurant_id || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!restaurantId || !email || !password) throw badRequest('restaurant_id, e-mail and password are required');

  const { rows } = await pool.query(
    'SELECT id, name, email, phone, password_hash, status FROM customers WHERE restaurant_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1',
    [restaurantId, email],
  );
  const customer = rows[0];
  // The hash is always compared, so a missing account takes as long as a wrong password.
  const matches = await bcrypt.compare(password, customer && customer.password_hash ? customer.password_hash : DUMMY_PASSWORD_HASH);
  if (!customer || !customer.password_hash || !matches || customer.status === false) {
    throw unauthorized(CUSTOMER_LOGIN_FAILED);
  }

  const token = sign({
    sub: customer.id,
    role: 'customer',
    name: customer.name,
    restaurant_id: restaurantId,
    phone: customer.phone,
  });
  ok(res, {
    token,
    user: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, role: 'customer', restaurant_id: restaurantId },
  });
}));

/**
 * The signed-in customer's own profile. The customer is taken from the token (sub) and the restaurant from the token
 * (restaurant_id), so a token from one restaurant can never read a customer of another, and no id is read from the URL.
 */

/* ---------- Social login ---------- */

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Finds the restaurant customer for a verified provider identity, or creates one (SEC-M6).
 *   1. A customer already linked to this (provider, subject) pair is used. The subject is the key, never the email.
 *   2. The email is used to link an existing customer only when the provider verified it, and only when that customer
 *      has no different account already linked for the same provider.
 *   3. Otherwise a new customer is created, so an unverified email cannot take over someone else's account.
 */
async function findOrCreateOAuthCustomer({ restaurantId, provider, sub, email, name, emailVerified }) {
  const subject = String(sub);
  const link = { provider, sub: subject };

  let { rows } = await pool.query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND data->\'oauth_links\' @> $2::jsonb LIMIT 1',
    [restaurantId, JSON.stringify([link])],
  );
  if (!rows[0]) {
    // Links written before (provider, subject) pairs were stored on the customer.
    ({ rows } = await pool.query(
      'SELECT * FROM customers WHERE restaurant_id = $1 AND data->>\'oauth\' = $2 AND data->>\'oauth_sub\' = $3 LIMIT 1',
      [restaurantId, provider, subject],
    ));
  }
  if (rows[0]) return rows[0];

  if (emailVerified) {
    const { rows: candidates } = await pool.query(
      'SELECT * FROM customers WHERE restaurant_id = $1 AND LOWER(email) = LOWER($2) ORDER BY created_at ASC LIMIT 5',
      [restaurantId, email],
    );
    const free = candidates.find((c) => {
      const d = c.data || {};
      const linked = Array.isArray(d.oauth_links) ? d.oauth_links : [];
      const otherSameProvider = linked.some((l) => l.provider === provider && String(l.sub) !== subject);
      const legacyOther = d.oauth === provider && d.oauth_sub && String(d.oauth_sub) !== subject;
      return !otherSameProvider && !legacyOther;
    });
    if (free) {
      const { rows: updated } = await pool.query(
        `UPDATE customers
            SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{oauth_links}',
                  COALESCE(data->'oauth_links', '[]'::jsonb) || $3::jsonb),
                updated_at = NOW()
          WHERE id = $1 AND restaurant_id = $2
          RETURNING *`,
        [free.id, restaurantId, JSON.stringify([link])],
      );
      return updated[0];
    }
  }

  const id = `cust_${crypto.randomBytes(8).toString('hex')}`;
  const inserted = await pool.query(
    `INSERT INTO customers (id, restaurant_id, name, email, phone, data, created_at, updated_at)
     VALUES ($1,$2,$3,$4,NULL,$5::jsonb,NOW(),NOW()) RETURNING *`,
    [id, restaurantId, name || email, email, JSON.stringify({ oauth: provider, oauth_sub: subject, oauth_links: [link] })],
  );
  return inserted.rows[0];
}

/** Social login — exchange provider token / code for CraveDash JWT (customer or staff link). */
router.post('/oauth/:provider', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }), asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  const { id_token, access_token, code, restaurant_id: restaurantId, email: emailHint, name: nameHint } = req.body || {};
  let email = emailHint;
  let name = nameHint;
  let sub = null;
  let emailVerified = false;

  // The customer's restaurant must be a real one, checked before any provider call (SEC-C3).
  const tenantId = restaurantId || req.headers['x-restaurant-id'] || null;
  if (tenantId) {
    const { rows: known } = await pool.query('SELECT id FROM restaurants WHERE id = $1', [String(tenantId)]);
    if (!known[0]) throw badRequest('Unknown restaurant');
  }

  if (provider === 'google') {
    const token = id_token || access_token;
    if (!token && !code) throw badRequest('Google id_token or access_token required');
    if (token) {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      // Production must name the app the token is for. Without it any app's token would be accepted (SEC-M1).
      if (!clientId && isProduction()) throw unauthorized('Google sign-in is not configured');
      const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.email) throw unauthorized('Invalid Google token');
      // Reject tokens issued to another app when this deployment names its client ID.
      if (clientId && data.aud !== clientId) {
        throw unauthorized('Google token was issued for another app');
      }
      if (String(data.email_verified) !== 'true') throw unauthorized('Google email is not verified');
      email = data.email;
      name = data.name || data.email;
      sub = data.sub;
      emailVerified = true;
    }
  } else if (provider === 'facebook') {
    if (!access_token) throw badRequest('Facebook access_token required');
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      if (isProduction()) throw unauthorized('Facebook sign-in is not configured');
      console.warn('[auth] FACEBOOK_APP_ID/FACEBOOK_APP_SECRET not set; Facebook token is not bound to an app (dev only)');
    } else {
      // debug_token confirms the token is valid and was issued to this app (SEC-M1).
      const dbg = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(access_token)}`
        + `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
      );
      const dbgBody = await dbg.json().catch(() => ({}));
      const info = (dbgBody && dbgBody.data) || {};
      if (!dbg.ok || info.error || !info.is_valid || String(info.app_id) !== String(appId)) {
        throw unauthorized('Invalid Facebook token');
      }
      sub = info.user_id ? String(info.user_id) : null;
    }
    const r = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(access_token)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw unauthorized((data.error && data.error.message) || 'Invalid Facebook token');
    if (sub && String(data.id) !== sub) throw unauthorized('Invalid Facebook token');
    sub = String(data.id);
    email = data.email || `${data.id}@facebook.local`;
    name = data.name || email;
    // Facebook does not say whether the address is verified, so it never links to an existing customer by email.
    emailVerified = false;
  } else if (provider === 'apple') {
    if (!id_token) throw badRequest('Apple id_token required');
    // The token is verified (signature, issuer, audience, expiry) before any claim is trusted.
    // The client-supplied email hint is never used for Apple: it is not covered by the token.
    const clientId = process.env.APPLE_CLIENT_ID;
    if (!clientId) throw unauthorized('Apple sign-in is not configured');
    let payload;
    try {
      payload = verifyAppleIdToken(id_token, { keys: await fetchAppleKeys(), clientId });
    } catch (err) {
      throw unauthorized(`Invalid Apple token: ${err.message}`);
    }
    email = payload.email || `${payload.sub}@apple.local`;
    name = nameHint || email;
    sub = payload.sub;
    emailVerified = !!payload.email && String(payload.email_verified) === 'true';
  } else {
    throw badRequest('Unsupported provider');
  }

  if (!email) throw badRequest('Could not resolve email from provider');

  // Link or create restaurant customer user if restaurant scoped; else return verified identity token
  const rid = tenantId;
  if (rid) {
    const cust = await findOrCreateOAuthCustomer({
      restaurantId: rid,
      provider,
      sub,
      email,
      name,
      emailVerified,
    });
    const token = sign({
      sub: cust.id,
      email: cust.email,
      role: 'customer',
      name: cust.name,
      restaurant_id: rid,
      oauth: provider,
    });
    return ok(res, { token, user: { id: cust.id, email: cust.email, name: cust.name, role: 'customer', restaurant_id: rid } });
  }

  ok(res, { verified: true, provider, email, name, sub });
}));

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  fail(res, err);
});

/**
 * Branch context audit: the client calls start when it enters "view as branch" and end when it leaves. The branch
 * itself is checked on every request by the shared middleware; these calls only record the start and end.
 */
async function auditBranchContext(req, event, branchId) {
  await pool.query(
    'INSERT INTO security_audit (restaurant_id, actor, actor_role, event, subject, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [req.user.restaurant_id, req.user.name || req.user.email || req.user.sub, req.user.role, event, req.user.sub, JSON.stringify({ branch_id: branchId })],
  );
}

router.post('/branch-context/start', requireAuth, requireRole('restaurant'), asyncHandler(async (req, res) => {
  const branch = String((req.body || {}).branch_id || '');
  if (!branch) throw badRequest('branch_id is required');
  // A real branch login cannot open a branch view. A restaurant admin who is already viewing a branch may switch to another.
  if (req.user.branch_id && !req.user.branch_context) throw forbidden('A branch login cannot open a branch view');
  const { isRestaurantBranch } = require('@cravedash/shared/src/branches');
  if (!(await isRestaurantBranch(pool, req.user.restaurant_id, branch))) throw forbidden('That branch is not part of your restaurant');
  await auditBranchContext(req, 'branch_context.start', branch);
  ok(res, { viewing: branch });
}));

router.post('/branch-context/end', requireAuth, requireRole('restaurant'), asyncHandler(async (req, res) => {
  const branch = req.user.branch_id || String((req.body || {}).branch_id || '');
  await auditBranchContext(req, 'branch_context.end', branch || null);
  ok(res, { viewing: null });
}));

/* ---------- Kitchen (chef) PIN login and password reset ---------- */

const OTP_TTL_SECONDS = 600;
const RESET_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function digest(value) {
  return require('crypto').createHash('sha256').update(String(value)).digest('hex');
}

function newOtp() {
  return String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Sends the OTP by email when SMTP is set in the environment (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM).
 * With no SMTP: outside production the code is returned as dev_otp for local testing. In production the request fails.
 */
async function deliverOtp(email, otp) {
  const host = process.env.SMTP_HOST;
  if (host && process.env.SMTP_FROM) {
    const email_ = require('@cravedash/shared/src/providers/email');
    await email_.send(
      { host, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD, from: process.env.SMTP_FROM },
      { to: email, subject: 'Your CraveDash verification code', text: `Your verification code is ${otp}. It expires in 10 minutes.` },
    );
    return {};
  }
  if (process.env.NODE_ENV === 'production') {
    throw new AppError('Email is not configured on this server', 503, 'EMAIL_NOT_CONFIGURED');
  }
  return { dev_otp: otp };
}

async function findResetUser(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND role IN ($2, $3) AND status = TRUE LIMIT 1',
    [String(email || ''), 'chef', 'restaurant'],
  );
  return rows[0] || null;
}

router.post('/staff/pin-login', asyncHandler(async (req, res) => {
  const { pin } = req.body || {};
  const restaurantId = String((req.body || {}).restaurant_id || req.headers['x-restaurant-id'] || '');
  if (!pin || !/^\d{4,8}$/.test(String(pin))) throw badRequest('pin must be 4 to 8 digits');
  if (!restaurantId) throw badRequest('restaurant_id is required');
  const { rows: chefs } = await pool.query(
    "SELECT id, pin_hash, data FROM chefs WHERE restaurant_id = $1 AND status = TRUE AND (pin_hash IS NOT NULL OR (data IS NOT NULL AND data ? 'pin_hash'))",
    [restaurantId],
  );
  let match = null;
  for (const chef of chefs) {
    const hash = chef.pin_hash || chef.data?.pin_hash;
    if (hash && (await bcrypt.compare(String(pin), String(hash)))) {
      match = chef;
      break;
    }
  }
  if (!match) throw unauthorized('Invalid PIN');
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'chef' AND status = TRUE", [match.id]);
  const user = rows[0];
  if (!user || !(await staffIsActive(user))) throw unauthorized('Invalid PIN');
  await pool.query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  const token = sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    restaurant_id: user.restaurant_id,
    till_id: user.till_id,
    branch_id: user.branch_id || null,
    tv: user.token_version ?? 0,
  });
  setSessionCookie(res, token);
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, restaurant_id: user.restaurant_id, branch_id: user.branch_id || null },
  });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  if (!email) throw badRequest('email is required');
  const user = await findResetUser(email);
  const response = { message: 'Verification OTP sent to your email', email, expires_in: OTP_TTL_SECONDS };
  if (!user) return ok(res, response); // same answer for unknown emails, so the endpoint does not reveal accounts
  const otp = newOtp();
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await pool.query(
    'INSERT INTO password_resets (id, user_id, email, otp_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + ($5 || \' seconds\')::interval)',
    [`pr_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`, user.id, user.email, digest(`${user.id}:${otp}`), String(OTP_TTL_SECONDS)],
  );
  Object.assign(response, await deliverOtp(user.email, otp));
  ok(res, response);
}));

router.post('/resend-otp', asyncHandler(async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  if (!email) throw badRequest('email is required');
  const user = await findResetUser(email);
  const response = { message: 'OTP code resent successfully', email, expires_in: OTP_TTL_SECONDS };
  if (!user) return ok(res, response);
  const otp = newOtp();
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await pool.query(
    'INSERT INTO password_resets (id, user_id, email, otp_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + ($5 || \' seconds\')::interval)',
    [`pr_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`, user.id, user.email, digest(`${user.id}:${otp}`), String(OTP_TTL_SECONDS)],
  );
  Object.assign(response, await deliverOtp(user.email, otp));
  ok(res, response);
}));

router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) throw badRequest('email and otp are required');
  const user = await findResetUser(email);
  const { rows } = user
    ? await pool.query(
      'SELECT * FROM password_resets WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [user.id],
    )
    : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('Too many attempts. Request a new OTP', 400, 'INVALID_OTP');
  await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [row.id]);
  if (digest(`${user.id}:${String(otp)}`) !== row.otp_hash) throw new AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
  const resetToken = `rst_${require('crypto').randomBytes(24).toString('hex')}`;
  await pool.query(
    "UPDATE password_resets SET reset_hash = $2, expires_at = NOW() + ($3 || ' seconds')::interval WHERE id = $1",
    [row.id, digest(resetToken), String(RESET_TTL_MS / 1000)],
  );
  ok(res, { verified: true, email: user.email, reset_token: resetToken });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const { email, reset_token, new_password, confirm_password } = req.body || {};
  if (!email || !reset_token || !new_password) throw badRequest('email, reset_token and new_password are required');
  if (new_password !== confirm_password) throw badRequest('Passwords do not match');
  if (String(new_password).length < 8) throw badRequest('Password must be at least 8 characters');
  const user = await findResetUser(email);
  const { rows } = user
    ? await pool.query(
      'SELECT * FROM password_resets WHERE user_id = $1 AND reset_hash = $2 AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [user.id, digest(String(reset_token))],
    )
    : { rows: [] };
  if (!rows[0]) throw new AppError('Reset token is invalid or expired', 400, 'INVALID_OTP');
  const hash = await bcrypt.hash(String(new_password), 10);
  await pool.query('UPDATE users SET password_hash = $2, token_version = COALESCE(token_version, 0) + 1, updated_at = NOW() WHERE id = $1', [user.id, hash]);
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [rows[0].id]);
  ok(res, { message: 'Password reset successfully. You may now log in with your new password.' });
}));

router.put('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body || {};
  if (!current_password || !new_password) throw badRequest('current_password and new_password are required');
  if (new_password !== confirm_password) throw badRequest('Passwords do not match');
  if (String(new_password).length < 8) throw badRequest('Password must be at least 8 characters');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(current_password), user.password_hash))) {
    throw unauthorized('Current password is incorrect');
  }
  const hash = await bcrypt.hash(String(new_password), 10);
  await pool.query('UPDATE users SET password_hash = $2, token_version = COALESCE(token_version, 0) + 1, updated_at = NOW() WHERE id = $1', [user.id, hash]);
  ok(res, { message: 'Password changed successfully' });
}));

module.exports = router;
