/**
 * TOTP helpers for super-admin MFA (RFC 6238).
 * Uses Node crypto — no mandatory third-party TOTP package.
 *
 * SEC-M3 / SEC-M5 additions:
 *   - matchTotpStep() returns the matched time-step counter so the caller can refuse a replay.
 *   - claimTotpStep() records the accepted step per account (in-process; see note below).
 *   - Backup codes are stored with bcrypt (salted). Legacy unsalted SHA-256 entries are still accepted
 *     by matchBackupCode() so existing rows keep working until each code is used.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BCRYPT_ROUNDS = 10;
const LEGACY_HASH_RE = /^[a-f0-9]{64}$/;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

function toBase32(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function fromBase32(str) {
  const cleaned = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret(bytes = 20) {
  return toBase32(crypto.randomBytes(bytes));
}

function hotp(secretBase32, counter) {
  const key = fromBase32(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

function totp(secretBase32, { step = 30, t = Date.now() } = {}) {
  const counter = Math.floor(t / 1000 / step);
  return hotp(secretBase32, counter);
}

/**
 * Returns the time-step counter that the 6-digit code matches inside the accepted window, or null.
 * The comparison runs over the whole window so timing does not reveal which step matched.
 */
function matchTotpStep(secretBase32, token, { window = 1, step = 30, t = Date.now() } = {}) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const base = Math.floor(t / 1000 / step);
  let matched = null;
  for (let w = -window; w <= window; w++) {
    const counter = base + w;
    const candidate = hotp(secretBase32, counter);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) matched = counter;
  }
  return matched;
}

function verifyTotp(secretBase32, token, { window = 1, step = 30 } = {}) {
  return matchTotpStep(secretBase32, token, { window, step }) !== null;
}

/**
 * Replay guard (SEC-M3). Accepts a step only once per account: a step that is not later than the last accepted
 * step is refused. State lives in this process; a multi-instance deployment needs a shared store.
 */
const acceptedSteps = new Map();
const STEP_TTL_MS = 5 * 60 * 1000;

function claimTotpStep(accountId, step) {
  const now = Date.now();
  for (const [k, v] of acceptedSteps) {
    if (v.exp < now) acceptedSteps.delete(k);
  }
  const key = String(accountId);
  const last = acceptedSteps.get(key);
  if (last && step <= last.step) return false;
  acceptedSteps.set(key, { step, exp: now + STEP_TTL_MS });
  return true;
}

function otpauthUrl({ secret, email, issuer = 'CraveDash' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Legacy unsalted SHA-256. Kept only to verify rows written before SEC-M5. Do not use for new codes. */
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase()).digest('hex');
}

/** Salted bcrypt hash for a new backup code. */
function hashBackupCodeSecure(code) {
  return bcrypt.hash(String(code).toUpperCase(), BCRYPT_ROUNDS);
}

/**
 * Finds the stored entry that matches the code. Returns its index, or -1.
 * Accepts both bcrypt entries and legacy SHA-256 entries.
 */
async function matchBackupCode(code, entries, { acceptLegacy = true } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const plain = String(code || '').toUpperCase();
  for (let i = 0; i < list.length; i++) {
    const entry = String(list[i] || '');
    if (BCRYPT_RE.test(entry)) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(plain, entry)) return i;
    } else if (LEGACY_HASH_RE.test(entry) && acceptLegacy) {
      const legacy = hashBackupCode(plain);
      if (crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(entry))) return i;
    }
  }
  return -1;
}

function hasLegacyBackupEntries(entries) {
  return (Array.isArray(entries) ? entries : []).some((e) => LEGACY_HASH_RE.test(String(e || '')));
}

function isLegacyBackupEntry(entry) {
  return LEGACY_HASH_RE.test(String(entry || ''));
}

function generateBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

module.exports = {
  generateSecret,
  totp,
  verifyTotp,
  matchTotpStep,
  claimTotpStep,
  otpauthUrl,
  hashBackupCode,
  hashBackupCodeSecure,
  matchBackupCode,
  isLegacyBackupEntry,
  hasLegacyBackupEntries,
  generateBackupCodes,
};
