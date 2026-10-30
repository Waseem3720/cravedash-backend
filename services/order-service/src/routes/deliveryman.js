const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, forbidden } = require('@cravedash/shared/src/errors');

const router = express.Router();

// All routes under /api/v1/deliveryman require authenticated rider or admin/epos role
router.use(requireAuth, requireRole('rider', 'courier', 'restaurant', 'super', 'epos'));

router.use(asyncHandler(async (req, res, next) => {
  const directId = req.user?.delivery_man_id || req.user?.sub || req.user?.id;
  const email = req.user?.email;

  // 1. Try direct ID
  if (directId) {
    const { rows } = await pool.query('SELECT * FROM deliverymen WHERE id = $1 LIMIT 1', [directId]);
    if (rows[0]) {
      req.deliveryman = rows[0];
      req.riderId = rows[0].id;
      return next();
    }
  }

  // 2. Try email
  if (email) {
    const { rows } = await pool.query('SELECT * FROM deliverymen WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (rows[0]) {
      req.deliveryman = rows[0];
      req.riderId = rows[0].id;
      return next();
    }
  }

  req.riderId = directId ? String(directId) : 'dm_1';
  next();
}));

function rid(req) {
  try {
    return restaurantId(req);
  } catch {
    return req.headers['x-restaurant-id'] || 'r1';
  }
}

function getRiderId(req) {
  return req.riderId || req.user?.delivery_man_id || req.user?.sub || req.user?.id || 'dm_1';
}

async function fetchRider(riderId, restaurantIdVal) {
  if (riderId) {
    const { rows } = await pool.query(
      `SELECT d.*, r.name AS restaurant_name
       FROM deliverymen d
       LEFT JOIN restaurants r ON d.restaurant_id = r.id
       WHERE d.id = $1
       LIMIT 1`,
      [riderId]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

function parseData(val) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return {}; }
  }
  return val || {};
}

function formatRiderProfile(dm, user) {
  const data = parseData(dm?.data);
  const isOnline = data.available !== false && data.vehicleAvailable !== false && (!dm?.status || dm.status === 'active' || dm.status === 'approved');
  return {
    id: dm?.id || user?.id || 'rider-demo',
    name: dm?.name || user?.name || 'Alex Rider',
    restaurant: dm?.restaurant_name || 'Porto Piri Piri',
    phone: dm?.phone || user?.phone || '07700 900123',
    email: dm?.email || user?.email || 'rider@portopiripiri.co.uk',
    vehicle: dm?.vehicle || user?.vehicle || 'Car',
    reg: data.reg || data.vehicle_reg || 'DEMO 01',
    vehicleAvailable: isOnline,
    zones: data.zones || ['Glasgow South · G41', 'Shawlands · G43'],
    capacity: Number(data.capacity || 3),
  };
}

async function logRiderEvent(restaurantIdVal, riderId, eventType, title, amount = null, orderId = null, shiftId = null, details = {}) {
  const id = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await pool.query(
      `INSERT INTO deliveryman_events (id, restaurant_id, deliveryman_id, shift_id, order_id, event_type, title, amount, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
      [id, restaurantIdVal, riderId, shiftId, orderId, eventType, title, amount, JSON.stringify(details)]
    );
  } catch (err) {
    console.warn('[deliveryman-events] Failed to record event:', err.message);
  }
}

/** 5. GET /api/v1/deliveryman/profile */
router.get('/profile', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const dm = await fetchRider(riderId, r);
  ok(res, formatRiderProfile(dm, req.user));
}));

/** 6. PATCH /api/v1/deliveryman/vehicle-status */
router.patch('/vehicle-status', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { vehicleAvailable } = req.body || {};
  const isAvailable = Boolean(vehicleAvailable);

  const dm = await fetchRider(riderId, r);
  const data = parseData(dm?.data);
  data.vehicleAvailable = isAvailable;
  data.available = isAvailable;

  await pool.query(
    `UPDATE deliverymen
     SET data = $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r, JSON.stringify(data)]
  );

  ok(res, {
    vehicleAvailable: isAvailable,
    message: isAvailable ? 'Vehicle marked available' : 'Vehicle marked unavailable',
  });
}));

/** 7. GET /api/v1/deliveryman/preferences */
router.get('/preferences', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const dm = await fetchRider(riderId, r);
  const data = parseData(dm?.data);
  const prefs = data.preferences || {
    theme: 'light',
    sound: true,
    vibration: true,
    location: true,
  };
  ok(res, prefs);
}));

/** 8. PUT /api/v1/deliveryman/preferences */
router.put('/preferences', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const body = req.body || {};
  const dm = await fetchRider(riderId, r);
  const data = parseData(dm?.data);

  data.preferences = {
    theme: body.theme || data.preferences?.theme || 'light',
    sound: body.sound !== undefined ? Boolean(body.sound) : (data.preferences?.sound ?? true),
    vibration: body.vibration !== undefined ? Boolean(body.vibration) : (data.preferences?.vibration ?? true),
    location: body.location !== undefined ? Boolean(body.location) : (data.preferences?.location ?? true),
  };

  await pool.query(
    `UPDATE deliverymen
     SET data = $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r, JSON.stringify(data)]
  );

  ok(res, data.preferences);
}));

/** 9. POST /api/v1/deliveryman/location */
router.post('/location', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { latitude, longitude, recorded_at } = req.body || {};
  if (latitude == null || longitude == null) {
    throw badRequest('latitude and longitude are required');
  }

  const recAt = recorded_at || new Date().toISOString();
  await pool.query(
    `INSERT INTO deliveryman_locations (deliveryman_id, restaurant_id, latitude, longitude, recorded_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (deliveryman_id)
     DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, recorded_at = EXCLUDED.recorded_at, updated_at = NOW()`,
    [riderId, r, latitude, longitude, recAt]
  );

  ok(res, {
    success: true,
    recorded_at: recAt,
  });
}));

/** 10. GET /api/v1/deliveryman/dashboard */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  // 1. Assigned active orders count
  const { rows: assignedRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2 AND status IN ('ready_for_serve', 'picked_up', 'out_for_delivery')`,
    [r, riderId]
  );

  // 2. Delivered today count & tips today total
  const { rows: todayRows } = await pool.query(
    `SELECT COUNT(*)::int AS delivered_count,
            COALESCE(SUM(COALESCE(tip, 0) + COALESCE((data->>'rider_tip')::numeric, 0)), 0)::numeric AS tips_total
     FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2
       AND status IN ('delivered', 'completed')
       AND DATE(updated_at) = CURRENT_DATE`,
    [r, riderId]
  );

  // 3. Active shift
  const { rows: shiftRows } = await pool.query(
    `SELECT * FROM deliveryman_shifts
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [r, riderId]
  );

  let activeShift = null;
  if (shiftRows[0]) {
    const s = shiftRows[0];
    activeShift = {
      id: s.id,
      started_at: s.started_at,
      opening_cash: Math.round(Number(s.opening_cash) * 100), // in pence as per spec
      float_owner: s.float_owner,
    };
  }

  const assignedCount = assignedRows[0]?.count || 0;
  const deliveredToday = todayRows[0]?.delivered_count || 0;
  const tipsToday = Math.round(Number(todayRows[0]?.tips_total || 0) * 100);

  ok(res, {
    assigned_orders_count: assignedCount,
    delivered_today_count: deliveredToday,
    tips_today_total: tipsToday,
    active_shift: activeShift,
  });
}));

/** 11. GET /api/v1/deliveryman/shifts/current */
router.get('/shifts/current', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_shifts
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [r, riderId]
  );

  if (!rows[0]) return ok(res, null);
  const s = rows[0];
  ok(res, {
    id: s.id,
    started_at: s.started_at,
    opening_cash: Math.round(Number(s.opening_cash) * 100),
    float_owner: s.float_owner,
    status: s.status,
  });
}));

/** 12. POST /api/v1/deliveryman/shifts/start */
router.post('/shifts/start', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const dm = await fetchRider(riderId, r);
  const { opening_cash = 0, float_owner = 'restaurant' } = req.body || {};

  // Check if shift is already active
  const { rows: existing } = await pool.query(
    `SELECT id FROM deliveryman_shifts WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active' LIMIT 1`,
    [r, riderId]
  );
  if (existing[0]) {
    throw badRequest('An active shift is already in progress');
  }

  const shiftId = `shift-${Date.now()}`;
  const openingDecimal = Number(opening_cash) > 100 ? (Number(opening_cash) / 100) : Number(opening_cash);

  const { rows } = await pool.query(
    `INSERT INTO deliveryman_shifts (id, restaurant_id, deliveryman_id, opening_cash, float_owner, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW())
     RETURNING *`,
    [shiftId, r, riderId, openingDecimal, String(float_owner)]
  );

  await logRiderEvent(r, riderId, 'shift_start', 'Shift Started', openingDecimal, null, shiftId, {
    opening_cash,
    float_owner,
  });

  ok(res, {
    id: shiftId,
    name: dm?.name || req.user?.name || 'Alex Rider',
    opening_cash: Number(opening_cash),
    float_owner: String(float_owner),
    started_at: rows[0].started_at,
  });
}));

/** 13. POST /api/v1/deliveryman/shifts/end */
router.post('/shifts/end', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const dm = await fetchRider(riderId, r);
  const { actual_closing = 0, reason = '' } = req.body || {};

  const { rows: shiftRows } = await pool.query(
    `SELECT * FROM deliveryman_shifts
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [r, riderId]
  );
  if (!shiftRows[0]) {
    throw badRequest('No active shift found to end');
  }
  const shift = shiftRows[0];

  // Calculate shift order metrics
  const { rows: orderStats } = await pool.query(
    `SELECT COUNT(*)::int AS orders_count,
            COALESCE(SUM(CASE WHEN payment_method ILIKE '%cash%' OR data->>'cash_collected' IS NOT NULL THEN total ELSE 0 END), 0)::numeric AS cash_collected,
            COALESCE(SUM(CASE WHEN data->>'cash_tip' IS NOT NULL THEN (data->>'cash_tip')::numeric ELSE 0 END), 0)::numeric AS cash_tips,
            COALESCE(SUM(COALESCE(tip, 0)), 0)::numeric AS online_tips
     FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2
       AND status IN ('delivered', 'completed')
       AND updated_at >= $3`,
    [r, riderId, shift.started_at]
  );

  const stats = orderStats[0] || {};
  const ordersDelivered = stats.orders_count || 0;
  const cashCollectedPence = Math.round(Number(stats.cash_collected || 0) * 100);
  const cashTipsPence = Math.round(Number(stats.cash_tips || 0) * 100);
  const onlineTipsPence = Math.round(Number(stats.online_tips || 0) * 100);
  const openingPence = Math.round(Number(shift.opening_cash || 0) * 100);

  const expectedClosingPence = openingPence + cashCollectedPence;
  const actualClosingPence = Number(actual_closing);
  const variancePence = actualClosingPence - expectedClosingPence;
  const restaurantDuePence = cashCollectedPence + (shift.float_owner === 'restaurant' ? openingPence : 0);
  const zNumber = `RZ-${Date.now()}`;
  const endedAt = new Date().toISOString();

  await pool.query(
    `UPDATE deliveryman_shifts
     SET status = 'ended',
         actual_closing = $3,
         expected_closing = $4,
         variance = $5,
         restaurant_due = $6,
         orders_count = $7,
         cash_collected = $8,
         cash_tips = $9,
         online_tips = $10,
         z_number = $11,
         note = $12,
         ended_at = $13,
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [
      shift.id,
      r,
      actualClosingPence / 100,
      expectedClosingPence / 100,
      variancePence / 100,
      restaurantDuePence / 100,
      ordersDelivered,
      cashCollectedPence / 100,
      cashTipsPence / 100,
      onlineTipsPence / 100,
      zNumber,
      reason || 'Closing cash balanced',
      endedAt,
    ]
  );

  await logRiderEvent(r, riderId, 'shift_end', 'Shift Ended', actualClosingPence / 100, null, shift.id, {
    actual_closing: actualClosingPence,
    variance: variancePence,
    z_number: zNumber,
  });

  ok(res, {
    id: shift.id,
    name: dm?.name || req.user?.name || 'Alex Rider',
    opening_cash: openingPence,
    actual_closing: actualClosingPence,
    expected_closing: expectedClosingPence,
    variance: variancePence,
    restaurant_due: restaurantDuePence,
    orders: ordersDelivered,
    cash_collected: cashCollectedPence,
    cash_tips: cashTipsPence,
    online_tips: onlineTipsPence,
    note: reason || 'Closing cash balanced',
    z_number: zNumber,
    ended_at: endedAt,
  });
}));

/** 14. GET /api/v1/deliveryman/shifts/x-report */
router.get('/shifts/x-report', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows: shiftRows } = await pool.query(
    `SELECT * FROM deliveryman_shifts
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [r, riderId]
  );
  if (!shiftRows[0]) throw badRequest('No active shift found');
  const shift = shiftRows[0];

  const { rows: orderStats } = await pool.query(
    `SELECT COUNT(*)::int AS orders_count,
            COALESCE(SUM(CASE WHEN payment_method ILIKE '%cash%' OR data->>'cash_collected' IS NOT NULL THEN total ELSE 0 END), 0)::numeric AS cash_collected,
            COALESCE(SUM(CASE WHEN data->>'cash_tip' IS NOT NULL THEN (data->>'cash_tip')::numeric ELSE 0 END), 0)::numeric AS cash_tips,
            COALESCE(SUM(COALESCE(tip, 0)), 0)::numeric AS online_tips
     FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2
       AND status IN ('delivered', 'completed')
       AND updated_at >= $3`,
    [r, riderId, shift.started_at]
  );

  const stats = orderStats[0] || {};
  const ordersDelivered = stats.orders_count || 0;
  const cashCollectedPence = Math.round(Number(stats.cash_collected || 0) * 100);
  const cashTipsPence = Math.round(Number(stats.cash_tips || 0) * 100);
  const onlineTipsPence = Math.round(Number(stats.online_tips || 0) * 100);
  const openingPence = Math.round(Number(shift.opening_cash || 0) * 100);
  const restaurantCashHeldPence = openingPence + cashCollectedPence;

  ok(res, {
    shift_id: shift.id,
    started_at: shift.started_at,
    opening_cash: openingPence,
    float_owner: shift.float_owner,
    orders_delivered: ordersDelivered,
    cash_collected: cashCollectedPence,
    cash_tips: cashTipsPence,
    online_tips: onlineTipsPence,
    restaurant_cash_held: restaurantCashHeldPence,
    generated_at: new Date().toISOString(),
  });
}));

/** 15. GET /api/v1/deliveryman/shifts */
router.get('/shifts', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { date } = req.query;

  const params = [r, riderId];
  let where = 'restaurant_id = $1 AND deliveryman_id = $2 AND status = \'ended\'';
  if (date) {
    params.push(date);
    where += ` AND DATE(started_at) = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_shifts WHERE ${where} ORDER BY started_at DESC LIMIT 50`,
    params
  );

  ok(res, rows.map((s) => ({
    id: s.id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    opening_cash: Math.round(Number(s.opening_cash) * 100),
    actual_closing: Math.round(Number(s.actual_closing) * 100),
    expected_closing: Math.round(Number(s.expected_closing) * 100),
    variance: Math.round(Number(s.variance) * 100),
    restaurant_due: Math.round(Number(s.restaurant_due) * 100),
    orders: s.orders_count,
    cash_collected: Math.round(Number(s.cash_collected) * 100),
    cash_tips: Math.round(Number(s.cash_tips) * 100),
    online_tips: Math.round(Number(s.online_tips) * 100),
    z_number: s.z_number,
    note: s.note,
  })));
}));

/** 16. GET /api/v1/deliveryman/shifts/:shiftId/z-report */
router.get('/shifts/:shiftId/z-report', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_shifts
     WHERE id = $1 AND restaurant_id = $2 AND deliveryman_id = $3
     LIMIT 1`,
    [req.params.shiftId, r, riderId]
  );
  if (!rows[0]) throw notFound('Shift record not found');
  const s = rows[0];

  ok(res, {
    id: s.id,
    z_number: s.z_number,
    started_at: s.started_at,
    ended_at: s.ended_at,
    opening_cash: Math.round(Number(s.opening_cash) * 100),
    actual_closing: Math.round(Number(s.actual_closing) * 100),
    expected_closing: Math.round(Number(s.expected_closing) * 100),
    variance: Math.round(Number(s.variance) * 100),
    restaurant_due: Math.round(Number(s.restaurant_due) * 100),
    orders: s.orders_count,
    cash_collected: Math.round(Number(s.cash_collected) * 100),
    cash_tips: Math.round(Number(s.cash_tips) * 100),
    online_tips: Math.round(Number(s.online_tips) * 100),
    note: s.note,
  });
}));

function projectDeliverymanOrder(order) {
  const cust = order.customer || {};
  const isCash = String(order.payment_method || '').toLowerCase().includes('cash');
  const totalPence = Math.round(Number(order.total || 0) * 100);
  const items = Array.isArray(order.items)
    ? order.items.map((it) => `${it.quantity || it.qty || 1} × ${it.name || it.title || 'Item'}`)
    : [];

  let statusOut = order.status;
  if (statusOut === 'ready_for_serve') statusOut = 'ready';
  else if (statusOut === 'failed_to_deliver') statusOut = 'failed';

  return {
    id: String(order.id),
    name: cust.name || `${cust.f_name || ''} ${cust.l_name || ''}`.trim() || 'Customer',
    address: cust.address || cust.delivery_address || 'Customer Address',
    postcode: cust.postcode || 'G41 3NH',
    phone: cust.phone || '07700 900456',
    zone: order.data?.zone || 'Glasgow South · G41',
    distance: order.driver_distance_km != null ? Number(order.driver_distance_km) : 1.4,
    total: totalPence,
    cashDue: isCash && order.payment_status !== 'paid' ? totalPence : 0,
    payment: isCash ? 'Cash' : 'Card',
    status: statusOut,
    assigned_at: order.data?.dispatched_at || order.created_at,
    items,
    note: order.note || cust.delivery_instructions || 'Ring the bell. Side entrance.',
    kitchen_note: order.data?.kitchen_note || 'Keep in hot delivery bag.',
  };
}

/** 17. GET /api/v1/deliveryman/orders */
router.get('/orders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { filter = 'active' } = req.query;

  const params = [r, riderId];
  let where = 'restaurant_id = $1 AND delivery_man_id = $2';

  if (filter === 'active') {
    where += ` AND status IN ('ready_for_serve', 'picked_up', 'out_for_delivery')`;
  } else if (filter === 'completed') {
    where += ` AND status IN ('delivered', 'completed')`;
  } else if (filter === 'failed') {
    where += ` AND status IN ('failed_to_deliver', 'failed', 'canceled', 'cancelled')`;
  }

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 50`,
    params
  );

  ok(res, rows.map((r) => projectDeliverymanOrder(r)));
}));

/** 18. GET /api/v1/deliveryman/orders/:orderId */
router.get('/orders/:orderId', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND delivery_man_id = $3 LIMIT 1`,
    [req.params.orderId, r, riderId]
  );
  if (!rows[0]) throw notFound('Order not found or not assigned to you');

  ok(res, projectDeliverymanOrder(rows[0]));
}));

/** 19. PATCH /api/v1/deliveryman/orders/:orderId/pickup */
router.patch('/orders/:orderId/pickup', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND delivery_man_id = $3 LIMIT 1`,
    [req.params.orderId, r, riderId]
  );
  if (!rows[0]) throw notFound('Order not found');
  const order = rows[0];

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({
    status: 'picked_up',
    at: new Date().toISOString(),
    by: `Rider ${req.user?.name || riderId}`,
  });

  const { rows: updated } = await pool.query(
    `UPDATE orders
     SET status = 'picked_up', history = $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.orderId, r, JSON.stringify(history)]
  );

  await logRiderEvent(r, riderId, 'pickup', `Order #${req.params.orderId} Picked Up`, null, req.params.orderId);

  ok(res, {
    order_id: String(req.params.orderId),
    status: 'picked_up',
    updated_at: updated[0].updated_at,
  });
}));

/** 20. PATCH /api/v1/deliveryman/orders/:orderId/start-delivery */
router.patch('/orders/:orderId/start-delivery', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND delivery_man_id = $3 LIMIT 1`,
    [req.params.orderId, r, riderId]
  );
  if (!rows[0]) throw notFound('Order not found');
  const order = rows[0];

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({
    status: 'out_for_delivery',
    at: new Date().toISOString(),
    by: `Rider ${req.user?.name || riderId}`,
  });

  const { rows: updated } = await pool.query(
    `UPDATE orders
     SET status = 'out_for_delivery', history = $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.orderId, r, JSON.stringify(history)]
  );

  await logRiderEvent(r, riderId, 'delivery_started', `Out for Delivery: #${req.params.orderId}`, null, req.params.orderId);

  ok(res, {
    order_id: String(req.params.orderId),
    status: 'out_for_delivery',
    updated_at: updated[0].updated_at,
  });
}));

/** 21. POST /api/v1/deliveryman/orders/:orderId/complete */
router.post('/orders/:orderId/complete', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND delivery_man_id = $3 LIMIT 1`,
    [req.params.orderId, r, riderId]
  );
  if (!rows[0]) throw notFound('Order not found');
  const order = rows[0];

  const { cash_received = false, tip_amount = 0, tip_method = 'cash', rating, note, delivery_photo } = req.body || {};
  const deliveredAt = new Date().toISOString();

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({
    status: 'delivered',
    at: deliveredAt,
    by: `Rider ${req.user?.name || riderId}`,
  });

  const orderData = parseData(order.data);
  if (delivery_photo) {
    orderData.pod = {
      photo_url: delivery_photo,
      recorded_at: deliveredAt,
      rider_id: riderId,
      notes: note || null,
    };
  }
  if (tip_amount > 0) {
    orderData.rider_tip = Number(tip_amount) / 100;
    orderData.tip_method = tip_method;
  }
  if (cash_received) {
    orderData.cash_collected = {
      amount: Number(order.total),
      collected_at: deliveredAt,
      rider_id: riderId,
    };
  }

  const paymentStatus = cash_received ? 'paid' : order.payment_status;

  const { rows: updated } = await pool.query(
    `UPDATE orders
     SET status = 'delivered', payment_status = $3, history = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.orderId, r, paymentStatus, JSON.stringify(history), JSON.stringify(orderData)]
  );

  // If customer rating supplied, record review
  if (rating != null) {
    const revId = `dm_rev_${Date.now()}`;
    await pool.query(
      `INSERT INTO deliveryman_reviews (id, restaurant_id, deliveryman_id, order_id, customer_id, rating, review_note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [revId, r, riderId, order.id, order.customer_id || null, Number(rating), note || 'Delivered successfully']
    ).catch(() => { });
  }

  // Trigger ledger engine
  const ordersRouter = require('./orders');
  if (ordersRouter.applyOrderEngines) {
    await ordersRouter.applyOrderEngines(r, updated[0], { prevPayment: order.payment_status });
  }

  await logRiderEvent(r, riderId, 'delivery_completed', `Delivered Order #${req.params.orderId}`, Number(order.total), req.params.orderId);

  ok(res, {
    order_id: String(req.params.orderId),
    status: 'delivered',
    delivered_at: deliveredAt,
  });
}));

/** 22. POST /api/v1/deliveryman/orders/:orderId/report-issue */
router.post('/orders/:orderId/report-issue', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND delivery_man_id = $3 LIMIT 1`,
    [req.params.orderId, r, riderId]
  );
  if (!rows[0]) throw notFound('Order not found');
  const order = rows[0];

  const { reason = 'Issue reported', outcome = 'failed', note = '' } = req.body || {};
  const at = new Date().toISOString();

  const history = Array.isArray(order.history) ? [...order.history] : [];
  const statusOut = outcome === 'failed' ? 'failed_to_deliver' : order.status;

  history.push({
    status: statusOut,
    at,
    by: `Rider Issue: ${reason}`,
  });

  const orderData = parseData(order.data);
  const issues = Array.isArray(orderData.issues) ? orderData.issues : [];
  issues.push({ reason, note, outcome, at, rider_id: riderId });
  orderData.issues = issues;

  await pool.query(
    `UPDATE orders
     SET status = $3, history = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [req.params.orderId, r, statusOut, JSON.stringify(history), JSON.stringify(orderData)]
  );

  await logRiderEvent(r, riderId, 'delivery_failed', `Delivery Failed: #${req.params.orderId}`, null, req.params.orderId, null, {
    reason,
    note,
  });

  ok(res, {
    order_id: String(req.params.orderId),
    status: 'failed',
    failure: {
      reason,
      note,
      at,
      by: req.user?.name || 'Alex Rider',
    },
  });
}));

/** 23. GET /api/v1/deliveryman/cash/summary */
router.get('/cash/summary', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  // Active shift opening float
  const { rows: shiftRows } = await pool.query(
    `SELECT opening_cash, float_owner FROM deliveryman_shifts
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [r, riderId]
  );
  const shiftFloatHeldPence = Math.round(Number(shiftRows[0]?.opening_cash || 0) * 100);

  // Today's collected cash & tips
  const { rows: todayStats } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN payment_method ILIKE '%cash%' OR data->>'cash_collected' IS NOT NULL THEN total ELSE 0 END), 0)::numeric AS collected_today,
            COALESCE(SUM(CASE WHEN data->>'cash_tip' IS NOT NULL THEN (data->>'cash_tip')::numeric ELSE 0 END), 0)::numeric AS cash_tips,
            COALESCE(SUM(COALESCE(tip, 0)), 0)::numeric AS online_tips,
            COUNT(*)::int AS orders_count
     FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2
       AND status IN ('delivered', 'completed')
       AND DATE(updated_at) = CURRENT_DATE`,
    [r, riderId]
  );

  const collectedTodayPence = Math.round(Number(todayStats[0]?.collected_today || 0) * 100);
  const cashTipsPence = Math.round(Number(todayStats[0]?.cash_tips || 0) * 100);
  const onlineTipsPence = Math.round(Number(todayStats[0]?.online_tips || 0) * 100);
  const ordersCount = todayStats[0]?.orders_count || 0;
  const deliveryPayPence = ordersCount * 250; // default base pay per drop

  // Handovers
  const { rows: hoRows } = await pool.query(
    `SELECT status, COALESCE(SUM(amount), 0)::numeric AS sum_amt
     FROM deliveryman_handovers
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND DATE(created_at) = CURRENT_DATE
     GROUP BY status`,
    [r, riderId]
  );

  let pendingHandoversPence = 0;
  let confirmedHandoversPence = 0;
  for (const ho of hoRows) {
    if (ho.status === 'confirmed') confirmedHandoversPence += Math.round(Number(ho.sum_amt) * 100);
    else if (ho.status === 'pending_confirmation') pendingHandoversPence += Math.round(Number(ho.sum_amt) * 100);
  }

  const heldOrderCashPence = Math.max(0, collectedTodayPence - confirmedHandoversPence);
  const restaurantCashHeldPence = shiftFloatHeldPence + heldOrderCashPence;
  const physicalCashPence = restaurantCashHeldPence + cashTipsPence;

  ok(res, {
    restaurant_cash_held: restaurantCashHeldPence,
    held_order_cash: heldOrderCashPence,
    restaurant_float_held: shiftFloatHeldPence,
    physical_cash: physicalCashPence,
    pending_handovers: pendingHandoversPence,
    collected_today: collectedTodayPence,
    confirmed_handovers: confirmedHandoversPence,
    cash_tips: cashTipsPence,
    online_tips: onlineTipsPence,
    delivery_pay: deliveryPayPence,
  });
}));

/** 24. POST /api/v1/deliveryman/cash/handover */
router.post('/cash/handover', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { amount, reference = '' } = req.body || {};

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw badRequest('Handover amount must be a positive number');
  }

  const handoverId = `event-${Date.now()}`;
  const amountDecimal = numAmount > 100 ? (numAmount / 100) : numAmount;

  await pool.query(
    `INSERT INTO deliveryman_handovers (id, restaurant_id, deliveryman_id, amount, reference, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending_confirmation', NOW(), NOW())`,
    [handoverId, r, riderId, amountDecimal, reference]
  );

  await logRiderEvent(r, riderId, 'handover_submitted', `Cash Handover: £${amountDecimal.toFixed(2)}`, amountDecimal, null, null, {
    reference,
  });

  ok(res, {
    handover_id: handoverId,
    amount: numAmount,
    status: 'pending_confirmation',
    at: new Date().toISOString(),
  });
}));

/** 25. GET /api/v1/deliveryman/cash/handovers */
router.get('/cash/handovers', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_handovers
     WHERE restaurant_id = $1 AND deliveryman_id = $2
     ORDER BY created_at DESC LIMIT 50`,
    [r, riderId]
  );

  ok(res, rows.map((ho) => ({
    handover_id: ho.id,
    amount: Math.round(Number(ho.amount) * 100),
    reference: ho.reference,
    status: ho.status,
    at: ho.created_at,
    confirmed_at: ho.confirmed_at,
  })));
}));

/** Helper: POST /api/v1/deliveryman/cash/handovers/:id/confirm */
router.post('/cash/handovers/:id/confirm', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query(
    `UPDATE deliveryman_handovers
     SET status = 'confirmed', confirmed_by = $3, confirmed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.id, r, req.user?.name || 'Manager']
  );
  if (!rows[0]) throw notFound('Handover not found');
  ok(res, rows[0]);
}));

/** 26. GET /api/v1/deliveryman/history/daily-summary */
router.get('/history/daily-summary', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const queryDate = req.query.date || new Date().toISOString().slice(0, 10);

  const { rows: stats } = await pool.query(
    `SELECT COUNT(*)::int AS delivered_orders,
            COALESCE(SUM(CASE WHEN payment_method ILIKE '%cash%' OR data->>'cash_collected' IS NOT NULL THEN total ELSE 0 END), 0)::numeric AS customer_cash,
            COALESCE(SUM(CASE WHEN data->>'cash_tip' IS NOT NULL THEN (data->>'cash_tip')::numeric ELSE 0 END), 0)::numeric AS cash_tips,
            COALESCE(SUM(COALESCE(tip, 0)), 0)::numeric AS online_tips
     FROM orders
     WHERE restaurant_id = $1 AND delivery_man_id = $2
       AND status IN ('delivered', 'completed')
       AND DATE(updated_at) = $3`,
    [r, riderId, queryDate]
  );

  const { rows: hoRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS confirmed_handovers
     FROM deliveryman_handovers
     WHERE restaurant_id = $1 AND deliveryman_id = $2 AND status = 'confirmed' AND DATE(created_at) = $3`,
    [r, riderId, queryDate]
  );

  const s = stats[0] || {};
  ok(res, {
    date: queryDate,
    delivered_orders: s.delivered_orders || 0,
    customer_cash_received: Math.round(Number(s.customer_cash || 0) * 100),
    cash_tips: Math.round(Number(s.cash_tips || 0) * 100),
    online_tips: Math.round(Number(s.online_tips || 0) * 100),
    confirmed_handovers: Math.round(Number(hoRows[0]?.confirmed_handovers || 0) * 100),
  });
}));

/** 27. GET /api/v1/deliveryman/events */
router.get('/events', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { date, shift_id } = req.query;

  const params = [r, riderId];
  let where = 'restaurant_id = $1 AND deliveryman_id = $2';
  if (shift_id) {
    params.push(shift_id);
    where += ` AND shift_id = $${params.length}`;
  }
  if (date) {
    params.push(date);
    where += ` AND DATE(created_at) = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT * FROM deliveryman_events WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );

  ok(res, rows);
}));

/** 28. GET /api/v1/deliveryman/history/statement */
router.get('/history/statement', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { format } = req.query;

  const { rows } = await pool.query(
    `SELECT id, event_type, title, amount, created_at, details
     FROM deliveryman_events
     WHERE restaurant_id = $1 AND deliveryman_id = $2
     ORDER BY created_at DESC LIMIT 500`,
    [r, riderId]
  );

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="deliveryman_statement.csv"');
    let csv = 'ID,Timestamp,Event,Title,Amount\n';
    for (const row of rows) {
      csv += `"${row.id}","${row.created_at}","${row.event_type}","${row.title}",${row.amount || 0}\n`;
    }
    return res.send(csv);
  }

  ok(res, rows);
}));

module.exports = router;
