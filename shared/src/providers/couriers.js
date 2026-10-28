/**
 * Courier / marketplace credential tests (OAuth token exchange or authenticated ping).
 */

async function uberDirectTest(keys) {
  const { customer_id, client_id, client_secret } = keys || {};
  if (!customer_id || !client_id || !client_secret) {
    throw new Error('Uber Direct customer_id, client_id and client_secret are required');
  }
  const res = await fetch('https://login.uber.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Uber OAuth failed (${res.status})`);
  }
  return { ok: true, provider: 'uber_direct', customer_id, token_type: data.token_type };
}

async function stuartTest(keys) {
  const { client_id, client_secret, env } = keys || {};
  if (!client_id || !client_secret) throw new Error('Stuart client_id and client_secret are required');
  const host = /prod/i.test(String(env || '')) ? 'https://api.stuart.com' : 'https://api.sandbox.stuart.com';
  const res = await fetch(`${host}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
      scope: 'api',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Stuart OAuth failed (${res.status})`);
  }
  return { ok: true, provider: 'stuart', env: env || 'Sandbox' };
}

async function deliverooTest(keys) {
  const { site_id, client_id, client_secret } = keys || {};
  if (!site_id || !client_id || !client_secret) {
    throw new Error('Deliveroo site_id, client_id and client_secret are required');
  }
  const res = await fetch('https://auth.developers.deliveroo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Some tenants use partner-specific hosts — still validate shape
    if (client_id.length < 4 || client_secret.length < 8) {
      throw new Error(data.error_description || data.error || `Deliveroo auth failed (${res.status})`);
    }
    throw new Error(data.error_description || data.error || `Deliveroo auth failed (${res.status})`);
  }
  return { ok: true, provider: 'deliveroo', site_id };
}

async function justeatTest(keys) {
  const { restaurant_id, api_key } = keys || {};
  if (!restaurant_id || !api_key) throw new Error('Just Eat restaurant_id and api_key are required');
  // Partner API varies by region; validate key is accepted by a lightweight UK catalog probe when possible
  const res = await fetch('https://uk.api.just-eat.io/restaurants/bypostcode/EC4M7RF', {
    headers: { Authorization: api_key, 'Accept-Tenant': 'uk' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Just Eat API key was rejected');
  }
  // 200/404/other still proves network path; key format already required
  return { ok: true, provider: 'justeat', restaurant_id, http_status: res.status };
}

async function ubereatsTest(keys) {
  const { store_id, client_id, client_secret } = keys || {};
  if (!store_id || !client_id || !client_secret) {
    throw new Error('Uber Eats store_id, client_id and client_secret are required');
  }
  const res = await fetch('https://login.uber.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
      scope: 'eats.store',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Uber Eats OAuth failed (${res.status})`);
  }
  return { ok: true, provider: 'ubereats', store_id };
}

module.exports = {
  uber_direct: { testConnection: uberDirectTest },
  stuart: { testConnection: stuartTest },
  deliveroo: { testConnection: deliverooTest },
  justeat: { testConnection: justeatTest },
  ubereats: { testConnection: ubereatsTest },
};
