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
  if (isTest) return rawSecret || 'test-jwt-secret-do-not-use-in-prod-32b';
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

function verifyEposStaff(token) {
  const p = verify(token);
  if (p.typ !== 'epos_staff' || !p.staff_id) {
    const err = new Error('Invalid EPOS staff token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return p;
}

/** Short-lived token for email verification (15 minutes default). */
const EMAIL_VERIFY_EXPIRES = process.env.JWT_EMAIL_VERIFY_EXPIRES || '15m';
function signEmailVerification(payload) {
  return sign({ ...payload, typ: 'email_verification' }, { expiresIn: EMAIL_VERIFY_EXPIRES });
}

function verifyEmailVerification(token) {
  const p = verify(token);
  if (p.typ !== 'email_verification' || !p.sub || !p.email || !p.jti) {
    const err = new Error('Invalid email verification token');
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
  signEmailVerification,
  verify,
  verifyEposStaff,
  verifyEmailVerification,
  SECRET,
  EXPIRES,
  IMPERSONATE_EXPIRES,
  EPOS_STAFF_EXPIRES,
  EMAIL_VERIFY_EXPIRES,
};

