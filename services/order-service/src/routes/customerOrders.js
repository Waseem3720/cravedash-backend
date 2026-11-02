/**
 * Orders placed by a signed-in customer (website checkout). The customer comes from the token, never from the body:
 * customer_id is the token's subject, and the restaurant is the token's restaurant_id.
 * Every amount is calculated here (services/order-service/src/customerTotals.js). The client's total, discount and
 * delivery charge are ignored. Staff APIs refuse customer tokens, so this is the only route a customer order goes through.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireCustomer } = require('@cravedash/shared/src/authMiddleware');
const { badRequest } = require('@cravedash/shared/src/errors');
const { isRestaurantBranch } = require('@cravedash/shared/src/branches');
const { priceLinesFromCatalogue, RejectedLine } = require('@cravedash/shared/src/catalogPricing');
const { priceDealLines } = require('../dealPricing');
const {
  round2, normalizeCode, couponDiscount, matchDeliveryArea, computeTotals, couponProblem,
} = require('../customerTotals');

const { loadOrderSettings, loadDeliveryAreas } = require('../orderSettings');

const router = express.Router();

const ORDER_TYPES = new Set(['delivery', 'collection']);

/** The street address the customer gave for a delivery, as text. Stored with the order so the rider can find it. */
function deliveryAddressOf(raw, postcode) {
  const address = raw && typeof raw === 'object' ? raw : {};
  const text = (value, max) => String(value || '').trim().slice(0, max);
  return {
    address: text(address.address, 300),
    postcode: text(postcode || address.postcode, 20),
    contact_person_name: text(address.contact_person_name, 120),
    contact_person_number: text(address.contact_person_number, 40),
  };
}

router.post('/', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurant } = req.customer;

  // The customer must belong to this restaurant and still be active.
  const { rows: customers } = await pool.query(
    'SELECT id, name, phone FROM customers WHERE id = $1 AND restaurant_id = $2 AND status IS DISTINCT FROM FALSE',
    [customerId, restaurant],
  );
  const customer = customers[0];
  if (!customer) throw badRequest('Customer account not found for this restaurant');

  const body = req.body || {};
  const branch = body.branch_id ? String(body.branch_id) : 'main';
  if (branch !== 'main' && !(await isRestaurantBranch(pool, restaurant, branch))) {
    throw badRequest('Unknown branch for this restaurant');
  }

  const orderType = ORDER_TYPES.has(body.order_type) ? body.order_type : 'collection';
  let items;
  try {
    // Deal lines (deal_id) are priced from the deal; every other line from the catalogue, as before.
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const dealLines = rawItems.filter((line) => line && line.deal_id != null);
    const plainLines = rawItems.filter((line) => !(line && line.deal_id != null));
    const plainPriced = await priceLinesFromCatalogue(pool, restaurant, plainLines, {
      branchId: branch === 'main' ? null : branch,
    });
    items = [...plainPriced, ...(await priceDealLines(pool, restaurant, dealLines, {
      branchId: branch === 'main' ? null : branch,
    }))];
  } catch (err) {
    if (err instanceof RejectedLine) throw badRequest(err.message);
    throw err;
  }
  if (items.length === 0) throw badRequest('items are required');

  // Order history shows names, so each catalogue line carries its product's name (deal lines already have one).
  const productIds = [...new Set(items.filter((it) => it.product_id).map((it) => String(it.product_id)))];
  const { rows: productNames } = productIds.length
    ? await pool.query('SELECT id, name FROM products WHERE restaurant_id = $1 AND id = ANY($2::text[])', [restaurant, productIds])
    : { rows: [] };
  const nameById = new Map(productNames.map((p) => [String(p.id), p.name]));
  items = items.map((it) => (it.name ? it : { ...it, name: nameById.get(String(it.product_id)) || 'Item' }));

  const subtotal = round2(items.reduce((sum, it) => {
    const addons = Array.isArray(it.addons) ? it.addons.reduce((a, x) => a + (Number(x && x.price) || 0), 0) : 0;
    return sum + ((Number(it.price) || 0) + addons) * (Number(it.qty) || 1);
  }, 0));

  const settings = await loadOrderSettings(restaurant);

  // Delivery needs a postcode that matches one of the restaurant's delivery areas.
  let area = null;
  if (orderType === 'delivery') {
    if (!body.postcode) throw badRequest('A postcode is required for delivery');
    area = matchDeliveryArea(body.postcode, await loadDeliveryAreas(restaurant));
    if (!area) throw badRequest('Delivery is not available to this postcode');
  }

  const couponCode = body.coupon_code ? normalizeCode(body.coupon_code) : null;
  const customerJson = { id: customer.id, name: customer.name || null, phone: customer.phone || null };

  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');

    // The coupon row is locked for the rest of the transaction. Per-user counts and the total count are read and written
    // under that lock, so two concurrent orders cannot both use the last allowed use.
    let coupon = null;
    let couponAmount = 0;
    if (couponCode) {
      const { rows: found } = await client.query(
        'SELECT * FROM coupons WHERE restaurant_id = $1 AND UPPER(code) = $2 FOR UPDATE',
        [restaurant, couponCode],
      );
      coupon = found[0] || null;
      const problem = couponProblem(coupon, { now: new Date(), subtotal });
      if (problem) throw badRequest(problem);
      const limit = Number(coupon.usage_limit || 0);
      if (limit > 0) {
        const { rows: used } = await client.query(
          `SELECT COUNT(*)::int AS n FROM orders
           WHERE restaurant_id = $1 AND customer_id = $2 AND UPPER(data->>'coupon_code') = $3 AND status <> 'canceled'`,
          [restaurant, customer.id, couponCode],
        );
        if (used[0].n >= limit) throw badRequest('You have already used this coupon the maximum number of times');
      }
      couponAmount = couponDiscount(subtotal, coupon);
    }

    const totals = computeTotals({ subtotal, orderType, settings, area, couponAmount });

    const { rows } = await client.query(
      `INSERT INTO orders (
         id, restaurant_id, branch, branch_id, source, order_type, status, payment_status,
         customer, customer_id, items, subtotal, discount, delivery_charge, service_charge, total,
         coupon_code, note, history, data
       ) VALUES (
         nextval('orders_id_seq'), $1, $2, $3, 'website', $4, 'pending', 'unpaid',
         $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12,
         $13, $14, $15::jsonb, $16::jsonb
       ) RETURNING *`,
      [
        restaurant,
        branch === 'main' ? 'Main Branch' : branch,
        branch,
        orderType,
        JSON.stringify(customerJson),
        customer.id,
        JSON.stringify(items),
        totals.subtotal,
        totals.discount,
        totals.delivery_charge,
        totals.service_charge,
        totals.total,
        couponCode,
        String(body.note || ''),
        JSON.stringify([{ status: 'pending', at: new Date().toISOString(), by: customer.name || 'Customer' }]),
        JSON.stringify({
          client_id: body.client_id || null,
          coupon_code: couponCode,
          postcode: body.postcode ? normalizeCode(body.postcode) : null,
          delivery_area: area ? area.area_name : null,
          delivery_address: orderType === 'delivery' ? deliveryAddressOf(body.delivery_address, body.postcode) : null,
          payment_method: body.payment_method === 'card' ? 'card' : 'cash',
          service_fee: totals.service_fee,
          bag_charge: totals.bag_charge,
        }),
      ],
    );
    row = rows[0];

    if (coupon) {
      await client.query('UPDATE coupons SET used = used + 1, updated_at = NOW() WHERE id = $1', [coupon.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A customer_id that does not belong to this restaurant fails the composite foreign key (23503).
    if (err && err.code === '23503') throw badRequest('Customer account not found for this restaurant');
    throw err;
  } finally {
    client.release();
  }
  created(res, row);
}));

module.exports = router;
