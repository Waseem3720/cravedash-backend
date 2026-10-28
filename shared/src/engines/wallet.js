const { pool, appendRow, listRows, round2, ensureDomainTables } = require('./helpers');

/**
 * Canonical schema provisioning handled by Migrations 000, 003, and 009 (CD-CON-058).
 * Retained as no-op to preserve function signature for callers.
 */
async function ensureCommerceDomain() {
  return;
}

async function getCustomer(restaurantId, customerIdOrName) {
  const { rows } = await pool.query(
    `SELECT * FROM customers WHERE restaurant_id = $1
     AND (id = $2 OR LOWER(name) = LOWER($2) OR LOWER(COALESCE(email,'')) = LOWER($2))
     LIMIT 1`,
    [restaurantId, String(customerIdOrName || '')],
  );
  return rows[0] || null;
}

async function creditWallet(restaurantId, {
  customer_id, customer, amount, type, reference, by,
}) {
  await ensureCommerceDomain();
  const cust = await getCustomer(restaurantId, customer_id || customer);
  if (!cust) {
    const err = new Error('Customer not found');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const credit = round2(Math.abs(+amount || 0));
  if (!credit) {
    const err = new Error('amount must be > 0');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const { rows } = await pool.query(
    `UPDATE customers SET wallet_balance = COALESCE(wallet_balance,0) + $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [cust.id, restaurantId, credit],
  );
  const txn = await appendRow(restaurantId, 'commerce', 'wallet_txns', {
    customer_id: cust.id,
    customer: cust.name,
    type: type || 'Add fund by admin',
    credit,
    debit: 0,
    balance: round2(+rows[0].wallet_balance),
    reference: reference || null,
    by: by || null,
  });
  return { customer: rows[0], txn };
}

async function debitWallet(restaurantId, {
  customer_id, customer, amount, type, reference, by, order_id,
}) {
  await ensureCommerceDomain();
  const cust = await getCustomer(restaurantId, customer_id || customer);
  if (!cust) {
    const err = new Error('Customer not found');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const debit = round2(Math.abs(+amount || 0));
  if (!debit) {
    const err = new Error('amount must be > 0');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const bal = round2(+cust.wallet_balance || 0);
  if (bal + 0.001 < debit) {
    const err = new Error(`Insufficient wallet balance (have £${bal.toFixed(2)})`);
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const { rows } = await pool.query(
    `UPDATE customers SET wallet_balance = COALESCE(wallet_balance,0) - $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND COALESCE(wallet_balance,0) >= $3
     RETURNING *`,
    [cust.id, restaurantId, debit],
  );
  if (!rows[0]) {
    const err = new Error('Wallet debit failed (concurrent update)');
    err.status = 409; err.code = 'CONFLICT'; throw err;
  }
  const txn = await appendRow(restaurantId, 'commerce', 'wallet_txns', {
    customer_id: cust.id,
    customer: cust.name,
    type: type || (order_id ? 'Order place' : 'Wallet debit'),
    credit: 0,
    debit,
    balance: round2(+rows[0].wallet_balance),
    reference: reference || order_id || null,
    order_id: order_id || null,
    by: by || null,
  });
  return { customer: rows[0], txn };
}

async function earnLoyalty(restaurantId, {
  customer_id, customer, points, type, reference, order_id, by,
}) {
  await ensureCommerceDomain();
  const cust = await getCustomer(restaurantId, customer_id || customer);
  if (!cust) return null;
  const pts = Math.max(0, Math.floor(+points || 0));
  if (!pts) return null;
  const { rows } = await pool.query(
    `UPDATE customers SET loyalty_points = COALESCE(loyalty_points,0) + $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [cust.id, restaurantId, pts],
  );
  const txn = await appendRow(restaurantId, 'commerce', 'loyalty_txns', {
    customer_id: cust.id,
    customer: cust.name,
    type: type || 'Order earn',
    credit: pts,
    debit: 0,
    balance: +rows[0].loyalty_points || 0,
    reference: reference || order_id || null,
    order_id: order_id || null,
    by: by || null,
  });
  return { customer: rows[0], txn };
}

async function redeemLoyalty(restaurantId, {
  customer_id, customer, points, type, reference, by,
}) {
  await ensureCommerceDomain();
  const cust = await getCustomer(restaurantId, customer_id || customer);
  if (!cust) {
    const err = new Error('Customer not found');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const pts = Math.max(0, Math.floor(+points || 0));
  if (!pts) {
    const err = new Error('points must be > 0');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const { rows } = await pool.query(
    `UPDATE customers SET loyalty_points = COALESCE(loyalty_points,0) - $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2 AND COALESCE(loyalty_points,0) >= $3
     RETURNING *`,
    [cust.id, restaurantId, pts],
  );
  if (!rows[0]) {
    const err = new Error('Insufficient loyalty points');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const txn = await appendRow(restaurantId, 'commerce', 'loyalty_txns', {
    customer_id: cust.id,
    customer: cust.name,
    type: type || 'Redeem',
    credit: 0,
    debit: pts,
    balance: +rows[0].loyalty_points || 0,
    reference: reference || null,
    by: by || null,
  });
  return { customer: rows[0], txn };
}

/** Earn 1 point per £1 spent (configurable later via settings). */
async function earnForOrder(restaurantId, order) {
  const cust = order.customer || {};
  const customerKey = cust.id || cust.customer_id || cust.phone || cust.email || cust.name;
  if (!customerKey) return null;
  const total = round2(+order.total || 0);
  const points = Math.floor(total);
  if (points <= 0) return null;
  try {
    return await earnLoyalty(restaurantId, {
      customer_id: cust.id,
      customer: customerKey,
      points,
      order_id: order.id,
      type: 'Order earn',
    });
  } catch {
    return null;
  }
}

async function walletReport(restaurantId) {
  await ensureCommerceDomain();
  const txns = await listRows(restaurantId, 'commerce', 'wallet_txns');
  const credit = round2(txns.reduce((s, t) => s + (+t.credit || 0), 0));
  const debit = round2(txns.reduce((s, t) => s + (+t.debit || 0), 0));
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(wallet_balance),0)::float AS bal FROM customers WHERE restaurant_id = $1`,
    [restaurantId],
  );
  return { credit, debit, blob_balance: round2(credit - debit), customer_balances: round2(rows[0]?.bal || 0), txns };
}

async function loyaltyReport(restaurantId) {
  await ensureCommerceDomain();
  const txns = await listRows(restaurantId, 'commerce', 'loyalty_txns');
  const credit = txns.reduce((s, t) => s + (+t.credit || 0), 0);
  const debit = txns.reduce((s, t) => s + (+t.debit || 0), 0);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(loyalty_points),0)::int AS pts FROM customers WHERE restaurant_id = $1`,
    [restaurantId],
  );
  return { credit, debit, customer_points: rows[0]?.pts || 0, txns };
}

module.exports = {
  creditWallet,
  debitWallet,
  earnLoyalty,
  redeemLoyalty,
  earnForOrder,
  walletReport,
  loyaltyReport,
  getCustomer,
  ensureCommerceDomain,
};

