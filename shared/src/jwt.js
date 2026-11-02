const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const WEAK = new Set([
  '',
  'dev-change-me',
  'change-me-in-production',
  'secret',
  'changeme',
  'jwt-secret',
  'cravedash',
  'password',
]);

const MIN_LEN = 32;
const rawSecret = String(process.env.JWT_SECRET || '');
const isTest = process.env.NODE_ENV === 'test';
const allowWeak = process.env.ALLOW_WEAK_JWT === '1' && process.env.NODE_ENV !== 'production';

function isWeak(secret) {
  if (!secret || WEAK.has(secret)) return true;
  if (secret.length < MIN_LEN) return true;
  if (/^(.)\1+$/.test(secret)) return true;
  return false;
}

function resolveSecret() {
  if (!isWeak(rawSecret)) return rawSecret;
  // BUG-034: NODE_ENV=test no longer accepts a weak JWT_SECRET (a deployed environment could be mislabelled test).
  // Without any secret, tests get a random per-process key, never a value committed to the source.
  if (isTest && !rawSecret) return crypto.randomBytes(48).toString('hex');
  if (allowWeak) {
    console.warn('[jwt] ALLOW_WEAK_JWT=1 — using weak/default secret (never in production)');
    return rawSecret || 'dev-change-me';
  }
  throw new Error(
    'JWT_SECRET must be a strong secret (≥32 chars, not a known placeholder). '
    + 'Set JWT_SECRET in .env, or ALLOW_WEAK_JWT=1 for local throwaway only.',
  );
}

const SECRET = resolveSecret();
const EXPIRES = process.env.JWT_EXPIRES || '7d';
const IMPERSONATE_EXPIRES = process.env.JWT_IMPERSONATE_EXPIRES || '15m';

function sign(payload, opts = {}) {
  const expiresIn = opts.expiresIn || EXPIRES;
  return jwt.sign(payload, SECRET, { expiresIn });
}

function signImpersonation(payload) {
  return sign(payload, { expiresIn: IMPERSONATE_EXPIRES });
}

/** Short-lived ticket after password OK, before TOTP (super MFA). */
function signMfaPending(payload) {
  return sign({ ...payload, mfa_pending: true }, { expiresIn: '5m' });
}

/** EPOS till staff session after PIN verify (not a login replacement). */
const EPOS_STAFF_EXPIRES = process.env.JWT_EPOS_STAFF_EXPIRES || '12h';
function signEposStaff(payload) {
  return sign({ ...payload, typ: 'epos_staff' }, { expiresIn: EPOS_STAFF_EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET);
}

/**
 * Browser session cookies (FE-H2). The browser holds the session as an httpOnly cookie, so page scripts cannot read
 * the token. The gateway turns the cookie into a Bearer header, so services keep verifying the same JWT.
 *   SESSION_COOKIE  - the signed-in session (path /api/v1).
 *   RESTORE_COOKIE  - a super admin's own session, kept while impersonating (only sent to /api/v1/auth).
 */
const SESSION_COOKIE = 'cd_session';
const RESTORE_COOKIE = 'cd_restore';

/** Returns the value of one cookie from a Cookie request header, or null. */
function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

function verifyEposStaff(token) {
  const p = verify(token);
  if (p.typ !== 'epos_staff' || !p.staff_id) {
    const err = new Error('Invalid EPOS staff token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return p;
}

module.exports = {
  sign,
  signImpersonation,
  signMfaPending,
  signEposStaff,
  verify,
  verifyEposStaff,
  readCookie,
  SESSION_COOKIE,
  RESTORE_COOKIE,
  SECRET,
  EXPIRES,
  IMPERSONATE_EXPIRES,
  EPOS_STAFF_EXPIRES,
};
