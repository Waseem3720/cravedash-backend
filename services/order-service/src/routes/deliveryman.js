/**
 * Rider (deliveryman) app routes, mounted at /api/v1/deliveryman. Every route works on the caller's own rider record
 * (users.id = deliverymen.id). Amounts in this API are in pence, as the rider app expects. The database stores pounds.
 * Only the cash handover confirmation is for the restaurant side (admin or till).
 */
const express = require('express');
const crypto = require('crypto');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, notFound } = require('@cravedash/shared/src/errors');
const { changeOrderStatus } = require('./orders');

const router = express.Router();

const toPence = (pounds) => Math.round((Number(pounds) || 0) * 100);
const toPounds = (pence) => Math.round(Number(pence) || 0) / 100;
const ACTIVE = ['ready_for_serve', 'out_for_delivery'];
const DEFAULT_PREFS = { theme: 'light', sound: true, vibration: true, location: true };

function rid(req) {
  return restaurantId(req);
}

/** Only riders use these routes, except the cash handover confirmation, which restaurant staff do. */
router.use((req, res, next) => {
  const isConfirm = req.method === 'POST' && /^\/cash\/handovers\/[^/]+\/confirm\/?$/.test(req.path);
  if (isConfirm) {
    if (['restaurant', 'super', 'epos'].includes(req.user?.role)) return next();
    return next(forbidden('Only restaurant staff can confirm a cash handover'));
  }
  if (req.user?.role === 'driver') return next();
  return next(forbidden('Only a rider session can use the deliveryman app'));
});

async function myRider(req) {
  const { rows } = await pool.query('SELECT * FROM deliverymen WHERE id = $1 AND restaurant_id = $2', [req.user.sub, rid(req)]);
  if (!rows[0]) throw notFound('Rider not found');
  return rows[0];
}

/** SQL condition: the order is assigned to this rider. Rider ids are plain tokens, so anything else is dropped. */
function assignedTo(riderId) {
  return `(o.data->>'delivery_man_id') = '${String(riderId).replace(/[^A-Za-z0-9_-]/g, '')}'`;
}

function hhmm(value) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Money and tips of one period, from the rider's delivered orders and driver payments. Amounts in pounds. */
async function periodStats(restaurant, riderId, since, until = null) {
  // The rider id is part of the condition itself (assignedTo), so only the restaurant and the dates are parameters.
  const params = [restaurant, since];
  let untilSql = '';
  if (until) {
    params.push(until);
    untilSql = `AND (o.data->>'delivered_at')::timestamptz <= $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT o.id, o.payment_method, o.data FROM orders o
      WHERE o.restaurant_id = $1 AND ${assignedTo(riderId)} AND o.status = 'delivered'
        AND (o.data->>'delivered_at')::timestamptz >= $2 ${untilSql}`,
    params,
  );
  let collected = 0;
  let cashTips = 0;
  let onlineTips = 0;
  for (const r of rows) {
    const d = r.data || {};
    collected += r.payment_method === 'cash' ? Number(d.cash_collected) || 0 : 0;
    const tip = Number(d.tip_amount) || 0;
    if (r.payment_method === 'cash') cashTips += tip;
    else onlineTips += tip;
  }
  return {
    orders: rows.length,
    collected: Math.round(collected * 100) / 100,
    cashTips: Math.round(cashTips * 100) / 100,
    onlineTips: Math.round(onlineTips * 100) / 100,
  };
}

async function handoverTotals(restaurant, riderId, since) {
  const { rows } = await pool.query(
    `SELECT status, COALESCE(SUM(amount), 0)::float AS total FROM rider_cash_handovers
      WHERE restaurant_id = $1 AND deliveryman_id = $2 AND created_at >= $3 GROUP BY status`,
    [restaurant, riderId, since],
  );
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.total) || 0]));
  return { pending: by.pending_confirmation || 0, confirmed: by.confirmed || 0 };
}

async function openShift(restaurant, riderId) {
  const { rows } = await pool.query(
    'SELECT * FROM rider_shifts WHERE restaurant_id = $1 AND deliveryman_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [restaurant, riderId],
  );
  return rows[0] || null;
}

function shiftView(s) {
  return {
    id: s.id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    opening_cash: toPence(s.opening_cash),
    float_owner: s.float_owner,
    actual_closing: s.actual_closing == null ? null : toPence(s.actual_closing),
    expected_closing: s.expected_closing == null ? null : toPence(s.expected_closing),
    variance: s.variance == null ? null : toPence(s.variance),
    restaurant_due: s.restaurant_due == null ? null : toPence(s.restaurant_due),
    orders: s.orders_count,
    cash_collected: s.cash_collected == null ? null : toPence(s.cash_collected),
    cash_tips: s.cash_tips == null ? null : toPence(s.cash_tips),
    online_tips: s.online_tips == null ? null : toPence(s.online_tips),
    note: s.note,
    z_number: s.z_number,
  };
}

/** The cash the rider holds now, in pence (cheff/deliveryman cash/summary). */
async function cashPosition(restaurant, rider) {
  const shift = await openShift(restaurant, rider.id);
  const since = shift ? shift.started_at : new Date(new Date().setHours(0, 0, 0, 0));
  const stats = await periodStats(restaurant, rider.id, since);
  const handovers = await handoverTotals(restaurant, rider.id, since);
  const floatHeld = shift && shift.float_owner === 'restaurant' ? Number(shift.opening_cash) || 0 : 0;
  const restaurantCashHeld = floatHeld + stats.collected;
  const { rows: pay } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0)::float AS total FROM driver_payments WHERE restaurant_id = $1 AND driver_id = $2 AND pay_date = CURRENT_DATE',
    [restaurant, rider.id],
  );
  return {
    shift,
    since,
    stats,
    handovers,
    summary: {
      restaurant_cash_held: toPence(restaurantCashHeld),
      held_order_cash: toPence(Math.max(0, stats.collected - handovers.pending - handovers.confirmed)),
      restaurant_float_held: toPence(floatHeld),
      physical_cash: toPence(restaurantCashHeld + stats.cashTips - handovers.confirmed),
      pending_handovers: toPence(handovers.pending),
      collected_today: toPence(stats.collected),
      confirmed_handovers: toPence(handovers.confirmed),
      cash_tips: toPence(stats.cashTips),
      online_tips: toPence(stats.onlineTips),
      delivery_pay: toPence(pay[0].total),
    },
  };
}

function riderOrder(o) {
  const c = o.customer || {};
  const d = o.data || {};
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    id: String(o.id),
    name: c.name || null,
    address: c.address || null,
    postcode: c.postcode || null,
    phone: c.phone || null,
    zone: d.zone || null,
    distance: d.distance ?? null,
    total: toPence(o.total),
    cashDue: o.payment_method === 'cash' && String(o.payment_status).toLowerCase() !== 'paid' ? toPence(o.total) : 0,
    method: o.payment_method ? o.payment_method.charAt(0).toUpperCase() + o.payment_method.slice(1) : null,
    status: o.status,
    time: o.created_at ? hhmm(o.created_at) : null,
    estimatedMins: d.prep_time ?? null,
    items: items.map((it) => `${Number(it.qty || it.quantity) || 1}x ${it.name}`),
    notes: o.note || null,
  };
}

async function myOrder(req) {
  const rider = await myRider(req);
  const { rows } = await pool.query(
    `SELECT o.* FROM orders o WHERE o.id = $1 AND o.restaurant_id = $2 AND ${assignedTo(rider.id)}`,
    [req.params.orderId, rid(req)],
  );
  if (!rows[0]) throw notFound('Order not found');
  return { rider, order: rows[0] };
}

async function setOrderData(orderId, restaurant, patch) {
  await pool.query(
    'UPDATE orders SET data = COALESCE(data, \'{}\'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $1 AND restaurant_id = $2',
    [orderId, restaurant, JSON.stringify(patch)],
  );
}

/* ---------- Profile, vehicle, preferences, location ---------- */

router.get('/profile', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const m = rider.metadata || {};
  const { rows } = await pool.query('SELECT name FROM restaurants WHERE id = $1', [rid(req)]);
  ok(res, {
    id: rider.id,
    name: rider.name,
    restaurant: rows[0]?.name || null,
    phone: rider.phone,
    email: rider.email,
    vehicle: rider.vehicle,
    reg: m.reg || null,
    vehicleAvailable: m.vehicle_available ?? true,
    zones: Array.isArray(m.zones) ? m.zones : [],
    capacity: m.capacity || 3,
  });
}));

router.patch('/vehicle-status', asyncHandler(async (req, res) => {
  const value = req.body?.vehicleAvailable;
  if (typeof value !== 'boolean') throw badRequest('vehicleAvailable must be true or false');
  const rider = await myRider(req);
  await pool.query(
    "UPDATE deliverymen SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('vehicle_available', $3::boolean), updated_at = NOW() WHERE id = $1 AND restaurant_id = $2",
    [rider.id, rid(req), value],
  );
  ok(res, { vehicleAvailable: value, message: value ? 'Vehicle marked available' : 'Vehicle marked unavailable' });
}));

router.get('/preferences', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const { rows } = await pool.query('SELECT data FROM rider_preferences WHERE deliveryman_id = $1', [rider.id]);
  ok(res, { ...DEFAULT_PREFS, ...(rows[0]?.data || {}) });
}));

router.put('/preferences', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const next = {};
  if (body.theme !== undefined) {
    if (!['light', 'dark'].includes(body.theme)) throw badRequest('theme must be light or dark');
    next.theme = body.theme;
  }
  for (const key of ['sound', 'vibration', 'location']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw badRequest(`${key} must be true or false`);
      next[key] = body[key];
    }
  }
  const rider = await myRider(req);
  const { rows } = await pool.query(
    `INSERT INTO rider_preferences (deliveryman_id, restaurant_id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (deliveryman_id) DO UPDATE SET data = rider_preferences.data || EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [rider.id, rid(req), JSON.stringify(next)],
  );
  ok(res, { ...DEFAULT_PREFS, ...rows[0].data });
}));

router.post('/location', asyncHandler(async (req, res) => {
  const { latitude, longitude, heading, speed, recorded_at } = req.body || {};
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw badRequest('latitude must be between -90 and 90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw badRequest('longitude must be between -180 and 180');
  const rider = await myRider(req);
  const at = recorded_at && !Number.isNaN(Date.parse(recorded_at)) ? new Date(recorded_at).toISOString() : new Date().toISOString();
  await pool.query(
    'INSERT INTO rider_locations (restaurant_id, deliveryman_id, latitude, longitude, heading, speed, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [rid(req), rider.id, lat, lng, Number.isFinite(Number(heading)) ? Number(heading) : null, Number.isFinite(Number(speed)) ? Number(speed) : null, at],
  );
  ok(res, { success: true, recorded_at: at });
}));

/* ---------- Dashboard and shifts ---------- */

router.get('/dashboard', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const restaurant = rid(req);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE o.status = ANY($2::text[]))::int AS assigned,
       COUNT(*) FILTER (WHERE o.status = 'delivered' AND (o.data->>'delivered_at')::date = CURRENT_DATE)::int AS delivered_today,
       COALESCE(SUM((o.data->>'tip_amount')::numeric) FILTER (WHERE o.status = 'delivered' AND (o.data->>'delivered_at')::date = CURRENT_DATE), 0)::float AS tips_today
     FROM orders o WHERE o.restaurant_id = $1 AND ${assignedTo(rider.id)}`,
    [restaurant, ACTIVE],
  );
  const shift = await openShift(restaurant, rider.id);
  ok(res, {
    assigned_orders_count: rows[0].assigned,
    delivered_today_count: rows[0].delivered_today,
    tips_today_total: toPence(rows[0].tips_today),
    active_shift: shift ? { id: shift.id, started_at: shift.started_at, opening_cash: toPence(shift.opening_cash), float_owner: shift.float_owner } : null,
  });
}));

router.get('/shifts/current', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const shift = await openShift(rid(req), rider.id);
  if (!shift) return ok(res, null);
  ok(res, { id: shift.id, started_at: shift.started_at, opening_cash: toPence(shift.opening_cash), float_owner: shift.float_owner, status: 'active' });
}));

router.post('/shifts/start', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const opening = Number(body.opening_cash);
  if (!Number.isInteger(opening) || opening < 0) throw badRequest('opening_cash must be a whole number of pence, zero or more');
  const floatOwner = body.float_owner === 'rider' ? 'rider' : 'restaurant';
  const rider = await myRider(req);
  if (await openShift(rid(req), rider.id)) throw new (require('@cravedash/shared/src/errors').AppError)('A shift is already open', 409, 'CONFLICT');
  const id = `shift-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const { rows } = await pool.query(
    'INSERT INTO rider_shifts (id, restaurant_id, deliveryman_id, opening_cash, float_owner) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, rid(req), rider.id, toPounds(opening), floatOwner],
  );
  created(res, { id, name: rider.name, opening_cash: toPence(rows[0].opening_cash), float_owner: floatOwner, started_at: rows[0].started_at });
}));

router.post('/shifts/end', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const actual = Number(body.actual_closing);
  if (!Number.isInteger(actual) || actual < 0) throw badRequest('actual_closing must be a whole number of pence, zero or more');
  const rider = await myRider(req);
  const restaurant = rid(req);
  const shift = await openShift(restaurant, rider.id);
  if (!shift) throw notFound('No open shift');
  const endedAt = new Date();
  const stats = await periodStats(restaurant, rider.id, shift.started_at, endedAt);
  const opening = Number(shift.opening_cash) || 0;
  const expected = Math.round((opening + stats.collected) * 100) / 100;
  const actualPounds = toPounds(actual);
  const variance = Math.round((actualPounds - expected) * 100) / 100;
  const zNumber = `RZ-${endedAt.getTime()}`;
  const note = body.reason ? String(body.reason).slice(0, 500) : null;
  const { rows } = await pool.query(
    `UPDATE rider_shifts SET ended_at = $2, actual_closing = $3, expected_closing = $4, variance = $5,
       restaurant_due = $6, orders_count = $7, cash_collected = $8, cash_tips = $9, online_tips = $10, note = $11, z_number = $12
     WHERE id = $1 RETURNING *`,
    [shift.id, endedAt, actualPounds, expected, variance, stats.collected, stats.orders, stats.collected, stats.cashTips, stats.onlineTips, note, zNumber],
  );
  ok(res, shiftView(rows[0]));
}));

router.get('/shifts/x-report', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const shift = await openShift(rid(req), rider.id);
  if (!shift) throw notFound('No open shift');
  const stats = await periodStats(rid(req), rider.id, shift.started_at);
  ok(res, {
    shift_id: shift.id,
    started_at: shift.started_at,
    opening_cash: toPence(shift.opening_cash),
    float_owner: shift.float_owner,
    orders_delivered: stats.orders,
    cash_collected: toPence(stats.collected),
    cash_tips: toPence(stats.cashTips),
    online_tips: toPence(stats.onlineTips),
    restaurant_cash_held: toPence((Number(shift.opening_cash) || 0) + stats.collected),
    generated_at: new Date().toISOString(),
  });
}));

router.get('/shifts', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const params = [rid(req), rider.id];
  let dateSql = '';
  if (req.query.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date))) throw badRequest('date must be YYYY-MM-DD');
    params.push(String(req.query.date));
    dateSql = `AND started_at::date = $${params.length}::date`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM rider_shifts WHERE restaurant_id = $1 AND deliveryman_id = $2 AND ended_at IS NOT NULL ${dateSql} ORDER BY started_at DESC`,
    params,
  );
  ok(res, rows.map(shiftView));
}));

router.get('/shifts/:shiftId/z-report', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const { rows } = await pool.query(
    'SELECT * FROM rider_shifts WHERE id = $1 AND restaurant_id = $2 AND deliveryman_id = $3 AND ended_at IS NOT NULL',
    [req.params.shiftId, rid(req), rider.id],
  );
  if (!rows[0]) throw notFound('Closed shift not found');
  ok(res, shiftView(rows[0]));
}));

/* ---------- Orders ---------- */

router.get('/orders', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const filter = String(req.query.filter || 'active');
  const statuses = {
    active: ACTIVE,
    completed: ['delivered'],
    failed: ['failed_to_deliver'],
  }[filter];
  if (!statuses) throw badRequest('filter must be active, completed or failed');
  const { rows } = await pool.query(
    `SELECT o.* FROM orders o WHERE o.restaurant_id = $1 AND ${assignedTo(rider.id)} AND o.status = ANY($2::text[])
      ORDER BY o.created_at DESC LIMIT 200`,
    [rid(req), statuses],
  );
  ok(res, rows.map(riderOrder));
}));

router.get('/orders/:orderId', asyncHandler(async (req, res) => {
  const { order } = await myOrder(req);
  ok(res, riderOrder(order));
}));

router.patch('/orders/:orderId/pickup', asyncHandler(async (req, res) => {
  const { order } = await myOrder(req);
  if (order.status !== 'ready_for_serve') throw badRequest(`Only ready orders can be picked up (this one is ${order.status})`);
  const at = new Date().toISOString();
  await setOrderData(order.id, rid(req), { picked_up_at: at });
  // The order status stays ready_for_serve until the rider starts the delivery. The kitchen status set has no picked_up state.
  ok(res, { id: String(order.id), status: order.status, picked_up_at: at });
}));

router.patch('/orders/:orderId/start-delivery', asyncHandler(async (req, res) => {
  const { order } = await myOrder(req);
  const updated = await changeOrderStatus(req, order.id, 'out_for_delivery', null);
  const at = new Date().toISOString();
  await setOrderData(order.id, rid(req), { out_for_delivery_at: at });
  ok(res, { id: String(updated.id), status: updated.status, out_for_delivery_at: at });
}));

router.post('/orders/:orderId/complete', asyncHandler(async (req, res) => {
  const { order } = await myOrder(req);
  const body = req.body || {};
  const cashPence = body.cash_collected == null ? 0 : Number(body.cash_collected);
  const tipPence = body.tip_amount == null ? 0 : Number(body.tip_amount);
  if (!Number.isInteger(cashPence) || cashPence < 0) throw badRequest('cash_collected must be whole pence, zero or more');
  if (!Number.isInteger(tipPence) || tipPence < 0) throw badRequest('tip_amount must be whole pence, zero or more');
  const rating = body.rating == null ? null : Number(body.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw badRequest('rating must be 1 to 5');
  const at = new Date().toISOString();
  const updated = await changeOrderStatus(req, order.id, 'delivered', body.notes ? String(body.notes).slice(0, 500) : null);
  await setOrderData(order.id, rid(req), {
    delivered_at: at,
    cash_collected: toPounds(cashPence),
    tip_amount: toPounds(tipPence),
    rating,
    delivery_notes: body.notes ? String(body.notes).slice(0, 500) : null,
  });
  ok(res, { id: String(updated.id), status: updated.status, delivered_at: at, cash_collected: cashPence, tip_amount: tipPence, rating });
}));

router.post('/orders/:orderId/report-issue', asyncHandler(async (req, res) => {
  const { order } = await myOrder(req);
  const body = req.body || {};
  const issue = body.issue_type ? String(body.issue_type).slice(0, 60) : 'other';
  const notes = body.notes ? String(body.notes).slice(0, 500) : null;
  const at = new Date().toISOString();
  const rider = await myRider(req);
  const updated = await changeOrderStatus(req, order.id, 'failed_to_deliver', `${issue}${notes ? `: ${notes}` : ''}`);
  await setOrderData(order.id, rid(req), { failure: { reason: issue, note: notes, at, by: rider.name } });
  ok(res, { order_id: String(updated.id), status: updated.status, failure: { reason: issue, note: notes, at, by: rider.name } });
}));

/* ---------- Cash ---------- */

router.get('/cash/summary', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const { summary } = await cashPosition(rid(req), rider);
  ok(res, summary);
}));

router.post('/cash/handover', asyncHandler(async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('amount must be a whole number of pence above zero');
  const reference = (req.body || {}).reference ? String((req.body || {}).reference).slice(0, 200) : null;
  const rider = await myRider(req);
  const restaurant = rid(req);
  const position = await cashPosition(restaurant, rider);
  if (amount > position.summary.physical_cash) throw badRequest('Amount is more than the cash you hold');
  const id = `event-${Date.now()}`;
  const at = new Date().toISOString();
  await pool.query(
    'INSERT INTO rider_cash_handovers (id, restaurant_id, deliveryman_id, shift_id, amount, reference, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, restaurant, rider.id, position.shift ? position.shift.id : null, toPounds(amount), reference, 'pending_confirmation', at],
  );
  created(res, { handover_id: id, amount, status: 'pending_confirmation', at });
}));

router.get('/cash/handovers', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const { rows } = await pool.query(
    'SELECT * FROM rider_cash_handovers WHERE restaurant_id = $1 AND deliveryman_id = $2 ORDER BY created_at DESC LIMIT 200',
    [rid(req), rider.id],
  );
  ok(res, rows.map((h) => ({
    handover_id: h.id,
    amount: toPence(h.amount),
    reference: h.reference,
    status: h.status,
    at: h.created_at,
    confirmed_at: h.confirmed_at,
  })));
}));

router.post('/cash/handovers/:id/confirm', asyncHandler(async (req, res) => {
  const restaurant = rid(req);
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM rider_cash_handovers WHERE id = $1 AND restaurant_id = $2 AND status = 'pending_confirmation' FOR UPDATE",
      [req.params.id, restaurant],
    );
    if (!rows[0]) throw notFound('No pending handover with that id');
    row = rows[0];
    const confirmedBy = req.user?.name || req.user?.email || 'Restaurant';
    const confirmedAt = new Date().toISOString();
    await client.query(
      "UPDATE rider_cash_handovers SET status = 'confirmed', confirmed_at = $2, confirmed_by = $3 WHERE id = $1",
      [row.id, confirmedAt, confirmedBy],
    );
    // The confirmed amount is recorded in the restaurant's rider settlements, so the reports match the cash.
    await client.query(
      `INSERT INTO driver_cash_settlements (id, restaurant_id, driver_id, settle_date, amount, note, created_by)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6)`,
      [`dcs_${row.id}`, restaurant, row.deliveryman_id, row.amount, `Handover ${row.id}${row.reference ? `: ${row.reference}` : ''}`, confirmedBy],
    );
    await client.query('COMMIT');
    row = { ...row, status: 'confirmed', confirmed_at: confirmedAt, confirmed_by: confirmedBy };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  ok(res, { id: row.id, amount: Number(row.amount).toFixed(2), status: 'confirmed', confirmed_by: row.confirmed_by, confirmed_at: row.confirmed_at });
}));

/* ---------- History and events ---------- */

router.get('/history/daily-summary', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const date = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
  const { rows } = await pool.query(
    `SELECT o.payment_method, o.data FROM orders o
      WHERE o.restaurant_id = $1 AND ${assignedTo(rider.id)} AND o.status = 'delivered'
        AND (o.data->>'delivered_at')::date = $2::date`,
    [rid(req), date],
  );
  let collected = 0;
  let cashTips = 0;
  let onlineTips = 0;
  for (const r of rows) {
    const d = r.data || {};
    if (r.payment_method === 'cash') collected += Number(d.cash_collected) || 0;
    if (r.payment_method === 'cash') cashTips += Number(d.tip_amount) || 0;
    else onlineTips += Number(d.tip_amount) || 0;
  }
  ok(res, {
    date,
    orders_count: rows.length,
    cash_collected: toPence(collected),
    cash_tips: toPence(cashTips),
    online_tips: toPence(onlineTips),
    total_tips: toPence(cashTips + onlineTips),
  });
}));

router.get('/history/statement', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const from = req.query.from ? String(req.query.from) : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to ? String(req.query.to) : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('from and to must be YYYY-MM-DD');
  const restaurant = rid(req);
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.total, o.data, o.payment_method, o.status, (o.data->>'delivered_at')::timestamptz AS at FROM orders o
      WHERE o.restaurant_id = $1 AND ${assignedTo(rider.id)} AND o.status = 'delivered'
        AND (o.data->>'delivered_at')::date BETWEEN $2::date AND $3::date`,
    [restaurant, from, to],
  );
  const { rows: handovers } = await pool.query(
    'SELECT * FROM rider_cash_handovers WHERE restaurant_id = $1 AND deliveryman_id = $2 AND created_at::date BETWEEN $3::date AND $4::date',
    [restaurant, rider.id, from, to],
  );
  const items = [
    ...orders.map((o) => ({
      id: `stmt_${o.id}`,
      date: new Date(o.at).toISOString().slice(0, 10),
      type: 'delivery',
      reference: `Order #${o.id}`,
      amount: toPence(o.total),
      tip: toPence(o.data?.tip_amount),
      status: o.status,
      at: o.at,
    })),
    ...handovers.map((h) => ({
      id: `stmt_${h.id}`,
      date: new Date(h.created_at).toISOString().slice(0, 10),
      type: 'handover',
      reference: h.reference || h.id,
      amount: toPence(h.amount),
      tip: 0,
      status: h.status,
      at: h.created_at,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  ok(res, items);
}));

router.get('/events', asyncHandler(async (req, res) => {
  const rider = await myRider(req);
  const restaurant = rid(req);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const [shifts, orders, handovers] = await Promise.all([
    pool.query('SELECT * FROM rider_shifts WHERE restaurant_id = $1 AND deliveryman_id = $2 ORDER BY started_at DESC LIMIT $3', [restaurant, rider.id, limit]),
    pool.query(
      `SELECT o.id, o.total, o.data, (o.data->>'delivered_at')::timestamptz AS at FROM orders o
        WHERE o.restaurant_id = $1 AND ${assignedTo(rider.id)} AND o.status = 'delivered' ORDER BY at DESC LIMIT $2`,
      [restaurant, limit],
    ),
    pool.query('SELECT * FROM rider_cash_handovers WHERE restaurant_id = $1 AND deliveryman_id = $2 ORDER BY created_at DESC LIMIT $3', [restaurant, rider.id, limit]),
  ]);
  const events = [];
  for (const s of shifts.rows) {
    events.push({ id: `ev_${s.id}_start`, event_type: 'shift_started', title: 'Shift started', amount: toPence(s.opening_cash), order_id: null, shift_id: s.id, at: s.started_at, details: { float_owner: s.float_owner } });
    if (s.ended_at) events.push({ id: `ev_${s.id}_end`, event_type: 'shift_ended', title: 'Shift ended', amount: toPence(s.actual_closing), order_id: null, shift_id: s.id, at: s.ended_at, details: { variance: toPence(s.variance) } });
  }
  for (const o of orders.rows) {
    events.push({ id: `ev_${o.id}`, event_type: 'delivery_completed', title: `Delivered Order #${o.id}`, amount: toPence(o.total), order_id: String(o.id), shift_id: null, at: o.at, details: { cash_collected: toPence(o.data?.cash_collected), tip_amount: toPence(o.data?.tip_amount) } });
  }
  for (const h of handovers.rows) {
    events.push({ id: h.id, event_type: h.status === 'confirmed' ? 'handover_confirmed' : 'handover_submitted', title: 'Cash handover', amount: toPence(h.amount), order_id: null, shift_id: h.shift_id, at: h.created_at, details: { status: h.status } });
  }
  ok(res, events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() })));
}));

module.exports = router;
