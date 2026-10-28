async function verifyRecaptcha(token, secretKey, remoteIp) {
  if (!secretKey) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'recaptcha token required' };
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: secretKey,
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {}),
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    return { ok: false, error: (data['error-codes'] || ['failed']).join(', ') };
  }
  return { ok: true, score: data.score, action: data.action };
}

async function loadRecaptchaSecret(pool, restaurantId) {
  if (process.env.RECAPTCHA_SECRET_KEY) return process.env.RECAPTCHA_SECRET_KEY;
  if (!restaurantId || !pool) return null;
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'integrations'],
  );
  const entry = rows[0]?.data?.recaptcha;
  if (!entry?.enabled || !entry.keys) return null;
  const { decryptSecret, isEncrypted } = require('./secretsCrypto');
  const sk = entry.keys.secret_key;
  if (!sk) return null;
  return isEncrypted(sk) ? decryptSecret(sk) : sk;
}

module.exports = { verifyRecaptcha, loadRecaptchaSecret };
