/**
 * The signed-in customer's own saved addresses and wishlist. The customer and the restaurant always come from the token
 * (requireCustomer), so one customer can never read or change another customer's rows, whatever id is sent.
 */
const crypto = require('crypto');
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireCustomer } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, unauthorized } = require('@cravedash/shared/src/errors');

const router = express.Router();
const ADDRESS_TYPES = new Set(['home', 'work', 'other', 'current']);
const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/** The address as the storefront reads it (address_line_1 and address_line_2 are the screens' names). */
function addressView(row) {
  return {
    id: row.id,
    address_type: row.address_type,
    house: row.house || '',
    floor: row.floor || '',
    road: row.road || '',
    town: row.town || '',
    postcode: row.postcode || '',
    instructions: row.instructions || '',
    contact_person_name: row.contact_name || '',
    contact_person_number: row.contact_phone || '',
    address_line_1: [row.house, row.road].filter(Boolean).join(' '),
    address_line_2: [row.floor, row.town].filter(Boolean).join(', ')
  };
}

/** The address fields from a request body, trimmed and limited. */
function addressFields(body = {}) {
  const type = ADDRESS_TYPES.has(String(body.address_type || '')) ? String(body.address_type) : 'home';
  const fields = {
    address_type: type,
    house: text(body.house),
    floor: text(body.floor),
    road: text(body.road),
    town: text(body.town),
    postcode: text(body.postcode, 12).toUpperCase(),
    instructions: text(body.instructions, 300),
    contact_name: text(body.contact_person_name),
    contact_phone: text(body.contact_person_number, 30)
  };
  if (!fields.road && !fields.house) throw badRequest('Add the house or the street for this address');
  if (!fields.postcode) throw badRequest('A postcode is required');
  return fields;
}

const customerOf = (req) => ({ id: req.customer.id, restaurantId: req.customer.restaurant_id });

/** The signed-in customer's profile, with the wallet and loyalty balances the account screens show. */
router.get('/customer/info', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const { rows } = await pool.query(
    'SELECT id, name, email, phone, status, data, wallet_balance, loyalty_points FROM customers WHERE id = $1 AND restaurant_id = $2',
    [id, restaurantId],
  );
  const customer = rows[0];
  if (!customer || customer.status === false) throw unauthorized('Customer account not found');
  ok(res, {
    id: customer.id,
    name: customer.name || null,
    email: customer.email || null,
    phone: customer.phone || null,
    restaurant_id: restaurantId,
    marketing_consent: !!(customer.data && customer.data.marketing_consent),
    wallet_balance: Number(customer.wallet_balance) || 0,
    loyalty_points: Number(customer.loyalty_points) || 0,
  });
}));

/** A UK mobile (07…) or an international number (+…), as the sign-in stores it. */
function normalizeContactPhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  else if (/^0\d{9,10}$/.test(p)) p = `+44${p.slice(1)}`;
  if (!/^\+\d{8,15}$/.test(p)) throw badRequest('Enter a valid phone number, for example 07700 900123');
  return p;
}

/** Edits the signed-in customer's name, e-mail and phone. A phone or e-mail used by another customer is refused. */
router.put('/customer/info', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const body = req.body || {};
  const name = text(body.name, 120);
  const email = text(body.email, 200);
  if (!name) throw badRequest('Enter your name');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid e-mail address');
  const phone = body.phone ? normalizeContactPhone(body.phone) : null;
  const { rows: taken } = await pool.query(
    'SELECT id FROM customers WHERE restaurant_id = $1 AND id <> $2 AND (($3::text IS NOT NULL AND LOWER(email) = LOWER($3)) OR ($4::text IS NOT NULL AND phone = $4)) LIMIT 1',
    [restaurantId, id, email || null, phone],
  );
  if (taken[0]) throw badRequest('That e-mail or phone number is already used by another account');
  const { rows } = await pool.query(
    `UPDATE customers SET name = $3, email = COALESCE(NULLIF($4, ''), email), phone = COALESCE($5, phone), updated_at = NOW()
      WHERE id = $1 AND restaurant_id = $2 AND status IS DISTINCT FROM FALSE
      RETURNING id, name, email, phone, data, wallet_balance, loyalty_points`,
    [id, restaurantId, name, email, phone],
  );
  const c = rows[0];
  if (!c) throw unauthorized('Customer account not found');
  ok(res, {
    id: c.id, name: c.name || null, email: c.email || null, phone: c.phone || null, restaurant_id: restaurantId,
    marketing_consent: !!(c.data && c.data.marketing_consent),
    wallet_balance: Number(c.wallet_balance) || 0, loyalty_points: Number(c.loyalty_points) || 0,
  });
}));

/**
 * Closes the signed-in customer's account. The account is switched off and its personal details and saved data are
 * removed. Past orders stay with the restaurant (they are its records), without the customer's contact details.
 */
router.delete('/customer/remove-account', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2', [restaurantId, id]);
    await client.query('DELETE FROM customer_wishlist WHERE restaurant_id = $1 AND customer_id = $2', [restaurantId, id]);
    const { rowCount } = await client.query(
      `UPDATE customers SET status = FALSE, name = NULL, email = NULL, phone = NULL, password_hash = NULL, updated_at = NOW()
        WHERE id = $1 AND restaurant_id = $2`,
      [id, restaurantId],
    );
    if (!rowCount) throw notFound('Customer account not found');
    await client.query('COMMIT');
    ok(res, { removed: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/customer/address/list', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const { rows } = await pool.query(
    'SELECT * FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 ORDER BY created_at ASC',
    [restaurantId, id],
  );
  ok(res, rows.map(addressView));
}));

router.post('/customer/address/add', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const f = addressFields(req.body);
  const addressId = `addr_${crypto.randomBytes(8).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO customer_addresses (id, restaurant_id, customer_id, address_type, house, floor, road, town, postcode,
       instructions, contact_name, contact_phone, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) RETURNING *`,
    [addressId, restaurantId, id, f.address_type, f.house, f.floor, f.road, f.town, f.postcode, f.instructions, f.contact_name, f.contact_phone],
  );
  ok(res, addressView(rows[0]));
}));

router.post('/customer/address/update/:addressId', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const f = addressFields(req.body);
  const { rows } = await pool.query(
    `UPDATE customer_addresses SET address_type = $4, house = $5, floor = $6, road = $7, town = $8, postcode = $9,
            instructions = $10, contact_name = $11, contact_phone = $12, updated_at = NOW()
      WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 RETURNING *`,
    [req.params.addressId, restaurantId, id, f.address_type, f.house, f.floor, f.road, f.town, f.postcode, f.instructions, f.contact_name, f.contact_phone],
  );
  if (!rows[0]) throw notFound('Address not found');
  ok(res, addressView(rows[0]));
}));

router.delete('/customer/address/:addressId', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const { rowCount } = await pool.query(
    'DELETE FROM customer_addresses WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3',
    [req.params.addressId, restaurantId, id],
  );
  if (!rowCount) throw notFound('Address not found');
  ok(res, { deleted: true });
}));

/** The wishlist: the products the customer saved that are still on the menu. */
router.get('/customer/wish-list', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.description, p.price, p.category_id, p.data
       FROM customer_wishlist w JOIN products p ON p.id = w.product_id AND p.restaurant_id = w.restaurant_id
      WHERE w.restaurant_id = $1 AND w.customer_id = $2 AND p.status = TRUE AND p.visible = TRUE
      ORDER BY w.created_at ASC`,
    [restaurantId, id],
  );
  ok(res, { products: rows.map((p) => ({ id: p.id, name: p.name, description: p.description || '', price: Number(p.price) || 0, category_id: p.category_id, image: (p.data && (p.data.img || p.data.image)) || null })) });
}));

router.post('/customer/wish-list/add', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const productId = text((req.body || {}).product_id, 120);
  if (!productId) throw badRequest('product_id is required');
  const { rows } = await pool.query('SELECT id FROM products WHERE id = $1 AND restaurant_id = $2', [productId, restaurantId]);
  if (!rows[0]) throw notFound('Product not found');
  await pool.query(
    `INSERT INTO customer_wishlist (restaurant_id, customer_id, product_id) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, customer_id, product_id) DO NOTHING`,
    [restaurantId, id, productId],
  );
  ok(res, { added: true, product_id: productId });
}));

router.post('/customer/wish-list/remove', requireCustomer, asyncHandler(async (req, res) => {
  const { id, restaurantId } = customerOf(req);
  const productId = text((req.body || {}).product_id, 120);
  if (!productId) throw badRequest('product_id is required');
  await pool.query(
    'DELETE FROM customer_wishlist WHERE restaurant_id = $1 AND customer_id = $2 AND product_id = $3',
    [restaurantId, id, productId],
  );
  ok(res, { removed: true, product_id: productId });
}));

module.exports = router;
