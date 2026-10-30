/**
 * POS offline sync — push outbox batch + pull deltas.
 * Idempotency keys are restaurant-scoped and never expire on ACK (kept for dedupe).
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest } = require('@cravedash/shared/src/errors');

const router = express.Router();

/**
 * Canonical schema provisioning handled by Migration 009 (CD-CON-058).
 * Retained as no-op to preserve function signature for callers.
 */
async function ensureSyncTables() {
  return;
}

function rid(req) {
  return restaurantId(req);
}

async function applyItem(req, item) {
  const r = rid(req);
  const key = String(item.idempotency_key || '');
  if (!key) return { key: '', status: 'error', error: 'missing idempotency_key' };

  const { rows: existing } = await pool.query(
    `SELECT * FROM sync_idempotency WHERE restaurant_id = $1 AND idempotency_key = $2`,
    [r, key],
  );
  if (existing[0]) {
    return {
      key,
      status: 'duplicate',
      server_id: existing[0].server_id,
      client_id: existing[0].client_id,
      result: existing[0].result,
    };
  }

  const entity = String(item.entity || '');
  const op = String(item.op || '');
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  let serverId = null;
  let clientId = payload.client_id || payload.id || null;
  let result = {};

  try {
    if (entity === 'order' && op === 'create') {
      // Prefer existing by client_id in data
      if (clientId) {
        const { rows: found } = await pool.query(
          `SELECT id FROM orders WHERE restaurant_id = $1 AND data->>'client_id' = $2 LIMIT 1`,
          [r, String(clientId)],
        );
        if (found[0]) {
          serverId = String(found[0].id);
          result = { reused: true };
        }
      }
      if (!serverId) {
        const { rows: idRows } = await pool.query("SELECT nextval('orders_id_seq') AS id");
        const id = idRows[0].id;
        const data = { ...(payload.data || {}), client_id: clientId, sync_key: key };
        const { rows } = await pool.query(
          `INSERT INTO orders (
            id, restaurant_id, branch, branch_id, source, order_type, status, payment_status, payment_method,
            customer, table_id, guests, items, subtotal, discount, coupon_code, delivery_charge,
            service_charge, tip, total, note, history, acknowledged, data
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
          ) RETURNING id`,
          [
            id,
            r,
            payload.branch || 'Main Branch',
            payload.branch_id || 'main',
            payload.source || 'pos',
            payload.order_type || 'takeaway',
            payload.status || 'completed',
            payload.payment_status || 'paid',
            payload.payment_method || null,
            JSON.stringify(payload.customer || null),
            payload.table_id || null,
            payload.guests || 0,
            JSON.stringify(payload.items || []),
            Number(payload.subtotal) || 0,
            Number(payload.discount) || 0,
            payload.coupon_code || null,
            Number(payload.delivery_charge) || 0,
            Number(payload.service_charge) || 0,
            Number(payload.tip) || 0,
            Number(payload.total) || 0,
            payload.note || null,
            JSON.stringify(payload.history || [{ status: payload.status || 'completed', at: new Date().toISOString(), by: 'POS sync' }]),
            true,
            JSON.stringify(data),
          ],
        );
        serverId = String(rows[0].id);
        result = { created: true };
      }
    } else if (entity === 'held' && op === 'upsert') {
      const hid = String(payload.id || clientId || key);
      const till = payload.till_id || req.user?.till_id || null;
      const label = payload.label || payload.name || null;
      await pool.query(
        `INSERT INTO held_orders (id, restaurant_id, till_id, label, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET 
           till_id = COALESCE(EXCLUDED.till_id, held_orders.till_id),
           label = COALESCE(EXCLUDED.label, held_orders.label),
           payload = EXCLUDED.payload, 
           updated_at = NOW()`,
        [hid, r, till, label, JSON.stringify(payload)],
      ).catch(async () => {
        // Fallback domain blob
        await pool.query(
          `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
           VALUES ($1,$2,$3::jsonb,NOW())
           ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [r, `held:${hid}`, JSON.stringify(payload)],
        );
      });
      serverId = hid;
      clientId = hid;
      result = { upserted: true };
    } else if (entity === 'held' && op === 'delete') {
      const hid = String(payload.id || '');
      await pool.query(`DELETE FROM held_orders WHERE id = $1 AND restaurant_id = $2`, [hid, r]).catch(() => {});
      serverId = hid;
      result = { deleted: true };
    } else if (entity === 'till' && op === 'count') {
      const kind = payload.kind;
      if (kind === 'x') {
        await pool.query(
          `INSERT INTO report_counters (restaurant_id, data, updated_at)
           VALUES ($1, jsonb_build_object('last_x', $2::jsonb), NOW())
           ON CONFLICT (restaurant_id) DO UPDATE
           SET data = COALESCE(report_counters.data,'{}'::jsonb) || jsonb_build_object('last_x', $2::jsonb), updated_at = NOW()`,
          [r, JSON.stringify(payload)],
        ).catch(() => {});
      } else if (kind === 'z') {
        const zid = String(payload.id || key || `z_${Date.now()}`);
        const zNo = parseInt(payload.z_no || payload.zCounter || payload.z_counter || 1, 10) || 1;
        const till = payload.till_id || req.user?.till_id || null;
        const countedCash = payload.counted_cash != null ? Number(payload.counted_cash) : null;
        const variance = payload.variance != null ? Number(payload.variance) : null;
        const generatedBy = payload.generated_by || req.user?.name || req.user?.email || null;

        await pool.query(
          `INSERT INTO z_reports (id, restaurant_id, till_id, z_no, report, counted_cash, variance, generated_by, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NOW())
           ON CONFLICT (id) DO UPDATE SET 
             report = EXCLUDED.report,
             counted_cash = COALESCE(EXCLUDED.counted_cash, z_reports.counted_cash),
             variance = COALESCE(EXCLUDED.variance, z_reports.variance)`,
          [zid, r, till, zNo, JSON.stringify(payload), countedCash, variance, generatedBy],
        );
        serverId = zid;
      }
      result = { counted: true };
    } else if (entity === 'print' && op === 'job') {
      result = { queued: true };
      serverId = payload.id || key;
    } else if (entity === 'terminal' && op === 'charge') {
      result = { deferred: true, note: 'Terminal charge should be executed via /engines/terminals/charge' };
      serverId = payload.order_client_id || key;
    } else if (entity === 'product' && op === 'create') {
      result = { deferred: true, note: 'Use catalog product APIs' };
      serverId = payload.id || null;
    } else {
      result = { ignored: true, entity, op };
    }

    await pool.query(
      `INSERT INTO sync_idempotency (restaurant_id, idempotency_key, entity, op, server_id, client_id, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [r, key, entity, op, serverId, clientId ? String(clientId) : null, JSON.stringify(result)],
    );

    return { key, status: 'acked', server_id: serverId, client_id: clientId, result };
  } catch (err) {
    return { key, status: 'error', error: err.message, client_id: clientId };
  }
}

router.post(
  '/push',
  asyncHandler(async (req, res) => {
    await ensureSyncTables();
    if (!rid(req)) throw badRequest('restaurant_id required');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw badRequest('items required');
    const results = [];
    for (const item of items) {
      // Sequential for money ops ordering
      results.push(await applyItem(req, item));
    }
    ok(res, { results });
  }),
);

router.get(
  '/pull',
  asyncHandler(async (req, res) => {
    await ensureSyncTables();
    const r = rid(req);
    if (!r) throw badRequest('restaurant_id required');
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);

    const [cats, products, addons, tables, staff, held, orders] = await Promise.all([
      pool.query(
        `SELECT * FROM categories WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2 ORDER BY priority ASC, num ASC, name ASC`,
        [r, since],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM products WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2 ORDER BY name`,
        [r, since],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM addons WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2`,
        [r, since],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM dining_tables WHERE restaurant_id = $1`,
        [r],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, name, role, status, till_id, branch_id FROM till_staff WHERE restaurant_id = $1 AND COALESCE(status,TRUE) = TRUE`,
        [r],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM held_orders WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2`,
        [r, since],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM orders WHERE restaurant_id = $1 AND updated_at > $2 ORDER BY updated_at DESC LIMIT 200`,
        [r, since],
      ).catch(() => ({ rows: [] })),
    ]);

    const cursor = new Date().toISOString();
    ok(res, {
      cursor,
      catalog: {
        categories: cats.rows,
        products: products.rows,
        addons: addons.rows,
      },
      tables: tables.rows,
      staff: staff.rows,
      held_orders: held.rows,
      orders: orders.rows,
    });
  }),
);

module.exports = router;
