/**
 * Card terminal / billing API connection tests (restaurant api-connect).
 */

async function stripeKeysTest(keys) {
  const sk = keys.sk || keys.secret || keys.api_key;
  if (!sk) throw new Error('Stripe secret key is required');
  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${sk}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe failed (${res.status})`);
  return { ok: true, provider: 'stripe', livemode: !!data.livemode };
}

async function stripeTerminalTest(keys) {
  const base = await stripeKeysTest(keys);
  if (keys.reader_id) {
    const res = await fetch(`https://api.stripe.com/v1/terminal/readers/${encodeURIComponent(keys.reader_id)}`, {
      headers: { Authorization: `Bearer ${keys.sk}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Stripe Terminal reader not found');
    return { ...base, reader: data.label || data.id, status: data.status };
  }
  return base;
}

async function gocardlessTest(keys) {
  const { mode, token } = keys || {};
  if (!token) throw new Error('GoCardless access token is required');
  const host = /live/i.test(String(mode || ''))
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
  const res = await fetch(`${host}/creditors`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `GoCardless failed (${res.status})`);
  return { ok: true, provider: 'gocardless', creditors: (data.creditors || []).length };
}

async function dojoTest(keys) {
  const { api_key, mode } = keys || {};
  if (!api_key) throw new Error('Dojo API key is required');
  const host = /prod/i.test(String(mode || ''))
    ? 'https://api.dojo.tech'
    : 'https://api.sandbox.dojo.tech';
  const res = await fetch(`${host}/payment-intents?pageSize=1`, {
    headers: {
      Authorization: `Basic ${Buffer.from(api_key + ':').toString('base64')}`,
      'software-house-id': 'cravedash',
      version: '2024-02-05',
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Dojo API key rejected');
  return { ok: true, provider: 'dojo', http_status: res.status, mode: mode || 'sandbox' };
}

async function sumupTest(keys) {
  const { api_key } = keys || {};
  if (!api_key) throw new Error('SumUp API key is required');
  const res = await fetch('https://api.sumup.com/v0.1/me', {
    headers: { Authorization: `Bearer ${api_key}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `SumUp failed (${res.status})`);
  return { ok: true, provider: 'sumup', merchant: data.merchant_code || data.username };
}

async function squareTest(keys) {
  const { token, mode } = keys || {};
  if (!token) throw new Error('Square access token is required');
  const host = /sandbox/i.test(String(mode || 'sandbox'))
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  const res = await fetch(`${host}/v2/locations`, {
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2024-01-18' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.errors && data.errors[0] && data.errors[0].detail) || `Square failed (${res.status})`);
  return { ok: true, provider: 'square', locations: (data.locations || []).length };
}

async function teyaTest(keys) {
  const { client_id, client_secret } = keys || {};
  if (!client_id || !client_secret) throw new Error('Teya client_id and client_secret are required');
  // Teya/SaltPay OAuth varies by region — validate credential presence + basic token attempt
  const res = await fetch('https://api.teya.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id,
      client_secret,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) return { ok: true, provider: 'teya' };
  if (client_id.length >= 4 && client_secret.length >= 8 && (res.status === 404 || res.status === 405)) {
    return { ok: true, provider: 'teya', note: 'Credentials stored; confirm token URL with Teya for your region' };
  }
  throw new Error(data.error_description || data.error || `Teya auth failed (${res.status})`);
}

const BILLING = {
  stripe: { testConnection: stripeKeysTest },
  gocardless: { testConnection: gocardlessTest },
  dojo: { testConnection: dojoTest },
};

const TERMINAL = {
  stripe_terminal: { testConnection: stripeTerminalTest },
  dojo: { testConnection: dojoTest },
  sumup: { testConnection: sumupTest },
  teya: { testConnection: teyaTest },
  square: { testConnection: squareTest },
};

module.exports = { BILLING, TERMINAL, stripeKeysTest };
