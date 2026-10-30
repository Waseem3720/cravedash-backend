const express = require('express');
const crypto = require('crypto');
const pool = require('@cravedash/shared/src/db');
const { buildCrud } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { notFound, forbidden, badRequest } = require('@cravedash/shared/src/errors');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { clearStripeCache } = require('@cravedash/shared/src/stripeClient');
const stripeOps = require('./stripeOps');

const router = express.Router();

// Live Stripe dual-rail ops (connect, intents, checkout, payouts, refunds)
router.use(stripeOps);

const RESTAURANT_DATA_KEYS = new Set([
  'modules',
  'access_level',
  'auto_deduct',
  'next_charge',
  'api_key',
  'api_key_status',
  'billing_cycle',
  'expires_at',
  'branches',
  'max_branches',
  'pay_api',
  'joined_at',
  'card_brand',
  'card_last4',
  'stripe_account',
  'charges_enabled',
  'payouts_enabled',
  'stripe_balance',
  'monthly_gmv',
  'vat_registered',
  'vat_number',
  'currency',
  'timezone',
  'compliance',
  'services',
  'dash_widgets',
  'branch_list',
  'machinery',
  'tills_summary',
  'billing',
]);

function flattenRestaurant(row) {
  if (!row) return row;
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const out = { ...row, ...data };
  if (out.owner == null && row.owner != null) out.owner = row.owner;
  return out;
}

function prepareRestaurantBody(body, existing) {
  const topCols = new Set(['name', 'owner', 'email', 'phone', 'plan_id', 'sub_status', 'status', 'address', 'city', 'live_id']);
  const existingData = existing?.data && typeof existing.data === 'object' ? existing.data : {};
  const nextData = { ...existingData };
  const top = {};

  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    Object.assign(nextData, body.data);
  }

  Object.entries(body || {}).forEach(([k, v]) => {
    if (k === 'data' || k === 'id') return;
    if (topCols.has(k)) top[k] = v;
    else if (RESTAURANT_DATA_KEYS.has(k) || k.startsWith('pay_') || k.startsWith('stripe_')) {
      nextData[k] = v;
    } else {
      nextData[k] = v;
    }
  });

  top.data = nextData;
  return top;
}

function mountGlobal(path, table, opts = {}) {
  const crud = buildCrud(pool, table, {
    restaurantColumn: null,
    jsonColumns: opts.jsonColumns || ['data', 'features', 'perms'],
    parseRow: opts.parseRow,
    ...opts,
  });

  router.get(path, asyncHandler(async (req, res) => ok(res, await crud.list(null))));
  router.get(`${path}/:id`, asyncHandler(async (req, res) => {
    const row = await crud.getById(req.params.id, null);
    if (!row) throw notFound();
    ok(res, row);
  }));
  router.post(path, asyncHandler(async (req, res) => {
    const body = { ...req.body };
    if (!body.id) body.id = `${table.slice(0, 3)}_${Date.now().toString(36)}`;
    created(res, await crud.create(body, null));
  }));
  router.put(`${path}/:id`, asyncHandler(async (req, res) => ok(res, await crud.update(req.params.id, req.body, null))));
  router.patch(`${path}/:id`, asyncHandler(async (req, res) => ok(res, await crud.update(req.params.id, req.body, null))));
  router.delete(`${path}/:id`, asyncHandler(async (req, res) => ok(res, await crud.remove(req.params.id, null))));
}

mountGlobal('/plans', 'plans', { jsonColumns: ['features', 'data'] });
mountGlobal('/subscriptions', 'subscriptions', { jsonColumns: ['data'] });
mountGlobal('/admins', 'platform_admins', { jsonColumns: ['perms'] });

const restaurantsCrud = buildCrud(pool, 'restaurants', {
  jsonColumns: ['data'],
  parseRow: flattenRestaurant,
});

router.get('/restaurants', asyncHandler(async (req, res) => {
  const rows = await restaurantsCrud.list(null);
  ok(res, rows.map(flattenRestaurant));
}));

router.get('/restaurants/:id', asyncHandler(async (req, res) => {
  const row = await restaurantsCrud.getById(req.params.id, null);
  if (!row) throw notFound();
  ok(res, flattenRestaurant(row));
}));

router.post('/restaurants', asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (!body.id) body.id = `r${Date.now().toString(36)}`;
  const prepared = prepareRestaurantBody(body, { data: {} });
  created(res, flattenRestaurant(await restaurantsCrud.create(prepared, null)));
}));

router.put('/restaurants/:id', asyncHandler(async (req, res) => {
  const existing = await restaurantsCrud.getById(req.params.id, null);
  if (!existing) throw notFound();
  const prepared = prepareRestaurantBody(req.body, existing);
  ok(res, flattenRestaurant(await restaurantsCrud.update(req.params.id, prepared, null)));
}));

router.patch('/restaurants/:id', asyncHandler(async (req, res) => {
  const existing = await restaurantsCrud.getById(req.params.id, null);
  if (!existing) throw notFound();
  const prepared = prepareRestaurantBody(req.body, existing);
  ok(res, flattenRestaurant(await restaurantsCrud.update(req.params.id, prepared, null)));
}));

router.delete('/restaurants/:id', asyncHandler(async (req, res) => {
  ok(res, flattenRestaurant(await restaurantsCrud.remove(req.params.id, null)));
}));

const STRIPE_SECRET_KEYS = new Set([
  'secret_key', 'secret', 'sk', 'webhook_secret', 'webhookSecret', 'pk_secret',
]);

function looksLikeStripeSecret(val) {
  return typeof val === 'string' && (
    /^sk_(test|live)_/.test(val)
    || /^rk_(test|live)_/.test(val)
    || /^whsec_/.test(val)
  );
}

function maskOneSecret(val) {
  if (typeof val !== 'string' || val.length < 8) return val;
  return `${val.slice(0, 7)}…${val.slice(-4)}`;
}

/** Recursively mask nested Stripe secrets (keys.test.sk, webhook.secret, etc.). */
function maskStripeSecrets(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return data && typeof data === 'object' ? {} : data;
  if (Array.isArray(data)) return data.map((x) => maskStripeSecrets(x, depth + 1));
  const out = {};
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (v && typeof v === 'object') {
      out[k] = maskStripeSecrets(v, depth + 1);
      return;
    }
    if ((STRIPE_SECRET_KEYS.has(k) || looksLikeStripeSecret(v)) && typeof v === 'string' && v.length > 8) {
      out[k] = maskOneSecret(v);
      out[`${k}_masked`] = true;
      out[`${k}_configured`] = true;
    } else {
      out[k] = v;
    }
  });
  return out;
}

function restoreMaskedSecrets(incoming, prev, depth = 0) {
  if (!incoming || typeof incoming !== 'object' || depth > 8) return incoming;
  if (Array.isArray(incoming)) return incoming;
  const out = { ...incoming };
  Object.keys(out).forEach((k) => {
    if (k.endsWith('_masked') || k.endsWith('_configured')) {
      delete out[k];
      return;
    }
    const v = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = restoreMaskedSecrets(v, (prev && prev[k]) || {}, depth + 1);
      return;
    }
    if (typeof v === 'string' && (v.includes('…') || incoming[`${k}_masked`])) {
      if (prev && typeof prev[k] === 'string') out[k] = prev[k];
      else delete out[k];
    }
  });
  return out;
}

router.get('/stripe', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM stripe_config WHERE id = 1');
  ok(res, maskStripeSecrets(rows[0]?.data || {}));
}));

router.put('/stripe', asyncHandler(async (req, res) => {
  const incoming = req.body || {};
  const { rows: curRows } = await pool.query('SELECT data FROM stripe_config WHERE id = 1');
  const prev = (curRows[0] && curRows[0].data) || {};
  // Deep-merge while restoring any masked secret placeholders from previous config
  const mergedIncoming = restoreMaskedSecrets(incoming, prev);
  const data = { ...prev, ...mergedIncoming };
  if (mergedIncoming.keys && typeof mergedIncoming.keys === 'object') {
    data.keys = { ...(prev.keys || {}), ...mergedIncoming.keys };
    ['test', 'live'].forEach((mode) => {
      if (mergedIncoming.keys[mode] && typeof mergedIncoming.keys[mode] === 'object') {
        data.keys[mode] = {
          ...((prev.keys && prev.keys[mode]) || {}),
          ...mergedIncoming.keys[mode],
        };
      }
    });
  }
  if (mergedIncoming.webhook && typeof mergedIncoming.webhook === 'object') {
    data.webhook = { ...(prev.webhook || {}), ...mergedIncoming.webhook };
  }
  const { rows } = await pool.query(
    `INSERT INTO stripe_config (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [JSON.stringify(data)],
  );
  clearStripeCache();
  ok(res, maskStripeSecrets(rows[0].data));
}));

router.get('/platform/revenue', asyncHandler(async (req, res) => {
  const rawMonths = req.query.months;
  const parsedMonths = rawMonths !== undefined ? parseInt(rawMonths, 10) : 12;
  const months = Number.isInteger(parsedMonths)
    ? Math.min(24, Math.max(1, parsedMonths))
    : 12;
  const { rows: subRows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_subs,
            COUNT(*) AS total_subs FROM subscriptions`,
  );
  const { rows: restRows } = await pool.query(
    `SELECT COUNT(*) AS restaurants,
            COUNT(*) FILTER (WHERE sub_status = 'active') AS active_restaurants
     FROM restaurants`,
  );
  const { rows: planRows } = await pool.query(
    `SELECT p.name, COUNT(r.id)::int AS count
     FROM plans p LEFT JOIN restaurants r ON r.plan_id = p.id
     GROUP BY p.id, p.name ORDER BY count DESC`,
  );

  // Dynamic monthly ledger: calculate subscription revenue, commissions from eligible orders, and setup fees per month
  const { rows: monthRows } = await pool.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - (($1::int - 1) || ' months')::interval,
         date_trunc('month', NOW()),
         '1 month'::interval
       ) AS month_start
     ),
     sub_periods AS (
       -- Formal subscriptions table records with lifecycle window
       SELECT 
         s.restaurant_id,
         COALESCE(
           CASE WHEN s.data->>'price' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (s.data->>'price')::numeric END,
           CASE WHEN s.data->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (s.data->>'amount')::numeric END,
           CASE 
             WHEN s.data->>'billing_cycle' = 'yearly' THEN ROUND((COALESCE(p.price_yearly, 0) / 12)::numeric, 2)
             ELSE COALESCE(p.price_monthly, 0)
           END,
           0
         ) AS monthly_price,
         date_trunc('month', COALESCE(s.start_at, s.created_at)) AS start_month,
         CASE 
           WHEN s.status = 'canceled' AND s.end_at IS NULL THEN date_trunc('month', s.updated_at)
           WHEN s.end_at IS NOT NULL THEN date_trunc('month', s.end_at)
           ELSE NULL
         END AS end_month
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.status IN ('active', 'trialing', 'completed', 'canceled')
         AND (s.payment_status IS NULL OR s.payment_status = 'paid')

       UNION ALL

       -- Fallback for active restaurants that lack discrete subscriptions records
       SELECT 
         r.id AS restaurant_id,
         COALESCE(p.price_monthly, 0) AS monthly_price,
         date_trunc('month', r.created_at) AS start_month,
         NULL::timestamptz AS end_month
       FROM restaurants r
       JOIN plans p ON p.id = r.plan_id
       WHERE r.sub_status IN ('active', 'trialing')
         AND r.status IS DISTINCT FROM FALSE
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions s WHERE s.restaurant_id = r.id
         )
     ),
     setup_fees AS (
       -- Setup fees recorded in subscriptions
       SELECT 
         s.restaurant_id,
         CASE WHEN s.data->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (s.data->>'setup_fee')::numeric ELSE 0::numeric END AS setup_fee,
         date_trunc('month', COALESCE(s.start_at, s.created_at)) AS month_start
       FROM subscriptions s
       WHERE (s.data->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$')
         AND (s.data->>'setup_fee')::numeric > 0
         AND (s.payment_status IS NULL OR s.payment_status = 'paid')

       UNION ALL

       -- Setup fees recorded in restaurant billing (if not already captured in subscriptions)
       SELECT 
         r.id AS restaurant_id,
         COALESCE(
           CASE WHEN r.data->'billing'->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.data->'billing'->>'setup_fee')::numeric END,
           CASE WHEN r.data->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.data->>'setup_fee')::numeric END,
           0::numeric
         ) AS setup_fee,
         date_trunc('month', COALESCE((r.data->'billing'->>'setup_fee_paid_at')::timestamptz, r.created_at)) AS month_start
       FROM restaurants r
       WHERE COALESCE(
         CASE WHEN r.data->'billing'->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.data->'billing'->>'setup_fee')::numeric END,
         CASE WHEN r.data->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (r.data->>'setup_fee')::numeric END,
         0::numeric
       ) > 0
       AND NOT EXISTS (
         SELECT 1 FROM subscriptions s 
         WHERE s.restaurant_id = r.id 
           AND s.data->>'setup_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$'
           AND (s.data->>'setup_fee')::numeric > 0
       )
     ),
     active_subs_per_month AS (
       SELECT 
         m.month_start,
         sp.restaurant_id,
         MAX(sp.monthly_price) AS monthly_price
       FROM months m
       JOIN sub_periods sp 
         ON sp.start_month <= m.month_start 
        AND (sp.end_month IS NULL OR sp.end_month >= m.month_start)
       GROUP BY m.month_start, sp.restaurant_id
     ),
     monthly_subs AS (
       SELECT 
         m.month_start,
         COALESCE(SUM(asp.monthly_price), 0)::float AS subscription
       FROM months m
       LEFT JOIN active_subs_per_month asp ON asp.month_start = m.month_start
       GROUP BY m.month_start
     ),
     active_setups_per_month AS (
       SELECT 
         sf.month_start,
         sf.restaurant_id,
         MAX(sf.setup_fee) AS setup_fee
       FROM setup_fees sf
       GROUP BY sf.month_start, sf.restaurant_id
     ),
     monthly_setups AS (
       SELECT 
         m.month_start,
         COALESCE(SUM(asf.setup_fee), 0)::float AS setup_fee
       FROM months m
       LEFT JOIN active_setups_per_month asf ON asf.month_start = m.month_start
       GROUP BY m.month_start
     ),
     monthly_commissions AS (
       SELECT 
         m.month_start,
         COALESCE(SUM(
           CASE 
             WHEN o.data->>'commission' ~ '^-?[0-9]+(\\.[0-9]+)?$' 
               THEN (o.data->>'commission')::numeric
             WHEN o.data->>'application_fee' ~ '^-?[0-9]+(\\.[0-9]+)?$' 
               THEN (o.data->>'application_fee')::numeric
             WHEN r.data->'billing'->>'commission_type' = 'fixed' 
              AND r.data->'billing'->>'commission_value' ~ '^-?[0-9]+(\\.[0-9]+)?$' 
               THEN (r.data->'billing'->>'commission_value')::numeric
             WHEN r.data->'billing'->>'commission_value' ~ '^-?[0-9]+(\\.[0-9]+)?$' 
               THEN ROUND((COALESCE(o.total, 0) * (r.data->'billing'->>'commission_value')::numeric / 100)::numeric, 2)
             WHEN p.data->>'commission' ~ '^-?[0-9]+(\\.[0-9]+)?$' 
               THEN ROUND((COALESCE(o.total, 0) * (p.data->>'commission')::numeric / 100)::numeric, 2)
             ELSE 0::numeric
           END
         ), 0)::float AS commission
       FROM months m
       LEFT JOIN orders o 
         ON date_trunc('month', o.created_at) = m.month_start
        AND (o.payment_status = 'paid' OR o.status IN ('delivered', 'completed'))
        AND o.status NOT IN ('cancelled', 'refunded')
        AND (o.payment_status IS DISTINCT FROM 'refunded')
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN plans p ON p.id = r.plan_id
       GROUP BY m.month_start
     )
     SELECT 
       to_char(m.month_start, 'YYYY-MM') AS month,
       ROUND(COALESCE(ms.subscription, 0)::numeric, 2)::float AS subscription,
       ROUND(COALESCE(mc.commission, 0)::numeric, 2)::float AS commission,
       ROUND(COALESCE(mst.setup_fee, 0)::numeric, 2)::float AS setup_fee,
       ROUND((COALESCE(ms.subscription, 0) + COALESCE(mc.commission, 0) + COALESCE(mst.setup_fee, 0))::numeric, 2)::float AS total
     FROM months m
     LEFT JOIN monthly_subs ms ON ms.month_start = m.month_start
     LEFT JOIN monthly_commissions mc ON mc.month_start = m.month_start
     LEFT JOIN monthly_setups mst ON mst.month_start = m.month_start
     ORDER BY m.month_start ASC`,
    [months],
  );

  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const paidTotal = monthRows.reduce((s, r) => round2(s + Number(r.subscription || 0)), 0);
  const totalRevenue = monthRows.reduce((s, r) => round2(s + Number(r.total || 0)), 0);
  const totalCommission = monthRows.reduce((s, r) => round2(s + Number(r.commission || 0)), 0);
  const totalSetupFee = monthRows.reduce((s, r) => round2(s + Number(r.setup_fee || 0)), 0);

  ok(res, {
    subscriptions: subRows[0],
    restaurants: restRows[0],
    plans_breakdown: planRows,
    months: monthRows,
    series: monthRows,
    subscription_earnings_estimate: paidTotal,
    total_revenue: totalRevenue,
    commission_total: totalCommission,
    setup_fee_total: totalSetupFee,
    source: 'dynamic_monthly_ledger',
  });
}));

router.get('/platform', asyncHandler(async (req, res) => {
  const [plans, restaurants, subscriptions, admins] = await Promise.all([
    buildCrud(pool, 'plans', { jsonColumns: ['features', 'data'] }).list(null),
    restaurantsCrud.list(null),
    buildCrud(pool, 'subscriptions', { jsonColumns: ['data'] }).list(null),
    buildCrud(pool, 'platform_admins', { jsonColumns: ['perms'] }).list(null),
  ]);
  const { rows: stripeRows } = await pool.query('SELECT data FROM stripe_config WHERE id = 1');
  ok(res, {
    plans,
    restaurants: restaurants.map(flattenRestaurant),
    subscriptions,
    admins,
    stripe: maskStripeSecrets(stripeRows[0]?.data || {}),
  });
}));

// ---- Platform meta (settings / terms / languages) ----
router.get('/platform-meta/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM platform_meta WHERE id = $1', [req.params.id]);
  ok(res, rows[0]?.data || {});
}));

router.put('/platform-meta/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO platform_meta (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [req.params.id, JSON.stringify(req.body || {})],
  );
  ok(res, rows[0].data);
}));

function tenantRestaurantId(req) {
  if (req.user?.role === 'super') {
    return req.query.restaurant_id || req.headers['x-restaurant-id'] || null;
  }
  return restaurantId(req);
}

function assertTicketAccess(req, row) {
  if (!row) throw notFound();
  if (req.user?.role === 'super') return row;
  const rid = restaurantId(req);
  if (row.restaurant_id !== rid && !(row.data && row.data.restaurant_id === rid)) {
    throw forbidden('Ticket belongs to another restaurant');
  }
  return row;
}

// ---- Support tickets (tenant-scoped for restaurant/epos) ----
(function mountSupportTickets() {
  const crud = buildCrud(pool, 'support_tickets', { restaurantColumn: null, jsonColumns: ['messages', 'data'] });
  router.get('/support-tickets', asyncHandler(async (req, res) => {
    let sql = 'SELECT * FROM support_tickets';
    const params = [];
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      params.push(rid);
      sql += ` WHERE (restaurant_id = $1 OR (data->>'restaurant_id') = $1)`;
    } else {
      const filter = tenantRestaurantId(req);
      if (filter) {
        params.push(filter);
        sql += ` WHERE (restaurant_id = $1 OR (data->>'restaurant_id') = $1)`;
      }
    }
    sql += ' ORDER BY created_at DESC, id ASC';
    const { rows } = await pool.query(sql, params);
    ok(res, rows);
  }));
  router.get('/support-tickets/:id', asyncHandler(async (req, res) => {
    ok(res, assertTicketAccess(req, await crud.getById(req.params.id, null)));
  }));
  function sanitizeTicket(body, forceRid, req) {
    const b = { ...(body || {}) };
    if (b.msgs && !b.messages) b.messages = b.msgs;
    const data = Object.assign({}, b.data || {});
    if (b.category) data.category = b.category;
    if (b.till) data.till = b.till;
    if (b.tillName) data.tillName = b.tillName;
    if (b.unread_admin != null) data.unread_admin = b.unread_admin;
    if (b.unread_epos != null) data.unread_epos = b.unread_epos;
    const isSuper = req?.user?.role === 'super';
    // Tenants cannot self-assign, resolve, or close tickets as platform staff
    if (isSuper && b.resolved_at) data.resolved_at = b.resolved_at;
    const out = {
      id: b.id,
      restaurant_id: forceRid || b.restaurant_id,
      restaurant_name: b.restaurant_name || b.restaurant,
      subject: b.subject,
      priority: b.priority,
      channel: b.channel,
      requester: b.requester || b.staff,
      body: b.body,
      messages: b.messages,
      data,
    };
    if (isSuper) {
      out.status = b.status;
      out.assignee = b.assignee;
    } else {
      // Restaurant may only open / cancel their own tickets
      const allowed = new Set(['open', 'canceled', 'cancelled']);
      if (b.status && allowed.has(String(b.status).toLowerCase())) {
        out.status = String(b.status).toLowerCase() === 'cancelled' ? 'canceled' : b.status;
      } else if (b.status == null) {
        out.status = 'open';
      }
    }
    return out;
  }
  router.post('/support-tickets', asyncHandler(async (req, res) => {
    const forceRid = req.user?.role === 'super' ? (req.body?.restaurant_id || null) : restaurantId(req);
    if (!forceRid && req.user?.role !== 'super') throw badRequest('restaurant_id required');
    const body = sanitizeTicket(req.body, forceRid, req);
    if (!body.id) body.id = `TK-${Date.now().toString(36)}`;
    if (!body.restaurant_id) body.restaurant_id = forceRid;
    if (req.user?.role !== 'super') body.status = body.status || 'open';
    created(res, await crud.create(body, null));
  }));
  router.post('/support/contact', asyncHandler(async (req, res) => {
    const forceRid = req.user?.restaurant_id || req.headers['x-restaurant-id'] || 'r1';
    const body = req.body || {};
    const ticketId = `TK-${Date.now().toString(36)}`;
    const ticketRecord = {
      id: ticketId,
      restaurant_id: forceRid,
      subject: `Kitchen Support Inquiry: ${body.message ? String(body.message).slice(0, 40) : 'Inquiry'}...`,
      status: 'open',
      priority: 'normal',
      messages: [{
        sender: body.email || 'Chef',
        phone: body.phone ? `${body.country_code || ''}${body.phone}` : '',
        body: body.message || 'Support inquiry from chef',
        at: new Date().toISOString(),
      }],
      data: {
        email: body.email,
        phone: body.phone,
        country_code: body.country_code,
        source: 'chef_app',
      },
    };
    await crud.create(ticketRecord, null);
    created(res, {
      ticket_id: ticketId,
      message: 'Support inquiry submitted successfully',
      created_at: new Date().toISOString(),
    });
  }));
  router.put('/support-tickets/:id', asyncHandler(async (req, res) => {
    const existing = assertTicketAccess(req, await crud.getById(req.params.id, null));
    const forceRid = req.user?.role === 'super' ? undefined : existing.restaurant_id;
    const body = sanitizeTicket(req.body, forceRid, req);
    if (req.user?.role !== 'super') {
      body.restaurant_id = existing.restaurant_id;
      delete body.assignee;
      if (body.status == null) delete body.status;
    }
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.patch('/support-tickets/:id', asyncHandler(async (req, res) => {
    const existing = assertTicketAccess(req, await crud.getById(req.params.id, null));
    const forceRid = req.user?.role === 'super' ? undefined : existing.restaurant_id;
    const body = sanitizeTicket(req.body, forceRid, req);
    if (req.user?.role !== 'super') {
      body.restaurant_id = existing.restaurant_id;
      delete body.assignee;
      if (body.status == null) delete body.status;
    }
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.delete('/support-tickets/:id', asyncHandler(async (req, res) => {
    assertTicketAccess(req, await crud.getById(req.params.id, null));
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can delete tickets');
    ok(res, await crud.remove(req.params.id, null));
  }));
})();

// ---- Payouts (super only via platformGate) ----
(function mountPayouts() {
  const crud = buildCrud(pool, 'payouts', { restaurantColumn: null, jsonColumns: ['data'] });
  const TOP = new Set(['id', 'restaurant_id', 'amount', 'status', 'note', 'ref', 'paid_at', 'data']);
  function packPayout(body) {
    const b = { ...(body || {}) };
    const data = { ...(b.data && typeof b.data === 'object' ? b.data : {}) };
    Object.keys(b).forEach((k) => {
      if (!TOP.has(k) && k !== 'id') {
        data[k] = b[k];
        delete b[k];
      }
    });
    b.data = data;
    return b;
  }
  function unpackPayout(row) {
    if (!row) return row;
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    return {
      ...row,
      restaurant: row.restaurant || data.restaurant,
      kind: row.kind || data.kind,
      requested_at: row.requested_at || data.requested_at || row.created_at,
      by: row.by || data.by,
      paid_at: row.paid_at || data.paid_at,
    };
  }
  router.get('/payouts', asyncHandler(async (req, res) => {
    let sql = 'SELECT * FROM payouts';
    const params = [];
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      params.push(rid);
      sql += ' WHERE restaurant_id = $1';
    } else if (req.query.restaurant_id) {
      params.push(req.query.restaurant_id);
      sql += ' WHERE restaurant_id = $1';
    }
    sql += ' ORDER BY created_at DESC, id ASC';
    const { rows } = await pool.query(sql, params);
    ok(res, rows.map(unpackPayout));
  }));
  router.get('/payouts/:id', asyncHandler(async (req, res) => {
    const row = unpackPayout(await crud.getById(req.params.id, null));
    if (!row) throw notFound();
    if (req.user?.role !== 'super' && row.restaurant_id !== restaurantId(req)) {
      throw forbidden('Payout belongs to another restaurant');
    }
    ok(res, row);
  }));
  router.post('/payouts', asyncHandler(async (req, res) => {
    let body = packPayout(req.body);
    if (!body.id) body.id = `po_${Date.now().toString(36)}`;
    if (req.user?.role !== 'super') {
      body.restaurant_id = restaurantId(req);
      body.status = 'requested';
      body.data = { ...(body.data || {}), kind: body.data?.kind || 'request' };
    }
    if (!body.restaurant_id) throw badRequest('restaurant_id required');
    created(res, unpackPayout(await crud.create(body, null)));
  }));
  router.put('/payouts/:id', asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can update payouts');
    ok(res, unpackPayout(await crud.update(req.params.id, packPayout(req.body), null)));
  }));
  router.patch('/payouts/:id', asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can update payouts');
    ok(res, unpackPayout(await crud.update(req.params.id, packPayout(req.body), null)));
  }));
  router.delete('/payouts/:id', asyncHandler(async (req, res) => {
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can delete payouts');
    ok(res, await crud.remove(req.params.id, null));
  }));
})();

// ---- Refund requests (tenant-scoped for restaurant) ----
(function mountRefunds() {
  const crud = buildCrud(pool, 'refund_requests', { restaurantColumn: null, jsonColumns: ['data'] });
  function assertRefund(req, row) {
    if (!row) throw notFound();
    if (req.user?.role === 'super') return row;
    if (row.restaurant_id !== restaurantId(req)) throw forbidden('Refund belongs to another restaurant');
    return row;
  }
  router.get('/refund-requests', asyncHandler(async (req, res) => {
    let sql = 'SELECT * FROM refund_requests';
    const params = [];
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      params.push(rid);
      sql += ' WHERE restaurant_id = $1';
    } else if (req.query.restaurant_id) {
      params.push(req.query.restaurant_id);
      sql += ' WHERE restaurant_id = $1';
    }
    sql += ' ORDER BY created_at DESC, id ASC';
    const { rows } = await pool.query(sql, params);
    ok(res, rows);
  }));
  router.get('/refund-requests/:id', asyncHandler(async (req, res) => {
    ok(res, assertRefund(req, await crud.getById(req.params.id, null)));
  }));
  function sanitizeRefundWrite(req, body, existing) {
    const out = { ...(body || {}) };
    if (req.user?.role === 'super') return out;
    out.restaurant_id = existing ? existing.restaurant_id : restaurantId(req);
    // Tenants may open / cancel pending requests only — never self-approve
    if (!existing) {
      out.status = 'pending';
    } else if (out.status !== undefined && out.status !== existing.status) {
      const next = String(out.status).toLowerCase();
      if (!(String(existing.status).toLowerCase() === 'pending' && next === 'canceled')) {
        throw forbidden('Only platform admins can change refund request status');
      }
    }
    return out;
  }
  router.post('/refund-requests', asyncHandler(async (req, res) => {
    let body = { ...(req.body || {}) };
    if (!body.id) body.id = `rf_${Date.now().toString(36)}`;
    body = sanitizeRefundWrite(req, body, null);
    if (!body.restaurant_id) throw badRequest('restaurant_id required');
    created(res, await crud.create(body, null));
  }));
  router.put('/refund-requests/:id', asyncHandler(async (req, res) => {
    const existing = assertRefund(req, await crud.getById(req.params.id, null));
    const body = sanitizeRefundWrite(req, req.body || {}, existing);
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.patch('/refund-requests/:id', asyncHandler(async (req, res) => {
    const existing = assertRefund(req, await crud.getById(req.params.id, null));
    const body = sanitizeRefundWrite(req, req.body || {}, existing);
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.delete('/refund-requests/:id', asyncHandler(async (req, res) => {
    assertRefund(req, await crud.getById(req.params.id, null));
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can delete refunds');
    ok(res, await crud.remove(req.params.id, null));
  }));
})();

// ---- Audit events ----
router.get('/audit-events', asyncHandler(async (req, res) => {
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 200;

  const where = [];
  const params = [];

  if (req.query.restaurant_id && typeof req.query.restaurant_id === 'string' && req.query.restaurant_id.trim()) {
    params.push(req.query.restaurant_id.trim());
    where.push(`restaurant_id = $${params.length}`);
  }
  if (req.query.actor && typeof req.query.actor === 'string' && req.query.actor.trim()) {
    params.push(req.query.actor.trim());
    where.push(`actor = $${params.length}`);
  }
  if (req.query.action && typeof req.query.action === 'string' && req.query.action.trim()) {
    params.push(req.query.action.trim());
    where.push(`action = $${params.length}`);
  }
  if (req.query.entity_type && typeof req.query.entity_type === 'string' && req.query.entity_type.trim()) {
    params.push(req.query.entity_type.trim());
    where.push(`entity_type = $${params.length}`);
  }
  if (req.query.entity_id && typeof req.query.entity_id === 'string' && req.query.entity_id.trim()) {
    params.push(req.query.entity_id.trim());
    where.push(`entity_id = $${params.length}`);
  }

  params.push(limit);
  const sql = `SELECT * FROM audit_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  ok(res, rows);
}));

router.post('/audit-events', asyncHandler(async (req, res) => {
  const b = req.body || {};

  // 1. Mandatory non-empty action validation
  if (!b.action || typeof b.action !== 'string' || !b.action.trim()) {
    throw badRequest('Valid audit action is required');
  }
  const action = b.action.trim();
  if (action.length > 100) {
    throw badRequest('Audit action must not exceed 100 characters');
  }

  // 2. Server-generated collision-resistant ID (reject client-controlled primary key)
  const id = `ae_${crypto.randomUUID()}`;

  // 3. Derive actor strictly from authenticated session
  const actor = req.user?.email || req.user?.id || req.user?.sub || 'system';

  // 4. Safely handle structured data payload
  let data = {};
  if (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) {
    data = { ...b.data };
  } else if (typeof b.data === 'string') {
    try {
      const parsed = JSON.parse(b.data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch {
      throw badRequest('Invalid JSON in data payload');
    }
  }

  // Preserve requested_actor if caller submitted a differing actor for forensic logging without forging actor column
  if (b.actor && typeof b.actor === 'string' && b.actor !== actor) {
    data.requested_actor = b.actor;
  }

  // 5. Sanitize entity and restaurant references
  const entityType = b.entity_type && typeof b.entity_type === 'string' ? b.entity_type.trim() : null;
  const entityId = b.entity_id && typeof b.entity_id === 'string' ? b.entity_id.trim() : null;
  const restaurantId = b.restaurant_id && typeof b.restaurant_id === 'string' ? b.restaurant_id.trim() : null;
  const detail = b.detail && typeof b.detail === 'string' ? b.detail.trim() : null;

  const { rows } = await pool.query(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      id,
      actor,
      action,
      entityType,
      entityId,
      restaurantId,
      detail,
      JSON.stringify(data),
    ],
  );
  created(res, rows[0]);
}));

module.exports = router;
