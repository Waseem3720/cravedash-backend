async function testConnection(keys) {
  const { mode, client_id, client_secret } = keys || {};
  if (!client_id || !client_secret) throw new Error('PayPal client_id and client_secret are required');
  const live = /live/i.test(String(mode || ''));
  const host = live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const auth = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
  const res = await fetch(`${host}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `PayPal auth failed (${res.status})`);
  }
  return { ok: true, provider: 'paypal', mode: live ? 'Live' : 'Sandbox', app_id: data.app_id };
}

module.exports = { testConnection };
