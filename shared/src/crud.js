const { notFound, forbidden, badRequest, AppError } = require('./errors');

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

function assertIdentName(name) {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return name;
}

/**
 * SEC-M14: a tenant-scoped table (restaurantColumn configured) is never read or written without the tenant id.
 * The tenant id comes only from the session (the caller passes it), so a missing id is refused, not treated as "all rows".
 */
function requireScope(scopeCol, restaurantId) {
  if (scopeCol && (restaurantId === undefined || restaurantId === null || restaurantId === '')) {
    throw forbidden('Restaurant scope required');
  }
}

function dependantsError(counts) {
  const parts = Object.entries(counts).map(([label, n]) => `${label}: ${n}`).join(', ');
  const err = new AppError(`Cannot delete: still in use (${parts})`, 409, 'CONFLICT');
  err.details = { dependants: counts };
  return err;
}

/**
 * SEC-M8: refuses a delete while child rows still reference the parent. checks: [{ table, column, label,
 * restaurantColumn }]. restaurantColumn defaults to 'restaurant_id' (the child must belong to restaurantId);
 * null means the child table is global. Pass a pool or a transaction client as `db`.
 */
async function assertNoDependants(db, parentId, checks, restaurantId = null) {
  const counts = {};
  for (const check of checks) {
    const table = assertIdentName(check.table);
    const column = assertIdentName(check.column);
    const params = [String(parentId)];
    let sql = `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`;
    if (check.restaurantColumn !== null) {
      const scope = assertIdentName(check.restaurantColumn || 'restaurant_id');
      requireScope(scope, restaurantId);
      params.push(restaurantId);
      sql += ` AND ${scope} = $2`;
    }
    const { rows } = await db.query(sql, params);
    const n = rows[0]?.n || 0;
    if (n > 0) counts[check.label || table] = n;
  }
  if (Object.keys(counts).length) throw dependantsError(counts);
}

/**
 * SEC-M8: delete one row only when no dependant rows exist. The parent row is locked (FOR UPDATE) and the check and
 * the delete run in one transaction. A child inserted after the check still fails on the foreign key (23503, 409).
 */
async function removeWithDependants(pool, opts) {
  const {
    table, id, dependants = [], idColumn = 'id', restaurantColumn = 'restaurant_id', restaurantId = null,
  } = opts;
  const t = assertIdentName(table);
  const idc = assertIdentName(idColumn);
  const params = [String(id)];
  let where = `${idc} = $1`;
  if (restaurantColumn) {
    requireScope(restaurantColumn, restaurantId);
    params.push(restaurantId);
    where += ` AND ${assertIdentName(restaurantColumn)} = $2`;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: found } = await client.query(`SELECT 1 FROM ${t} WHERE ${where} FOR UPDATE`, params);
    if (!found[0]) throw notFound();
    await assertNoDependants(client, id, dependants, restaurantId);
    const { rows } = await client.query(`DELETE FROM ${t} WHERE ${where} RETURNING *`, params);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * SEC-M7: every foreign-key id in the body must name a row of the caller's own restaurant.
 * refs: { column: 'table' }. A column that is absent, null or '' is not checked (optional link).
 */
async function assertTenantRefs(db, restaurantId, body, refs) {
  requireScope('restaurant_id', restaurantId);
  for (const [column, table] of Object.entries(refs)) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, column)) continue;
    const value = body[column];
    if (value === undefined || value === null || value === '') continue;
    const t = assertIdentName(table);
    const { rows } = await db.query(`SELECT 1 FROM ${t} WHERE id = $1 AND restaurant_id = $2`, [String(value), restaurantId]);
    if (!rows[0]) throw badRequest(`${column} does not refer to a record of this restaurant`);
  }
}

function buildCrud(pool, table, opts = {}) {
  const idCol = opts.idColumn || 'id';
  const scopeCol = opts.restaurantColumn || null;
  const jsonCols = opts.jsonColumns || [];
  const orderBy = opts.orderBy || `${idCol} ASC`;
  const allowedColumns = opts.allowedColumns || null; // Set/array of writable column names

  function assertIdent(name) {
    if (!IDENT.test(name)) throw new Error(`Invalid column: ${name}`);
    return name;
  }

  function filterPayload(data) {
    const payload = { ...data };
    if (!allowedColumns) return payload;
    const allow = allowedColumns instanceof Set ? allowedColumns : new Set(allowedColumns);
    Object.keys(payload).forEach((k) => {
      if (!allow.has(k) && k !== idCol && k !== scopeCol) delete payload[k];
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
    requireScope(scopeCol, restaurantId);
    const where = [];
    const params = [];
    if (scopeCol) {
      params.push(restaurantId);
      where.push(`${assertIdent(scopeCol)} = $${params.length}`);
    }
    Object.entries(filters).forEach(([key, val]) => {
      if (key === '$null') {
        // Restaurant-level rows only: { $null: ['branch_id'] } matches rows whose branch column is NULL.
        (val || []).forEach((col) => where.push(`${assertIdent(col)} IS NULL`));
        return;
      }
      if (val === undefined || val === null || val === '') return;
      if (key === scopeCol) return; // the tenant column is never a filter the caller can choose
      if (allowedColumns && !(allowedColumns instanceof Set ? allowedColumns : new Set(allowedColumns)).has(key)) return;
      assertIdent(key);
      params.push(val);
      where.push(`${key} = $${params.length}`);
    });
    const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
    const { rows } = await pool.query(sql, params);
    return rows.map(parseRow);
  }

  async function getById(id, restaurantId) {
    requireScope(scopeCol, restaurantId);
    const params = [id];
    let sql = `SELECT * FROM ${table} WHERE ${idCol} = $1`;
    if (scopeCol) {
      params.push(restaurantId);
      sql += ` AND ${scopeCol} = $2`;
    }
    const { rows } = await pool.query(sql, params);
    return parseRow(rows[0]);
  }

  async function create(data, restaurantId) {
    requireScope(scopeCol, restaurantId);
    const payload = filterPayload({ ...data });
    // The tenant column always comes from the session, never from the request body.
    if (scopeCol) {
      delete payload[scopeCol];
      payload[scopeCol] = restaurantId;
    }
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
    requireScope(scopeCol, restaurantId);
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
    let sql = `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE ${assertIdent(idCol)} = $1`;
    if (scopeCol) {
      params.push(restaurantId);
      sql += ` AND ${assertIdent(scopeCol)} = $${params.length}`;
    }
    sql += ' RETURNING *';
    const { rows } = await pool.query(sql, params);
    return parseRow(rows[0]);
  }

  async function remove(id, restaurantId) {
    requireScope(scopeCol, restaurantId);
    const params = [id];
    let sql = `DELETE FROM ${table} WHERE ${idCol} = $1`;
    if (scopeCol) {
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

module.exports = {
  buildCrud,
  rowToJson,
  requireScope,
  assertNoDependants,
  removeWithDependants,
  assertTenantRefs,
  dependantsError,
};
