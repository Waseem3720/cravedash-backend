/**
 * Domain APIs for inventory / payroll / accounting.
 * Documents live in domain_docs (not restaurant_blobs). Legacy blobs are copied in on first read; a read never deletes them.
 *
 * Concurrency (SEC-M11): a document PUT may send If-Match with the version from the ETag header. A stale version is
 * refused with 409. Without If-Match the write is unconditional, as before, so existing clients keep working.
 * Ledger rows created from legacy arrays get ids derived from their content, so a repeated first read cannot duplicate them.
 */
const crypto = require('crypto');
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, AppError } = require('@cravedash/shared/src/errors');
const { branchServiceGate } = require('@cravedash/shared/src/branchServiceGuard');

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
    'epos_customers', 'till_counts', 'held_orders', 'till_staff', 'epos_tills',
    'staff_activity', 'notifications_feed', 'call_log', 'reports',
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
  epos_devices: 'object',
  reports: 'object',
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

/**
 * Courier jobs belong to the branch that dispatched them (NULL = restaurant-level). Reads are scoped the same way, and a
 * write takes the caller's branch, whatever the body says.
 */
function courierScope(collection, req, rows) {
  if (collection !== 'courier_jobs' || req.user?.role === 'super') return rows;
  const bound = branchId(req);
  if (bound) return rows.filter((r) => String(r.branch_id || '') === String(bound));
  return rows.filter((r) => r.branch_id === null || r.branch_id === undefined);
}

function ledgerScopeStamp(collection, req) {
  return collection === 'courier_jobs' ? { branch_id: branchId(req) || null } : {};
}

/** Accounting journal and ledger rows are written only by the accounting engine, never through a domain event. */
const SERVER_WRITTEN_LEDGERS = new Set(['acc_journals', 'acc_ledger']);

function assertNotServerWritten(collection) {
  if (SERVER_WRITTEN_LEDGERS.has(collection)) {
    throw forbidden(`Collection "${collection}" is written only by the accounting engine`);
  }
}

/** Flat map: collection → domain (for /domain/:collection shortcuts). */
const COLLECTION_DOMAIN = {};
Object.entries(DOMAINS).forEach(([domain, set]) => {
  set.forEach((c) => { COLLECTION_DOMAIN[c] = domain; });
});

/**
 * Branch service guard for domain data. A domain maps to the page services that cover it; a collection can name its
 * own service. Collections not listed here (fail open, like other unmapped routes) stay open to a branch login.
 */
const DOMAIN_SERVICE_KEYS = {
  inventory: ['inventory', 'purchase'],
  payroll: ['payroll'],
  accounting: ['accounting'],
  commerce: ['wallet-report', 'wallet-add', 'wallet-bonus', 'loyalty-report'],
};

const COLLECTION_SERVICE_KEYS = {
  till_staff: ['till-staff'],
  epos_customers: ['customers'],
  notifications_feed: ['notification'],
  tips_config: ['tips'],
  tips_runs: ['tips'],
  reservation_settings: ['book-table'],
  delivery_zones: ['dm-list'],
  delivery_areas: ['dm-list'],
  courier_jobs: ['dm-list'],
  employee_roles: ['role-setup'],
  approval_rules: ['approvals'],
  epos_devices: ['epos-devices'],
  epos_tills: ['epos-devices'],
  card_terminals: ['epos-devices'],
  pos_devices: ['epos-devices'],
  print_settings: ['printers'],
  print_rules: ['printers'],
  print_routes: ['printers'],
};

/** Service keys for a /domain or domain alias request, read from the path (a list call gives the domain's keys). */
function domainServiceKeys(req) {
  const parts = String(req.originalUrl || req.url || '').split('?')[0].toLowerCase().split('/').filter(Boolean);
  let domain;
  let collection;
  const at = parts.indexOf('domain');
  if (at >= 0) {
    domain = parts[at + 1];
    collection = parts[at + 2];
  } else {
    const alias = Object.keys(DOMAIN_SERVICE_KEYS).find((d) => parts.includes(d)) || (parts.includes('ops') ? 'ops' : null);
    if (!alias) return null;
    domain = alias;
    collection = parts[parts.indexOf(alias) + 1];
  }
  if (collection && COLLECTION_SERVICE_KEYS[collection]) return COLLECTION_SERVICE_KEYS[collection];
  return DOMAIN_SERVICE_KEYS[domain] || null;
}

router.use(branchServiceGate(domainServiceKeys));

// Tables, constraints and the version column come from scripts/init-db.sql (SEC-M10: no DDL in request handling).

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

/** If-Match carries the document version from the ETag. Absent means an unconditional write (older clients). */
function ifMatchVersion(req) {
  const raw = req.get('If-Match');
  if (raw === undefined) return undefined;
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(String(raw).trim());
  if (!m) throw badRequest('If-Match must be the document version from the ETag header');
  return Number(m[1]);
}

function versionConflict() {
  return new AppError('The document changed since it was read. Reload it and save again.', 409, 'CONFLICT');
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

/**
 * SEC-M11: a row without an id gets an id derived from its position and content. The same legacy array always maps to
 * the same ids, so running the copy twice (or from two requests at once) cannot create duplicate ledger rows.
 */
function legacyRowId(collection, row, index) {
  if (row && row.id) return String(row.id);
  const digest = crypto.createHash('sha256').update(`${index}:${JSON.stringify(row ?? null)}`).digest('hex');
  return `${collection}_${digest.slice(0, 24)}`;
}

async function migrateArrayToRows(restaurantIdVal, domain, collection, arr) {
  if (!Array.isArray(arr) || !arr.length) return;
  for (let i = 0; i < arr.length; i += 1) {
    const row = arr[i];
    const id = legacyRowId(collection, row, i);
    const data = row && typeof row === 'object' ? row : { value: row };
    await pool.query(
      `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
       ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING`,
      [restaurantIdVal, domain, collection, id, JSON.stringify(data)],
    );
  }
}

/** Legacy data for a collection: the domain document if one exists, else the old restaurant_blobs row. Never deletes. */
async function legacyData(restaurantIdVal, domain, collection, { checkDoc }) {
  if (checkDoc) {
    const { rows: doc } = await pool.query(
      'SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = $2 AND collection = $3',
      [restaurantIdVal, domain, collection],
    );
    if (doc[0]) return doc[0].data;
  }
  const { rows: blob } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantIdVal, collection],
  );
  return blob[0] ? blob[0].data : null;
}

/** Returns { data, version }. version is 0 for a collection never written as a document (ETag "0"). */
async function readDoc(restaurantIdVal, domain, collection) {
  if (APPEND_ONLY.has(collection)) {
    let events = await listLedgerEvents(restaurantIdVal, domain, collection);
    if (events.length) return { data: events, version: null };
    const legacy = await legacyData(restaurantIdVal, domain, collection, { checkDoc: true });
    if (Array.isArray(legacy) && legacy.length) {
      await migrateArrayToRows(restaurantIdVal, domain, collection, legacy);
      events = await listLedgerEvents(restaurantIdVal, domain, collection);
    }
    return { data: events, version: null };
  }

  const { rows } = await pool.query(
    'SELECT data, version FROM domain_docs WHERE restaurant_id = $1 AND domain = $2 AND collection = $3',
    [restaurantIdVal, domain, collection],
  );
  if (rows[0]) return { data: rows[0].data, version: Number(rows[0].version) };

  // One-time copy from the legacy blob. The blob is kept here; it is removed when the document is first written.
  const legacy = await legacyData(restaurantIdVal, domain, collection, { checkDoc: false });
  const data = legacy == null ? [] : legacy;
  if (legacy != null) {
    await pool.query(
      `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at, version)
       VALUES ($1,$2,$3,$4::jsonb,NOW(),0)
       ON CONFLICT (restaurant_id, domain, collection) DO NOTHING`,
      [restaurantIdVal, domain, collection, JSON.stringify(data)],
    );
  }
  return { data, version: 0 };
}

/**
 * Saves a whole document. expectedVersion undefined: unconditional (legacy clients). 0: create or overwrite a document
 * that is still at version 0. n > 0: only if the stored version is still n. Any other state is refused with 409.
 */
async function writeDoc(restaurantIdVal, domain, collection, data, expectedVersion) {
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

  let result;
  if (expectedVersion === undefined) {
    ({ rows: [result] } = await pool.query(
      `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at, version)
       VALUES ($1,$2,$3,$4::jsonb,NOW(),1)
       ON CONFLICT (restaurant_id, domain, collection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), version = domain_docs.version + 1
       RETURNING data, version`,
      [restaurantIdVal, domain, collection, raw],
    ));
  } else if (expectedVersion === 0) {
    ({ rows: [result] } = await pool.query(
      `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at, version)
       VALUES ($1,$2,$3,$4::jsonb,NOW(),1)
       ON CONFLICT (restaurant_id, domain, collection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), version = domain_docs.version + 1
       WHERE domain_docs.version = 0
       RETURNING data, version`,
      [restaurantIdVal, domain, collection, raw],
    ));
  } else {
    ({ rows: [result] } = await pool.query(
      `UPDATE domain_docs SET data = $4::jsonb, updated_at = NOW(), version = version + 1
       WHERE restaurant_id = $1 AND domain = $2 AND collection = $3 AND version = $5
       RETURNING data, version`,
      [restaurantIdVal, domain, collection, raw, expectedVersion],
    ));
  }
  if (!result) throw versionConflict();

  // The document now holds the data, so the legacy blob for this key is removed. A failure here fails the write.
  await pool.query(
    'DELETE FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantIdVal, collection],
  );
  return { data: result.data, version: Number(result.version) };
}

/**
 * Ops documents that belong to each branch (its printers, EPOS and POS devices, card terminals, print settings, delivery
 * zones and areas, EPOS settings). A branch login reads and writes its own copy, stored in branch_settings. The owner's
 * copy is the restaurant document. The other ops documents are restaurant-wide: a branch reads them and cannot change them.
 */
const BRANCH_OWNED_DOCS = new Set([
  'printers', 'epos_devices', 'pos_devices', 'card_terminals', 'print_settings', 'print_rules', 'print_routes',
  'delivery_zones', 'delivery_areas', 'epos_settings', 'employee_roles',
]);

/**
 * Operational documents that a till (EPOS session) writes while it trades. A till writes them into its branch's own copy,
 * so they are shared by the till and its branch admin, and never by another branch. Configuration stays owner-only.
 */
const TILL_OPERATIONAL_DOCS = new Set([
  'till_counts', 'held_orders', 'staff_activity', 'notifications_feed', 'call_log', 'epos_customers', 'till_staff',
]);

/** Till operational docs that a branch admin may also save into its own branch copy. Every other till doc stays till-only. */
const BRANCH_ADMIN_WRITABLE_DOCS = new Set(['epos_customers']);

/** True for an EPOS till session (a till login, not an admin login). */
function isTillSession(req) {
  return req.user?.role === 'epos' || !!req.user?.till_id;
}

/** Documents kept in a branch's own copy for this caller: the branch-owned set, plus the till operational set for tills. */
function branchCopyDoc(collection, till) {
  return BRANCH_OWNED_DOCS.has(collection) || (till && TILL_OPERATIONAL_DOCS.has(collection));
}

function branchDocKey(domain, collection) {
  return `dom:${domain}:${collection}`;
}

/** Reads a document for the caller's scope. A branch with no copy of a branch-owned document starts empty. */
async function readScopedDoc(restaurantIdVal, domain, collection, branch) {
  // A branch (admin or till) reads its own copy of a branch-kept document. The till operational set is kept for both.
  if (!branch || !(BRANCH_OWNED_DOCS.has(collection) || TILL_OPERATIONAL_DOCS.has(collection))) {
    return readDoc(restaurantIdVal, domain, collection);
  }
  const { rows } = await pool.query(
    'SELECT data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key = $3',
    [restaurantIdVal, branch, branchDocKey(domain, collection)],
  );
  if (rows[0]) return { data: rows[0].data, version: 0 };
  return { data: [], version: 0 }; // same empty value as the restaurant document
}

/** Writes a document for the caller's scope. A branch may write only the branch-owned documents. */
async function writeScopedDoc(restaurantIdVal, domain, collection, data, expectedVersion, branch, till = false) {
  if (!branch) return writeDoc(restaurantIdVal, domain, collection, data, expectedVersion);
  if (!branchCopyDoc(collection, till) && !BRANCH_ADMIN_WRITABLE_DOCS.has(collection)) {
    throw forbidden(`"${collection}" is restaurant-wide and can only be changed by the owner`);
  }
  const kind = COLLECTION_SCHEMA[collection] || 'array';
  const normalized = data == null ? (kind === 'object' ? {} : []) : data;
  assertPayloadSchema(collection, normalized);
  let raw;
  try {
    raw = JSON.stringify(normalized);
  } catch {
    throw badRequest('Payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw badRequest('Domain document exceeds 1 MiB limit');
  await pool.query(
    `INSERT INTO branch_settings (restaurant_id, branch_id, key, data, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (restaurant_id, branch_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [restaurantIdVal, branch, branchDocKey(domain, collection), raw],
  );
  return { data: normalized, version: 0 };
}

function sendDoc(res, doc, append) {
  if (!append) res.set('ETag', `"${doc.version}"`);
  return ok(res, doc.data);
}

router.get('/domain/:domain/:collection', asyncHandler(async (req, res) => {
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  assertCanRead(req, domain);
  const doc = await readScopedDoc(rid(req), domain, collection, branchId(req) || null);
  if (Array.isArray(doc.data)) doc.data = courierScope(collection, req, doc.data);
  sendDoc(res, doc, APPEND_ONLY.has(collection));
}));

router.put('/domain/:domain/:collection', asyncHandler(async (req, res) => {
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  assertCanWrite(req, domain);
  if (APPEND_ONLY.has(collection)) {
    throw forbidden(`Collection "${collection}" is append-only — POST /domain/${domain}/${collection}/events`);
  }
  const expected = ifMatchVersion(req);
  sendDoc(res, await writeScopedDoc(rid(req), domain, collection, req.body, expected, branchId(req) || null, isTillSession(req)), false);
}));

/** Phase B.3: append ledger event (immutable row). */
router.post('/domain/:domain/:collection/events', asyncHandler(async (req, res) => {
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  if (!APPEND_ONLY.has(collection)) {
    throw badRequest(`Collection "${collection}" is not an append-only ledger`);
  }
  assertNotServerWritten(collection);
  assertCanWrite(req, domain);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw badRequest('Event payload must be a JSON object');
  const id = String(body.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const payload = Object.assign({}, body, { id }, ledgerScopeStamp(collection, req));
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
  const { domain, collection } = assertDomainCollection(req.params.domain, req.params.collection);
  if (!APPEND_ONLY.has(collection)) {
    throw badRequest(`Collection "${collection}" is not an append-only ledger`);
  }
  assertCanRead(req, domain);
  ok(res, courierScope(collection, req, await listLedgerEvents(rid(req), domain, collection)));
}));

/** Shortcut: /inventory/ingredients → domain inventory */
function mountDomainAlias(pathPrefix, domain) {
  router.get(`${pathPrefix}/:collection`, asyncHandler(async (req, res) => {
    const { collection } = assertDomainCollection(domain, req.params.collection);
    assertCanRead(req, domain);
    const aliasDoc = await readScopedDoc(rid(req), domain, collection, branchId(req) || null);
    if (Array.isArray(aliasDoc.data)) aliasDoc.data = courierScope(collection, req, aliasDoc.data);
    sendDoc(res, aliasDoc, APPEND_ONLY.has(collection));
  }));
  router.put(`${pathPrefix}/:collection`, asyncHandler(async (req, res) => {
    const { collection } = assertDomainCollection(domain, req.params.collection);
    assertCanWrite(req, domain);
    if (APPEND_ONLY.has(collection)) {
      throw forbidden(`Collection "${collection}" is append-only — POST /domain/${domain}/${collection}/events`);
    }
    const expected = ifMatchVersion(req);
    sendDoc(res, await writeScopedDoc(rid(req), domain, collection, req.body, expected, branchId(req) || null, isTillSession(req)), false);
  }));
  router.post(`${pathPrefix}/:collection/events`, asyncHandler(async (req, res) => {
    const { collection } = assertDomainCollection(domain, req.params.collection);
    if (!APPEND_ONLY.has(collection)) {
      throw badRequest(`Collection "${collection}" is not an append-only ledger`);
    }
    assertNotServerWritten(collection);
    assertCanWrite(req, domain);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) throw badRequest('Event payload must be a JSON object');
    const id = String(body.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    const payload = Object.assign({}, body, { id }, ledgerScopeStamp(collection, req));
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
module.exports.legacyRowId = legacyRowId;
