/**
 * Rider assignment for delivery orders.
 *
 * Rules (enforced here on the server, not only in the UI):
 *  - a rider must be active, in the same branch as the order (restaurant-level riders serve restaurant-level orders),
 *    and below the open-order limit;
 *  - an order is only assigned while it is open (confirmed to cooking, ready, or out for delivery);
 *  - each assignment runs under a lock on the restaurant, so two requests cannot push one rider over the limit;
 *  - automatic assignment runs once per order when it reaches cooking; if no rider is eligible the order is flagged
 *    `waiting_for_rider` and stays where it is. Nothing here moves an order to out_for_delivery.
 *
 * The open-order limit is DELIVERY_MAX_OPEN_ORDERS (default 5). It is not stored per restaurant yet.
 */
const { AppError, badRequest, notFound } = require('../errors');

// Pending counts too: a rider can be chosen before the order is accepted, and that commitment uses a slot.
const OPEN_STATUSES = ['pending', 'confirmed', 'processing', 'cooking', 'ready_for_serve', 'out_for_delivery'];
const AUTO_TRIGGER_STATUS = 'cooking';

function maxOpenOrders() {
  const n = Number(process.env.DELIVERY_MAX_OPEN_ORDERS);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

async function lockRestaurant(db, restaurant) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider-assign:${restaurant}`]);
}

/** Riders of the order's branch with their open-order count and whether each one can take the order. */
async function candidatesFor(db, restaurant, branch) {
  const max = maxOpenOrders();
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.status, d.branch_id,
            (SELECT COUNT(*)::int FROM orders o
              WHERE o.restaurant_id = d.restaurant_id AND o.data->>'delivery_man_id' = d.id
                AND o.status = ANY($3::text[])) AS open_orders
       FROM deliverymen d
      WHERE d.restaurant_id = $1 AND d.branch_id IS NOT DISTINCT FROM $2
      ORDER BY d.name, d.id`,
    // 'main' is the restaurant-level branch (see assignRider), so riders with no branch are listed for it.
    [restaurant, branch && branch !== 'main' ? branch : null, OPEN_STATUSES],
  );
  return rows.map((r) => {
    const active = String(r.status || '').toLowerCase() === 'active';
    const reason = !active ? 'Not active' : r.open_orders >= max ? `Already has ${max} open orders` : null;
    return { id: r.id, name: r.name, branch_id: r.branch_id || null, open_orders: r.open_orders, eligible: reason === null, reason };
  });
}

function assignedRider(data) {
  return data && typeof data === 'object' && data.delivery_man_id ? data.delivery_man_id : null;
}

/** Loads the order under a row lock. The caller must already hold the restaurant lock and an open transaction. */
async function lockOrder(client, restaurant, orderId) {
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [orderId, restaurant]);
  if (!rows[0]) throw notFound('Order not found');
  return rows[0];
}

/** Writes the rider onto the order, appends to the assignment history, and clears the waiting flag. */
async function writeAssignment(client, order, rider, { by, reason, previous }) {
  const data = { ...(order.data || {}) };
  data.delivery_man_id = rider.id;
  data.delivery_man = rider.name;
  delete data.waiting_for_rider;
  delete data.waiting_since;
  data.assignment_history = [
    ...(Array.isArray(data.assignment_history) ? data.assignment_history : []),
    { rider_id: rider.id, rider_name: rider.name, previous_rider_id: previous || null, by, reason: reason || null, at: new Date().toISOString() },
  ];
  const { rows } = await client.query(
    `UPDATE orders SET data = $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND restaurant_id = $2 AND status = $4 RETURNING *`,
    [order.id, order.restaurant_id, JSON.stringify(data), order.status],
  );
  if (!rows[0]) throw new AppError('This order changed while the rider was being assigned. Reload and try again.', 409, 'CONFLICT');
  return rows[0];
}

/**
 * Assigns a rider chosen by an admin. Re-assigning an order that already has a rider needs a reason.
 * Assigning the rider already on the order does nothing (safe to retry).
 */
async function assignRider(client, { restaurant, orderId, riderId, by, reason, inScope }) {
  await lockRestaurant(client, restaurant);
  const order = await lockOrder(client, restaurant, orderId);
  if (order.order_type !== 'delivery') throw badRequest('Only delivery orders take a rider');
  if (!OPEN_STATUSES.includes(order.status)) throw new AppError(`A rider cannot be assigned to an order that is ${order.status}`, 409, 'CONFLICT');
  const current = assignedRider(order.data);
  if (current === String(riderId)) return { order, changed: false };
  if (current && !(reason && String(reason).trim().length >= 3)) {
    throw badRequest('Give a reason (at least 3 characters) to change the rider on this order');
  }
  const { rows: riderRows } = await client.query('SELECT id, name, status, branch_id FROM deliverymen WHERE id = $1 AND restaurant_id = $2', [String(riderId), restaurant]);
  const rider = riderRows[0];
  if (!rider) throw badRequest('Delivery man not found');
  // A rider outside the caller's scope is reported as not found, the same as the order lookup.
  if (inScope && !inScope(rider.branch_id)) throw notFound('Delivery man not found');
  // 'main' is the restaurant-level branch that orders without a branch are stored under, the same as a NULL branch.
  const restaurantLevel = (b) => (b && b !== 'main' ? b : null);
  if (restaurantLevel(rider.branch_id) !== restaurantLevel(order.branch_id)) throw badRequest('This delivery man works in another branch');
  const mine = (await candidatesFor(client, restaurant, order.branch_id)).find((c) => c.id === rider.id);
  if (!mine || !mine.eligible) throw new AppError(mine ? `Cannot assign: ${mine.reason}` : 'Delivery man not available', 409, 'CONFLICT');
  const updated = await writeAssignment(client, order, rider, { by, reason, previous: current });
  return { order: updated, changed: true };
}

/**
 * Picks the eligible rider with the fewest open orders for a delivery order that has no rider yet. If nobody is
 * eligible, the order is flagged as waiting for a rider (once) and returned unchanged otherwise.
 */
async function autoAssign(client, { restaurant, orderId, by }) {
  await lockRestaurant(client, restaurant);
  const order = await lockOrder(client, restaurant, orderId);
  if (order.order_type !== 'delivery' || !OPEN_STATUSES.includes(order.status)) return { order, rider: null };
  if (assignedRider(order.data)) return { order, rider: null };
  const eligible = (await candidatesFor(client, restaurant, order.branch_id))
    .filter((c) => c.eligible)
    .sort((a, b) => a.open_orders - b.open_orders || a.name.localeCompare(b.name));
  if (!eligible.length) {
    if (order.data && order.data.waiting_for_rider) return { order, rider: null };
    const data = { ...(order.data || {}), waiting_for_rider: true, waiting_since: new Date().toISOString() };
    const { rows } = await client.query(
      'UPDATE orders SET data = $3::jsonb, updated_at = NOW() WHERE id = $1 AND restaurant_id = $2 AND status = $4 RETURNING *',
      [order.id, restaurant, JSON.stringify(data), order.status],
    );
    if (!rows[0]) throw new AppError('This order changed while looking for a rider. Reload and try again.', 409, 'CONFLICT');
    return { order: rows[0], rider: null };
  }
  const pick = eligible[0];
  const updated = await writeAssignment(client, order, { id: pick.id, name: pick.name }, { by, reason: 'Automatic assignment' });
  return { order: updated, rider: { id: pick.id, name: pick.name } };
}

module.exports = {
  OPEN_STATUSES,
  AUTO_TRIGGER_STATUS,
  maxOpenOrders,
  candidatesFor,
  assignRider,
  autoAssign,
};
