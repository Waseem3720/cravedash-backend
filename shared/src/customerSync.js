/**
 * Keeps the restaurant customer list in step with orders. An order's customer is matched by phone number,
 * so the same person is not stored twice. Existing orders are not changed.
 */

/** Digits only. A Pakistani number sent as +92 / 0092 is stored in the 03XXXXXXXXX form. */
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('92') && digits.length === 12) digits = `0${digits.slice(2)}`;
  return digits;
}

/**
 * Finds the customer with this phone number, or creates one. Returns the customer id, or null when the order
 * has no usable phone number. Throws on database errors; use `linkOrderCustomer` from order flows.
 */
async function upsertCustomerFromOrder(db, { restaurantId, customer, branchId }) {
  const phone = normalizePhone(customer && customer.phone);
  if (phone.length < 7) return null;
  const name = String((customer && customer.name) || '').trim() || null;
  const email = String((customer && customer.email) || '').trim() || null;
  const address = String((customer && customer.address) || '').trim() || null;

  const { rows } = await db.query(
    `SELECT id FROM customers
     WHERE restaurant_id = $1 AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
     ORDER BY created_at LIMIT 1`,
    [restaurantId, phone],
  );
  if (rows[0]) {
    if (name) {
      await db.query(
        'UPDATE customers SET name = $3, updated_at = NOW() WHERE id = $1 AND restaurant_id = $2',
        [rows[0].id, restaurantId, name],
      );
    }
    return rows[0].id;
  }

  const id = `cust_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO customers (id, restaurant_id, name, email, phone, branch_id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())`,
    [id, restaurantId, name, email, phone, branchId || null, JSON.stringify(address ? { address } : {})],
  );
  return id;
}

/**
 * Called after an order is saved. A failure here is logged and never fails the order.
 */
async function linkOrderCustomer(db, args) {
  try {
    return await upsertCustomerFromOrder(db, args);
  } catch (err) {
    console.error('[customers] could not link order customer:', err.message);
    return null;
  }
}

module.exports = { normalizePhone, upsertCustomerFromOrder, linkOrderCustomer };
