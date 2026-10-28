const { notFound } = require('./errors');

function rowToJson(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of Object.keys(out)) {
    if (out[k] && typeof out[k] === 'object' && out[k].constructor?.name === 'Object') {
      /* keep json from pg */
    }
  }
  return out;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ORDER_CLAUSE_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i;

function assertIdent(name) {
  if (!name || typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

function assertOrderBy(orderBy) {
  if (typeof orderBy !== 'string') {
    throw new Error(`Invalid orderBy clause: ${orderBy}`);
  }
  const str = orderBy.trim();
  if (!str) throw new Error('orderBy clause cannot be empty');

  const parts = str.split(',').map((p) => p.trim());
  if (parts.length === 0) throw new Error('orderBy clause cannot be empty');

  for (const part of parts) {
    if (!ORDER_CLAUSE_REGEX.test(part)) {
      throw new Error(`Invalid orderBy clause: "${part}" in "${orderBy}"`);
    }
  }
  return str;
}

function buildCrud(pool, table, opts = {}) {
  assertIdent(table);
  const idCol = opts.idColumn !== undefined ? assertIdent(opts.idColumn) : 'id';
  const scopeCol = opts.restaurantColumn !== undefined && opts.restaurantColumn !== null
    ? assertIdent(opts.restaurantColumn)
    : null;
  const jsonCols = (opts.jsonColumns || []).map(assertIdent);
  const orderBy = opts.orderBy !== undefined
    ? assertOrderBy(opts.orderBy)
    : assertOrderBy(`${idCol} ASC`);

  let allowedColumns = null;
  if (opts.allowedColumns) {
    const list = Array.isArray(opts.allowedColumns)
      ? opts.allowedColumns
      : Array.from(opts.allowedColumns);
    list.forEach(assertIdent);
    allowedColumns = new Set(list);
  }

  function filterPayload(data) {
    const payload = { ...data };
    if (!allowedColumns) return payload;
    Object.keys(payload).forEach((k) => {
      if (!allowedColumns.has(k) && k !== idCol && k !== scopeCol) delete payload[k];
    });
    return payload;
  }

  function parseRow(row) {
    if (!row) return row;
    const r = rowToJson(row);
    jsonCols.forEach((c) => {
      if (typeof r[c] === 'string') {
        try { r[c] = JSON.parse(r[c]); } catch { /* keep */ }
      }
    });
    if (opts.parseRow) return opts.parseRow(r);
    return r;
  }

  async function list(restaurantId, filters = {}) {
    const where = [];
    const params = [];
    if (scopeCol && restaurantId) {
      params.push(restaurantId);
      where.push(`${scopeCol} = $${params.length}`);
    }
    Object.entries(filters).forEach(([key, val]) => {
      if (val === undefined || val === null || val === '') return;
      if (allowedColumns && !allowedColumns.has(key)) return;
      assertIdent(key);
      params.push(val);
      where.push(`${key} = $${params.length}`);
    });
    const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
    const { rows } = await pool.query(sql, params);
    return rows.map(parseRow);
  }

  async function getById(id, restaurantId) {
    const params = [id];
    let sql = `SELECT * FROM ${table} WHERE ${idCol} = $1`;
    if (scopeCol && restaurantId) {
      params.push(restaurantId);
      sql += ` AND ${scopeCol} = $2`;
    }
    const { rows } = await pool.query(sql, params);
    return parseRow(rows[0]);
  }

  async function create(data, restaurantId) {
    const payload = filterPayload({ ...data });
    if (scopeCol && restaurantId) payload[scopeCol] = restaurantId;
    jsonCols.forEach((c) => {
      if (payload[c] !== undefined && typeof payload[c] !== 'string') {
        payload[c] = JSON.stringify(payload[c]);
      }
    });
    const keys = Object.keys(payload).filter((k) => payload[k] !== undefined).map(assertIdent);
    const vals = keys.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`;
    const { rows } = await pool.query(sql, keys.map((k) => payload[k]));
    return parseRow(rows[0]);
  }

  async function update(id, data, restaurantId) {
    const existing = await getById(id, restaurantId);
    if (!existing) throw notFound();
    const payload = filterPayload({ ...data });
    delete payload[idCol];
    if (scopeCol) delete payload[scopeCol];
    jsonCols.forEach((c) => {
      if (payload[c] !== undefined && typeof payload[c] !== 'string') {
        payload[c] = JSON.stringify(payload[c]);
      }
    });
    const keys = Object.keys(payload).filter((k) => payload[k] !== undefined).map(assertIdent);
    if (!keys.length) return existing;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const params = [id, ...keys.map((k) => payload[k])];
    let sql = `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idCol} = $1`;
    if (scopeCol && restaurantId) {
      params.push(restaurantId);
      sql += ` AND ${scopeCol} = $${params.length}`;
    }
    sql += ' RETURNING *';
    const { rows } = await pool.query(sql, params);
    return parseRow(rows[0]);
  }

  async function remove(id, restaurantId) {
    const params = [id];
    let sql = `DELETE FROM ${table} WHERE ${idCol} = $1`;
    if (scopeCol && restaurantId) {
      params.push(restaurantId);
      sql += ` AND ${scopeCol} = $2`;
    }
    sql += ' RETURNING *';
    const { rows } = await pool.query(sql, params);
    if (!rows[0]) throw notFound();
    return parseRow(rows[0]);
  }

  return { list, getById, create, update, remove, parseRow };
}

module.exports = { buildCrud, rowToJson, assertIdent, assertOrderBy };
