const crypto = require('crypto');

/**
 * HMAC-SHA256 verification for inbound webhooks, per source and per restaurant.
 *
 * Canonical string (CraveDash-side proposal, not a provider contract): `${timestamp}.${rawBody}`,
 * where rawBody is the exact request bytes and timestamp is Unix seconds. The signature is lowercase hex.
 * Provider header names and formats are NOT known to this codebase; they must be confirmed per provider
 * before any route relies on this module (see the marketplace plan in the side-session notes).
 *
 * Fails closed: a missing secret, missing headers, a stale or future timestamp, or a bad signature all throw.
 */

const DEFAULT_TOLERANCE_SEC = 300;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function computeSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

/**
 * Throws an Error with a short reason when the request is not authentic and fresh.
 * `now` is in milliseconds and injectable for tests.
 */
function verifyWebhookSignature({
  secret,
  rawBody,
  signature,
  timestamp,
  now = Date.now(),
  toleranceSec = DEFAULT_TOLERANCE_SEC,
}) {
  if (!secret) throw new Error('webhook secret is not configured for this source');
  if (!Buffer.isBuffer(rawBody)) throw new Error('raw request body is required');
  if (!signature) throw new Error('signature header is missing');
  if (timestamp === undefined || timestamp === null || timestamp === '') throw new Error('timestamp header is missing');

  const ts = String(timestamp);
  if (!/^\d+$/.test(ts)) throw new Error('timestamp is not a Unix time');
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) throw new Error('timestamp is outside the allowed window');

  const provided = String(signature).trim().toLowerCase();
  if (!HEX_SHA256.test(provided)) throw new Error('signature is malformed');

  const expected = Buffer.from(computeSignature(secret, ts, rawBody), 'hex');
  if (!crypto.timingSafeEqual(expected, Buffer.from(provided, 'hex'))) {
    throw new Error('signature does not match');
  }
  return { ok: true, timestamp: Number(ts) };
}

module.exports = { verifyWebhookSignature, computeSignature, DEFAULT_TOLERANCE_SEC };
