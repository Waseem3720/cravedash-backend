const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { optionalAuth } = require('@cravedash/shared/src/authMiddleware');
const { ingestMarketplaceOrder } = require('@cravedash/shared/src/engines/couriers');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { created } = require('@cravedash/shared/src/response');
const { badRequest, forbidden, notFound, unauthorized } = require('@cravedash/shared/src/errors');
const { verifyWebhookSignature } = require('@cravedash/shared/src/webhookSignature');
const { decryptSecret, isEncrypted } = require('@cravedash/shared/src/secretsCrypto');

/**
 * Marketplace order intake. Mounted without JWT because providers call it.
 *
 * Every request must carry a valid HMAC-SHA256 signature made with the restaurant's own marketplace secret
 * (SEC-C2). Headers: X-CraveDash-Timestamp (Unix seconds) and X-CraveDash-Signature (hex of
 * HMAC-SHA256(secret, "<timestamp>." + raw body)). A restaurant with no secret for this source is refused (403),
 * so unsigned requests are never accepted. Provider-specific header formats are not wired yet.
 *
 * What this route does enforce now:
 *  - a signed-in restaurant or EPOS session may only write to its own restaurant (no cross-tenant injection);
 *  - the restaurant must exist (no inbox rows for made-up ids);
 *  - the source name is a plain identifier.
 */
const router = express.Router();

router.post('/engines/marketplaces/:source/webhook', optionalAuth, asyncHandler(async (req, res) => {
  const source = String(req.params.source || '');
  if (!/^[a-z_]{1,40}$/i.test(source)) throw badRequest('Unknown marketplace source');

  const restaurantHint = req.body?.restaurant_id || req.headers['x-restaurant-id'] || req.query.restaurant_id;
  if (!restaurantHint) throw badRequest('restaurant_id required');
  const restaurantId = String(restaurantHint);

  if (req.user && req.user.role !== 'super' && req.user.restaurant_id !== restaurantId) {
    throw forbidden('Session is not for this restaurant');
  }
  const { rows } = await pool.query('SELECT id FROM restaurants WHERE id = $1', [restaurantId]);
  if (!rows[0]) throw notFound('Restaurant not found');

  // Fail closed: no secret for this restaurant and source means the source is not set up, so nothing is accepted.
  const { rows: blob } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'integrations'],
  );
  const entry = blob[0] && blob[0].data && blob[0].data.marketplaces && blob[0].data.marketplaces[source];
  const stored = entry && entry.enabled && entry.keys && entry.keys.webhook_secret;
  if (!stored) throw forbidden('Marketplace webhook is not configured for this restaurant');
  const secret = isEncrypted(stored) ? decryptSecret(stored) : stored;
  try {
    verifyWebhookSignature({
      secret,
      rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
      signature: req.headers['x-cravedash-signature'],
      timestamp: req.headers['x-cravedash-timestamp'],
    });
  } catch (err) {
    throw unauthorized(`Invalid marketplace signature: ${err.message}`);
  }

  created(res, await ingestMarketplaceOrder(restaurantId, source, {
    ...req.body,
    external_id: req.body?.id || req.body?.orderId || req.body?.external_id,
  }));
}));

module.exports = router;
