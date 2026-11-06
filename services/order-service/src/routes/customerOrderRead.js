/**
 * The signed-in customer's own orders, read only: the list, one order's details, and its tracking history.
 * The customer and the restaurant come from the token (requireCustomer), never from the URL. Every query also filters
 * on restaurant_id and customer_id, so a customer cannot read another customer's order by changing the order id.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireCustomer } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound } = require('@cravedash/shared/src/errors');
const { RejectedLine } = require('@cravedash/shared/src/catalogPricing');
const { priceDealLines } = require('../dealPricing');

const router = express.Router();

// The dashboard's own status names are mapped to the names the website shows (see WEBSITE_STATUS).
const DELIVERED = ['delivered', 'completed'];
const CANCELLED = ['canceled', 'cancelled', 'returned', 'failed_to_deliver', 'failed'];
const LIST_MAX = 100;

/** The dashboard's status names, as the website's order screens expect them. */
const WEBSITE_STATUS = {
  completed: 'delivered',
  ready_for_serve: 'prepared',
  cooking: 'cooking',
  processing: 'processing',
  returned: 'returned',
  failed_to_deliver: 'failed',
  canceled: 'canceled',
};
const websiteStatus = (status) => WEBSITE_STATUS[status] || status;

/** Human-readable status as seen by the customer (image spec). */
const CUSTOMER_DISPLAY_STATUS = {
  pending: 'Order placed',
  processing: 'Waiting for restaurant confirmation',
  confirmed: 'Order confirmed',
  cooking: 'Being prepared',
  ready_for_serve: 'Prepared',
  out_for_delivery: 'On the way',
  delivered: 'Delivered',
  completed: 'Delivered',
  failed_to_deliver: 'Delivery failed',
  canceled: 'Canceled',
  returned: 'Returned',
};
const customerDisplayStatus = (status) => CUSTOMER_DISPLAY_STATUS[status] || (status ? String(status).replace(/_/g, ' ') : 'Order placed');

/** The order as the website reads it (order_status, order_amount, payment_method). */
function orderView(row) {
  return {
    id: String(row.id),
    status: row.status,
    order_status: websiteStatus(row.status),
    customer_status: customerDisplayStatus(row.status),
    display_status: customerDisplayStatus(row.status),
    order_amount: Number(row.total) || 0,
    subtotal: Number(row.subtotal) || 0,
    discount: Number(row.discount) || 0,
    delivery_charge: Number(row.delivery_charge) || 0,
    service_charge: Number(row.service_charge) || 0,
    order_type: row.order_type,
    payment_method: (row.data && row.data.payment_method) || null,
    coupon_code: row.coupon_code || null,
    order_note: row.note || '',
    branch: row.branch || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A line of the order with the product name looked up from the restaurant's products. */
function lineView(line, names) {
  const productId = line && line.product_id != null ? String(line.product_id) : null;
  const name = (productId && names.get(productId)) || (productId ? `Item #${productId}` : 'Item');
  const addons = Array.isArray(line && line.addons) ? line.addons : [];
  const addonTotal = addons.reduce((sum, a) => sum + (Number(a && a.price) || 0), 0);
  const quantity = Math.max(1, Number(line && (line.qty ?? line.quantity)) || 1);
  return {
    product_id: productId,
    product_name: name,
    product: { name },
    quantity,
    price: Number(line && line.price) || 0,
    addons: addons.map((a) => ({ name: a && a.name ? String(a.name) : null, price: Number(a && a.price) || 0 })),
    line_total: Math.round((((Number(line && line.price) || 0) + addonTotal) * quantity) * 100) / 100,
  };
}

async function productNames(restaurantId, items) {
  const ids = [...new Set(items.map((l) => (l && l.product_id != null ? String(l.product_id) : null)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query('SELECT id, name FROM products WHERE restaurant_id = $1 AND id = ANY($2::text[])', [restaurantId, ids]);
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

const orderIdOf = (req) => {
  const raw = String(req.query.order_id || '').trim();
  if (!/^\d+$/.test(raw)) throw badRequest('order_id is required');
  return raw;
};

/** One order that belongs to this customer in this restaurant, or 404. */
async function ownOrder(req) {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3`,
    [orderIdOf(req), restaurantId, customerId],
  );
  if (!rows[0]) throw notFound('Order not found');
  return rows[0];
}

router.get('/list', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  // The website sends a page number (1 is the first page) in offset, as the older website API did.
  const limit = Math.min(LIST_MAX, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Math.floor(Number(req.query.offset) || 1));
  const offset = (page - 1) * limit;
  const filter = String(req.query.order_filter || 'all');
  const params = [restaurantId, customerId];
  let statusClause = '';
  if (filter === 'delivered') {
    params.push(DELIVERED);
    statusClause = ` AND status = ANY($${params.length}::text[])`;
  } else if (filter === 'cancelled') {
    params.push(CANCELLED);
    statusClause = ` AND status = ANY($${params.length}::text[])`;
  } else if (filter === 'active') {
    params.push([...DELIVERED, ...CANCELLED]);
    statusClause = ` AND NOT (status = ANY($${params.length}::text[]))`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 AND customer_id = $2${statusClause}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  ok(res, { orders: rows.map(orderView), total_size: rows.length });
}));

router.get('/details', requireCustomer, asyncHandler(async (req, res) => {
  const row = await ownOrder(req);
  const items = Array.isArray(row.items) ? row.items : [];
  const names = await productNames(row.restaurant_id, items);
  ok(res, { order: orderView(row), details: items.map((l) => lineView(l, names)) });
}));

router.get('/track', requireCustomer, asyncHandler(async (req, res) => {
  const row = await ownOrder(req);
  const history = Array.isArray(row.history) ? row.history : [];
  ok(res, {
    order: orderView(row),
    history: history.map((h) => ({
      status: h && h.status ? websiteStatus(String(h.status)) : null,
      display_status: h && h.status ? customerDisplayStatus(String(h.status)) : null,
      at: h && h.at ? h.at : null,
    })),
  });
}));

/* Cancel: only an order the restaurant has not started (pending). Confirmed orders already ran stock and loyalty
   effects that a customer cancel would not reverse, so those are refused. */
const CANCELLABLE = ['pending'];

router.put('/cancel', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  const orderId = String((req.body || {}).order_id || '').trim();
  if (!/^\d+$/.test(orderId)) throw badRequest('order_id is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 FOR UPDATE',
      [orderId, restaurantId, customerId],
    );
    const order = rows[0];
    if (!order) throw notFound('Order not found');
    if (!CANCELLABLE.includes(order.status)) throw badRequest('This order can no longer be cancelled. Please contact the restaurant.');
    const history = Array.isArray(order.history) ? order.history : [];
    history.push({ status: 'canceled', at: new Date().toISOString(), by: 'Customer' });
    await client.query(
      "UPDATE orders SET status = 'canceled', history = $2::jsonb, updated_at = NOW() WHERE id = $1",
      [orderId, JSON.stringify(history)],
    );
    if (order.coupon_code) {
      await client.query(
        'UPDATE coupons SET used = GREATEST(used - 1, 0), updated_at = NOW() WHERE restaurant_id = $1 AND UPPER(code) = UPPER($2)',
        [restaurantId, order.coupon_code],
      );
    }
    await client.query('COMMIT');
    ok(res, { id: orderId, order_status: 'canceled' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    client.release();
  }
}));

/* Notifications for the customer: their orders' status changes, newest first (the history the restaurant records). */
router.get('/notifications', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const { rows } = await pool.query(
    'SELECT id, status, history, created_at FROM orders WHERE restaurant_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 30',
    [restaurantId, customerId],
  );
  const items = [];
  for (const order of rows) {
    const history = Array.isArray(order.history) ? order.history : [];
    for (const step of history) {
      if (!step || !step.status || !step.at) continue;
      items.push({
        id: `${order.id}-${step.status}-${step.at}`,
        order_id: String(order.id),
        title: `Order #${order.id}`,
        message: `Your order: ${customerDisplayStatus(step.status)}.`,
        status: step.status,
        display_status: customerDisplayStatus(step.status),
        created_at: step.at,
      });
    }
  }
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  ok(res, { notifications: items.slice(0, limit) });
}));

/** Checks a deal and its choices before the customer adds it to the cart. The same rules the order uses. */
router.post('/deal-preview', requireCustomer, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const dealId = body.deal_id == null ? '' : String(body.deal_id);
  if (!dealId) throw badRequest('deal_id is required');
  try {
    const [line] = await priceDealLines(pool, req.customer.restaurant_id, [{
      deal_id: dealId,
      qty: 1,
      selections: Array.isArray(body.selections) ? body.selections : [],
    }], { branchId: body.branch_id ? String(body.branch_id) : null });
    ok(res, { deal_id: line.deal_id, name: line.name, price: line.price, selections: line.selections });
  } catch (err) {
    if (err instanceof RejectedLine) throw badRequest(err.message);
    throw err;
  }
}));

module.exports = router;

