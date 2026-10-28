const { appendRow, readDoc, writeDoc, round2 } = require('./helpers');

async function getIntegration(pool, restaurantId, provider) {
  const { decryptKeysObject } = require('../secretsCrypto');
  const { secretFieldsFor } = require('../providers');
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'integrations'],
  );
  const entry = rows[0]?.data?.[provider];
  if (!entry?.enabled) return null;
  return { ...entry, keys: decryptKeysObject(entry.keys || {}, secretFieldsFor(provider)) };
}

async function uberDirectToken(keys) {
  const res = await fetch('https://login.uber.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || data.error || 'Uber OAuth failed'), { status: 400 });
  }
  return data.access_token;
}

async function stuartToken(keys) {
  const host = /prod/i.test(String(keys.env || '')) ? 'https://api.stuart.com' : 'https://api.sandbox.stuart.com';
  const res = await fetch(`${host}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      grant_type: 'client_credentials',
      scope: 'api',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || data.error || 'Stuart OAuth failed'), { status: 400 });
  }
  return { token: data.access_token, host };
}

/**
 * Dispatch a delivery job to Uber Direct or Stuart.
 * body: { provider, order_id, pickup, dropoff, manifest }
 */
async function dispatch(pool, restaurantId, body) {
  const provider = String(body.provider || 'uber_direct');
  const integ = await getIntegration(pool, restaurantId, provider);
  if (!integ) {
    throw Object.assign(new Error(`${provider} is not enabled`), { status: 400 });
  }
  const keys = integ.keys;
  let external = null;
  let status = 'queued';

  if (provider === 'uber_direct') {
    const token = await uberDirectToken(keys);
    const payload = {
      pickup: body.pickup || {},
      dropoff: body.dropoff || {},
      manifest_items: body.manifest || [{ name: `Order ${body.order_id}`, quantity: 1 }],
      external_id: body.order_id,
    };
    const res = await fetch(
      `https://api.uber.com/v1/customers/${encodeURIComponent(keys.customer_id)}/deliveries`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.message || data.error || `Uber dispatch failed (${res.status})`), { status: 400 });
    }
    external = data.id || data.delivery_id;
    status = data.status || 'pending';
  } else if (provider === 'stuart') {
    const { token, host } = await stuartToken(keys);
    const payload = {
      job: {
        pickups: [body.pickup || {}],
        dropoffs: [body.dropoff || {}],
        assignment_code: body.order_id,
      },
    };
    const res = await fetch(`${host}/v2/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.message || data.error || `Stuart dispatch failed (${res.status})`), { status: 400 });
    }
    external = data.id || (data.job && data.job.id);
    status = (data.status || data.job?.status) || 'pending';
  } else {
    throw Object.assign(new Error(`Unsupported courier: ${provider}`), { status: 400 });
  }

  const job = await appendRow(restaurantId, 'ops', 'courier_jobs', {
    provider,
    order_id: body.order_id,
    external_id: external,
    status,
    pickup: body.pickup || null,
    dropoff: body.dropoff || null,
    amount: body.amount != null ? round2(body.amount) : null,
  });
  return job;
}

async function ingestMarketplaceOrder(restaurantId, source, payload) {
  const orders = await readDoc(restaurantId, 'ops', 'marketplace_inbox', []);
  const arr = Array.isArray(orders) ? orders : [];
  const row = {
    id: `mp_${source}_${Date.now().toString(36)}`,
    source,
    external_id: payload.external_id || payload.id || payload.order_id || null,
    status: 'pending_import',
    customer: payload.customer || null,
    items: payload.items || [],
    total: payload.total != null ? round2(payload.total) : null,
    raw: payload,
    received_at: new Date().toISOString(),
  };
  arr.unshift(row);
  await writeDoc(restaurantId, 'ops', 'marketplace_inbox', arr.slice(0, 200));
  return row;
}

module.exports = { dispatch, ingestMarketplaceOrder, getIntegration };
