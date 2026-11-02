/**
 * POS offline sync — push outbox batch + pull deltas.
 * Idempotency keys are restaurant-scoped and never expire on ACK (kept for dedupe).
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, assertBranchAccess, tillId, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const riderAssignment = require('@cravedash/shared/src/engines/riderAssignment');
const { badRequest } = require('@cravedash/shared/src/errors');
const { linkOrderCustomer } = require('@cravedash/shared/src/customerSync');
const { applyOrderEngines } = require('@cravedash/shared/src/orderEngines');
const { priceLinesFromCatalogue, RejectedLine } = require('@cravedash/shared/src/catalogPricing');
const { withoutServerKeys } = require('@cravedash/shared/src/serverOwnedData');

/** The order statuses a till may send (the same list the order service accepts). */
const SYNC_STATUSES = new Set([
  'pending', 'confirmed', 'processing', 'cooking', 'ready_for_serve',
  'out_for_delivery', 'delivered', 'completed', 'canceled', 'returned', 'failed_to_deliver',
]);

const router = express.Router();

async function ensureSyncTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_idempotency (
      restaurant_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      entity TEXT,
      op TEXT,
      server_id TEXT,
      client_id TEXT,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (restaurant_id, idempotency_key)
    )
  `);
}

function rid(req) {
  return restaurantId(req);
}

/** Only an EPOS till or super session may record a sale as paid through sync (same rule as orders.js). */
function canSetMoneyFields(req) {
  const role = req.user?.role;
  return role === 'super' || role === 'epos';
}

/** Payment methods a till may record as paid offline. Stripe is confirmed only by the provider. */
const OFFLINE_PAID_METHODS = new Set(['cash', 'card']);

/**
 * Server-side money for an offline order. The client's paid status, subtotal, discount and total are
 * not trusted:
 * - status defaults to unpaid; paid needs a till or super session and a cash or card method;
 * - subtotal is summed from the lines, which were already priced from the catalogue (ORD-H2, ORD-M1);
 * - discount is capped at the subtotal; charges are non-negative;
 * - total is recomputed from those values, never copied from the payload.
 */
function orderMoneyFromPayload(req, payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const subtotal = Math.round(items.reduce((s, it) => {
    // Prices can never be negative and quantities are whole numbers of at least 1 (review finding).
    const price = Math.max(0, Number(it && it.price) || 0);
    const qty = Math.max(1, Math.floor(Number(it && it.qty) || 1));
    const addons = Array.isArray(it && it.addons)
      ? it.addons.reduce((a, x) => a + (Number(x && x.price) || 0), 0)
      : 0;
    return s + (price + addons) * qty;
  }, 0) * 100) / 100;
  const discount = Math.min(Math.max(0, Number(payload.discount) || 0), subtotal);
  const charges = {
    delivery_charge: Math.max(0, Number(payload.delivery_charge) || 0),
    service_charge: Math.max(0, Number(payload.service_charge) || 0),
    tip: Math.max(0, Number(payload.tip) || 0),
  };
  const total = Math.round((subtotal - discount + charges.delivery_charge + charges.service_charge + charges.tip) * 100) / 100;
  const paymentMethod = payload.payment_method ? String(payload.payment_method) : null;
  const paid = canSetMoneyFields(req)
    && String(payload.payment_status || '').toLowerCase() === 'paid'
    && OFFLINE_PAID_METHODS.has(String(paymentMethod || '').toLowerCase());
  return { paymentStatus: paid ? 'paid' : 'unpaid', paymentMethod, subtotal, discount, charges, total };
}

function duplicateOutcome(key, row) {
  return {
    key,
    status: 'duplicate',
    server_id: row.server_id,
    client_id: row.client_id,
    result: row.result,
  };
}

/**
 * Creates an offline order once per idempotency key (ORD-M3).
 *
 * The key is claimed with INSERT ... ON CONFLICT DO NOTHING in the same transaction as the order insert. A concurrent
 * push of the same key waits on the claim and then sees it as a duplicate, so two orders cannot be created. A failed
 * line rolls the claim back, so the till can retry it. The unique index on orders (restaurant_id, branch_id, client_id) is the
 * backstop: a duplicate there is answered with the existing order.
 */
/** The rider on a synced order: looked up in the restaurant and checked against the till's branch. */
async function riderForSync(db, restaurant, req, riderId) {
  if (riderId === null || riderId === undefined || riderId === '') return { id: null, name: null };
  const id = String(riderId);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw badRequest('Invalid delivery man');
  const { rows } = await db.query('SELECT id, name, branch_id FROM deliverymen WHERE id = $1 AND restaurant_id = $2', [id, restaurant]);
  if (!rows[0] || !rowInBranchScope(req, rows[0].branch_id)) throw badRequest('Delivery man not found for this branch');
  const mine = (await riderAssignment.candidatesFor(db, restaurant, rows[0].branch_id)).find((c) => c.id === rows[0].id);
  if (mine && !mine.eligible) throw badRequest(`Delivery man cannot take this order: ${mine.reason}`);
  return { id: rows[0].id, name: rows[0].name };
}

async function createOrderOnce(req, r, key, clientId, payload) {
  // The branch is fixed before anything is read or written, so a client_id is only matched within its own branch.
  const scopedBranch = branchId(req);
  // The branch comes only from the till's own binding or a validated branch context; a payload branch is refused.
  if (!scopedBranch && payload.branch_id && String(payload.branch_id) !== 'main') {
    throw badRequest('This till has no branch, so the order cannot be placed for a branch');
  }
  const orderBranch = scopedBranch || 'main';
  const client = await pool.connect();
  let inTx = false;
  try {
    await client.query('BEGIN');
    inTx = true;
    const { rows: claimed } = await client.query(
      `INSERT INTO sync_idempotency (restaurant_id, idempotency_key, entity, op, server_id, client_id, result)
       VALUES ($1, $2, 'order', 'create', NULL, $3, '{}'::jsonb)
       ON CONFLICT (restaurant_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [r, key, clientId ? String(clientId) : null],
    );
    if (!claimed[0]) {
      await client.query('ROLLBACK');
      inTx = false;
      const { rows: existing } = await pool.query(
        'SELECT * FROM sync_idempotency WHERE restaurant_id = $1 AND idempotency_key = $2',
        [r, key],
      );
      return duplicateOutcome(key, existing[0] || {});
    }

    let serverId = null;
    let result = {};
    let created = null;
    if (clientId) {
      const { rows: found } = await client.query(
        `SELECT id FROM orders WHERE restaurant_id = $1 AND branch_id = $3 AND data->>'client_id' = $2 LIMIT 1`,
        [r, String(clientId), orderBranch],
      );
      if (found[0]) {
        serverId = String(found[0].id);
        result = { reused: true };
      }
    }
    if (!serverId) {
      const { rows: idRows } = await client.query("SELECT nextval('orders_id_seq') AS id");
      const id = idRows[0].id;
      // BUG-009: a till may record a sale that is still open or completed, never one that is already cancelled, returned or failed.
      const syncStatus = payload.status || 'completed';
      if (!SYNC_STATUSES.has(syncStatus) || ['canceled', 'returned', 'failed_to_deliver'].includes(syncStatus)) {
        throw badRequest('Invalid status for an offline sale');
      }
      // Line prices come from the server catalogue, never from the offline payload (ORD-H2, ORD-M1).
      const pricingBranch = scopedBranch || null;
      // Offline quantities are clamped to whole numbers of at least 1 (the same rule as orderMoneyFromPayload), not refused.
      const syncItems = (Array.isArray(payload.items) ? payload.items : []).map((it) => ({
        ...it,
        qty: Math.max(1, Math.floor(Number(it && it.qty) || 1)),
      }));
      const pricedItems = await priceLinesFromCatalogue(client, r, syncItems, { branchId: pricingBranch });
      const pricedPayload = { ...payload, items: pricedItems };
      const { paymentStatus, paymentMethod, subtotal, discount, charges, total } = orderMoneyFromPayload(req, pricedPayload);
      // BUG-009: engine flags, payment and payout fields and commission are server-owned. An offline till cannot set them.
      const { delivery_man: _clientRiderName, ...clientData } = withoutServerKeys(payload.data);
      const rider = Object.prototype.hasOwnProperty.call(clientData, 'delivery_man_id')
        ? await riderForSync(client, r, req, clientData.delivery_man_id)
        : null;
      delete clientData.delivery_man_id;
      const data = {
        ...clientData,
        ...(rider && rider.id ? { delivery_man_id: rider.id, delivery_man: rider.name } : {}),
        client_id: clientId,
        sync_key: key,
      };
      // A branch-bound till writes to its own branch only (SEC-ORD-H3). The client's branch_id is used only without a binding.
      if (scopedBranch) assertBranchAccess(req, orderBranch);
      const { rows } = await client.query(
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
          orderBranch,
          payload.source || 'pos',
          payload.order_type || 'takeaway',
          syncStatus,
          paymentStatus,
          paymentMethod,
          JSON.stringify(payload.customer || null),
          payload.table_id || null,
          payload.guests || 0,
          JSON.stringify(pricedItems),
          subtotal,
          discount,
          payload.coupon_code || null,
          charges.delivery_charge,
          charges.service_charge,
          charges.tip,
          total,
          payload.note || null,
          JSON.stringify(payload.history || [{ status: payload.status || 'completed', at: new Date().toISOString(), by: 'POS sync' }]),
          true,
          JSON.stringify(data),
        ],
      );
      serverId = String(rows[0].id);
      result = { created: true };
      created = { id, orderBranch, paymentStatus, customer: payload.customer };
    }

    await client.query(
      `UPDATE sync_idempotency SET server_id = $3, client_id = $4, result = $5::jsonb
       WHERE restaurant_id = $1 AND idempotency_key = $2`,
      [r, key, serverId, clientId ? String(clientId) : null, JSON.stringify(result)],
    );
    await client.query('COMMIT');
    inTx = false;

    // Customer link and engines run after the commit, on the pool, as before.
    if (created) {
      await linkOrderCustomer(pool, { restaurantId: r, customer: created.customer, branchId: created.orderBranch });
      // A paid offline sale posts the same stock, loyalty and accounting effects as an online one (ORD-H9).
      if (created.paymentStatus === 'paid') {
        const { rows: saved } = await pool.query('SELECT * FROM orders WHERE id = $1', [created.id]);
        await applyOrderEngines(r, saved[0], { prevPayment: 'unpaid' });
      }
    }
    return { key, status: 'acked', server_id: serverId, client_id: clientId, result };
  } catch (err) {
    if (inTx) await client.query('ROLLBACK').catch(() => {});
    inTx = false;
    // Another order already holds this client_id (unique index). Answer with that order, and remember the key.
    if (err && err.code === '23505' && clientId) {
      const { rows: found } = await pool.query(
        `SELECT id FROM orders WHERE restaurant_id = $1 AND branch_id = $3 AND data->>'client_id' = $2 LIMIT 1`,
        [r, String(clientId), orderBranch],
      );
      if (found[0]) {
        const serverId = String(found[0].id);
        const result = { reused: true };
        await pool.query(
          `INSERT INTO sync_idempotency (restaurant_id, idempotency_key, entity, op, server_id, client_id, result)
           VALUES ($1, $2, 'order', 'create', $3, $4, $5::jsonb)
           ON CONFLICT (restaurant_id, idempotency_key) DO NOTHING`,
          [r, key, serverId, String(clientId), JSON.stringify(result)],
        );
        return { key, status: 'acked', server_id: serverId, client_id: clientId, result };
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

async function applyItem(req, item) {
  const r = rid(req);
  const key = String(item.idempotency_key || '');
  if (!key) return { key: '', status: 'error', error: 'missing idempotency_key' };

  // A Z Report is never closed from an offline batch (D1-Z). It is held until an online manager approval.
  const isZCount = String(item.entity || '') === 'till'
    && String(item.op || '') === 'count'
    && String((item.payload && item.payload.kind) || '') === 'z';
  if (isZCount) return { key, status: 'held', reason: 'approval_required' };

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
      // The key is claimed and the order written in one transaction (ORD-M3). The outcome is returned directly.
      return await createOrderOnce(req, r, key, clientId || null, payload);
    } else if (entity === 'held' && op === 'upsert') {
      const hid = String(payload.id || clientId || key);
      // Columns match the table (payload, till_id, label). A till may change only its own held orders, and the
      // restaurant must match. No blob fallback and no swallowed errors (ORD-H10).
      const tillOfHold = tillId(req) || payload.till_id || null;
      const holdBranch = await holdBranchOf(r, tillOfHold, req);
      const { rows: heldExisting } = await pool.query('SELECT till_id, restaurant_id, branch_id FROM held_orders WHERE id = $1', [hid]);
      if (heldExisting[0] && heldExisting[0].restaurant_id !== r) throw badRequest('Held order id is already in use');
      if (heldExisting[0] && (heldExisting[0].branch_id || null) !== holdBranch) throw badRequest('Held order id is already in use');
      if (heldExisting[0] && tillId(req) && heldExisting[0].till_id && heldExisting[0].till_id !== tillId(req)) {
        throw badRequest('This held order belongs to another till');
      }
      await pool.query(
        `INSERT INTO held_orders (id, restaurant_id, till_id, label, payload, updated_at, branch_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,NOW(),$6)
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, till_id = EXCLUDED.till_id,
           label = EXCLUDED.label, updated_at = NOW()`,
        [hid, r, tillOfHold, payload.label || null, JSON.stringify(payload), holdBranch],
      );
      serverId = hid;
      clientId = hid;
      result = { upserted: true };
    } else if (entity === 'held' && op === 'delete') {
      const hid = String(payload.id || '');
      const { rows: heldRow } = await pool.query('SELECT till_id, branch_id FROM held_orders WHERE id = $1 AND restaurant_id = $2', [hid, r]);
      if (heldRow[0] && (heldRow[0].branch_id || null) !== (await holdBranchOf(r, tillId(req) || payload.till_id || null, req))) {
        throw badRequest('This held order belongs to another branch');
      }
      if (heldRow[0] && tillId(req) && heldRow[0].till_id && heldRow[0].till_id !== tillId(req)) {
        throw badRequest('This held order belongs to another till');
      }
      await pool.query(`DELETE FROM held_orders WHERE id = $1 AND restaurant_id = $2`, [hid, r]);
      serverId = hid;
      result = { deleted: true };
    } else if (entity === 'till' && op === 'count') {
      const kind = payload.kind;
      if (kind === 'x') {
        // The key must match what the reader uses (`lastX`). A failure is not swallowed, so the item is not acked (ORD-H11).
        await pool.query(
          `INSERT INTO report_counters (restaurant_id, data, updated_at)
           VALUES ($1, jsonb_build_object('lastX', $2::jsonb), NOW())
           ON CONFLICT (restaurant_id) DO UPDATE
           SET data = COALESCE(report_counters.data,'{}'::jsonb) || jsonb_build_object('lastX', $2::jsonb), updated_at = NOW()`,
          [r, JSON.stringify(payload)],
        );
      } else if (kind === 'z') {
        const zid = payload.id || key;
        await pool.query(
          `INSERT INTO z_reports (id, restaurant_id, data, created_at)
           VALUES ($1,$2,$3::jsonb,NOW())
           ON CONFLICT (id) DO NOTHING`,
          [zid, r, JSON.stringify(payload)],
        ).catch(() => {});
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

    // Only work that was really done is acked and remembered. A deferred item is not done, and an ignored item was
    // never understood, so neither is recorded as a success. They are reported with their own status (ORD-H12).
    if (result.deferred) return { key, status: 'deferred', server_id: serverId, client_id: clientId, result };
    if (result.ignored) return { key, status: 'rejected', server_id: serverId, client_id: clientId, result };

    await pool.query(
      `INSERT INTO sync_idempotency (restaurant_id, idempotency_key, entity, op, server_id, client_id, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [r, key, entity, op, serverId, clientId ? String(clientId) : null, JSON.stringify(result)],
    );

    return { key, status: 'acked', server_id: serverId, client_id: clientId, result };
  } catch (err) {
    // A line the catalogue does not recognise is refused for good, so the till does not retry it forever (ORD-H2).
    if (err && (err.rejected || err instanceof RejectedLine)) return { key, status: 'rejected', error: err.message, client_id: clientId };
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

/** The branch of a held order: the till record decides; a till with no record uses the caller's own branch. */
async function holdBranchOf(restaurant, till, req) {
  if (till) {
    const { rows } = await pool.query('SELECT branch_id FROM epos_tills WHERE id = $1 AND restaurant_id = $2', [String(till), restaurant]);
    if (rows[0]) return rows[0].branch_id || null;
  }
  return branchId(req) || null;
}

router.get(
  '/pull',
  asyncHandler(async (req, res) => {
    await ensureSyncTables();
    const r = rid(req);
    if (!r) throw badRequest('restaurant_id required');
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);

    // A branch-bound till pulls its own branch's menu only (Option A). Owners pull every branch's rows, as before.
    const menuBranch = branchId(req) || null;
    // A branch till also gets the restaurant products and categories assigned to it, with the branch's price, image
    // and active state. Owner tills keep the plain query.
    const [cats, products, addons, tables, staff, held, orders] = await Promise.all([
      pool.query(
        menuBranch
          ? `SELECT c.id, c.restaurant_id, c.num, c.name, c.image, c.colour, c.text_colour, c.priority,
                    (c.status AND COALESCE(a.active, TRUE)) AS status, c.data, c.created_at, c.updated_at, c.branch_id
               FROM categories c LEFT JOIN category_branch_assignments a ON a.category_id = c.id AND a.branch_id = $3
              WHERE c.restaurant_id = $1 AND COALESCE(GREATEST(c.updated_at, a.updated_at), c.created_at) > $2
                AND (c.branch_id = $3 OR (c.branch_id IS NULL AND a.category_id IS NOT NULL))
              ORDER BY c.priority NULLS LAST, c.name`
          : `SELECT * FROM categories WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2
           AND branch_id IS NOT DISTINCT FROM $3::text ORDER BY priority NULLS LAST, name`,
        [r, since, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        menuBranch
          ? `SELECT p.id, p.restaurant_id, p.live_id, p.name, p.description, p.category_id, p.sub_category_id,
                    COALESCE(a.price, p.price) AS price, p.from_price,
                    CASE WHEN a.image IS NOT NULL THEN jsonb_set(COALESCE(p.data, '{}'::jsonb), '{image}', to_jsonb(a.image)) ELSE p.data END AS data,
                    (p.status AND COALESCE(a.active, TRUE)) AS status, p.visible, p.created_at, p.updated_at, p.branch_id
               FROM products p LEFT JOIN product_branch_assignments a ON a.product_id = p.id AND a.branch_id = $3
              WHERE p.restaurant_id = $1 AND COALESCE(GREATEST(p.updated_at, a.updated_at), p.created_at) > $2
                AND (p.branch_id = $3 OR (p.branch_id IS NULL AND a.product_id IS NOT NULL))
              ORDER BY p.name`
          : `SELECT * FROM products WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2
           AND branch_id IS NOT DISTINCT FROM $3::text ORDER BY name`,
        [r, since, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM addons WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2
           AND branch_id IS NOT DISTINCT FROM $3::text`,
        [r, since, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM dining_tables WHERE restaurant_id = $1 AND branch_id IS NOT DISTINCT FROM $2::text`,
        [r, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, name, role, status, till_id, branch_id FROM till_staff WHERE restaurant_id = $1 AND COALESCE(status,TRUE) = TRUE AND branch_id IS NOT DISTINCT FROM $2::text`,
        [r, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT * FROM held_orders WHERE restaurant_id = $1 AND COALESCE(updated_at, created_at) > $2
           AND branch_id IS NOT DISTINCT FROM $3::text`,
        [r, since, menuBranch],
      ).catch(() => ({ rows: [] })),
      pool.query(
        // A branch-bound till pulls its own branch only (ORD-H13). Oldest first, one page of 200 plus a probe row (ORD-H14).
        `SELECT * FROM orders WHERE restaurant_id = $1 AND updated_at > $2 AND ($3::text IS NULL OR branch_id = $3) ORDER BY updated_at ASC, id ASC LIMIT 201`,
        [r, since, branchId(req) || null],
      ).catch(() => ({ rows: [] })),
    ]);

    // More orders than one page: the cursor is the last order returned, so the next pull continues from there.
    // A client that only reads `cursor` keeps working unchanged (ORD-H14).
    const hasMore = orders.rows.length > 200;
    const pageOrders = hasMore ? orders.rows.slice(0, 200) : orders.rows;
    const cursor = hasMore
      ? new Date(pageOrders[pageOrders.length - 1].updated_at).toISOString()
      : new Date().toISOString();
    ok(res, {
      cursor,
      has_more: hasMore,
      catalog: {
        categories: cats.rows,
        products: products.rows,
        addons: addons.rows,
      },
      tables: tables.rows,
      staff: staff.rows,
      held_orders: held.rows,
      orders: pageOrders,
    });
  }),
);

module.exports = router;
