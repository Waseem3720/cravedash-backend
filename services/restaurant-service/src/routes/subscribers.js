const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const {
  badRequest,
  notFound,
  forbidden,
  unauthorized,
  conflict,
} = require('@cravedash/shared/src/errors');

const router = express.Router();

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * POST /api/v1/subscribers/events
 * Record marketing subscription events (subscribe / unsubscribe).
 * Supported for public storefront (via trusted X-API-KEY) and authenticated staff.
 */
router.post('/events', asyncHandler(async (req, res) => {
  const tenantId = restaurantId(req);
  if (!tenantId) throw badRequest('restaurant_id missing from session');

  const body = req.body || {};
  const rawEmail = String(body.email || '').trim().toLowerCase();
  if (!rawEmail || !isValidEmail(rawEmail)) {
    throw badRequest('Valid email is required');
  }

  const eventType = String(body.event_type || '').trim().toLowerCase();
  if (!['subscribe', 'unsubscribe'].includes(eventType)) {
    throw badRequest("event_type must be 'subscribe' or 'unsubscribe'");
  }

  const source = typeof body.source === 'string'
    ? body.source.trim().slice(0, 100) || 'storefront'
    : 'storefront';

  const idempotencyKey = typeof body.idempotency_key === 'string'
    ? body.idempotency_key.trim().slice(0, 128)
    : null;

  // Safe consent evidence: only record explicit opt-in confirmation; do not store untrusted client IP
  let safeConsent = null;
  if (body.consent && typeof body.consent === 'object' && !Array.isArray(body.consent)) {
    safeConsent = {
      opt_in: Boolean(body.consent.opt_in),
      timestamp: body.consent.timestamp || new Date().toISOString(),
      channel: body.consent.channel ? String(body.consent.channel).slice(0, 50) : 'web',
    };
  }

  // 1. Idempotency pre-check
  if (idempotencyKey) {
    const { rows: existingEventRows } = await pool.query(
      `SELECT id, restaurant_id, email, event_type, source, idempotency_key, data, created_at
       FROM subscriber_events
       WHERE restaurant_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [tenantId, idempotencyKey],
    );

    if (existingEventRows[0]) {
      const existing = existingEventRows[0];
      // Payload conflict check: same idempotency key cannot be used with different email or event_type
      if (existing.email.toLowerCase() !== rawEmail || existing.event_type !== eventType) {
        throw conflict('Idempotency key already used with different payload');
      }
      return ok(res, {
        idempotent: true,
        message: 'Event already processed',
        event: existing,
      });
    }
  }

  // 2. Transactional execution of state update and event recording
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row lock on subscriber within tenant scope
    const { rows: subRows } = await client.query(
      `SELECT id, restaurant_id, email, name, source, status, data, subscribed_at, updated_at
       FROM subscribers
       WHERE restaurant_id = $1 AND LOWER(email) = LOWER($2)
       FOR UPDATE`,
      [tenantId, rawEmail],
    );

    let subscriber = null;
    const now = new Date().toISOString();

    if (subRows[0]) {
      const current = subRows[0];
      const curData = (typeof current.data === 'string' ? JSON.parse(current.data) : current.data) || {};

      let newStatus = current.status;
      let subscribeCount = Number(curData.subscribe_count || (current.status === 'active' ? 1 : 0));
      let unsubscribeCount = Number(curData.unsubscribe_count || (current.status === 'unsubscribed' ? 1 : 0));

      const updatedData = { ...curData, last_source: source };

      if (eventType === 'subscribe') {
        newStatus = 'active';
        subscribeCount += 1;
        updatedData.subscribe_count = subscribeCount;
        if (safeConsent) updatedData.consent = safeConsent;

        const { rows: updatedRows } = await client.query(
          `UPDATE subscribers
           SET status = 'active', data = $1::jsonb, subscribed_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND restaurant_id = $3
           RETURNING *`,
          [JSON.stringify(updatedData), current.id, tenantId],
        );
        subscriber = updatedRows[0];
      } else {
        newStatus = 'unsubscribed';
        unsubscribeCount += 1;
        updatedData.unsubscribe_count = unsubscribeCount;
        updatedData.unsubscribed_at = now;

        const { rows: updatedRows } = await client.query(
          `UPDATE subscribers
           SET status = 'unsubscribed', data = $1::jsonb, updated_at = NOW()
           WHERE id = $2 AND restaurant_id = $3
           RETURNING *`,
          [JSON.stringify(updatedData), current.id, tenantId],
        );
        subscriber = updatedRows[0];
      }
    } else {
      // New subscriber insertion
      const newSubId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const isSub = eventType === 'subscribe';
      const initialData = {
        subscribe_count: isSub ? 1 : 0,
        unsubscribe_count: isSub ? 0 : 1,
        source,
      };
      if (isSub && safeConsent) initialData.consent = safeConsent;
      if (!isSub) initialData.unsubscribed_at = now;

      const { rows: insertedRows } = await client.query(
        `INSERT INTO subscribers (id, restaurant_id, email, name, source, status, data, subscribed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
         RETURNING *`,
        [
          newSubId,
          tenantId,
          rawEmail,
          body.name ? String(body.name).trim().slice(0, 100) : null,
          source,
          isSub ? 'active' : 'unsubscribed',
          JSON.stringify(initialData),
        ],
      );
      subscriber = insertedRows[0];
    }

    // Insert audit event in subscriber_events
    const eventId = `sev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const eventData = {
      ...(body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}),
      subscriber_id: subscriber.id,
      actor_role: req.user?.role || 'public_storefront',
    };
    if (safeConsent) eventData.consent = safeConsent;

    let eventRecord = null;
    try {
      const { rows: eventRows } = await client.query(
        `INSERT INTO subscriber_events (id, restaurant_id, email, event_type, source, idempotency_key, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
         RETURNING *`,
        [eventId, tenantId, rawEmail, eventType, source, idempotencyKey, JSON.stringify(eventData)],
      );
      eventRecord = eventRows[0];
    } catch (insertErr) {
      // Handle concurrent duplicate idempotency race condition gracefully
      if (insertErr.code === '23505' && idempotencyKey) {
        await client.query('ROLLBACK');
        const { rows: existingRows } = await pool.query(
          `SELECT * FROM subscriber_events WHERE restaurant_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [tenantId, idempotencyKey],
        );
        if (existingRows[0]) {
          return ok(res, {
            idempotent: true,
            message: 'Event already processed',
            event: existingRows[0],
          });
        }
      }
      throw insertErr;
    }

    await client.query('COMMIT');

    created(res, {
      success: true,
      subscriber: {
        id: subscriber.id,
        email: subscriber.email,
        status: subscriber.status,
        subscribed_at: subscriber.subscribed_at,
        data: typeof subscriber.data === 'string' ? JSON.parse(subscriber.data) : subscriber.data,
      },
      event: eventRecord,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

function assertAdminRole(req) {
  const role = req.user?.role;
  if (!role || !['restaurant', 'super'].includes(role)) {
    throw forbidden('Admin privileges required to manage subscribers');
  }
}

/**
 * GET /api/v1/subscribers
 * Paginated subscriber listing with tenant-scoped aggregate statistics.
 * Restricted to restaurant staff and super admins.
 */
router.get('/', asyncHandler(async (req, res) => {
  assertAdminRole(req);
  const tenantId = restaurantId(req);
  if (!tenantId) throw badRequest('restaurant_id missing from session');

  const { status = 'all', q = '' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // 1. Tenant aggregate counts (unfiltered overview)
  const { rows: countRows } = await pool.query(
    `SELECT 
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed
     FROM subscribers
     WHERE restaurant_id = $1`,
    [tenantId],
  );
  const counts = countRows[0] || { total: 0, active: 0, unsubscribed: 0 };

  // 2. Build filtered query
  const whereClauses = ['restaurant_id = $1'];
  const params = [tenantId];

  if (status === 'active') {
    whereClauses.push("status = 'active'");
  } else if (status === 'unsubscribed') {
    whereClauses.push("status = 'unsubscribed'");
  }

  if (q && typeof q === 'string' && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    whereClauses.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(name, '')) LIKE $${params.length})`);
  }

  const whereSql = whereClauses.join(' AND ');

  // Filtered total count
  const { rows: filteredCountRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM subscribers WHERE ${whereSql}`,
    params,
  );
  const filteredTotal = filteredCountRows[0]?.count || 0;

  // Filtered rows
  const listParams = [...params, limit, offset];
  const { rows: subscriberRows } = await pool.query(
    `SELECT id, restaurant_id, email, name, source, status, data, subscribed_at, updated_at
     FROM subscribers
     WHERE ${whereSql}
     ORDER BY subscribed_at DESC, id DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  const formattedRows = subscriberRows.map((r) => ({
    ...r,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
  }));

  ok(res, {
    subscribers: formattedRows,
    pagination: {
      total: counts.total,
      filtered: filteredTotal,
      limit,
      offset,
    },
    counts,
  });
}));

/**
 * GET /api/v1/subscribers/:id
 * Subscriber details with complete event audit timeline.
 * Restricted to restaurant staff and super admins.
 */
router.get('/:id', asyncHandler(async (req, res) => {
  assertAdminRole(req);
  const tenantId = restaurantId(req);
  if (!tenantId) throw badRequest('restaurant_id missing from session');

  const { id } = req.params;

  const { rows: subRows } = await pool.query(
    `SELECT id, restaurant_id, email, name, source, status, data, subscribed_at, updated_at
     FROM subscribers
     WHERE id = $1 AND restaurant_id = $2
     LIMIT 1`,
    [id, tenantId],
  );

  if (!subRows[0]) {
    throw notFound('Subscriber not found');
  }

  const subscriber = subRows[0];

  // Retrieve event timeline in chronological order
  const { rows: eventRows } = await pool.query(
    `SELECT id, restaurant_id, email, event_type, source, idempotency_key, data, created_at
     FROM subscriber_events
     WHERE restaurant_id = $1 AND LOWER(email) = LOWER($2)
     ORDER BY created_at ASC, id ASC`,
    [tenantId, subscriber.email],
  );

  ok(res, {
    ...subscriber,
    data: typeof subscriber.data === 'string' ? JSON.parse(subscriber.data) : subscriber.data,
    events: eventRows.map((e) => ({
      ...e,
      data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
    })),
  });
}));

/**
 * DELETE /api/v1/subscribers/:id
 * GDPR Data Erasure Workflow:
 * Permanently removes personal subscriber record, anonymizes audit history, and emits audit_events entry.
 * Restricted to authorized admin roles.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  assertAdminRole(req);
  const tenantId = restaurantId(req);
  if (!tenantId) throw badRequest('restaurant_id missing from session');

  const targetId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock and retrieve subscriber
    const { rows: subRows } = await client.query(
      `SELECT id, email, restaurant_id 
       FROM subscribers 
       WHERE id = $1 AND restaurant_id = $2 
       FOR UPDATE`,
      [targetId, tenantId],
    );

    if (!subRows[0]) {
      await client.query('ROLLBACK');
      throw notFound('Subscriber not found');
    }

    const sub = subRows[0];

    // 2. Permanently delete the subscriber record
    await client.query(
      'DELETE FROM subscribers WHERE id = $1 AND restaurant_id = $2',
      [targetId, tenantId],
    );

    // 3. Anonymize associated subscriber events to erase PII while maintaining count integrity
    await client.query(
      `UPDATE subscriber_events 
       SET email = 'anonymized-gdpr@deleted.internal',
           data = jsonb_set(COALESCE(data, '{}'::jsonb), '{erased_at}', to_jsonb(NOW()::text))
       WHERE restaurant_id = $1 AND LOWER(email) = LOWER($2)`,
      [tenantId, sub.email],
    );

    // 4. Emit an immutable audit log entry in audit_events (no personal email or consent info!)
    const auditId = `ae_gdpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await client.query(
      `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data, created_at)
       VALUES ($1, $2, 'GDPR_SUBSCRIBER_ERASURE', 'subscriber', $3, $4, $5, $6::jsonb, NOW())`,
      [
        auditId,
        req.user?.sub || req.user?.id || 'admin',
        targetId,
        tenantId,
        'Subscriber data permanently erased for GDPR compliance',
        JSON.stringify({ erasure_type: 'GDPR_RIGHT_TO_BE_FORGOTTEN', subscriber_id: targetId }),
      ],
    );

    await client.query('COMMIT');

    return ok(res, {
      success: true,
      erased: true,
      subscriber_id: targetId,
      message: 'Subscriber and personal data permanently erased for GDPR compliance',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
