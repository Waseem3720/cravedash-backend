/**
 * Kitchen (chef) app routes: riders, kitchen alerts, support, store profile, integration status and branding.
 * All routes need a session (the router is mounted behind requireAuth). Every query is scoped to the caller's restaurant.
 */
const express = require('express');
const crypto = require('crypto');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound } = require('@cravedash/shared/src/errors');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

function clampPaging(query, defaultLimit) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, offset: (page - 1) * limit };
}

/* ---------- Riders ---------- */

router.get('/riders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const wanted = String(req.query.status || 'all');
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.phone, d.vehicle, d.status,
            EXISTS (
              SELECT 1 FROM orders o
               WHERE o.restaurant_id = d.restaurant_id
                 AND o.data->>'delivery_man_id' = d.id
                 AND o.status = 'out_for_delivery'
            ) AS busy
       FROM deliverymen d
      WHERE d.restaurant_id = $1
      ORDER BY d.name ASC`,
    [r],
  );
  const riders = rows.map((d) => {
    const active = String(d.status).toLowerCase() === 'active';
    const online = active ? (d.busy ? 'busy' : 'available') : 'offline';
    return {
      id: d.id,
      name: d.name,
      phone: d.phone,
      status: active,
      online_status: online,
      vehicle_type: d.vehicle || null,
    };
  });
  const filtered = wanted === 'all' ? riders : riders.filter((x) => x.online_status === wanted);
  ok(res, filtered);
}));

/* ---------- Kitchen alerts ---------- */

async function kitchenNotify(restaurantId, { title, message, orderId = null, branch = null }) {
  await pool.query(
    'INSERT INTO kitchen_notifications (id, restaurant_id, branch_id, title, message, order_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [`notif_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, restaurantId, branch, title, message || null, orderId],
  );
}

function mapNotification(row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    order_id: row.order_id,
    is_read: !!row.is_read,
    created_at: row.created_at,
  };
}

router.get('/notifications', asyncHandler(async (req, res) => {
  const r = rid(req);
  const unreadOnly = ['true', '1', 'yes'].includes(String(req.query.unread_only || '').toLowerCase());
  const { limit, offset } = clampPaging(req.query, 20);
  const params = [r];
  const where = ['restaurant_id = $1'];
  const scoped = branchId(req);
  if (scoped) {
    params.push(scoped);
    where.push(`(branch_id = $${params.length} OR branch_id IS NULL)`);
  }
  if (unreadOnly) where.push('is_read = FALSE');
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM kitchen_notifications WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  ok(res, rows.map(mapNotification));
}));

router.patch('/notifications/:id/read', asyncHandler(async (req, res) => {
  const isRead = req.body?.is_read === undefined ? true : !!req.body.is_read;
  const { rows } = await pool.query(
    'UPDATE kitchen_notifications SET is_read = $3 WHERE id = $1 AND restaurant_id = $2 RETURNING *',
    [req.params.id, rid(req), isRead],
  );
  if (!rows[0]) throw notFound('Notification not found');
  ok(res, { id: rows[0].id, is_read: rows[0].is_read, message: 'Notification marked as read' });
}));

router.post('/notifications/mark-all-read', asyncHandler(async (req, res) => {
  const r = rid(req);
  if (req.body?.restaurant_id && String(req.body.restaurant_id) !== String(r)) {
    throw badRequest('restaurant_id does not match your session');
  }
  await pool.query('UPDATE kitchen_notifications SET is_read = TRUE WHERE restaurant_id = $1 AND is_read = FALSE', [r]);
  ok(res, { message: 'All notifications marked as read' });
}));

/* ---------- Support ---------- */

router.post('/support/contact', asyncHandler(async (req, res) => {
  const { email, country_code, phone, message } = req.body || {};
  if (!message || !String(message).trim()) throw badRequest('message is required');
  const r = rid(req);
  const { rows: restaurant } = await pool.query('SELECT name FROM restaurants WHERE id = $1', [r]);
  const id = `TK-${Date.now().toString(36)}`;
  const contact = [email, [country_code, phone].filter(Boolean).join(' ')].filter(Boolean).join(' / ');
  const createdAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO support_tickets (id, restaurant_id, restaurant_name, subject, priority, status, channel, requester, messages, data)
     VALUES ($1, $2, $3, $4, 'normal', 'queue', 'kitchen', $5, $6::jsonb, $7::jsonb)`,
    [
      id,
      r,
      restaurant[0]?.name || null,
      'Kitchen support request',
      email || null,
      JSON.stringify([{ from: 'kitchen', at: createdAt, contact, body: String(message).slice(0, 2000) }]),
      JSON.stringify({ source: 'kitchen_app' }),
    ],
  );
  created(res, { ticket_id: id, message: 'Support inquiry submitted successfully', created_at: createdAt });
}));

/* ---------- Store profile and integrations ---------- */

router.get('/restaurant/profile', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, phone, address, status, created_at FROM restaurants WHERE id = $1',
    [rid(req)],
  );
  if (!rows[0]) throw notFound('Restaurant not found');
  ok(res, rows[0]);
}));

router.get('/restaurant/integrations', asyncHandler(async (req, res) => {
  const r = rid(req);
  const [tills, tables, printers, restaurant] = await Promise.all([
    pool.query("SELECT COUNT(DISTINCT till_id)::int AS n FROM till_staff WHERE restaurant_id = $1 AND till_id IS NOT NULL", [r]),
    pool.query('SELECT COUNT(*)::int AS n FROM dining_tables WHERE restaurant_id = $1 AND active IS NOT FALSE', [r]),
    pool.query(`SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'printers' LIMIT 1`, [r]),
    pool.query('SELECT data FROM restaurants WHERE id = $1', [r]),
  ]);
  const printerData = printers.rows[0]?.data;
  const printerCount = Array.isArray(printerData) ? printerData.length : (printerData?.items || printerData?.printers || []).length;
  const callerIdOn = !!restaurant.rows[0]?.data?.integrations?.callerid;
  // Status is read from configuration (a till or printer is set up), not from a live ping.
  const status = (on) => ({ connected: !!on, status: on ? 'online' : 'not_configured' });
  ok(res, {
    epos: status(tills.rows[0].n > 0),
    printers: status(printerCount > 0),
    tables: status(tables.rows[0].n > 0),
    caller_id: { connected: callerIdOn, status: callerIdOn ? 'active' : 'not_configured' },
  });
}));

/* ---------- Branding ---------- */

router.get('/brand/config', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT name, data FROM restaurants WHERE id = $1',
    [rid(req)],
  );
  if (!rows[0]) throw notFound('Restaurant not found');
  const d = rows[0].data || {};
  const brand = d.brand || {};
  const orderSettings = d.order_settings || d.ordering || {};
  ok(res, {
    brand_name: brand.name || rows[0].name,
    theme: {
      primary_color: brand.primary_color || brand.primaryColor || '#ff6b00',
      logo_url: brand.logo_url || brand.logoUrl || null,
      currency: d.currency || 'GBP',
      currency_symbol: d.currency_symbol || '£',
    },
    order_settings: {
      delivery: orderSettings.delivery ?? true,
      takeaway: orderSettings.takeaway ?? true,
      dine_in: orderSettings.dine_in ?? true,
    },
  });
}));

module.exports = router;
module.exports.kitchenNotify = kitchenNotify;
