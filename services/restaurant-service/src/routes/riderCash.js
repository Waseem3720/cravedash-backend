/**
 * Cash a rider holds from cash deliveries.
 *
 *   collected  = delivered cash orders assigned to the rider, whatever their payment status
 *   settled    = cash the rider has handed in (driver_cash_settlements)
 *   in hand    = collected - settled
 *
 * A handover is the only thing that reduces cash in hand. Marking an order paid does not, because that would take the
 * same cash out twice.
 *
 * Nothing is stored on the order or the rider; the figures are computed from the rows each time.
 */
const DONE = ['delivered', 'completed'];

/**
 * Cash in hand for each rider of the restaurant (or for one rider when driverId is given). `db` is a pool or a client,
 * so a settlement can read the figure inside its own transaction.
 */
async function cashByRider(db, restaurant, driverId = null) {
  const { rows: collected } = await db.query(
    `SELECT data->>'delivery_man_id' AS driver, COALESCE(SUM(total), 0) AS amount
       FROM orders
      WHERE restaurant_id = $1
        AND data->>'delivery_man_id' IS NOT NULL
        AND status = ANY($2::text[])
        AND LOWER(COALESCE(payment_method, '')) = 'cash'
        AND ($3::text IS NULL OR data->>'delivery_man_id' = $3)
      GROUP BY 1`,
    [restaurant, DONE, driverId],
  );
  const { rows: settled } = await db.query(
    `SELECT driver_id AS driver, COALESCE(SUM(amount), 0) AS amount
       FROM driver_cash_settlements
      WHERE restaurant_id = $1 AND ($2::text IS NULL OR driver_id = $2)
      GROUP BY 1`,
    [restaurant, driverId],
  );
  const map = new Map();
  for (const r of collected) map.set(r.driver, { collected: Number(r.amount), settled: 0 });
  for (const r of settled) {
    const s = map.get(r.driver) || { collected: 0, settled: 0 };
    s.settled = Number(r.amount);
    map.set(r.driver, s);
  }
  for (const [id, s] of map) map.set(id, { ...s, in_hand: round2(s.collected - s.settled) });
  return map;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { cashByRider, round2 };
