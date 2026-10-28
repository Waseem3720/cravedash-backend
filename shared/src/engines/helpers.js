const pool = require('../db');

/**
 * Canonical schema provisioning handled by Migration 009 (CD-CON-058).
 * Retained as no-op to preserve function signature for callers.
 */
async function ensureDomainTables() {
  return;
}

async function readDoc(restaurantId, domain, collection, fallback = []) {
  await ensureDomainTables();
  const { rows } = await pool.query(
    `SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = $2 AND collection = $3`,
    [restaurantId, domain, collection],
  );
  if (rows[0]) return rows[0].data;
  return fallback;
}

async function writeDoc(restaurantId, domain, collection, data) {
  await ensureDomainTables();
  const { rows } = await pool.query(
    `INSERT INTO domain_docs (restaurant_id, domain, collection, data, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [restaurantId, domain, collection, JSON.stringify(data == null ? [] : data)],
  );
  return rows[0].data;
}

async function appendRow(restaurantId, domain, collection, payload) {
  await ensureDomainTables();
  const id = String(payload.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
  const data = Object.assign({}, payload, { id, created_at: payload.created_at || new Date().toISOString() });
  const { rows } = await pool.query(
    `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING
     RETURNING id, data, updated_at`,
    [restaurantId, domain, collection, id, JSON.stringify(data)],
  );
  if (!rows[0]) {
    const err = new Error('Ledger event id already exists');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return Object.assign({}, rows[0].data, { id: rows[0].id, _at: rows[0].updated_at });
}

async function listRows(restaurantId, domain, collection) {
  await ensureDomainTables();
  const { rows } = await pool.query(
    `SELECT id, data, updated_at FROM domain_rows
     WHERE restaurant_id = $1 AND domain = $2 AND collection = $3
     ORDER BY updated_at ASC, id ASC`,
    [restaurantId, domain, collection],
  );
  return rows.map((r) => Object.assign({}, r.data && typeof r.data === 'object' ? r.data : {}, {
    id: r.id,
    _at: r.updated_at,
  }));
}

function round4(n) {
  return Math.round((+n || 0) * 10000) / 10000;
}

function round2(n) {
  return Math.round((+n || 0) * 100) / 100;
}

module.exports = {
  pool,
  ensureDomainTables,
  readDoc,
  writeDoc,
  appendRow,
  listRows,
  round4,
  round2,
};
