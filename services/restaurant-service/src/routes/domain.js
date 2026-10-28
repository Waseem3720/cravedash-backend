/**
 * Domain APIs for inventory / payroll / accounting.
 * Documents live in domain_docs (not restaurant_blobs). First GET migrates leftover blobs.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden } = require('@cravedash/shared/src/errors');

const router = express.Router();

const DOMAINS = {
  inventory: new Set([
    'ingredients', 'wastage', 'recipes', 'stock_moves', 'suppliers',
    'purchase_po', 'purchase_grn', 'purchase_payments', 'purchase_reports',
  ]),
  payroll: new Set([
    'payroll_staff', 'payroll_shifts', 'payroll_roster', 'payroll_attendance',
    'payroll_runs', 'payroll_reports',
  ]),
  accounting: new Set([
    'coa', 'acc_mapping', 'acc_journals', 'acc_manual', 'acc_ledger', 'acc_expenses',
    'acc_drawer', 'acc_ar', 'acc_ap', 'acc_tb', 'acc_pl', 'acc_bs',
  ]),
  // Phase B.2: ops/config formerly in restaurant_blobs
  ops: new Set([
    'branches', 'delivery_zones', 'delivery_areas', 'reservation_settings',
    'approval_rules', 'epos_settings', 'menuPresentation', 'tips_config',
    'employee_roles', 'time_slots', 'print_settings', 'print_rules', 'print_routes',
    'card_terminals', 'epos_devices', 'pos_devices', 'printers',
    'epos_customers', 'till_counts',
    'courier_jobs', 'marketplace_inbox', 'tips_runs', 'offline_queue',
  ]),
  commerce: new Set([
    'wallet_txns', 'loyalty_txns', 'wallet_bonus',
  ]),
};

/** Payload shape per collection — fail closed on wrong JSON type. */
const COLLECTION_SCHEMA = {
  // objects (singleton docs)
  epos_settings: 'object',
  menuPresentation: 'object',
  tips_config: 'object',
  reservation_settings: 'object',
  approval_rules: 'object',
  print_settings: 'object',
  print_rules: 'object',
  print_routes: 'object',
  acc_mapping: 'object',
  wallet_bonus: 'object',
  // everything else in DOMAINS defaults to array
};

/** Phase B.3: append-only ledgers stored as domain_rows (not replaceable JSON docs). */
const APPEND_ONLY = new Set([
  'stock_moves', 'wastage', 'purchase_payments',
  'acc_journals', 'acc_ledger', 'acc_manual', 'acc_expenses',
  'payroll_runs', 'payroll_attendance',
  'wallet_txns', 'loyalty_txns',
  'courier_jobs', 'tips_runs',
]);

/** Flat map: collection → domain (for /domain/:collection shortcuts). */
const COLLECTION_DOMAIN = {};
Object.entries(DOMAINS).forEach(([domain, set]) => {
  set.forEach((c) => { COLLECTION_DOMAIN[c] = domain; });
});

/**
 * Canonical schema provisioning handled by Migration 009 (CD-CON-058).
 * Retained as no-op to preserve function signature for callers.
 */
async function ensureTables() {
  return;
}

function rid(req) {
  return restaurantId(req);
}

function assertDomainCollection(domain, collection) {
  const d = String(domain || '');
  const c = String(collection || '');
  if (!DOMAINS[d]) throw badRequest('Invalid domain');
  if (!DOMAINS[d].has(c)) throw badRequest(`Unknown ${d} collection: ${c}`);
  return { domain: d, collection: c };
}

function reqRoleIsEposSensitive(domain) {
  return domain === 'payroll' || domain === 'accounting';
}

function assertCanRead(req, domain) {
  if (req.user?.role === 'epos' || req.user?.till_id) {
    if (reqRoleIsEposSensitive(domain)) {
      throw forbidden('EPOS cannot read payroll/accounting data');
    }
  }
}

function assertCanWrite(req, domain) {
  if (req.user?.role === 'epos' || req.user?.till_id) {
    if (reqRoleIsEposSensitive(domain) || domain === 'inventory') {
      throw forbidden('EPOS cannot write domain ledgers — use restaurant admin');
    }
  }
}

function assertPayloadSchema(collection, data) {
  const kind = COLLECTION_SCHEMA[collection] || 'array';
  if (kind === 'array') {
    if (!Array.isArray(data)) throw badRequest(`Collection "${collection}" expects a JSON array`);
    return;
  }
  if (kind === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw badRequest(`Collection "${collection}" expects a JSON object`);
    }
  }
}

async function listLedgerEvents(restaurantIdVal, domain, collection) {
  const { rows } = await pool.query(
    `SELECT id, data, updated_at FROM domain_rows
     WHERE restaurant_id = $1 AND domain = $2 AND collection = $3
     ORDER BY updated_at ASC, id ASC`,
    [restaurantIdVal, domain, collection],
  );
  return rows.map((r) => Object.assign({}, r.data && typeof r.data === 'object' ? r.data : {}, {
    id: r.id,
    _at: r.updated_at,
  }));
}

async function migrateArrayToRows(restaurantIdVal, domain, collection, arr) {
  if (!Array.isArray(arr) || !arr.length) return;
  for (let i = 0; i < arr.length; i += 1) {
    const row = arr[i];
    const id = (row && row.id) ? String(row.id) : `${collection}_${i}_${Date.now().toString(36)}`;
    const data = row && typeof row === 'object' ? row : { value: row };
    await pool.query(
      `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
       ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING`,
      [restaurantIdVal, domain, collection, id, JSON.stringify(data)],
    );
  }
}

async function readDoc(restaurantIdVal, domain, collection) {
  if (APPEND_ONLY.has(collection)) {
    let events = await listLedgerEvents(restaurantIdVal, domain, collection);
    if (events.length) return events;
    // One-time: pull legacy doc/blob array into rows
    const { rows: doc } = await pool.query(
      `SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = $2 AND collection = $3`,
      [restaurantIdVal, domain, collection],
    );
    let legacy = doc[0] ? doc[0].data : null;
    if (legacy == null) {
      const { rows: blob } = await pool.query(
        `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2`,
        [restaurantIdVal, collection],
      );
      legacy = blob[0] ? blob[0].data : [];
      if (blob[0]) {
        await pool.query(
          `DELETE FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2`,
          [restaurantIdVal, collection],
        ).catch(() => {});
      }
    }
    if (Array.isArray(legacy) && legacy.length) {
      await migrateArrayToRows(restaurantIdVal, domain, collection, legacy);
      events = await listLedgerEvents(restaurantIdVal, domain, collection);
    }
    return events;
  }

  const { rows } = await pool.query(
    `SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = $2 AND collection = $3`,
    [restaurantIdVal, domain, collection],
  );
  if (rows[0]) return rows[0].data;

  // One-time migrate from legacy blob
  const { rows: blob } = await pool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2`,
    [restaurantIdVal, collection],
  );
  const data = blob[0] ? blob[0].data : [];
  await pool.query(
    `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection) DO NOTHING`,
    [restaurantIdVal, domain, collection, JSON.stringify(data == null ? [] : data)],
  );
  if (blob[0]) {
    await pool.query(
      `DELETE FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2`,
      [restaurantIdVal, collection],
    ).catch(() => {});
  }
  return data == null ? [] : data;
}

async function writeDoc(restaurantIdVal, domain, collection, data) {
  const kind = COLLECTION_SCHEMA[collection] || 'array';
  const normalized = data == null ? (kind === 'object' ? {} : []) : data;
  assertPayloadSchema(collection, normalized);
  let raw;
  try {
    raw = JSON.stringify(normalized);
  } catch {
    throw badRequest('Payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
    throw badRequest('Domain document exceeds 1 MiB limit');
  }
  const { rows } = await pool.query(
    `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [restaurantIdVal, domain, collection, raw],
  );
  // Keep blobs out of sync — delete legacy key if present
  await pool.query(
    `DELETE FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2`,
    [restaurantIdVal, collection],
  ).catch(() => {});
  return rows[0].data;
}

router.get('/domain/:domain/:collection', asyncHandler(async (req, res) => {
  await ensureTables();
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  assertCanRead(req, domain);
  ok(res, await readDoc(rid(req), domain, collection));
}));

router.put('/domain/:domain/:collection', asyncHandler(async (req, res) => {
  await ensureTables();
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  assertCanWrite(req, domain);
  if (APPEND_ONLY.has(collection)) {
    throw forbidden(`Collection "${collection}" is append-only — POST /domain/${domain}/${collection}/events`);
  }
  ok(res, await writeDoc(rid(req), domain, collection, req.body));
}));

/** Phase B.3: append ledger event (immutable row). */
router.post('/domain/:domain/:collection/events', asyncHandler(async (req, res) => {
  await ensureTables();
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  if (!APPEND_ONLY.has(collection)) {
    throw badRequest(`Collection "${collection}" is not an append-only ledger`);
  }
  assertCanWrite(req, domain);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw badRequest('Event payload must be a JSON object');
  const id = String(body.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const payload = Object.assign({}, body, { id });
  const { rows } = await pool.query(
    `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING
     RETURNING id, data, updated_at`,
    [rid(req), domain, collection, id, JSON.stringify(payload)],
  );
  if (!rows[0]) throw badRequest('Event id already exists (append-only — no overwrite)');
  ok(res, Object.assign({}, rows[0].data, { id: rows[0].id, _at: rows[0].updated_at }));
}));

router.get('/domain/:domain/:collection/events', asyncHandler(async (req, res) => {
  await ensureTables();
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  if (!APPEND_ONLY.has(collection)) {
    throw badRequest(`Collection "${collection}" is not an append-only ledger`);
  }
  assertCanRead(req, domain);
  ok(res, await listLedgerEvents(rid(req), domain, collection));
}));

/** Shortcut: /inventory/ingredients → domain inventory */
function mountDomainAlias(pathPrefix, domain) {
  router.get(`${pathPrefix}/:collection`, asyncHandler(async (req, res) => {
    await ensureTables();
    const { collection } = assertDomainCollection(domain, req.params.collection);
    assertCanRead(req, domain);
    ok(res, await readDoc(rid(req), domain, collection));
  }));
  router.put(`${pathPrefix}/:collection`, asyncHandler(async (req, res) => {
    await ensureTables();
    const { collection } = assertDomainCollection(domain, req.params.collection);
    assertCanWrite(req, domain);
    if (APPEND_ONLY.has(collection)) {
      throw forbidden(`Collection "${collection}" is append-only — POST /domain/${domain}/${collection}/events`);
    }
    ok(res, await writeDoc(rid(req), domain, collection, req.body));
  }));
  router.post(`${pathPrefix}/:collection/events`, asyncHandler(async (req, res) => {
    await ensureTables();
    const { collection } = assertDomainCollection(domain, req.params.collection);
    if (!APPEND_ONLY.has(collection)) {
      throw badRequest(`Collection "${collection}" is not an append-only ledger`);
    }
    assertCanWrite(req, domain);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) throw badRequest('Event payload must be a JSON object');
    const id = String(body.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    const payload = Object.assign({}, body, { id });
    const { rows } = await pool.query(
      `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
       ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING
       RETURNING id, data, updated_at`,
      [rid(req), domain, collection, id, JSON.stringify(payload)],
    );
    if (!rows[0]) throw badRequest('Event id already exists (append-only — no overwrite)');
    ok(res, Object.assign({}, rows[0].data, { id: rows[0].id, _at: rows[0].updated_at }));
  }));
}

mountDomainAlias('/inventory', 'inventory');
mountDomainAlias('/payroll', 'payroll');
mountDomainAlias('/accounting', 'accounting');
mountDomainAlias('/ops', 'ops');
mountDomainAlias('/commerce', 'commerce');

/** List which collections exist for a domain (including empty defaults). */
router.get('/domain/:domain', asyncHandler(async (req, res) => {
  await ensureTables();
  const domain = String(req.params.domain || '');
  if (!DOMAINS[domain]) throw badRequest('Invalid domain');
  assertCanRead(req, domain);
  const r = rid(req);
  const { rows } = await pool.query(
    `SELECT collection, updated_at FROM domain_docs WHERE restaurant_id = $1 AND domain = $2`,
    [r, domain],
  );
  const present = {};
  rows.forEach((row) => { present[row.collection] = row.updated_at; });
  ok(res, {
    domain,
    collections: [...DOMAINS[domain]],
    stored: present,
  });
}));

router.get('/domain-meta/collections', asyncHandler(async (req, res) => {
  ok(res, {
    inventory: [...DOMAINS.inventory],
    payroll: [...DOMAINS.payroll],
    accounting: [...DOMAINS.accounting],
    ops: [...DOMAINS.ops],
    commerce: [...DOMAINS.commerce],
    schema: COLLECTION_SCHEMA,
    append_only: [...APPEND_ONLY],
    map: COLLECTION_DOMAIN,
  });
}));

module.exports = router;
module.exports.COLLECTION_DOMAIN = COLLECTION_DOMAIN;
module.exports.DOMAINS = DOMAINS;
module.exports.COLLECTION_SCHEMA = COLLECTION_SCHEMA;
module.exports.APPEND_ONLY = APPEND_ONLY;
