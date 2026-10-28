const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, requireAuth, requireRole } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, forbidden } = require('@cravedash/shared/src/errors');

const router = express.Router();

// Middleware: all routes under /api/v1/rider require authenticated rider/courier role
router.use(requireAuth, requireRole('rider', 'courier'));

function rid(req) {
  return restaurantId(req);
}

function getRiderId(req) {
  const id = req.user?.delivery_man_id || req.user?.sub || req.user?.id;
  if (!id) throw forbidden('No rider identity found in authentication credentials');
  return String(id);
}

function parseOrder(row) {
  if (!row) return row;
  const o = { ...row };
  ['customer', 'items', 'history', 'data'].forEach((k) => {
    if (typeof o[k] === 'string') {
      try { o[k] = JSON.parse(o[k]); } catch { /* keep */ }
    }
  });
  o.id = Number(o.id);
  return o;
}

function projectRiderOrder(order) {
  if (!order) return null;
  const o = { ...order };

  let safeCustomer = null;
  if (o.customer && typeof o.customer === 'object') {
    safeCustomer = {
      name: o.customer.name || `${o.customer.f_name || ''} ${o.customer.l_name || ''}`.trim() || 'Customer',
      phone: o.customer.phone || o.customer.contact_number || '',
      email: o.customer.email || '',
      address: o.customer.address || o.customer.delivery_address || '',
      delivery_address: o.customer.delivery_address || o.customer.address || '',
      delivery_instructions: o.customer.delivery_instructions || o.customer.note || '',
    };
  }

  const safeItems = Array.isArray(o.items) ? o.items.map((it) => ({
    name: it.name || it.title || 'Item',
    qty: it.qty || it.quantity || 1,
    variant: it.variant || it.variation || null,
    addons: it.addons || [],
    note: it.note || it.instructions || '',
    price: it.price != null ? Number(it.price) : undefined,
  })) : [];

  return {
    id: o.id,
    restaurant_id: o.restaurant_id,
    branch_id: o.branch_id,
    order_type: o.order_type,
    status: o.status,
    delivery_man_id: o.delivery_man_id,
    driver_distance_km: o.driver_distance_km,
    customer: safeCustomer,
    items: safeItems,
    total: o.total,
    delivery_charge: o.delivery_charge,
    tip: o.tip,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
    note: o.note,
    history: o.history,
    created_at: o.created_at,
    updated_at: o.updated_at,
    data: {
      pod: o.data?.pod || null,
      issues: o.data?.issues || [],
      delivery_notes: o.data?.delivery_notes || o.data?.dropoff_instructions || null,
      dropoff_instructions: o.data?.dropoff_instructions || null,
      cash_collected: o.data?.cash_collected || null,
    },
  };
}

const RIDER_VALID_TRANSITIONS = {
  ready_for_serve: ['out_for_delivery', 'failed_to_deliver'],
  cooking: ['out_for_delivery'],
  out_for_delivery: ['delivered', 'failed_to_deliver'],
};

async function fetchAssignedOrder(id, restaurant_id, rider_id) {
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
    [id, restaurant_id],
  );
  if (!rows[0]) throw notFound('Order not found');
  const order = parseOrder(rows[0]);
  if (!order.delivery_man_id || String(order.delivery_man_id) !== String(rider_id)) {
    throw forbidden('Order is not assigned to you');
  }
  return order;
}

/** GET /api/v1/rider/me — Self profile & active vehicle status */
router.get('/me', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);

  const { rows } = await pool.query(
    `SELECT id, restaurant_id, branch_id, name, phone, email, vehicle, status, data, created_at
     FROM deliverymen
     WHERE id = $1 AND restaurant_id = $2
     LIMIT 1`,
    [riderId, r],
  );

  if (rows[0]) {
    const dm = rows[0];
    const data = typeof dm.data === 'string' ? JSON.parse(dm.data) : (dm.data || {});
    return ok(res, {
      id: dm.id,
      restaurant_id: dm.restaurant_id,
      branch_id: dm.branch_id,
      name: dm.name,
      phone: dm.phone,
      email: dm.email,
      vehicle: dm.vehicle,
      status: dm.status,
      active: dm.status === 'active' || dm.status === 'approved',
      is_available: data.available !== false,
      shifts: data.shifts || [],
      created_at: dm.created_at,
    });
  }

  // Fallback to JWT context if deliverymen row is soft-provisioned
  ok(res, {
    id: riderId,
    restaurant_id: r,
    branch_id: req.user?.branch_id || null,
    name: req.user?.name || 'Courier Rider',
    phone: req.user?.phone || null,
    vehicle: req.user?.vehicle || 'bike',
    active: true,
    is_available: true,
  });
}));

/** POST /api/v1/rider/vehicle-availability & /availability */
const toggleAvailability = asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { available = true, vehicle } = req.body || {};

  const { rows } = await pool.query(
    `UPDATE deliverymen
     SET vehicle = COALESCE($3, vehicle),
         data = jsonb_set(COALESCE(data, '{}'::jsonb), '{available}', $4::jsonb),
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING id, vehicle, status, data`,
    [riderId, r, vehicle || null, JSON.stringify(Boolean(available))],
  );

  if (!rows[0]) {
    return ok(res, { success: true, available: Boolean(available), vehicle: vehicle || 'bike' });
  }

  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : (rows[0].data || {});
  ok(res, {
    id: rows[0].id,
    vehicle: rows[0].vehicle,
    status: rows[0].status,
    active: rows[0].status === 'active' || rows[0].status === 'approved',
    available: data.available,
  });
});
router.post('/availability', toggleAvailability);
router.post('/vehicle-availability', toggleAvailability);

/** GET /api/v1/rider/orders — Orders assigned strictly to this authenticated rider */
router.get('/orders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { status, limit = 50 } = req.query;

  const params = [r, riderId];
  const where = ['restaurant_id = $1', 'delivery_man_id = $2'];

  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  params.push(Math.min(200, +limit || 50));
  const sql = `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);

  ok(res, rows.map((row) => projectRiderOrder(parseOrder(row))));
}));

/** GET /api/v1/rider/orders/:id — Safe order detail projection */
router.get('/orders/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const order = await fetchAssignedOrder(req.params.id, r, riderId);
  ok(res, projectRiderOrder(order));
}));

/** POST /api/v1/rider/orders/:id/status — Delivery status transition */
router.post('/orders/:id/status', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { status, note } = req.body || {};

  if (!status) throw badRequest('Status is required');
  const order = await fetchAssignedOrder(req.params.id, r, riderId);

  const allowed = RIDER_VALID_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    throw badRequest(`Rider cannot transition order from ${order.status} to ${status}`);
  }

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({
    status,
    at: new Date().toISOString(),
    by: `Rider ${req.user?.name || riderId}`,
  });

  const { rows } = await pool.query(
    `UPDATE orders
     SET status = $3,
         history = $4,
         note = COALESCE($5, note),
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.id, r, status, JSON.stringify(history), note || null],
  );

  const updated = parseOrder(rows[0]);

  // Apply ledger engines if delivered
  if (status === 'delivered') {
    const ordersRouter = require('./orders');
    if (ordersRouter.applyOrderEngines) {
      await ordersRouter.applyOrderEngines(r, updated, { prevPayment: order.payment_status });
    }
  }

  ok(res, projectRiderOrder(updated));
}));

/** POST /api/v1/rider/orders/:id/proof & /pod — Proof of delivery */
const recordProofOfDelivery = asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { photo_url, signature, recipient_name, notes } = req.body || {};

  if (!photo_url && !signature) {
    throw badRequest('Proof of delivery requires either photo_url or signature');
  }

  const order = await fetchAssignedOrder(req.params.id, r, riderId);

  const podRecord = {
    photo_url: photo_url || null,
    signature: signature || null,
    recipient_name: recipient_name || null,
    notes: notes || null,
    recorded_at: new Date().toISOString(),
    rider_id: riderId,
  };

  const data = {
    ...(order.data || {}),
    pod: podRecord,
  };

  const { rows } = await pool.query(
    `UPDATE orders
     SET data = $3::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.id, r, JSON.stringify(data)],
  );

  ok(res, {
    success: true,
    order_id: req.params.id,
    pod: podRecord,
  });
});
router.post('/orders/:id/proof', recordProofOfDelivery);
router.post('/orders/:id/pod', recordProofOfDelivery);

/** POST /api/v1/rider/orders/:id/issues & /delivery-issue — Delivery issue reporting */
const reportDeliveryIssue = asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { reason, details, mark_failed = false } = req.body || {};

  if (!reason) throw badRequest('Issue reason is required');
  const order = await fetchAssignedOrder(req.params.id, r, riderId);

  const issueEntry = {
    reason,
    details: details || '',
    mark_failed: Boolean(mark_failed),
    reported_at: new Date().toISOString(),
    rider_id: riderId,
  };

  const currentIssues = Array.isArray(order.data?.issues) ? order.data.issues : [];
  const updatedIssues = [...currentIssues, issueEntry];

  let newStatus = order.status;
  const history = Array.isArray(order.history) ? [...order.history] : [];

  if (mark_failed && ['ready_for_serve', 'out_for_delivery'].includes(order.status)) {
    newStatus = 'failed_to_deliver';
    history.push({
      status: newStatus,
      at: new Date().toISOString(),
      by: `Rider Issue: ${reason}`,
    });
  }

  const data = {
    ...(order.data || {}),
    issues: updatedIssues,
  };

  const { rows } = await pool.query(
    `UPDATE orders
     SET status = $3, history = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.id, r, newStatus, JSON.stringify(history), JSON.stringify(data)],
  );

  ok(res, {
    success: true,
    order_id: req.params.id,
    status: newStatus,
    issue: issueEntry,
  });
});
router.post('/orders/:id/issues', reportDeliveryIssue);
router.post('/orders/:id/delivery-issue', reportDeliveryIssue);

/** POST /api/v1/rider/orders/:id/cash-collect — Cash collection for COD orders */
router.post('/orders/:id/cash-collect', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { amount, notes } = req.body || {};

  const order = await fetchAssignedOrder(req.params.id, r, riderId);

  const collectAmount = amount != null ? Number(amount) : Number(order.total || 0);
  if (isNaN(collectAmount) || collectAmount < 0) {
    throw badRequest('Invalid collection amount');
  }

  const cashRecord = {
    amount: collectAmount,
    currency: 'GBP',
    collected_at: new Date().toISOString(),
    rider_id: riderId,
    notes: notes || 'Cash collected upon delivery',
  };

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({
    status: order.status,
    action: 'cash_collected',
    amount: collectAmount,
    at: new Date().toISOString(),
    by: `Rider ${riderId}`,
  });

  const data = {
    ...(order.data || {}),
    cash_collected: cashRecord,
  };

  const { rows } = await pool.query(
    `UPDATE orders
     SET payment_status = 'paid', history = $3, data = $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [req.params.id, r, JSON.stringify(history), JSON.stringify(data)],
  );

  const updated = parseOrder(rows[0]);
  const ordersRouter = require('./orders');
  if (ordersRouter.applyOrderEngines) {
    await ordersRouter.applyOrderEngines(r, updated, { prevPayment: order.payment_status });
  }

  ok(res, {
    success: true,
    order_id: req.params.id,
    payment_status: 'paid',
    cash_collected: cashRecord,
  });
}));

/** POST /api/v1/rider/shifts/start — Start courier shift */
router.post('/shifts/start', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { vehicle, odometer_start, notes } = req.body || {};

  const shift = {
    id: `sh_${Date.now()}`,
    status: 'active',
    vehicle: vehicle || req.user?.vehicle || 'bike',
    odometer_start: odometer_start != null ? Number(odometer_start) : null,
    notes: notes || null,
    started_at: new Date().toISOString(),
  };

  const { rows } = await pool.query(
    `SELECT data FROM deliverymen WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r],
  );

  const currentData = rows[0]
    ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : (rows[0].data || {}))
    : {};

  const shifts = Array.isArray(currentData.shifts) ? currentData.shifts : [];
  shifts.push(shift);

  await pool.query(
    `UPDATE deliverymen
     SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{shifts}', $3::jsonb),
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r, JSON.stringify(shifts)],
  );

  created(res, shift);
}));

/** POST /api/v1/rider/shifts/end — End courier shift */
router.post('/shifts/end', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { odometer_end, cash_collected, orders_delivered, notes } = req.body || {};

  const { rows } = await pool.query(
    `SELECT data FROM deliverymen WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r],
  );

  const currentData = rows[0]
    ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : (rows[0].data || {}))
    : {};

  const shifts = Array.isArray(currentData.shifts) ? [...currentData.shifts] : [];
  const activeShiftIndex = shifts.slice().reverse().findIndex((s) => s.status === 'active');

  if (activeShiftIndex === -1) {
    throw badRequest('No active shift found to end');
  }

  const realIndex = shifts.length - 1 - activeShiftIndex;
  shifts[realIndex] = {
    ...shifts[realIndex],
    status: 'ended',
    ended_at: new Date().toISOString(),
    odometer_end: odometer_end != null ? Number(odometer_end) : null,
    cash_collected: cash_collected != null ? Number(cash_collected) : null,
    orders_delivered: orders_delivered != null ? Number(orders_delivered) : null,
    closing_notes: notes || null,
  };

  await pool.query(
    `UPDATE deliverymen
     SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{shifts}', $3::jsonb),
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r, JSON.stringify(shifts)],
  );

  ok(res, shifts[realIndex]);
}));

/** POST /api/v1/rider/handovers — Courier daily cash handover reconciliation */
router.post('/handovers', asyncHandler(async (req, res) => {
  const r = rid(req);
  const riderId = getRiderId(req);
  const { amount, shift_id, manager_id, notes } = req.body || {};

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw badRequest('Handover amount must be a positive number');
  }

  const handover = {
    id: `ho_${Date.now()}`,
    amount: numAmount,
    shift_id: shift_id || null,
    manager_id: manager_id || null,
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    notes: notes || null,
  };

  const { rows } = await pool.query(
    `SELECT data FROM deliverymen WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r],
  );

  const currentData = rows[0]
    ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : (rows[0].data || {}))
    : {};

  const handovers = Array.isArray(currentData.handovers) ? currentData.handovers : [];
  handovers.push(handover);

  await pool.query(
    `UPDATE deliverymen
     SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{handovers}', $3::jsonb),
         updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [riderId, r, JSON.stringify(handovers)],
  );

  created(res, handover);
}));

module.exports = router;
