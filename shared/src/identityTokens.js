const crypto = require('crypto');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const KEY_CACHE_MS = 60 * 60 * 1000;

let appleKeyCache = { keys: null, at: 0 };

/** Fetches Apple's public signing keys (JWKS), cached for an hour. */
async function fetchAppleKeys() {
  if (appleKeyCache.keys && Date.now() - appleKeyCache.at < KEY_CACHE_MS) return appleKeyCache.keys;
  const res = await fetch(APPLE_KEYS_URL);
  if (!res.ok) throw new Error(`Apple key set unavailable (${res.status})`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error('Apple key set malformed');
  appleKeyCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

/**
 * Verifies an Apple identity token: RS256 signature against Apple's JWKS, issuer, audience
 * (the configured Services ID or bundle ID), expiry and subject. Throws on any failure.
 * `keys` and `now` are injectable for tests.
 */
function verifyAppleIdToken(idToken, { keys, clientId, now = Date.now() } = {}) {
  if (!clientId) throw new Error('Apple sign-in is not configured (APPLE_CLIENT_ID)');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed Apple id_token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected Apple id_token algorithm');
  const jwk = (keys || []).find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('Apple signing key not found');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(sigB64, 'base64url'),
  );
  if (!valid) throw new Error('Apple id_token signature is invalid');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (payload.iss !== APPLE_ISSUER) throw new Error('Apple id_token issuer is wrong');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) throw new Error('Apple id_token audience is wrong');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) throw new Error('Apple id_token has expired');
  if (!payload.sub) throw new Error('Apple id_token has no subject');
  return payload;
}

module.exports = { verifyAppleIdToken, fetchAppleKeys, APPLE_ISSUER };
