const crypto = require('crypto');
const { pool, appendRow, listRows, round2, ensureDomainTables } = require('./helpers');

async function ensureCommerceDomain() {
  await ensureDomainTables();
  try {
    await pool.query(`ALTER TABLE domain_rows DROP CONSTRAINT IF EXISTS domain_rows_domain_check`);
    await pool.query(`ALTER TABLE domain_rows ADD CONSTRAINT domain_rows_domain_check
      CHECK (domain IN ('inventory','payroll','accounting','ops','commerce'))`);
    await pool.query(`ALTER TABLE domain_docs DROP CONSTRAINT IF EXISTS domain_docs_domain_check`);
    await pool.query(`ALTER TABLE domain_docs ADD CONSTRAINT domain_docs_domain_check
      CHECK (domain IN ('inventory','payroll','accounting','ops','commerce'))`);
  } catch { /* ignore if no permission / already widened */ }
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0`);
}

/**
 * The customer a wallet or loyalty change applies to. A stable id always wins. A name or email is used only when it
 * matches exactly one customer of this restaurant; two matches are refused, never guessed (BUG-015).
 */
async function getCustomer(restaurantId, customerIdOrName) {
  const key = String(customerIdOrName || '').trim();
  if (!key) return null;
  const { rows: byId } = await pool.query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND id = $2 LIMIT 1',
    [restaurantId, key],
  );
  if (byId[0]) return byId[0];
  const { rows } = await pool.query(
    `SELECT * FROM customers WHERE restaurant_id = $1
     AND (LOWER(name) = LOWER($2) OR LOWER(COALESCE(email,'')) = LOWER($2))
     LIMIT 2`,
    [restaurantId, key],
  );
  if (rows.length > 1) {
    const err = new Error('More than one customer matches. Use the customer id.');
    err.status = 409;
    err.code = 'CONFLICT';
    throw err;
  }
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

/** A customer lookup that matches no single customer (ambiguous name or email) is a business outcome: no points. */
function isBusinessRefusal(err) {
  return Boolean(err && (err.status === 400 || err.status === 409));
}

/**
 * Stable id of the loyalty line for one order, so the earn or the reversal of an order is recorded once (AUD-P1-2).
 */
function orderLoyaltyLineId(type, orderId) {
  return `lt_${crypto.createHash('sha256').update(`${type}|${orderId}`).digest('hex').slice(0, 40)}`;
}

async function loyaltyLineExists(restaurantId, lineId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM domain_rows WHERE restaurant_id = $1 AND domain = $2 AND collection = $3 AND id = $4',
    [restaurantId, 'commerce', 'loyalty_txns', lineId],
  );
  return rows.length > 0;
}

/**
 * Writes the loyalty line first, then changes the customer's points. If the points change fails, the line is removed again,
 * so a retry never awards or takes back the same points twice. Returns null when the line already exists.
 */
async function postOrderLoyalty(restaurantId, { lineId, customer, type, points, sign, order }) {
  if (await loyaltyLineExists(restaurantId, lineId)) return null;
  const current = +customer.loyalty_points || 0;
  // The fields are the same as before this change: an earn carries credit and balance, a reversal carries points.
  const line = sign > 0
    ? {
      customer_id: customer.id,
      customer: customer.name,
      type,
      credit: points,
      debit: 0,
      balance: current + points,
      reference: order.id,
      order_id: order.id,
      by: null,
    }
    : {
      customer_id: customer.id,
      customer: customer.name,
      type,
      points: -points,
      order_id: order.id,
    };
  const txn = await appendRow(restaurantId, 'commerce', 'loyalty_txns', { id: lineId, ...line }).catch((err) => {
    if (err.message === 'Ledger event id already exists') return null;
    throw err;
  });
  if (!txn) return null;
  try {
    if (sign > 0) {
      await pool.query(
        `UPDATE customers SET loyalty_points = COALESCE(loyalty_points,0) + $3, updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2`,
        [customer.id, restaurantId, points],
      );
    } else {
      await pool.query(
        `UPDATE customers SET loyalty_points = GREATEST(0, COALESCE(loyalty_points,0) - $3), updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2`,
        [customer.id, restaurantId, points],
      );
    }
  } catch (err) {
    await pool.query(
      'DELETE FROM domain_rows WHERE restaurant_id = $1 AND domain = $2 AND collection = $3 AND id = $4',
      [restaurantId, 'commerce', 'loyalty_txns', lineId],
    ).catch((undoErr) => console.error('[wallet] could not remove an unsaved loyalty line', undoErr.message));
    throw err;
  }
  return txn;
}

/**
 * Earn 1 point per £1 spent (configurable later via settings). Errors are not swallowed: a failed award fails the effect,
 * which is retried. A business refusal (for example an ambiguous customer name) still gives no points, as before.
 */
async function earnForOrder(restaurantId, order) {
  const cust = order.customer || {};
  const customerKey = cust.id || cust.customer_id || cust.phone || cust.email || cust.name;
  if (!customerKey) return null;
  const total = round2(+order.total || 0);
  const points = Math.floor(total);
  if (points <= 0) return null;
  await ensureCommerceDomain();
  let found;
  try {
    found = await getCustomer(restaurantId, cust.id || customerKey);
  } catch (err) {
    if (isBusinessRefusal(err)) return null;
    throw err;
  }
  if (!found) return null;
  return postOrderLoyalty(restaurantId, {
    lineId: orderLoyaltyLineId('Order earn', order.id),
    customer: found,
    type: 'Order earn',
    points,
    sign: 1,
    order,
  });
}

/** Ids of one branch's customers, or null for the whole restaurant (owner). */
async function branchCustomerIds(restaurantId, bound) {
  if (!bound) return null;
  const { rows } = await pool.query('SELECT id FROM customers WHERE restaurant_id = $1 AND branch_id = $2', [restaurantId, bound]);
  return new Set(rows.map((r) => r.id));
}

/** A ledger line belongs to a branch when the line itself is tagged with it, or its customer is in the branch. */
function inBranch(line, bound, ids) {
  if (!ids) return true;
  return String(line.branch_id) === String(bound) || (line.customer_id != null && ids.has(line.customer_id));
}

async function walletReport(restaurantId, bound = null) {
  await ensureCommerceDomain();
  const ids = await branchCustomerIds(restaurantId, bound);
  const txns = (await listRows(restaurantId, 'commerce', 'wallet_txns')).filter((t) => inBranch(t, bound, ids));
  const credit = round2(txns.reduce((s, t) => s + (+t.credit || 0), 0));
  const debit = round2(txns.reduce((s, t) => s + (+t.debit || 0), 0));
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(wallet_balance),0)::float AS bal FROM customers WHERE restaurant_id = $1 AND ($2::text IS NULL OR branch_id = $2)`,
    [restaurantId, bound],
  );
  return { credit, debit, blob_balance: round2(credit - debit), customer_balances: round2(rows[0]?.bal || 0), txns };
}

async function loyaltyReport(restaurantId, bound = null) {
  await ensureCommerceDomain();
  const ids = await branchCustomerIds(restaurantId, bound);
  const txns = (await listRows(restaurantId, 'commerce', 'loyalty_txns')).filter((t) => inBranch(t, bound, ids));
  const credit = txns.reduce((s, t) => s + (+t.credit || 0), 0);
  const debit = txns.reduce((s, t) => s + (+t.debit || 0), 0);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(loyalty_points),0)::int AS pts FROM customers WHERE restaurant_id = $1 AND ($2::text IS NULL OR branch_id = $2)`,
    [restaurantId, bound],
  );
  return { credit, debit, customer_points: rows[0]?.pts || 0, txns };
}

/** Takes back the loyalty points an order earned (ORD-H7 phase 2). Mirrors earnForOrder; never below zero. */
async function reverseLoyaltyForOrder(restaurantId, order) {
  const cust = order.customer || {};
  const customerKey = cust.id || cust.customer_id || cust.phone || cust.email || cust.name;
  if (!customerKey) return null;
  const points = Math.floor(round2(+order.total || 0));
  if (points <= 0) return null;
  await ensureCommerceDomain();
  let found;
  try {
    found = await getCustomer(restaurantId, cust.id || cust.customer_id || customerKey);
  } catch (err) {
    if (isBusinessRefusal(err)) return null;
    throw err;
  }
  if (!found) return null;
  const txn = await postOrderLoyalty(restaurantId, {
    lineId: orderLoyaltyLineId('Order reversal', order.id),
    customer: found,
    type: 'Order reversal',
    points,
    sign: -1,
    order,
  });
  return txn ? { reversed: points } : null;
}

module.exports = {
  reverseLoyaltyForOrder,
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
