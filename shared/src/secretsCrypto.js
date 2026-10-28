const crypto = require('crypto');

const PREFIX = 'enc:v1:';

let warnedFallback = false;

function secretKey() {
  const explicit = process.env.INTEGRATIONS_SECRET_KEY;
  if (process.env.NODE_ENV === 'production') {
    if (!explicit || explicit === 'change-me-in-production' || explicit === 'dev-only-integrations-key') {
      throw new Error('INTEGRATIONS_SECRET_KEY must be explicitly set and strong in production; falling back to JWT_SECRET is forbidden');
    }
    return crypto.createHash('sha256').update(String(explicit)).digest();
  }

  if (explicit && explicit !== 'change-me-in-production' && explicit !== 'dev-only-integrations-key') {
    return crypto.createHash('sha256').update(String(explicit)).digest();
  }

  // Non-production fallback to JWT_SECRET for test/dev compatibility
  const fallback = process.env.JWT_SECRET;
  if (fallback && fallback !== 'change-me-in-production') {
    if (!warnedFallback) {
      console.warn('[secretsCrypto] WARN: INTEGRATIONS_SECRET_KEY not set; using JWT_SECRET fallback (non-production only)');
      warnedFallback = true;
    }
    return crypto.createHash('sha256').update(String(fallback)).digest();
  }

  return crypto.createHash('sha256').update('dev-only-integrations-key').digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  const text = String(plain);
  if (isEncrypted(text)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptSecret(value) {
  if (value == null || value === '') return value;
  const text = String(value);
  if (!isEncrypted(text)) return text;
  const buf = Buffer.from(text.slice(PREFIX.length), 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function maskSecret(value) {
  const plain = isEncrypted(value) ? '••••••••' : String(value || '');
  if (!plain || plain === '••••••••') return plain ? '••••' + (String(value || '').slice(-4) || '••••') : '';
  return plain.length <= 4 ? '••••' : '••••••' + plain.slice(-4);
}

/** Decrypt all known secret fields (and any enc:v1: values) for server-side use. */
function decryptKeysObject(keys, secretFields) {
  const out = { ...(keys || {}) };
  const fields = new Set(secretFields || []);
  for (const [f, v] of Object.entries(out)) {
    if (v == null || v === '') continue;
    if (fields.has(f) || isEncrypted(v)) {
      try {
        out[f] = decryptSecret(v);
      } catch {
        /* leave as-is if key rotated */
      }
    }
  }
  return out;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  maskSecret,
  decryptKeysObject,
};
