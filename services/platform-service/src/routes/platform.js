const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const accounting = require('@cravedash/shared/src/engines/accounting');
const { buildCrud, removeWithDependants } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { notFound, forbidden, badRequest } = require('@cravedash/shared/src/errors');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { idempotent } = require('@cravedash/shared/src/idempotency');
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

/**
 * Coerce an incoming status value to the boolean the DB column expects.
 * Accepts true/false, "true"/"false", "active"/"inactive", 1/0. undefined = not supplied, null = null.
 */
function toStatusBool(value, field = 'status') {
  if (value === undefined || value === null) return value;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'active' || v === '1') return true;
    if (v === 'false' || v === 'inactive' || v === '0') return false;
  }
  throw badRequest(`${field} must be true/false, "active"/"inactive", or 1/0`);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Non-negative number (accepts numeric strings). undefined = not supplied; null only if allowNull. */
function toNonNegativeNumber(value, field, allowNull = false) {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a number >= 0`);
  return n;
}

function preparePlanBody(body, { create }) {
  const b = { ...(body || {}) };
  if (create) {
    if (!isNonEmptyString(b.name)) throw badRequest('name is required');
    if (b.price_monthly === undefined) throw badRequest('price_monthly is required');
  } else if (b.name !== undefined && !isNonEmptyString(b.name)) {
    throw badRequest('name must be a non-empty string');
  }
  if ('price_monthly' in b) b.price_monthly = toNonNegativeNumber(b.price_monthly, 'price_monthly');
  if ('price_yearly' in b) b.price_yearly = toNonNegativeNumber(b.price_yearly, 'price_yearly', true);
  if ('status' in b) b.status = toStatusBool(b.status);
  return b;
}

/** platform_admins.perms is jsonb. "ALL" is stored as the JSON string "ALL" (read back as "ALL", which
 *  adminPerms() in the frontend and the rest of the code already expect); arrays are stored as JSON arrays. */
function normalisePerms(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value.trim().toUpperCase() === 'ALL') return JSON.stringify('ALL');
    throw badRequest('perms must be "ALL", an array of permission keys, or null');
  }
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value;
  throw badRequest('perms must be "ALL", an array of permission keys, or null');
}

function prepareAdminBody(body, { create }) {
  const b = { ...(body || {}) };
  if (create) {
    if (!isNonEmptyString(b.name)) throw badRequest('name is required');
    if (!isNonEmptyString(b.email)) throw badRequest('email is required');
  }
  if ('status' in b) b.status = toStatusBool(b.status);
  if ('perms' in b) b.perms = normalisePerms(b.perms);
  return b;
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
    if (k === 'status') top.status = toStatusBool(v);
    else if (topCols.has(k)) top[k] = v;
    else if (RESTAURANT_DATA_KEYS.has(k) || k.startsWith('pay_') || k.startsWith('stripe_')) {
      nextData[k] = v;
    } else {
      nextData[k] = v;
    }
  });

  top.data = nextData;
  return top;
}

/**
 * Phase 2 limit: a branch's services must be a subset of the restaurant's services. A branch with no services list
 * inherits the restaurant's full list, so only an explicit list is checked here.
 */
function assertBranchServicesWithinRestaurant(data) {
  const branches = Array.isArray(data?.branch_list) ? data.branch_list : [];
  const allowed = new Set(Array.isArray(data?.services) ? data.services.map(String) : []);
  for (const b of branches) {
    if (!b || !Array.isArray(b.services)) continue;
    if (b.services.some((s) => !allowed.has(String(s)))) {
      throw badRequest(`Branch "${b.name || b.id}" has a service the restaurant does not have`);
    }
  }
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
  const prep = (body, create) => (opts.prepare ? opts.prepare(body || {}, { create }) : body);
  router.post(path, asyncHandler(async (req, res) => {
    const body = { ...prep(req.body, true) };
    if (!body.id) body.id = `${table.slice(0, 3)}_${Date.now().toString(36)}`;
    created(res, await crud.create(body, null));
  }));
  router.put(`${path}/:id`, asyncHandler(async (req, res) => ok(res, await crud.update(req.params.id, prep(req.body, false), null))));
  router.patch(`${path}/:id`, asyncHandler(async (req, res) => ok(res, await crud.update(req.params.id, prep(req.body, false), null))));
  // SEC-M8: opts.dependants refuses the delete with 409 and counts while rows still reference this one.
  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    if (opts.dependants) {
      return ok(res, await removeWithDependants(pool, {
        table,
        id: req.params.id,
        restaurantColumn: null,
        dependants: opts.dependants,
      }));
    }
    return ok(res, await crud.remove(req.params.id, null));
  }));
}

mountGlobal('/plans', 'plans', {
  jsonColumns: ['features', 'data'],
  prepare: preparePlanBody,
  dependants: [
    { table: 'restaurants', column: 'plan_id', label: 'restaurants', restaurantColumn: null },
    { table: 'subscriptions', column: 'plan_id', label: 'subscriptions', restaurantColumn: null },
  ],
});
mountGlobal('/subscriptions', 'subscriptions', { jsonColumns: ['data'] });
mountGlobal('/admins', 'platform_admins', { jsonColumns: ['perms'], prepare: prepareAdminBody });

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

// Next plain numeric restaurant id (17, 18, …). Legacy `r`-prefixed ids are counted too.
// A concurrent duplicate fails on the primary key, it never overwrites.
async function nextRestaurantId() {
  const { rows } = await pool.query(
    "SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^r', '') AS INTEGER)), 0) + 1 AS next FROM restaurants WHERE id ~ '^r?[0-9]+$'",
  );
  return String(rows[0].next);
}

router.post('/restaurants', asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (!isNonEmptyString(body.name)) throw badRequest('name is required');
  if (!body.id) body.id = await nextRestaurantId();
  const prepared = prepareRestaurantBody(body, { data: {} });
  assertBranchServicesWithinRestaurant(prepared.data);
  prepared.id = body.id; // prepareRestaurantBody drops id; a create must keep it
  created(res, flattenRestaurant(await restaurantsCrud.create(prepared, null)));
}));

router.put('/restaurants/:id', asyncHandler(async (req, res) => {
  const existing = await restaurantsCrud.getById(req.params.id, null);
  if (!existing) throw notFound();
  if (req.body?.name !== undefined && !isNonEmptyString(req.body.name)) throw badRequest('name must be a non-empty string');
  const prepared = prepareRestaurantBody(req.body, existing);
  assertBranchServicesWithinRestaurant(prepared.data);
  ok(res, flattenRestaurant(await restaurantsCrud.update(req.params.id, prepared, null)));
}));

router.patch('/restaurants/:id', asyncHandler(async (req, res) => {
  const existing = await restaurantsCrud.getById(req.params.id, null);
  if (!existing) throw notFound();
  if (req.body?.name !== undefined && !isNonEmptyString(req.body.name)) throw badRequest('name must be a non-empty string');
  const prepared = prepareRestaurantBody(req.body, existing);
  assertBranchServicesWithinRestaurant(prepared.data);
  ok(res, flattenRestaurant(await restaurantsCrud.update(req.params.id, prepared, null)));
}));

/**
 * SEC-M8: a restaurant that still has orders, payments, refunds, products, customers or staff is not deleted. The cascade
 * from restaurants would remove that data silently. The 409 names each count. Dependants are matched on restaurant_id = id.
 */
const RESTAURANT_DEPENDANTS = [
  { table: 'orders', column: 'restaurant_id', label: 'orders', restaurantColumn: null },
  { table: 'payouts', column: 'restaurant_id', label: 'payouts', restaurantColumn: null },
  { table: 'refund_requests', column: 'restaurant_id', label: 'refund requests', restaurantColumn: null },
  { table: 'products', column: 'restaurant_id', label: 'products', restaurantColumn: null },
  { table: 'categories', column: 'restaurant_id', label: 'categories', restaurantColumn: null },
  { table: 'customers', column: 'restaurant_id', label: 'customers', restaurantColumn: null },
  { table: 'deliverymen', column: 'restaurant_id', label: 'riders', restaurantColumn: null },
  { table: 'chefs', column: 'restaurant_id', label: 'chefs', restaurantColumn: null },
  { table: 'subscriptions', column: 'restaurant_id', label: 'subscriptions', restaurantColumn: null },
  // BUG-021: logins, staff data, rider pay and print history are tenant data too. A restaurant that still has any of them
  // is refused (409) instead of being deleted and leaving them attached to a reusable restaurant id.
  { table: 'users', column: 'restaurant_id', label: 'logins', restaurantColumn: null },
  { table: 'domain_docs', column: 'restaurant_id', label: 'documents', restaurantColumn: null },
  { table: 'domain_rows', column: 'restaurant_id', label: 'records', restaurantColumn: null },
  { table: 'driver_pay_policies', column: 'restaurant_id', label: 'rider pay policies', restaurantColumn: null },
  { table: 'driver_payments', column: 'restaurant_id', label: 'rider payments', restaurantColumn: null },
  { table: 'driver_cash_settlements', column: 'restaurant_id', label: 'rider cash settlements', restaurantColumn: null },
  { table: 'print_jobs', column: 'restaurant_id', label: 'print jobs', restaurantColumn: null },
  { table: 'restaurant_blobs', column: 'restaurant_id', label: 'settings blobs', restaurantColumn: null },
];

router.delete('/restaurants/:id', asyncHandler(async (req, res) => {
  const row = await removeWithDependants(pool, {
    table: 'restaurants',
    id: req.params.id,
    restaurantColumn: null,
    dependants: RESTAURANT_DEPENDANTS,
  });
  ok(res, flattenRestaurant(row));
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
  const client = await pool.connect();
  let saved;
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO stripe_config (id, data, updated_at) VALUES (1, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING");
    // SEC-M12: the read and the writes happen under one row lock, and each changed key is set with jsonb_set.
    // A key this request does not send is never rewritten, so a concurrent save of another key is kept.
    const { rows: curRows } = await client.query('SELECT data FROM stripe_config WHERE id = 1 FOR UPDATE');
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
    for (const key of Object.keys(mergedIncoming)) {
      await client.query(
        'UPDATE stripe_config SET data = jsonb_set(data, $1::text[], $2::jsonb, true), updated_at = NOW() WHERE id = 1',
        [[key], JSON.stringify(data[key] === undefined ? null : data[key])],
      );
    }
    const { rows } = await client.query('SELECT data FROM stripe_config WHERE id = 1');
    await client.query('COMMIT');
    saved = rows[0].data;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  clearStripeCache();
  ok(res, maskStripeSecrets(saved));
}));

router.get('/platform/revenue', asyncHandler(async (req, res) => {
  const months = Math.min(24, Math.max(1, +(req.query.months || 12)));
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
  // Monthly estimated subscription revenue from active plan prices (until invoice ledger exists)
  const { rows: monthEst } = await pool.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - (($1::int - 1) || ' months')::interval,
         date_trunc('month', NOW()),
         '1 month'::interval
       ) AS month
     ),
     active AS (
       SELECT COALESCE(SUM(p.price_monthly), 0)::float AS mrr
       FROM restaurants r
       JOIN plans p ON p.id = r.plan_id
       WHERE r.sub_status IN ('active', 'trialing') AND r.status IS DISTINCT FROM FALSE
     )
     SELECT to_char(m.month, 'YYYY-MM') AS month,
            (SELECT mrr FROM active) AS subscription,
            0::float AS commission,
            0::float AS setup_fee,
            (SELECT mrr FROM active) AS total
     FROM months m
     ORDER BY m.month`,
    [months],
  );
  const paidTotal = monthEst.reduce((s, r) => s + Number(r.subscription || 0), 0);
  ok(res, {
    subscriptions: subRows[0],
    restaurants: restRows[0],
    plans_breakdown: planRows,
    months: monthEst,
    series: monthEst,
    subscription_earnings_estimate: paidTotal,
    source: 'plan_mrr_estimate',
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
  // Only the restaurant_id column decides ownership. A restaurant_id inside `data` is client input (SEC-H7).
  if (row.restaurant_id !== rid) {
    throw forbidden('Ticket belongs to another restaurant');
  }
  // A branch login sees only its own branch's tickets. The owner sees every ticket of the restaurant (consolidated).
  const bound = branchId(req);
  if (bound && String(row.branch_id || '') !== String(bound)) throw notFound();
  return row;
}

// ---- Support tickets (tenant-scoped for restaurant/epos) ----
(function mountSupportTickets() {
  const crud = buildCrud(pool, 'support_tickets', { restaurantColumn: null, jsonColumns: ['messages', 'data'] });
  router.get('/support-tickets', asyncHandler(async (req, res) => {
    let rows = await crud.list(null);
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      rows = rows.filter((t) => t.restaurant_id === rid);
      const bound = branchId(req);
      if (bound) rows = rows.filter((t) => String(t.branch_id || '') === String(bound));
    } else {
      const filter = tenantRestaurantId(req);
      if (filter) {
        rows = rows.filter((t) => t.restaurant_id === filter);
      }
    }
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
    // Tenant scope is the restaurant_id column only, never a value the client put inside data (SEC-H7).
    delete data.restaurant_id;
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
    // A branch login's tickets belong to its branch, whatever the body says. The owner's tickets have no branch.
    if (req.user?.role !== 'super') body.branch_id = branchId(req) || null;
    created(res, await crud.create(body, null));
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
    let rows = (await crud.list(null)).map(unpackPayout);
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      rows = rows.filter((p) => p.restaurant_id === rid);
    } else if (req.query.restaurant_id) {
      rows = rows.filter((p) => p.restaurant_id === req.query.restaurant_id);
    }
    ok(res, rows);
  }));
  router.get('/payouts/:id', asyncHandler(async (req, res) => {
    const row = unpackPayout(await crud.getById(req.params.id, null));
    if (!row) throw notFound();
    if (req.user?.role !== 'super' && row.restaurant_id !== restaurantId(req)) {
      throw forbidden('Payout belongs to another restaurant');
    }
    ok(res, row);
  }));
  router.post('/payouts', idempotent('payouts'), asyncHandler(async (req, res) => {
    let body = packPayout(req.body);
    if (!body.id) body.id = `po_${Date.now().toString(36)}`;
    if (req.user?.role !== 'super') {
      body.restaurant_id = restaurantId(req);
      body.status = 'requested';
      // A tenant request cannot choose its kind, Stripe destination, totals or order list. Those come from the server (SEC-C5).
      const { kind, stripe_account, totals, order_ids, period, ...safeData } = body.data || {};
      body.data = { ...safeData, kind: 'request' };
      if (!Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) throw badRequest('amount must be a positive number');
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
    let rows = await crud.list(null);
    if (req.user?.role !== 'super') {
      const rid = restaurantId(req);
      rows = rows.filter((r) => r.restaurant_id === rid);
    } else if (req.query.restaurant_id) {
      rows = rows.filter((r) => r.restaurant_id === req.query.restaurant_id);
    }
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
      const tillCashApproval = req.managerApproved === true && next === 'approved';
      if (!tillCashApproval && !(String(existing.status).toLowerCase() === 'pending' && next === 'canceled')) {
        throw forbidden('Only platform admins can change refund request status');
      }
    }
    return out;
  }
  router.post('/refund-requests', idempotent('refund-requests'), asyncHandler(async (req, res) => {
    let body = { ...(req.body || {}) };
    if (!body.id) body.id = `rf_${Date.now().toString(36)}`;
    body = sanitizeRefundWrite(req, body, null);
    if (!body.restaurant_id) throw badRequest('restaurant_id required');
    created(res, await crud.create(body, null));
  }));
  /**
   * A cash refund at the till is approved only with the PIN of a restaurant manager (can_approve) (cash refund decision).
   * The PIN is read from the body and removed from it, so it is never stored. Any other request gets false.
   */
  async function verifyCashRefundManager(req, existing) {
    const pin = req.body && req.body.manager_pin;
    if (req.body) delete req.body.manager_pin;
    if (req.user?.role !== 'epos' || String(req.body?.status || '').toLowerCase() !== 'approved') return false;
    const method = String(existing.method || (existing.data && existing.data.method) || '').toLowerCase();
    if (method !== 'cash') return false;
    if (!/^\d{4,8}$/.test(String(pin || ''))) throw forbidden('A manager PIN is required to approve a cash refund');
    const { rows } = await pool.query(
      "SELECT pin_hash FROM till_staff WHERE restaurant_id = $1 AND COALESCE(status, TRUE) = TRUE AND COALESCE((data->>'can_approve')::boolean, FALSE) = TRUE AND pin_hash IS NOT NULL",
      [existing.restaurant_id],
    );
    for (const row of rows) {
      if (await bcrypt.compare(String(pin), row.pin_hash)) return true;
    }
    throw forbidden('The manager PIN is not valid for this restaurant');
  }

  /**
   * A manual (non-Stripe) refund approved by a platform admin is recorded on its order, under the same cap as
   * Stripe refunds (FE-H1 / ORD-H7). Stripe refunds record themselves in the Stripe route, so they are skipped here.
   */
  async function recordManualRefundApproval(existing, body) {
    const approving = String(body.status || '').toLowerCase() === 'approved'
      && String(existing.status || '').toLowerCase() !== 'approved';
    if (!approving || !existing.order_id) return;
    const rd = existing.data && typeof existing.data === 'object' ? existing.data : {};
    if (rd.stripe_refund_id) return;
    const amount = Math.round(Number(existing.amount || 0) * 100) / 100;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // BUG-023: the refund request's own restaurant must own the order. A bare id lookup could move another tenant's refund cap.
      const { rows } = await client.query(
        'SELECT total, data, created_at FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
        [existing.order_id, existing.restaurant_id],
      );
      if (!rows[0]) throw notFound('Order not found for this refund');
      const already = Number((rows[0].data && rows[0].data.refund_amount) || 0);
      const remaining = Math.round((Number(rows[0].total) - already) * 100) / 100;
      if (!(amount > 0) || amount > remaining + 0.005) {
        const err = new Error(`Only ${Math.max(0, remaining).toFixed(2)} can still be refunded on this order`);
        err.status = 409;
        throw err;
      }
      await client.query(
        `UPDATE orders SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('refund_amount', $2::numeric), updated_at = NOW()
         WHERE id = $1`,
        [existing.order_id, Math.round((already + amount) * 100) / 100],
      );
      await client.query('COMMIT');
      // BUG-017: the refunded share of the sale is reversed in the ledger. A posting failure is flagged on the order for reconciliation.
      const total = Number(rows[0].total);
      const fullyRefunded = Math.round((already + amount) * 100) / 100 + 0.009 >= total;
      try {
        await accounting.postRefundSale(existing.restaurant_id, {
          id: existing.order_id, total, created_at: rows[0].created_at, restaurant_id: existing.restaurant_id,
        }, { refundAmount: amount, refundKey: `request-${existing.id}`, fullyRefunded });
      } catch (postErr) {
        await pool.query(
          `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
          [existing.order_id, JSON.stringify({ refund_journal_pending: { refund_request_id: existing.id, error: String(postErr.message || '').slice(0, 200) } })],
        ).catch(() => {});
        console.error('[refunds] ledger posting pending for order', existing.order_id, postErr.message);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  router.put('/refund-requests/:id', asyncHandler(async (req, res) => {
    const existing = assertRefund(req, await crud.getById(req.params.id, null));
    req.managerApproved = await verifyCashRefundManager(req, existing);
    const body = sanitizeRefundWrite(req, req.body || {}, existing);
    await recordManualRefundApproval(existing, body);
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.patch('/refund-requests/:id', asyncHandler(async (req, res) => {
    const existing = assertRefund(req, await crud.getById(req.params.id, null));
    req.managerApproved = await verifyCashRefundManager(req, existing);
    const body = sanitizeRefundWrite(req, req.body || {}, existing);
    await recordManualRefundApproval(existing, body);
    ok(res, await crud.update(req.params.id, body, null));
  }));
  router.delete('/refund-requests/:id', asyncHandler(async (req, res) => {
    assertRefund(req, await crud.getById(req.params.id, null));
    if (req.user?.role !== 'super') throw forbidden('Only platform admins can delete refunds');
    ok(res, await crud.remove(req.params.id, null));
  }));
})();

// ---- Refund postings waiting for reconciliation (platform admins only) ----
// Orders whose refund reached Stripe but whose vendor-side adjustment or ledger posting did not finish.
router.get('/refund-reconciliation', asyncHandler(async (req, res) => {
  if (req.user?.role !== 'super') throw forbidden('Only platform admins can see refund reconciliation');
  const { rows } = await pool.query(
    `SELECT id, restaurant_id, branch_id, total, refund_amount, payment_status, data, updated_at
       FROM orders
      WHERE data ? 'vendor_adjustment_pending' OR data ? 'refund_journal_pending'
      ORDER BY updated_at DESC
      LIMIT 500`,
  );
  ok(res, rows.map((r) => ({
    order_id: r.id,
    restaurant_id: r.restaurant_id,
    branch_id: r.branch_id,
    total: r.total,
    refund_amount: r.refund_amount,
    payment_status: r.payment_status,
    vendor_adjustment_pending: r.data?.vendor_adjustment_pending || null,
    refund_journal_pending: r.data?.refund_journal_pending || null,
    updated_at: r.updated_at,
  })));
}));

// ---- Audit events ----
router.get('/audit-events', asyncHandler(async (req, res) => {
  const limit = Math.min(+(req.query.limit || 200), 500);
  const { rows } = await pool.query(
    'SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  ok(res, rows);
}));

router.post('/audit-events', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const id = b.id || `ae_${Date.now().toString(36)}`;
  const { rows } = await pool.query(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      id,
      b.actor || req.user?.email || 'system',
      b.action || 'event',
      b.entity_type || null,
      b.entity_id || null,
      b.restaurant_id || null,
      b.detail || null,
      JSON.stringify(b.data || {}),
    ],
  );
  created(res, rows[0]);
}));

// Map Postgres errors caused by bad client input to 400 (everything else falls through to the app handler).
// SEC-M16: the Postgres message is logged, not returned. The client gets a fixed message.
const INPUT_ERROR_CODES = new Set(['22P02', '22007', '22008', '22003', '22001', '23502', '23514']);
router.use((err, req, res, next) => {
  if (err && INPUT_ERROR_CODES.has(err.code)) {
    console.error('[platform] invalid input', err.code, err.column || '', err.message);
    return next(badRequest('Invalid input: a field has the wrong type, format or length'));
  }
  return next(err);
});

module.exports = router;
