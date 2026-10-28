const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, assertBranchAccess } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, forbidden } = require('@cravedash/shared/src/errors');
const inventory = require('@cravedash/shared/src/engines/inventory');
const wallet = require('@cravedash/shared/src/engines/wallet');
const accounting = require('@cravedash/shared/src/engines/accounting');
const { calculateDealPreview } = require('@cravedash/shared/src/engines/deals');

const router = express.Router();

/** Fire-and-forget ledger side effects when an order is paid / completed. */
async function applyOrderEngines(restaurantId, order, { prevPayment } = {}) {
  if (!order || !restaurantId) return;
  const paidNow = String(order.payment_status || '').toLowerCase() === 'paid'
    && String(prevPayment || '').toLowerCase() !== 'paid';
  const completed = ['completed', 'delivered'].includes(String(order.status || ''));
  try {
    if (paidNow || (completed && String(order.payment_status || '').toLowerCase() === 'paid')) {
      const already = order.data && order.data.engines_posted;
      if (!already) {
        let hasEngineError = false;
        await inventory.deductForOrder(restaurantId, order).catch((e) => {
          hasEngineError = true;
          console.warn('[order-engines] stock', e.message);
        });
        await wallet.earnForOrder(restaurantId, order).catch((e) => {
          hasEngineError = true;
          console.warn('[order-engines] loyalty', e.message);
        });
        await accounting.postSaleFromOrder(restaurantId, order).catch((e) => {
          hasEngineError = true;
          console.warn('[order-engines] sale', e.message);
        });
        if (!hasEngineError) {
          await pool.query(
            `UPDATE orders SET data = COALESCE(data,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
             WHERE id = $1 AND restaurant_id = $2`,
            [order.id, restaurantId, JSON.stringify({ engines_posted: true, engines_at: new Date().toISOString() })],
          ).catch((e) => console.warn('[order-engines] update', e.message));
        }
      }
    }
  } catch (err) {
    console.warn('[order-engines]', err.message);
  }
}

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

const TRANSITIONS = {
  pending: ['confirmed', 'canceled'],
  confirmed: ['processing', 'cooking', 'ready_for_serve', 'canceled'],
  processing: ['cooking', 'ready_for_serve', 'canceled'],
  cooking: ['ready_for_serve', 'out_for_delivery', 'canceled'],
  ready_for_serve: ['out_for_delivery', 'completed', 'canceled'],
  out_for_delivery: ['delivered', 'failed_to_deliver', 'canceled'],
  delivered: ['returned', 'completed'],
  completed: ['returned'],
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

function projectRiderOrder(order) {
  if (!order) return null;
  const o = { ...order };
  let safeCustomer = null;
  if (o.customer && typeof o.customer === 'object') {
    safeCustomer = {
      name: o.customer.name || `${o.customer.f_name || ''} ${o.customer.l_name || ''}`.trim() || 'Customer',
      phone: o.customer.phone || o.customer.contact_number || '',
      email: o.customer.email || '',
      address: o.customer.address || o.customer.delivery_address || '',
      delivery_address: o.customer.delivery_address || o.customer.address || '',
      delivery_instructions: o.customer.delivery_instructions || o.customer.note || '',
    };
  }
  const safeItems = Array.isArray(o.items) ? o.items.map((it) => ({
    name: it.name || it.title || 'Item',
    qty: it.qty || it.quantity || 1,
    variant: it.variant || it.variation || null,
    addons: it.addons || [],
    note: it.note || it.instructions || '',
    price: it.price != null ? Number(it.price) : undefined,
  })) : [];
  return {
    id: o.id,
    restaurant_id: o.restaurant_id,
    branch_id: o.branch_id,
    order_type: o.order_type,
    status: o.status,
    delivery_man_id: o.delivery_man_id,
    driver_distance_km: o.driver_distance_km,
    customer: safeCustomer,
    items: safeItems,
    total: o.total,
    delivery_charge: o.delivery_charge,
    tip: o.tip,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
    note: o.note,
    history: o.history,
    created_at: o.created_at,
    updated_at: o.updated_at,
    data: {
      pod: o.data?.pod || null,
      issues: o.data?.issues || [],
      delivery_notes: o.data?.delivery_notes || o.data?.dropoff_instructions || null,
      dropoff_instructions: o.data?.dropoff_instructions || null,
      cash_collected: o.data?.cash_collected || null,
    },
  };
}

async function fetchOrder(id, restaurant_id, req) {
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
    const isRider = req.user?.role === 'rider' || req.user?.role === 'courier';
    if (isRider) {
      const riderId = req.user?.delivery_man_id || req.user?.sub || req.user?.id;
      if (!riderId || !order.delivery_man_id || String(order.delivery_man_id) !== String(riderId)) {
        throw forbidden('Order is not assigned to you');
      }
    }
  }
  return order;
}

function appendHistory(order, status, by) {
  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({ status, at: new Date().toISOString(), by: by || 'System' });
  return history;
}

router.get('/', asyncHandler(async (req, res) => {
  // Never trust x-user-role header — JWT role only
  const isSuper = req.user?.role === 'super';
  const allRestaurants = isSuper && (req.query.all === '1' || req.query.scope === 'platform');
  const { status, from, to, limit = 100, restaurant_id, alerts, delivery_man_id } = req.query;
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
  }
  // Branch ACL: till-bound / branch-scoped sessions only see their branch
  const scopedBranch = branchId(req);
  if (scopedBranch) {
    params.push(scopedBranch);
    where.push(`(branch_id = $${params.length} OR branch_id IS NULL)`);
  }
  // Courier / Rider isolation: riders only see orders assigned to them
  const isRider = req.user?.role === 'rider' || req.user?.role === 'courier';
  const riderId = isRider
    ? (req.user?.delivery_man_id || req.user?.id)
    : (delivery_man_id || null);
  if (isRider) {
    if (!riderId) {
      where.push('1 = 0');
    } else {
      params.push(riderId);
      where.push(`delivery_man_id = $${params.length}`);
    }
  } else if (riderId) {
    params.push(riderId);
    where.push(`delivery_man_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }
  params.push(Math.min(1000, +limit || 100));
  const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  const parsed = rows.map(parseOrder);
  if (isRider) {
    return ok(res, parsed.map(projectRiderOrder));
  }
  ok(res, parsed);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound('Order not found');
  if (req.user?.role === 'rider' || req.user?.role === 'courier') {
    return ok(res, projectRiderOrder(order));
  }
  ok(res, order);
}));

router.post('/deal-preview', asyncHandler(async (req, res) => {
  const result = await calculateDealPreview(rid(req), req.body || {});
  ok(res, { success: true, deal_preview: result });
}));

router.post('/', asyncHandler(async (req, res) => {
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
       LIMIT 1`,
      [r, String(idempotencyKey)],
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
  const scopedBranch = branchId(req);
  if (body.branch_id) {
    assertBranchAccess(req, String(body.branch_id));
  }
  const orderBranchId = body.branch_id || scopedBranch || 'main';
  if (scopedBranch) {
    assertBranchAccess(req, orderBranchId);
  }

  if (body.branch_id) {
    const { rows: branchRows } = await pool.query(
      'SELECT id, name FROM branches WHERE restaurant_id = $1 AND id = $2',
      [r, String(body.branch_id)],
    );
    if (!branchRows[0]) {
      const { rows: blobRows } = await pool.query(
        `SELECT 1 FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'branches' AND data::text LIKE $2`,
        [r, `%"id":"${String(body.branch_id)}"%`],
      ).catch(() => ({ rows: [] }));

      if (!blobRows[0]) {
        const { rows: anyBranches } = await pool.query(
          'SELECT 1 FROM branches WHERE restaurant_id = $1 LIMIT 1',
          [r],
        );
        if (anyBranches[0] || body.branch_id !== 'main') {
          throw badRequest(`Invalid branch_id "${body.branch_id}" for this restaurant`);
        }
      }
    }
  }

  const deliveryManId = body.delivery_man_id || null;
  const driverDistanceKm = body.driver_distance_km != null ? Number(body.driver_distance_km) : null;

  const moneyOk = canSetMoneyFields(req);
  if (!moneyOk && body.payment_status && String(body.payment_status).toLowerCase() === 'paid') {
    throw forbidden('Cannot create an order as paid without EPOS/payment rail');
  }
  const paymentStatus = moneyOk ? (body.payment_status || 'unpaid') : 'unpaid';
  const items = Array.isArray(body.items) ? body.items : [];
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
    subtotal = Number(body.subtotal) || itemsSubtotal;
    discount = Number(body.discount) || 0;
    deliveryCharge = Number(body.delivery_charge) || 0;
    serviceCharge = Number(body.service_charge) || 0;
    tip = Number(body.tip) || 0;
    total = Number(body.total) || (subtotal - discount + deliveryCharge + serviceCharge + tip);
  } else {
    subtotal = Math.round(itemsSubtotal * 100) / 100;
    discount = 0;
    deliveryCharge = Math.max(0, Number(body.delivery_charge) || 0);
    serviceCharge = Math.max(0, Number(body.service_charge) || 0);
    tip = Math.max(0, Number(body.tip) || 0);
    total = Math.round((subtotal - discount + deliveryCharge + serviceCharge + tip) * 100) / 100;
  }

  const orderData = {
    ...(body.data && typeof body.data === 'object' ? body.data : {}),
    ...(body.client_id ? { client_id: body.client_id } : {}),
    ...(idempotencyKey ? { sync_key: String(idempotencyKey), idempotency_key: String(idempotencyKey) } : {}),
  };

  const { rows } = await pool.query(
    `INSERT INTO orders (
      id, restaurant_id, branch, branch_id, source, order_type, status, payment_status, payment_method,
      customer, table_id, guests, items, subtotal, discount, coupon_code, delivery_charge,
      service_charge, tip, total, note, history, acknowledged, data,
      delivery_man_id, driver_distance_km
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
    ) RETURNING *`,
    [
      id, r, body.branch || 'Main Branch', orderBranchId, body.source || 'website', body.order_type || 'delivery',
      status, paymentStatus, body.payment_method || null,
      JSON.stringify(body.customer || null), body.table_id || null, body.guests || 0,
      JSON.stringify(items), subtotal, discount, body.coupon_code || null,
      deliveryCharge, serviceCharge, tip, total,
      body.note || '', JSON.stringify(history), body.acknowledged ?? false, JSON.stringify(orderData),
      deliveryManId, driverDistanceKm,
    ],
  );
  const createdOrder = parseOrder(rows[0]);
  if (String(createdOrder.payment_status || '').toLowerCase() === 'paid') {
    await applyOrderEngines(rid(req), createdOrder, { prevPayment: 'unpaid' });
  }
  created(res, createdOrder);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const role = req.user?.role;
  if (role === 'rider' || role === 'courier') {
    throw forbidden('Riders cannot directly modify order attributes');
  }
  const existing = await fetchOrder(req.params.id, rid(req), req);
  if (!existing) throw notFound();
  const body = req.body || {};

  if (role === 'chef' || role === 'kitchen') {
    if (body.delivery_man_id !== undefined && String(body.delivery_man_id) !== String(existing.delivery_man_id || '')) {
      throw forbidden('Chefs cannot assign or reassign delivery personnel');
    }
    if (body.customer !== undefined) {
      throw forbidden('Chefs cannot modify customer details');
    }
  }

  const moneyOk = canSetMoneyFields(req);
  if (!moneyOk) {
    for (const f of MONEY_FIELDS) {
      if (body[f] !== undefined && String(body[f]) !== String(existing[f])) {
        throw forbidden(`Cannot update ${f} without EPOS/payment rail`);
      }
    }
  }

  if (body.delivery_man_id) {
    const { rows: dm } = await pool.query(
      'SELECT id FROM deliverymen WHERE id = $1 AND restaurant_id = $2',
      [body.delivery_man_id, rid(req)],
    );
    if (!dm[0]) {
      throw badRequest(`Delivery man "${body.delivery_man_id}" does not exist for this restaurant`);
    }
  }
  if (body.branch_id) {
    const { rows: bRows } = await pool.query(
      'SELECT id FROM branches WHERE restaurant_id = $1 AND id = $2',
      [rid(req), String(body.branch_id)],
    );
    if (!bRows[0] && body.branch_id !== 'main') {
      throw badRequest(`Invalid branch_id "${body.branch_id}" for this restaurant`);
    }
  }

  const fields = [
    'branch', 'branch_id', 'source', 'order_type', 'payment_status', 'payment_method', 'table_id', 'guests',
    'subtotal', 'discount', 'coupon_code', 'delivery_charge', 'service_charge', 'tip', 'total', 'note', 'acknowledged',
    'delivery_man_id', 'driver_distance_km',
  ];
  const sets = [];
  const params = [req.params.id, rid(req)];
  fields.forEach((f) => {
    if (body[f] === undefined) return;
    if (!moneyOk && MONEY_FIELDS.has(f)) return;
    params.push(body[f]);
    sets.push(`${f} = $${params.length}`);
  });
  ['customer', 'items', 'history', 'data'].forEach((f) => {
    if (body[f] === undefined) return;
    params.push(JSON.stringify(body[f]));
    sets.push(`${f} = $${params.length}`);
  });
  if (!sets.length) return ok(res, existing);
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(', ')} WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    params,
  );
  const updated = parseOrder(rows[0]);
  await applyOrderEngines(rid(req), updated, { prevPayment: existing.payment_status });
  ok(res, updated);
}));

router.post('/:id/status', asyncHandler(async (req, res) => {
  const { status, note } = req.body || {};
  if (!status || !STATUSES.has(status)) throw badRequest('Invalid status');
  const role = req.user?.role;

  if (role === 'chef' || role === 'kitchen') {
    const CHEF_PERMITTED = new Set(['confirmed', 'processing', 'cooking', 'ready_for_serve', 'canceled']);
    if (!CHEF_PERMITTED.has(status)) {
      throw forbidden(`Chefs cannot transition orders to ${status}`);
    }
  }

  if (role === 'rider' || role === 'courier') {
    const RIDER_PERMITTED = new Set(['out_for_delivery', 'delivered', 'failed_to_deliver']);
    if (!RIDER_PERMITTED.has(status)) {
      throw forbidden(`Riders cannot transition orders to ${status}`);
    }
  }

  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  const allowed = TRANSITIONS[order.status] || [];
  if (order.status !== status && !allowed.includes(status)) {
    throw badRequest(`Cannot transition from ${order.status} to ${status}`);
  }
  const history = appendHistory(order, status, req.user?.name || 'Staff');
  const { rows } = await pool.query(
    `UPDATE orders SET status = $3, acknowledged = TRUE, history = $4, note = COALESCE($5, note), updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [req.params.id, rid(req), status, JSON.stringify(history), note || null],
  );
  const updated = parseOrder(rows[0]);
  await applyOrderEngines(rid(req), updated, { prevPayment: order.payment_status });
  ok(res, updated);
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
  if (req.user?.role === 'rider' || req.user?.role === 'courier') {
    throw forbidden('Riders cannot accept kitchen orders');
  }
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (order.status !== 'pending') throw badRequest('Only pending orders can be accepted');
  const prep = Number((req.body || {}).prep_time) || 20;
  const history = appendHistory(order, 'confirmed', req.user?.name || 'Staff');
  const data = { ...(order.data || {}), prep_time: prep };
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'confirmed', acknowledged = TRUE, history = $3, data = $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [req.params.id, rid(req), JSON.stringify(history), JSON.stringify(data)],
  );
  ok(res, parseOrder(rows[0]));
}));

router.post('/:id/reject', asyncHandler(async (req, res) => {
  if (req.user?.role === 'rider' || req.user?.role === 'courier') {
    throw forbidden('Riders cannot reject kitchen orders');
  }
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();
  if (!['pending', 'confirmed'].includes(order.status)) {
    throw badRequest(`Cannot reject order in status ${order.status}`);
  }
  const note = (req.body || {}).note || 'Rejected by restaurant';
  const history = appendHistory(order, 'canceled', req.user?.name || 'Staff');
  const data = { ...(order.data || {}), cancel_reason: note };
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'canceled', acknowledged = TRUE, history = $3, note = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [req.params.id, rid(req), JSON.stringify(history), note, JSON.stringify(data)],
  );
  ok(res, parseOrder(rows[0]));
}));

/** Cashier partial or full line item returns with authoritative refund calculation */
router.post('/:id/return', asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();

  const rawItems = req.body?.items || req.body?.returned_items;
  const returnItems = Array.isArray(rawItems)
    ? rawItems
    : (req.body?.item_index !== undefined ? [req.body] : []);

  if (!returnItems.length) {
    throw badRequest('No items specified to return');
  }

  const orderItems = Array.isArray(order.items) ? [...order.items] : [];
  if (!orderItems.length) {
    throw badRequest('Order contains no line items to return');
  }

  let totalRefund = 0;
  const processedReturns = [];

  for (const entry of returnItems) {
    let targetIndex = -1;
    let targetItem = null;

    if (entry.item_index !== undefined && entry.item_index !== null) {
      const idx = Number(entry.item_index);
      if (idx >= 0 && idx < orderItems.length) {
        targetIndex = idx;
        targetItem = orderItems[idx];
      }
    } else if (entry.id !== undefined || entry.product_id !== undefined) {
      const matchId = String(entry.id || entry.product_id);
      targetIndex = orderItems.findIndex((it) => String(it.id || it.product_id) === matchId);
      if (targetIndex >= 0) {
        targetItem = orderItems[targetIndex];
      }
    }

    if (!targetItem || targetIndex === -1) {
      throw badRequest(`Item ${entry.item_index !== undefined ? `at index ${entry.item_index}` : (entry.id || entry.product_id)} not found in order`);
    }

    const availableQty = (Number(targetItem.qty) || 1) - (Number(targetItem.returned) || 0);
    const returnQty = Math.max(0, Number(entry.qty) || 1);

    if (returnQty <= 0) {
      throw badRequest('Return quantity must be greater than zero');
    }
    if (returnQty > availableQty) {
      throw badRequest(`Cannot return ${returnQty} of "${targetItem.name || 'item'}"; available to return: ${availableQty}`);
    }

    const price = Number(targetItem.price) || 0;
    const addons = Array.isArray(targetItem.addons)
      ? targetItem.addons.reduce((sum, a) => sum + (Number(a && a.price) || 0), 0)
      : 0;
    const unitPrice = price + addons;
    const lineRefund = Math.round(unitPrice * returnQty * 100) / 100;

    totalRefund += lineRefund;
    targetItem.returned = (Number(targetItem.returned) || 0) + returnQty;

    processedReturns.push({
      item_index: targetIndex,
      product_id: targetItem.id || targetItem.product_id || null,
      name: targetItem.name || 'Item',
      qty: returnQty,
      unit_price: unitPrice,
      refund_amount: lineRefund,
      reason: entry.reason || req.body?.reason || 'Cashier return',
    });
  }

  const refundAmount = Math.round(totalRefund * 100) / 100;
  // Authoritative recomputation of remaining subtotal from active quantities
  const activeSubtotal = orderItems.reduce((sum, it) => {
    const p = Number(it.price) || 0;
    const q = Math.max(0, (Number(it.qty) || 1) - (Number(it.returned) || 0));
    const a = Array.isArray(it.addons)
      ? it.addons.reduce((s, x) => s + (Number(x && x.price) || 0), 0)
      : 0;
    return sum + (p + a) * q;
  }, 0);
  const newSubtotal = Math.round(activeSubtotal * 100) / 100;
  const newTotal = Math.max(0, Math.round((Number(order.total) - refundAmount) * 100) / 100);

  const allReturned = orderItems.every((it) => (Number(it.returned) || 0) >= (Number(it.qty) || 1));
  const newStatus = allReturned ? 'returned' : order.status;

  const existingReturns = Array.isArray(order.data?.returns) ? [...order.data.returns] : [];
  const returnRecord = {
    return_id: `ret_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    at: new Date().toISOString(),
    by: req.user?.name || req.user?.email || 'Cashier',
    user_id: req.user?.id || req.user?.sub || null,
    refund_amount: refundAmount,
    reason: req.body?.reason || 'Cashier return',
    payment_method: req.body?.payment_method || order.payment_method || 'cash',
    items: processedReturns,
  };
  existingReturns.push(returnRecord);

  const updatedData = {
    ...(order.data || {}),
    returns: existingReturns,
    total_refunded: Math.round(((order.data?.total_refunded || 0) + refundAmount) * 100) / 100,
  };

  const history = appendHistory(
    order,
    newStatus,
    `Returned items: refund ${refundAmount.toFixed(2)} (${req.body?.reason || 'Cashier return'})`,
  );

  const { rows } = await pool.query(
    `UPDATE orders SET
       items = $3,
       subtotal = $4,
       total = $5,
       status = $6,
       data = $7::jsonb,
       history = $8,
       updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [
      req.params.id,
      rid(req),
      JSON.stringify(orderItems),
      newSubtotal,
      newTotal,
      newStatus,
      JSON.stringify(updatedData),
      JSON.stringify(history),
    ],
  );

  const updated = parseOrder(rows[0]);
  ok(res, updated);
}));

/** Stockout resolution: remove unavailable items and authoritatively recalculate totals */
const handleRemoveItems = asyncHandler(async (req, res) => {
  const order = await fetchOrder(req.params.id, rid(req), req);
  if (!order) throw notFound();

  const rawItems = req.body?.items || req.body?.removed_items;
  const itemsToRemove = Array.isArray(rawItems)
    ? rawItems
    : (req.body?.item_index !== undefined ? [req.body] : []);

  if (!itemsToRemove.length) {
    throw badRequest('No items specified to remove');
  }

  const orderItems = Array.isArray(order.items) ? [...order.items] : [];
  if (!orderItems.length) {
    throw badRequest('Order contains no line items');
  }

  const removedLog = [];

  for (const entry of itemsToRemove) {
    let targetIndex = -1;
    let targetItem = null;

    if (entry.item_index !== undefined && entry.item_index !== null) {
      const idx = Number(entry.item_index);
      if (idx >= 0 && idx < orderItems.length) {
        targetIndex = idx;
        targetItem = orderItems[idx];
      }
    } else if (entry.id !== undefined || entry.product_id !== undefined) {
      const matchId = String(entry.id || entry.product_id);
      targetIndex = orderItems.findIndex((it) => String(it.id || it.product_id) === matchId);
      if (targetIndex >= 0) {
        targetItem = orderItems[targetIndex];
      }
    }

    if (!targetItem || targetIndex === -1) {
      throw badRequest(`Item ${entry.item_index !== undefined ? `at index ${entry.item_index}` : (entry.id || entry.product_id)} not found in order`);
    }

    const currentQty = Number(targetItem.qty) || 1;
    const removeQty = entry.qty != null ? Number(entry.qty) : currentQty;

    if (removeQty <= 0) {
      throw badRequest('Remove quantity must be greater than zero');
    }
    if (removeQty > currentQty) {
      throw badRequest(`Cannot remove ${removeQty} of "${targetItem.name || 'item'}"; existing quantity: ${currentQty}`);
    }

    const price = Number(targetItem.price) || 0;
    const addons = Array.isArray(targetItem.addons)
      ? targetItem.addons.reduce((sum, a) => sum + (Number(a && a.price) || 0), 0)
      : 0;

    removedLog.push({
      item_index: targetIndex,
      product_id: targetItem.id || targetItem.product_id || null,
      name: targetItem.name || 'Item',
      qty_removed: removeQty,
      price: price + addons,
      reason: entry.reason || req.body?.reason || 'Item unavailable / stockout',
      removed_at: new Date().toISOString(),
      by: req.user?.name || req.user?.email || 'Staff',
    });

    targetItem.qty = currentQty - removeQty;
  }

  // Filter out items with 0 remaining quantity
  const updatedItems = orderItems.filter((it) => (Number(it.qty) || 0) > 0);

  // Authoritative server-side recomputation of subtotal & total without throwing 403 on MONEY_FIELDS
  const newSubtotal = updatedItems.reduce((s, it) => {
    const p = Number(it.price) || 0;
    const q = Number(it.qty) || 1;
    const addons = Array.isArray(it.addons)
      ? it.addons.reduce((a, x) => a + (Number(x && x.price) || 0), 0)
      : 0;
    return s + (p + addons) * q;
  }, 0);
  const roundedSubtotal = Math.round(newSubtotal * 100) / 100;
  const discount = Number(order.discount) || 0;
  const deliveryCharge = Number(order.delivery_charge) || 0;
  const serviceCharge = Number(order.service_charge) || 0;
  const tip = Number(order.tip) || 0;
  const newTotal = Math.max(
    0,
    Math.round((roundedSubtotal - discount + deliveryCharge + serviceCharge + tip) * 100) / 100,
  );

  const existingRemoved = Array.isArray(order.data?.removed_items) ? [...order.data.removed_items] : [];
  existingRemoved.push(...removedLog);

  const updatedData = {
    ...(order.data || {}),
    removed_items: existingRemoved,
  };

  const history = appendHistory(
    order,
    order.status,
    `Removed unavailable items: ${removedLog.map((r) => `${r.qty_removed}x ${r.name}`).join(', ')}`,
  );

  const { rows } = await pool.query(
    `UPDATE orders SET
       items = $3,
       subtotal = $4,
       total = $5,
       data = $6::jsonb,
       history = $7,
       updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [
      req.params.id,
      rid(req),
      JSON.stringify(updatedItems),
      roundedSubtotal,
      newTotal,
      JSON.stringify(updatedData),
      JSON.stringify(history),
    ],
  );

  const updated = parseOrder(rows[0]);
  ok(res, updated);
});

router.post('/:id/remove-items', handleRemoveItems);
router.post('/:id/item-unavailable', handleRemoveItems);

router.applyOrderEngines = applyOrderEngines;
router.parseOrder = parseOrder;
router.projectRiderOrder = projectRiderOrder;

module.exports = router;

