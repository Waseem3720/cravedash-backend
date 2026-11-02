const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const { idempotent } = require('@cravedash/shared/src/idempotency');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, assertBranchAccess, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { AppError, badRequest, notFound, forbidden } = require('@cravedash/shared/src/errors');
const { linkOrderCustomer } = require('@cravedash/shared/src/customerSync');
const inventory = require('@cravedash/shared/src/engines/inventory');
const wallet = require('@cravedash/shared/src/engines/wallet');
const accounting = require('@cravedash/shared/src/engines/accounting');
const { requireBranchService } = require('@cravedash/shared/src/branchServiceGuard');
const riderAssignment = require('@cravedash/shared/src/engines/riderAssignment');

const router = express.Router();
router.use(requireBranchService);

const { applyOrderEngines } = require('@cravedash/shared/src/orderEngines');
const { applyOrderReversal } = require('@cravedash/shared/src/orderReversal');
const { priceLinesFromCatalogue, RejectedLine } = require('@cravedash/shared/src/catalogPricing');
const STATUSES = new Set([
  'pending', 'confirmed', 'processing', 'cooking', 'ready_for_serve',
  'out_for_delivery', 'delivered', 'completed', 'canceled', 'returned', 'failed_to_deliver',
]);

/** Payment / money fields — not client-writable by restaurant admin (EPOS till + super only). */
const MONEY_FIELDS = new Set([
  'payment_status', 'subtotal', 'discount', 'delivery_charge', 'service_charge', 'tip', 'total',
]);

function canSetMoneyFields(req) {
  const role = req.user?.role;
  return role === 'super' || role === 'epos';
}

/** Payment state only: restaurant admins may record a payment, but not change totals or discounts. */
const PAYMENT_FIELDS = new Set(['payment_status', 'payment_method']);
/** Payment states where money is held by the restaurant. Changing them, or cancelling, needs the refund workflow. */
const PAID_STATES = ['paid', 'partially_refunded', 'refunded'];
const REFUND_STATES = ['partially_refunded', 'refunded'];

function canSetPaymentFields(req) {
  const role = req.user?.role;
  return role === 'super' || role === 'epos' || role === 'restaurant';
}

/** Server-owned keys inside `data` are shared with the EPOS sync (shared/src/serverOwnedData.js). */
const { SERVER_OWNED_DATA_KEYS, withoutServerKeys } = require('@cravedash/shared/src/serverOwnedData');

/** New `data` for an update: the client's fields, with server-owned keys taken from the stored order. */
/**
 * The rider an order is assigned to, read from the rider record: name and id come from the server, never from the client.
 * A rider outside the caller's scope is refused, so a branch cannot assign another branch's rider.
 */
async function resolveRider(restaurant, req, riderId) {
  if (riderId === null || riderId === undefined || riderId === '') return { id: null, name: null };
  const id = String(riderId);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw badRequest('Invalid delivery man');
  const { rows } = await pool.query('SELECT id, name, branch_id FROM deliverymen WHERE id = $1 AND restaurant_id = $2', [id, restaurant]);
  if (!rows[0] || !rowInBranchScope(req, rows[0].branch_id)) throw badRequest('Delivery man not found for this branch');
  const mine = (await riderAssignment.candidatesFor(pool, restaurant, rows[0].branch_id)).find((c) => c.id === rows[0].id);
  if (mine && !mine.eligible) throw badRequest(`Delivery man cannot take this order: ${mine.reason}`);
  return { id: rows[0].id, name: rows[0].name };
}

/**
 * Runs automatic assignment when a delivery order reaches cooking. The status change is already saved, so a failure
 * here is logged and the order is returned as it is; an admin can then assign or retry from the order page.
 */
async function autoAssignAfterCooking(restaurant, order, by) {
  if (order.order_type !== 'delivery' || order.status !== riderAssignment.AUTO_TRIGGER_STATUS) return order;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { order: next } = await riderAssignment.autoAssign(client, { restaurant, orderId: order.id, by });
    await client.query('COMMIT');
    return parseOrder(next);
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[orders] auto-assign rollback failed', rollbackErr));
    console.error('[orders] automatic rider assignment failed', err);
    return order;
  } finally {
    client.release();
  }
}

/** A delivery order cannot leave the kitchen for the road without a rider on it (server-side rule). */
function assertRiderForDispatch(order, status) {
  if (status !== 'out_for_delivery' || order.order_type !== 'delivery') return;
  const d = order.data && typeof order.data === 'object' ? order.data : {};
  if (!d.delivery_man_id) throw badRequest('Assign a delivery man before sending this order out for delivery');
}

function mergeClientData(stored, incoming) {
  const keep = {};
  const storedData = stored && typeof stored === 'object' ? stored : {};
  SERVER_OWNED_DATA_KEYS.forEach((k) => {
    if (storedData[k] !== undefined) keep[k] = storedData[k];
  });
  return { ...withoutServerKeys(incoming), ...keep };
}

/** Kitchen display stages (cheff.md) and the fulfilment sources they can be filtered by. */
const KITCHEN_STAGES = {
  newOrder: ['pending', 'confirmed'],
  preparing: ['cooking', 'processing'],
  ready: ['ready_for_serve'],
};
const KITCHEN_SOURCES = {
  delivery: "order_type = 'delivery'",
  dineIn: "order_type = 'dine_in'",
  collection: "order_type = 'takeaway'",
  walkIn: "order_type = 'walk_in'",
  epos: "source = 'epos'",
};

const TRANSITIONS = {
  pending: ['confirmed', 'canceled'],
  confirmed: ['processing', 'canceled'],
  processing: ['cooking', 'canceled'],
  cooking: ['ready_for_serve', 'out_for_delivery', 'canceled'],
  ready_for_serve: ['completed', 'out_for_delivery', 'canceled'],
  out_for_delivery: ['delivered', 'failed_to_deliver', 'canceled'],
  delivered: ['returned', 'completed'],
  completed: [],
  canceled: [],
  returned: [],
  failed_to_deliver: ['canceled'],
};

function rid(req) {
  return restaurantId(req);
}

function parseOrder(row) {
  if (!row) return row;
  const o = { ...row };
  ['customer', 'items', 'history', 'data'].forEach((k) => {
    if (typeof o[k] === 'string') {
      try { o[k] = JSON.parse(o[k]); } catch { /* keep */ }
    }
  });
  o.id = Number(o.id);
  return o;
}

async function fetchOrder(id, restaurant_id, req) {
  // orders.id is BIGINT: a non-numeric id such as "ord_x" can never match, so answer "not found" instead of a SQL error.
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
    [id, restaurant_id],
  );
  const order = parseOrder(rows[0]);
  if (order && req) {
    const bound = branchId(req);
    if (bound && order.branch_id && String(order.branch_id) !== String(bound)) {
      throw forbidden('Branch out of scope for this session');
    }
  }
  return order;
}

/** One history entry, appended in SQL with jsonb concatenation so concurrent writers cannot drop each other's entries (ORD-M2). */
function historyEntry(status, by) {
  return JSON.stringify({ status, at: new Date().toISOString(), by: by || 'System' });
}

/** A status write lost a race: the order changed since it was read. The caller must reload and decide again. */
function staleStatus() {
  return new AppError('Order was changed by someone else; reload and try again', 409, 'CONFLICT');
}

router.get('/', asyncHandler(async (req, res) => {
  // Never trust x-user-role header — JWT role only
  const isSuper = req.user?.role === 'super';
  const allRestaurants = isSuper && (req.query.all === '1' || req.query.scope === 'platform');
  const { status, from, to, limit = 100, restaurant_id, alerts } = req.query;
  const params = [];
  const where = [];
  if (!allRestaurants) {
    // Non-super: always JWT restaurant_id (rid); ignore client restaurant_id
    const scoped = rid(req);
    if (!scoped) throw badRequest('restaurant_id required');
    params.push(scoped);
    where.push(`restaurant_id = $${params.length}`);
  } else if (restaurant_id) {
    params.push(restaurant_id);
    where.push(`restaurant_id = $${params.length}`);
  }
  // New-order popup source: pending, not ack'd, not Later-dismissed
  if (alerts === '1' || alerts === 'true') {
    where.push(`status = 'pending'`);
    where.push(`COALESCE(acknowledged, FALSE) = FALSE`);
    where.push(`alert_dismissed_at IS NULL`);
  } else if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  } else if (req.query.stage) {
    // Kitchen display stages (cheff.md): newOrder, preparing, ready.
    const stageStatuses = KITCHEN_STAGES[String(req.query.stage)];
    if (!stageStatuses) throw badRequest('stage must be newOrder, preparing or ready');
    params.push(stageStatuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (req.query.source) {
    const filter = KITCHEN_SOURCES[String(req.query.source)];
    if (!filter) throw badRequest('source must be delivery, dineIn, collection, walkIn or epos');
    where.push(filter);
  }
  // Branch ACL: till-bound / branch-scoped sessions only see their branch
  const scopedBranch = branchId(req);
  if (scopedBranch) {
    params.push(scopedBranch);
    where.push(`branch_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }
  // BUG-026: keyset paging so a client can read every order in a window, not only the newest page. The cursor is the
  // last row of the previous page (created_at and id), so orders with the same timestamp are not skipped.
  if (req.query.before) {
    const beforeAt = new Date(String(req.query.before));
    if (Number.isNaN(beforeAt.getTime())) throw badRequest('before must be a date');
    params.push(beforeAt.toISOString());
    const at = params.length;
    if (req.query.before_id !== undefined && /^\d+$/.test(String(req.query.before_id))) {
      params.push(Number(req.query.before_id));
      where.push(`(created_at < $${at} OR (created_at = $${at} AND id < $${params.length}))`);
    } else {
      where.push(`created_at < $${at}`);
    }
  }
  params.push(Math.min(1000, +limit || 100));
  let sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  // Page numbers for the kitchen app (page 1 is the newest page). Combines with the keyset cursor above.
  if (req.query.page && +req.query.page > 1) {
    params.push((+req.query.page - 1) * (+limit || 100));
    sql += ` OFFSET $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  ok(res, rows.map(parseOrder));
}));

/* ---------- Kitchen (chef) app: archive, live stream, ready/complete, print, refund, dispatch ---------- */

router.get('/history', asyncHandler(async (req, res) => {
  const filter = String(req.query.filter || '');
  const params = [rid(req)];
  const where = ['restaurant_id = $1'];
  if (filter === 'completed') where.push(`status IN ('completed', 'delivered')`);
  else if (filter === 'rejected') where.push(`status = 'canceled'`);
  else if (filter) throw badRequest('filter must be completed or rejected');
  else where.push(`status IN ('completed', 'delivered', 'canceled')`);
  if (req.query.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date))) throw badRequest('date must be YYYY-MM-DD');
    params.push(String(req.query.date));
    where.push(`created_at::date = $${params.length}::date`);
  }
  const scoped = branchId(req);
  if (scoped) {
    params.push(scoped);
    where.push(`branch_id = $${params.length}`);
  }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  ok(res, rows.map(parseOrder));
}));

/** Server-Sent Events: new orders and status changes for this restaurant. Checks the database every 5 seconds. */
router.get('/live-stream', asyncHandler(async (req, res) => {
  const r = rid(req);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('connected', { status: 'streaming', connected_at: new Date().toISOString() });
  const seen = new Map();
  let first = true;
  const check = async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, status, order_type, total, items FROM orders
          WHERE restaurant_id = $1 AND created_at > NOW() - INTERVAL '1 day'
            AND status = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 200`,
        [r, ['pending', 'confirmed', 'processing', 'cooking', 'ready_for_serve', 'out_for_delivery']],
      );
      for (const o of rows) {
        if (seen.get(o.id) === o.status) continue;
        const isNew = !seen.has(o.id) && o.status === 'pending';
        seen.set(o.id, o.status);
        if (first) continue; // the first check only records what is already open
        const payload = { id: o.id, status: o.status, order_type: o.order_type, total: Number(o.total) || 0, items_count: Array.isArray(o.items) ? o.items.length : 0 };
        send(isNew ? 'new_order' : 'status_change', payload);
      }
      first = false;
    } catch (err) {
      console.error('[orders] live-stream check failed', err.message);
    }
  };
  await check();
  const timer = setInterval(check, 5000);
  const pinger = setInterval(() => send('ping', { timestamp: new Date().toISOString() }), 15000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(pinger);
    res.end();
  });
}));

router.post('/:id/ready', asyncHandler(async (req, res) => {
  const { pass_station, ready_at } = req.body || {};
  const note = pass_station ? `Ready at ${String(pass_station).slice(0, 80)}` : null;
  const updated = await changeOrderStatus(req, req.params.id, 'ready_for_serve', note);
  ok(res, { id: updated.id, status: updated.status, pass_station: pass_station || null, ready_at: ready_at || null, updated_at: updated.updated_at });
}));

router.post('/:id/complete', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  // A delivery that is out on the road is delivered, a ready order at the pass is completed.
  const target = order.status === 'out_for_delivery' ? 'delivered' : 'completed';
  const updated = await changeOrderStatus(req, req.params.id, target, null);
  ok(res, { id: updated.id, status: updated.status, completed_at: new Date().toISOString(), updated_at: updated.updated_at });
}));

router.post('/:id/print', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const { printer_id, copies, type } = req.body || {};
  const n = Math.min(5, Math.max(1, parseInt(copies, 10) || 1));
  const lines = (Array.isArray(order.items) ? order.items : []).map((it) => {
    const variations = Array.isArray(it.variations) ? it.variations.map((v) => `${v.name}: ${(v.values || []).join(', ')}`).join('; ') : '';
    return `<p>${Number(it.qty) || 1} x ${escapeHtml(it.name)}${variations ? ` (${escapeHtml(variations)})` : ''}${it.instructions ? `<br>${escapeHtml(it.instructions)}` : ''}</p>`;
  });
  const html = `<h3>${escapeHtml(String(type || 'kitchen_ticket').replace('_', ' ').toUpperCase())} #${escapeHtml(order.id)}</h3>`
    + `<p>${escapeHtml(order.order_type || '')}${order.table_id ? ` - Table ${escapeHtml(order.table_id)}` : ''}</p>`
    + lines.join('') + (order.note ? `<p>Note: ${escapeHtml(order.note)}</p>` : '');
  const base = process.env.RESTAURANT_SERVICE_URL || 'http://127.0.0.1:4004';
  const r = await fetch(`${base}/api/v1/print/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
    body: JSON.stringify({ printer_id: printer_id || null, title: `Kitchen ticket #${order.id}`, html, copies: n }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success) throw badRequest(data.error?.message || 'Print job could not be queued');
  ok(res, {
    job_id: data.data.job_id,
    order_id: String(order.id),
    printer_id: data.data.printer_id || printer_id || null,
    copies: n,
    status: data.data.status || 'queued',
    printed_at: new Date().toISOString(),
  });
}));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

router.post('/:id/refund', asyncHandler(async (req, res) => {
  // Refunds are a restaurant admin action. A kitchen (chef) session cannot issue them.
  if (!['restaurant', 'super'].includes(req.user?.role)) throw forbidden('Refunds need a restaurant admin session');
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const body = req.body || {};
  const amount = Math.round(Number(body.refund_amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('refund_amount must be greater than zero');
  const total = Math.round((Number(order.total) || 0) * 100) / 100;
  const refunded = (Array.isArray(order.data?.refunds) ? order.data.refunds : []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const key = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : null;
  const existing = key && (order.data?.refunds || []).find((x) => x.idempotency_key === key);
  if (existing) return ok(res, { order_id: String(order.id), refund_amount: existing.amount, customer_email: existing.customer_email, status: order.payment_status, message: existing.message });
  if (Math.round((refunded + amount) * 100) / 100 > total) throw badRequest(`Refund exceeds the order total of ${total.toFixed(2)}`);
  const entry = {
    id: `rf_${Date.now().toString(36)}`,
    amount,
    currency: String(body.currency || 'GBP').toUpperCase(),
    customer_email: body.customer_email || null,
    message: body.message || null,
    idempotency_key: key,
    at: new Date().toISOString(),
    by: req.user?.name || 'Admin',
  };
  const fullyRefunded = Math.round((refunded + amount) * 100) / 100 >= total;
  const nextPayment = fullyRefunded ? 'refunded' : 'partially_refunded';
  await pool.query(
    `UPDATE orders SET payment_status = $3,
       data = jsonb_set(COALESCE(data, '{}'::jsonb), '{refunds}', COALESCE(data->'refunds', '[]'::jsonb) || $4::jsonb),
       history = COALESCE(history, '[]'::jsonb) || $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [req.params.id, rid(req), nextPayment, JSON.stringify([entry]), historyEntry(nextPayment, req.user?.name || 'Admin')],
  );
  ok(res, { order_id: String(order.id), refund_amount: amount, customer_email: entry.customer_email, status: nextPayment, message: entry.message });
}));

router.post('/:id/dispatch', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const riderId = body.rider_id || body.delivery_man_id;
  if (!riderId) throw badRequest('rider_id is required');
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await riderAssignment.assignRider(client, {
      restaurant: rid(req),
      orderId: order.id,
      riderId,
      by: req.user?.name || 'Kitchen',
      // The kitchen dispatch is an explicit choice, so it is recorded as the reason when the rider changes.
      reason: body.reason || 'Dispatched from the kitchen',
      inScope: (riderBranch) => rowInBranchScope(req, riderBranch),
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[orders] dispatch rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
  const updated = await changeOrderStatus(req, req.params.id, 'out_for_delivery', null);
  ok(res, {
    order_id: String(updated.id),
    status: updated.status,
    rider_id: riderId,
    rider_name: body.rider_name || updated.delivery_man_name || null,
    dispatched_at: new Date().toISOString(),
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound('Order not found');
  ok(res, order);
}));

router.post('/', idempotent('orders'), asyncHandler(async (req, res) => {
  const r = rid(req);
  const body = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key || (body.data && body.data.client_id) || body.client_id || null;

  // Idempotent replay: same Idempotency-Key / client_id → return existing order (no double sale)
  if (idempotencyKey) {
    const { rows: prior } = await pool.query(
      `SELECT * FROM orders
       WHERE restaurant_id = $1
         AND (
           data->>'sync_key' = $2
           OR data->>'client_id' = $2
           OR data->>'idempotency_key' = $2
         )
         -- A session only replays orders of its own branch (SEC-ORD-H4). An unbound session replays 'main', the branch
         -- its new orders are stored under, so it never receives another branch's order (ORD-H4).
         AND branch_id = $3
       LIMIT 1`,
      [r, String(idempotencyKey), branchId(req) || 'main'],
    );
    if (prior[0]) {
      return ok(res, parseOrder(prior[0]));
    }
  }

  const { rows: idRows } = await pool.query("SELECT nextval('orders_id_seq') AS id");
  // orders.id is bigint — only accept numeric client ids (EPOS nextOrderId); ignore soft/string ids
  const clientId = body.id != null && /^\d+$/.test(String(body.id)) ? Number(body.id) : null;
  const id = clientId || idRows[0].id;
  const status = body.status || 'pending';
  if (!STATUSES.has(status)) throw badRequest('Invalid status');
  const history = body.history || [{ status, at: new Date().toISOString(), by: req.user?.name || 'API' }];
  // The branch comes only from a validated branch context (X-Branch-Context, checked on every request), never from the
  // body. Without one the order is restaurant-level (master products only).
  const scopedBranch = branchId(req);
  if (!scopedBranch && body.branch_id && String(body.branch_id) !== 'main') {
    throw badRequest('Choose the branch first (View a branch) before creating an order for it');
  }
  // A branch-bound session may not write an order for another branch (the body's branch_id must match the session).
  if (scopedBranch && body.branch_id !== undefined && body.branch_id !== null && body.branch_id !== ''
    && String(body.branch_id) !== String(scopedBranch)) {
    throw badRequest('This order does not belong to the branch you are viewing');
  }
  const orderBranchId = scopedBranch || 'main';
  if (scopedBranch) assertBranchAccess(req, orderBranchId);
  const pricingBranch = scopedBranch || null;

  const moneyOk = canSetMoneyFields(req);
  if (!moneyOk && body.payment_status && String(body.payment_status).toLowerCase() === 'paid') {
    throw forbidden('Cannot create an order as paid without EPOS/payment rail');
  }
  const paymentStatus = moneyOk ? (body.payment_status || 'unpaid') : 'unpaid';
  let items = Array.isArray(body.items) ? body.items : [];
  // Every caller is priced from the catalogue, and an unknown line is refused (ORD-M1). EPOS and super callers
  // used to keep client prices here; the offline sync path already prices from the catalogue, so both now match.
  try {
    items = await priceLinesFromCatalogue(pool, r, items, { branchId: pricingBranch });
  } catch (err) {
    if (err instanceof RejectedLine) throw badRequest(err.message);
    throw err;
  }
  const itemsSubtotal = items.reduce((s, it) => {
    const price = Number(it && it.price) || 0;
    const qty = Number(it && it.qty) || 1;
    const addons = Array.isArray(it && it.addons)
      ? it.addons.reduce((a, x) => a + (Number(x && x.price) || 0), 0)
      : 0;
    return s + (price + addons) * qty;
  }, 0);
  // Non-EPOS: recompute money from line items — ignore client total/discount forgery
  let subtotal;
  let discount;
  let deliveryCharge;
  let serviceCharge;
  let tip;
  let total;
  if (moneyOk) {
    // Till and super callers may set discount and charges, but the subtotal comes from the lines and the total is
    // always recomputed. A discount is capped to the subtotal and charges are never negative (SEC-ORD-H6).
    subtotal = Math.round(itemsSubtotal * 100) / 100;
    discount = Math.min(Math.max(0, Number(body.discount) || 0), subtotal);
    deliveryCharge = Math.max(0, Number(body.delivery_charge) || 0);
    serviceCharge = Math.max(0, Number(body.service_charge) || 0);
    tip = Math.max(0, Number(body.tip) || 0);
    total = Math.round((subtotal - discount + deliveryCharge + serviceCharge + tip) * 100) / 100;
  } else {
    subtotal = Math.round(itemsSubtotal * 100) / 100;
    discount = 0;
    deliveryCharge = Math.max(0, Number(body.delivery_charge) || 0);
    serviceCharge = Math.max(0, Number(body.service_charge) || 0);
    tip = Math.max(0, Number(body.tip) || 0);
    total = Math.round((subtotal - discount + deliveryCharge + serviceCharge + tip) * 100) / 100;
  }

  const { delivery_man: _clientRiderName, delivery_man_id: clientRiderId, ...clientData } = withoutServerKeys(body.data) || {};
  const riderOnCreate = body.data && typeof body.data === 'object' && Object.prototype.hasOwnProperty.call(body.data, 'delivery_man_id')
    ? await resolveRider(r, req, clientRiderId)
    : null;
  const orderData = {
    ...clientData,
    ...(riderOnCreate && riderOnCreate.id ? { delivery_man_id: riderOnCreate.id, delivery_man: riderOnCreate.name } : {}),
    ...(body.client_id ? { client_id: body.client_id } : {}),
    ...(idempotencyKey ? { sync_key: String(idempotencyKey), idempotency_key: String(idempotencyKey) } : {}),
  };

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO orders (
        id, restaurant_id, branch, branch_id, source, order_type, status, payment_status, payment_method,
        customer, table_id, guests, items, subtotal, discount, coupon_code, delivery_charge,
        service_charge, tip, total, note, history, acknowledged, data
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
      ) RETURNING *`,
      [
        id, r, body.branch || 'Main Branch', orderBranchId, body.source || 'website', body.order_type || 'delivery',
        status, paymentStatus, body.payment_method || null,
        JSON.stringify(body.customer || null), body.table_id || null, body.guests || 0,
        JSON.stringify(items), subtotal, discount, body.coupon_code || null,
        deliveryCharge, serviceCharge, tip, total,
        body.note || '', JSON.stringify(history), body.acknowledged ?? false, JSON.stringify(orderData),
      ],
    ));
  } catch (err) {
    // A concurrent create with the same client_id won the unique index (ORD-M3): answer with that order.
    if (err && err.code === '23505' && orderData.client_id) {
      const { rows: winner } = await pool.query(
        `SELECT * FROM orders WHERE restaurant_id = $1 AND branch_id = $3 AND data->>'client_id' = $2 LIMIT 1`,
        [r, String(orderData.client_id), orderBranchId],
      );
      if (winner[0]) return ok(res, parseOrder(winner[0]));
    }
    throw err;
  }
  const createdOrder = parseOrder(rows[0]);
  await linkOrderCustomer(pool, { restaurantId: r, customer: createdOrder.customer, branchId: orderBranchId });
  if (String(createdOrder.payment_status || '').toLowerCase() === 'paid') {
    await applyOrderEngines(rid(req), createdOrder, { prevPayment: 'unpaid' });
  }
  // Kitchen alert for the chef tablets (cheff.md, notifications). Best effort: an alert never fails the order.
  pool.query(
    'INSERT INTO kitchen_notifications (id, restaurant_id, branch_id, title, message, order_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      `notif_${createdOrder.id}_${Date.now().toString(36)}`,
      r,
      orderBranchId === 'main' ? null : orderBranchId,
      `New ${String(createdOrder.order_type || 'order').replace('_', '-')} order #${createdOrder.id}`,
      `Order #${createdOrder.id} for £${Number(createdOrder.total || 0).toFixed(2)} received`,
      String(createdOrder.id),
    ],
  ).catch((err) => console.error('[orders] kitchen alert not saved', err.message));
  created(res, createdOrder);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const existing = await fetchOrder(req.params.id, rid(req), req);
  if (!existing) throw notFound();
  const body = req.body || {};
  // Server-owned keys inside data are kept from the stored order, whatever the client sends (ORD-H5).
  let dataToWrite = body.data !== undefined && req.user?.role !== 'super'
    ? mergeClientData(existing.data, body.data)
    : body.data;
  if (body.data && typeof body.data === 'object' && Object.prototype.hasOwnProperty.call(body.data, 'delivery_man_id')) {
    // The rider is changed only through the assign action, which locks the restaurant and checks the limit.
    const wanted = body.data.delivery_man_id == null ? null : String(body.data.delivery_man_id);
    const current = existing.data && existing.data.delivery_man_id ? String(existing.data.delivery_man_id) : null;
    if (wanted !== current) {
      throw new AppError('Change the delivery man with the Assign rider action', 409, 'CONFLICT');
    }
  }
  if (body.data && typeof body.data === 'object' && (Object.prototype.hasOwnProperty.call(body.data, 'delivery_man_id') || Object.prototype.hasOwnProperty.call(body.data, 'delivery_man'))) {
    // The rider's id and name are kept as stored; a save from the client cannot rename the rider on the order.
    dataToWrite = { ...(dataToWrite || {}), delivery_man_id: existing.data?.delivery_man_id ?? null, delivery_man: existing.data?.delivery_man ?? null };
  }
  // An order stays with its branch: its product pricing and availability were checked for that branch.
  if (body.branch_id !== undefined && String(body.branch_id ?? '') !== String(existing.branch_id ?? '')) {
    throw new AppError('An order cannot be moved to another branch', 409, 'CONFLICT');
  }
  // BUG-010: items are priced again from the catalogue and the total is recomputed here. A client price, subtotal or total
  // is never stored. Discount and charges keep their stored values unless a till or super caller changes them.
  let repriced = null;
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) throw badRequest('items must be a list');
    const pricingBranch = existing.branch_id && existing.branch_id !== 'main' ? existing.branch_id : null;
    let lines;
    try {
      lines = await priceLinesFromCatalogue(pool, rid(req), body.items, { branchId: pricingBranch });
    } catch (err) {
      if (err instanceof RejectedLine) throw badRequest(err.message);
      throw err;
    }
    const subtotal = Math.round(lines.reduce((s, it) => {
      const addons = Array.isArray(it.addons) ? it.addons.reduce((a, x) => a + (Number(x && x.price) || 0), 0) : 0;
      return s + ((Number(it.price) || 0) + addons) * (Number(it.qty) || 1);
    }, 0) * 100) / 100;
    const moneyFromClient = canSetMoneyFields(req);
    const discount = moneyFromClient && body.discount !== undefined
      ? Math.min(Math.max(0, Number(body.discount) || 0), subtotal)
      : Math.min(Math.max(0, Number(existing.discount) || 0), subtotal);
    const pick = (field) => (moneyFromClient && body[field] !== undefined ? Math.max(0, Number(body[field]) || 0) : Math.max(0, Number(existing[field]) || 0));
    const total = Math.round((subtotal - discount + pick('delivery_charge') + pick('service_charge') + pick('tip')) * 100) / 100;
    repriced = { items: lines, subtotal, total };
  }
  // BUG-010: order history is append-only. A save may extend it but never rewrite or remove an entry (cancel records stay).
  if (body.history !== undefined) {
    const stored = Array.isArray(existing.history) ? existing.history : [];
    const incoming = Array.isArray(body.history) ? body.history : null;
    if (!incoming || stored.some((entry, i) => JSON.stringify(entry) !== JSON.stringify(incoming[i]))) {
      throw new AppError('Order history is append-only and cannot be rewritten', 409, 'CONFLICT');
    }
  }
  const moneyOk = canSetMoneyFields(req);
  const paymentOk = canSetPaymentFields(req);
  const touchesPayment = body.payment_status !== undefined || body.payment_method !== undefined;
  if (!moneyOk) {
    for (const f of MONEY_FIELDS) {
      if (PAYMENT_FIELDS.has(f) && paymentOk) continue;
      if (body[f] !== undefined && String(body[f]) !== String(existing[f])) {
        throw forbidden(`Cannot update ${f} without EPOS/payment rail`);
      }
    }
  }
  if (!moneyOk && paymentOk && touchesPayment) {
    if (existing.payment_method === 'stripe' || body.payment_method === 'stripe') {
      throw forbidden('Online (Stripe) payments are confirmed by the payment provider only');
    }
  }
  // BUG-011: a recorded payment or refund state is changed only by the payment and refund workflow, not by a restaurant save.
  if (!moneyOk && body.payment_status !== undefined) {
    const from = String(existing.payment_status || '').toLowerCase();
    const to = String(body.payment_status).toLowerCase();
    if (PAID_STATES.includes(from) && to !== from) {
      throw forbidden('A recorded payment can only be changed through the refund workflow');
    }
    if (REFUND_STATES.includes(to)) throw forbidden('Refund status is set by the refund workflow only');
  }
  // Optional precondition (FE-M2): the updated_at the client read. A newer write is refused, never overwritten.
  const baseUpdatedAt = body.base_updated_at;
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== null && Number.isNaN(Date.parse(baseUpdatedAt))) {
    throw badRequest('base_updated_at must be a date');
  }
  // Optional transition in the same write (FE-M3). It is `next_status`, not `status`, so a whole-order save that
  // carries an old status does not start a transition by accident.
  let nextStatus = null;
  if (body.next_status !== undefined && body.next_status !== existing.status) {
    if (!STATUSES.has(body.next_status)) throw badRequest('Invalid status');
    if (!(TRANSITIONS[existing.status] || []).includes(body.next_status)) {
      throw badRequest(`Cannot transition from ${existing.status} to ${body.next_status}`);
    }
    assertPaidOrderCanLeave(existing, body.next_status);
    assertRiderForDispatch({ ...existing, data: dataToWrite || existing.data }, body.next_status);
    nextStatus = body.next_status;
  }
  const fields = [
    'branch', 'source', 'order_type', 'payment_status', 'payment_method', 'table_id', 'guests',
    'subtotal', 'discount', 'coupon_code', 'delivery_charge', 'service_charge', 'tip', 'total', 'note', 'acknowledged',
  ];
  const sets = [];
  const params = [req.params.id, rid(req)];
  fields.forEach((f) => {
    if (body[f] === undefined) return;
    if (!moneyOk && MONEY_FIELDS.has(f) && !(PAYMENT_FIELDS.has(f) && paymentOk)) return;
    params.push(body[f]);
    sets.push(`${f} = $${params.length}`);
  });
  ['customer', 'items', 'history', 'data'].forEach((f) => {
    let value = f === 'data' ? dataToWrite : body[f];
    if (f === 'items' && repriced) value = repriced.items;
    if (value === undefined) return;
    params.push(JSON.stringify(value));
    sets.push(`${f} = $${params.length}`);
  });
  if (repriced) {
    params.push(repriced.subtotal);
    sets.push(`subtotal = $${params.length}`);
    params.push(repriced.total);
    sets.push(`total = $${params.length}`);
  }
  if (!sets.length && !nextStatus) return ok(res, existing);
  if (nextStatus) {
    params.push(nextStatus);
    sets.push(`status = $${params.length}`);
    params.push(historyEntry(nextStatus, req.user?.name || 'Staff'));
    sets.push(`history = COALESCE(history, '[]'::jsonb) || $${params.length}::jsonb`);
  }
  sets.push('updated_at = NOW()');
  const conditions = ['id = $1', 'restaurant_id = $2'];
  // The status is checked as read (ORD-M2) and the precondition is checked in the same statement (FE-M2).
  // updated_at is stored to the microsecond, so both sides are compared at millisecond precision.
  if (nextStatus) {
    params.push(existing.status);
    conditions.push(`status = $${params.length}`);
  }
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== null) {
    params.push(new Date(baseUpdatedAt).toISOString());
    conditions.push(`date_trunc('milliseconds', updated_at) = $${params.length}::timestamptz`);
  }
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`,
    params,
  );
  if (!rows[0]) {
    throw new AppError('This order was changed on another till or tab. Reload the order and try again.', 409, 'CONFLICT');
  }
  const updated = parseOrder(rows[0]);
  await applyOrderEngines(rid(req), updated, { prevPayment: existing.payment_status });
  if (nextStatus && ['canceled', 'returned'].includes(nextStatus)) await applyOrderReversal(rid(req), updated);
  ok(res, await autoAssignAfterCooking(rid(req), updated, req.user?.name || 'Staff'));
}));

/** A paid order can be cancelled or returned only once a refund for its full amount is recorded (ORD-H7, phase 1). */
function assertPaidOrderCanLeave(order, nextStatus) {
  if (!['canceled', 'returned'].includes(nextStatus)) return;
  // BUG-011: a partly refunded order still holds money, so it gets the same gate as a paid one.
  if (!PAID_STATES.includes(String(order.payment_status || '').toLowerCase())) return;
  const refunded = Number((order.data && order.data.refund_amount) || 0);
  if (refunded + 0.005 >= Number(order.total || 0)) return;
  throw new AppError('Refund the paid order before cancelling or returning it', 409, 'CONFLICT');
}

/**
 * One order status change with its rules and side effects. The status route and the kitchen routes both use it.
 * Returns the updated order.
 */
async function changeOrderStatus(req, orderId, status, note) {
  if (!status || !STATUSES.has(status)) throw badRequest('Invalid status');
  const order = await fetchOrder(orderId, rid(req), req);
  if (!order) throw notFound();
  const allowed = TRANSITIONS[order.status] || [];
  if (order.status !== status && !allowed.includes(status)) {
    throw badRequest(`Cannot transition from ${order.status} to ${status}`);
  }
  // Already in this status: nothing to do. Re-running the write would append history and repeat the engine
  // effects, including a second stock and sale reversal for a cancelled order (ORD-M2).
  if (order.status === status) return order;
  assertPaidOrderCanLeave(order, status);
  assertRiderForDispatch(order, status);
  // Conditional on the status read above (ORD-M2): if another request moved the order first, nothing changes and 409 is returned.
  const { rows } = await pool.query(
    `UPDATE orders SET status = $3, acknowledged = TRUE,
       history = COALESCE(history, '[]'::jsonb) || $4::jsonb,
       note = COALESCE($5, note), updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND status = $6 RETURNING *`,
    [orderId, rid(req), status, historyEntry(status, req.user?.name || 'Staff'), note || null, order.status],
  );
  if (!rows[0]) throw staleStatus();
  const updated = parseOrder(rows[0]);
  await applyOrderEngines(rid(req), updated, { prevPayment: order.payment_status });
  // A cancelled or returned order gives back its stock, loyalty and sale (ORD-H7 phase 2).
  if (['canceled', 'returned'].includes(status)) await applyOrderReversal(rid(req), updated);
  return autoAssignAfterCooking(rid(req), updated, req.user?.name || 'Staff');
}

router.post('/:id/status', asyncHandler(async (req, res) => {
  const { status, note } = req.body || {};
  ok(res, await changeOrderStatus(req, req.params.id, status, note));
}));

/** Persist "Later" so other devices/tabs do not re-popup the same pending order. */
router.post('/:id/dismiss-alert', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (order.status !== 'pending') throw badRequest('Only pending orders can dismiss alerts');
  const { rows } = await pool.query(
    `UPDATE orders SET alert_dismissed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [req.params.id, rid(req)],
  );
  ok(res, parseOrder(rows[0]));
}));

router.post('/:id/accept', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (order.status !== 'pending') throw badRequest('Only pending orders can be accepted');
  // The kitchen app sends cook_time_minutes and station; the till sends prep_time.
  const body = req.body || {};
  const prep = Number(body.cook_time_minutes ?? body.prep_time) || 20;
  const station = body.station ? String(body.station).slice(0, 80) : null;
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'confirmed', acknowledged = TRUE,
       history = COALESCE(history, '[]'::jsonb) || $3::jsonb,
       data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('prep_time', $4::int, 'station', $5::text),
       updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND status = 'pending' RETURNING *`,
    [req.params.id, rid(req), historyEntry('confirmed', req.user?.name || 'Staff'), prep, station],
  );
  if (!rows[0]) throw staleStatus();
  ok(res, parseOrder(rows[0]));
}));

router.post('/:id/reject', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (!['pending', 'confirmed'].includes(order.status)) {
    throw badRequest(`Cannot reject order in status ${order.status}`);
  }
  // BUG-011: rejecting is a cancel. A paid order must be refunded first, the same as the status route.
  assertPaidOrderCanLeave(order, 'canceled');
  const body = req.body || {};
  // The kitchen app sends reason and custom_note; the till sends note.
  const reason = body.reason ? String(body.reason).slice(0, 200) : null;
  const note = body.note || body.custom_note || reason || 'Rejected by restaurant';
  // Conditional on the status read above (ORD-M2): a pending order accepted in the meantime is not rejected.
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'canceled', acknowledged = TRUE,
       history = COALESCE(history, '[]'::jsonb) || $3::jsonb,
       note = $4,
       data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('cancel_reason', $5::text),
       updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND status = $6 RETURNING *`,
    [req.params.id, rid(req), historyEntry('canceled', req.user?.name || 'Staff'), note, reason || note, order.status],
  );
  if (!rows[0]) throw staleStatus();
  // Reverses stock, loyalty and sale only if they were posted for this order (a no-op otherwise).
  await applyOrderReversal(rid(req), parseOrder(rows[0]));
  ok(res, parseOrder(rows[0]));
}));

/** The riders of the order's branch, each with open orders and whether they can take this order. */
router.get('/:id/eligible-riders', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (order.order_type !== 'delivery') throw badRequest('Only delivery orders take a rider');
  const riders = await riderAssignment.candidatesFor(pool, rid(req), order.branch_id);
  ok(res, { max_open_orders: riderAssignment.maxOpenOrders(), current: order.data?.delivery_man_id || null, riders });
}));

router.post('/:id/assign-rider', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.delivery_man_id) throw badRequest('delivery_man_id is required');
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { order: updated, changed } = await riderAssignment.assignRider(client, {
      restaurant: rid(req),
      orderId: order.id,
      riderId: body.delivery_man_id,
      by: req.user?.name || 'Staff',
      reason: body.reason,
      inScope: (riderBranch) => rowInBranchScope(req, riderBranch),
    });
    await client.query('COMMIT');
    ok(res, { order: parseOrder(updated), changed });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[orders] assign rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

/** One automatic attempt per request. Retrying is an explicit admin action, not a loop. */
router.post('/:id/auto-assign', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { order: updated, rider } = await riderAssignment.autoAssign(client, { restaurant: rid(req), orderId: order.id, by: req.user?.name || 'Staff' });
    await client.query('COMMIT');
    ok(res, { order: parseOrder(updated), rider });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[orders] auto-assign rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
// The rider routes move orders through the same rules and effects as the status route.
module.exports.changeOrderStatus = changeOrderStatus;
