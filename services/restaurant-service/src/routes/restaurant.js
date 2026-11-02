const crypto = require('crypto');
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { buildCrud, assertTenantRefs, removeWithDependants } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, assertBranchAccess, branchScopeFilter, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { notFound, forbidden, badRequest, unauthorized, AppError } = require('@cravedash/shared/src/errors');
const { requireBranchService } = require('@cravedash/shared/src/branchServiceGuard');
const { cashByRider } = require('./riderCash');

const router = express.Router();
router.use(requireBranchService);

/** Keys restaurant tenants may write into restaurants.data (entitlements / billing stay platform-only). */
const TENANT_DATA_ALLOW = new Set([
  'currency',
  'timezone',
  'vat_number',
  'vat_registered',
  'restaurantTerms',
  'platformTermsAccepted',
  'platform_terms_version',
  'users',
  'admins',
  'menu_presentation',
  'branches',
  'card_brand',
  'card_last4',
]);

const TENANT_BODY_TO_DATA = [
  'users',
  'admins',
  'restaurantTerms',
  'platformTermsAccepted',
  'platform_terms_version',
];

function rid(req) {
  return restaurantId(req);
}

function isPlatformSuper(req) {
  return req.user?.role === 'super' && !req.user?.impersonating;
}

function pickTenantData(existing, incoming) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;
  for (const key of TENANT_DATA_ALLOW) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      out[key] = incoming[key];
    }
  }
  return out;
}

/** SEC-M7: ids generated here carry the restaurant, so two restaurants never generate the same id. */
function scopedId(restaurant, prefix) {
  return `${restaurant}_${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Generic tenant resource.
 *   foreignKeys: { column: 'table' } ids in writes must belong to the caller's restaurant (SEC-M7).
 *   dependants:  [{ table, column, label }] delete is refused with 409 and counts while any of these rows exist (SEC-M8).
 *   immutableWhen(row): true blocks changes and deletes of that row with 409 (approvals are final once resolved).
 *   allowedColumns: write allow-list (SEC-M9); columns outside it are dropped on create and update.
 */
/**
 * Moves the extra fields a resource keeps in its JSON `data` (opts.packExtra) out of the top-level body, so they are
 * stored there and never reach a column the table does not have. On update the stored data is kept and merged.
 */
function packExtras(body, opts, existing = null) {
  if (!opts.packExtra) return body;
  const extra = {};
  for (const key of opts.packExtra) {
    if (key in body) {
      extra[key] = body[key];
      delete body[key];
    }
  }
  if (!Object.keys(extra).length && !existing) return body;
  const current = existing && existing.data && typeof existing.data === 'object' ? existing.data : {};
  const incoming = body.data && typeof body.data === 'object' ? body.data : {};
  body.data = { ...current, ...incoming, ...extra };
  return body;
}

function mount(path, table, opts = {}) {
  const crud = buildCrud(pool, table, {
    restaurantColumn: 'restaurant_id',
    jsonColumns: opts.jsonColumns || ['data', 'payload', 'perms', 'settings'],
    ...opts,
  });
  const foreignKeys = opts.foreignKeys || {};

  async function assertMutable(existing) {
    if (opts.immutableWhen && opts.immutableWhen(existing)) {
      throw new AppError(`This ${table} record is final and cannot be changed`, 409, 'CONFLICT');
    }
  }

  router.get(path, asyncHandler(async (req, res) => {
    const r = rid(req);
    const bound = opts.branchScope ? branchId(req) : null;
    let rows;
    if (!bound) {
      rows = await crud.list(r, opts.branchScope ? branchScopeFilter(req) : {});
    } else {
      // Phase C.1: branch JWT sees own branch + HQ-shared (null branch_id). branchOnly: own branch only.
      const sharedClause = opts.branchOnly ? '' : ' OR branch_id IS NULL';
      ({ rows } = await pool.query(
        `SELECT * FROM ${table} WHERE restaurant_id = $1 AND (branch_id = $2${sharedClause}) ORDER BY id ASC`,
        [r, bound],
      ));
    }
    ok(res, opts.enrich ? await opts.enrich(r, rows) : rows);
  }));
  router.get(`${path}/:id`, asyncHandler(async (req, res) => {
    const row = await crud.getById(req.params.id, rid(req));
    if (!row) throw notFound();
    if (opts.branchScope && !rowInBranchScope(req, row.branch_id)) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, row.branch_id, { allowShared: !opts.branchOnly });
    ok(res, row);
  }));
  router.post(path, asyncHandler(async (req, res) => {
    const r = rid(req);
    const body = packExtras({ ...req.body }, opts);
    if (!body.id) body.id = scopedId(r, table.slice(0, 4));
    if (opts.branchScope) {
      const bound = branchId(req);
      if (bound) {
        body.branch_id = bound; // cannot invent another branch
      } else if (req.user?.role !== 'super') {
        body.branch_id = null; // the owner's rows are restaurant-level
      } else if (body.branch_id) {
        assertBranchAccess(req, body.branch_id, { allowShared: true });
      }
    }
    await assertTenantRefs(pool, r, body, foreignKeys);
    created(res, await crud.create(body, r));
  }));
  router.put(`${path}/:id`, asyncHandler(async (req, res) => {
    const r = rid(req);
    const existing = await crud.getById(req.params.id, r);
    if (!existing) throw notFound();
    if (opts.branchScope && !rowInBranchScope(req, existing.branch_id)) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: !opts.branchOnly });
    await assertMutable(existing);
    const body = packExtras({ ...req.body }, opts, existing);
    if (opts.branchScope && req.user?.role !== 'super') delete body.branch_id; // cannot reassign out of scope
    await assertTenantRefs(pool, r, body, foreignKeys);
    ok(res, await crud.update(req.params.id, body, r));
  }));
  router.patch(`${path}/:id`, asyncHandler(async (req, res) => {
    const r = rid(req);
    const existing = await crud.getById(req.params.id, r);
    if (!existing) throw notFound();
    if (opts.branchScope && !rowInBranchScope(req, existing.branch_id)) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: !opts.branchOnly });
    await assertMutable(existing);
    const body = packExtras({ ...req.body }, opts, existing);
    if (opts.branchScope && req.user?.role !== 'super') delete body.branch_id;
    await assertTenantRefs(pool, r, body, foreignKeys);
    ok(res, await crud.update(req.params.id, body, r));
  }));
  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    const r = rid(req);
    const existing = await crud.getById(req.params.id, r);
    if (!existing) throw notFound();
    if (opts.branchScope && !rowInBranchScope(req, existing.branch_id)) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: !opts.branchOnly });
    await assertMutable(existing);
    if (opts.dependants) {
      ok(res, await removeWithDependants(pool, {
        table,
        id: req.params.id,
        restaurantId: r,
        dependants: opts.dependants,
      }));
      return;
    }
    ok(res, await crud.remove(req.params.id, r));
  }));
}

mount('/customers', 'customers', {
  branchScope: true,
  branchOnly: true,
  // CRM fields the till and dashboard send that have no column: they are kept in `data` (EPOS spec, customers 30-31).
  packExtra: ['address', 'postcode', 'notes', 'rating'],
  // Block wallet/loyalty mass-assignment — use dedicated ledger endpoints later
  allowedColumns: [
    'id', 'name', 'email', 'phone', 'status', 'data',
    'f_name', 'l_name', 'branch', 'branch_id',
  ],
});
mount('/coupons', 'coupons', { branchScope: true, branchOnly: true });
mount('/employees/roles', 'employee_roles', { idColumn: 'id', branchScope: true, branchOnly: true });
mount('/employees', 'employees', {
  branchScope: true,
  branchOnly: true,
  foreignKeys: { role_id: 'employee_roles' },
  allowedColumns: [
    'id', 'f_name', 'l_name', 'email', 'phone', 'role_id', 'branch', 'branch_id', 'status', 'data',
  ],
});
mount('/bookings', 'bookings', { branchScope: true, branchOnly: true });
// SEC-M9: status and resolution fields change only through PATCH /approvals/:id/resolve. Resolved rows are final.
mount('/approvals', 'approval_requests', {
  branchScope: true,
  branchOnly: true,
  jsonColumns: ['payload'],
  allowedColumns: ['id', 'app', 'till', 'action', 'order_id', 'payload'],
  immutableWhen: (row) => !!row.status && row.status !== 'pending',
});
// SEC-M9: wallet_balance is not writable from the tenant API. SEC-M8: a rider with pay history or a login is kept.
/** Rider stats from the orders assigned to each rider (orders carry delivery_man_id). Nothing is stored on the rider. */
const RIDER_ONGOING = new Set(['pending', 'confirmed', 'processing', 'cooking', 'ready_for_serve', 'out_for_delivery']);
const RIDER_CANCELLED = new Set(['canceled', 'returned', 'failed_to_deliver']);
const RIDER_DONE = new Set(['delivered', 'completed']);

async function riderStats(restaurant, rows) {
  if (!rows.length) return rows;
  const { rows: orders } = await pool.query(
    `SELECT data->>'delivery_man_id' AS rider, status, total FROM orders
      WHERE restaurant_id = $1 AND data->>'delivery_man_id' IS NOT NULL`,
    [restaurant],
  );
  const empty = () => ({ total: 0, ongoing: 0, cancelled: 0, completed: 0, amount: 0, cash_collected: 0, cash_settled: 0, cash_in_hand: 0 });
  const cash = await cashByRider(pool, restaurant);
  const byRider = new Map();
  for (const o of orders) {
    const s = byRider.get(o.rider) || empty();
    s.total += 1;
    if (RIDER_ONGOING.has(o.status)) s.ongoing += 1;
    else if (RIDER_CANCELLED.has(o.status)) s.cancelled += 1;
    else if (RIDER_DONE.has(o.status)) {
      s.completed += 1;
      s.amount += Number(o.total) || 0;
    }
    byRider.set(o.rider, s);
  }
  return rows.map((r) => {
    const s = byRider.get(r.id) || empty();
    const c = cash.get(r.id);
    return {
      ...r,
      stats: { ...s, cash_collected: c ? c.collected : 0, cash_settled: c ? c.settled : 0, cash_in_hand: c ? c.in_hand : 0 },
    };
  });
}

mount('/deliverymen', 'deliverymen', {
  branchScope: true,
  branchOnly: true,
  enrich: riderStats,
  jsonColumns: ['metadata'],
  allowedColumns: ['id', 'name', 'phone', 'email', 'vehicle', 'status', 'metadata', 'branch_id'],
  dependants: [
    { table: 'driver_payments', column: 'driver_id', label: 'payments' },
    { table: 'driver_pay_policies', column: 'driver_id', label: 'pay plans' },
    { table: 'users', column: 'id', label: 'linked accounts' },
  ],
});
mount('/chefs', 'chefs', {
  dependants: [{ table: 'users', column: 'id', label: 'linked accounts' }],
});

/**
 * Branch-owned floor plan. A branch login sees, creates, edits and deletes only rows whose branch_id is its own branch.
 * Owners see every row. Rows with no branch (owner-created) are invisible to branch logins.
 */
const areasCrud = () => buildCrud(pool, 'areas', { restaurantColumn: 'restaurant_id' });
const tablesCrud = () => buildCrud(pool, 'dining_tables', { restaurantColumn: 'restaurant_id' });

/** Loads a row the caller may change. A row outside the caller's branch is a 404, so it does not show as existing. */
async function ownedRow(req, crud, id) {
  const row = await crud.getById(id, rid(req));
  const bound = branchId(req);
  if (!row || !rowInBranchScope(req, row.branch_id)) throw notFound();
  return row;
}

router.get('/tables', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  const scope = branchScopeFilter(req);
  const areas = await areasCrud().list(r, scope);
  const tables = await tablesCrud().list(r, scope);
  // Tables held by a website booking right now: the visit has started (or starts within 15 minutes) and runs 90 minutes.
  const { rows: held } = await pool.query(
    `SELECT DISTINCT table_id FROM bookings
      WHERE restaurant_id = $1 AND table_id IS NOT NULL
        AND status = ANY($2::text[])
        AND booked_at <= NOW() + INTERVAL '15 minutes'
        AND booked_at + INTERVAL '90 minutes' > NOW()`,
    [r, ['booked', 'confirmed', 'seated', 'pending']],
  );
  ok(res, { areas, tables, booked_table_ids: held.map((row) => String(row.table_id)) });
}));

router.post('/tables/areas', asyncHandler(async (req, res) => {
  const bound = branchId(req);
  const body = { ...req.body, id: req.body.id || scopedId(rid(req), 'area') };
  body.branch_id = bound || (req.user?.role === 'super' ? body.branch_id : null);
  created(res, await areasCrud().create(body, rid(req)));
}));

router.put('/tables/areas/:id', asyncHandler(async (req, res) => {
  await ownedRow(req, areasCrud(), req.params.id);
  const body = { ...req.body };
  if (req.user?.role !== 'super') delete body.branch_id;
  ok(res, await areasCrud().update(req.params.id, body, rid(req)));
}));

/** SEC-M8: an area with tables is refused (409 with the count). Tables are not deleted as a side effect any more. */
router.delete('/tables/areas/:id', asyncHandler(async (req, res) => {
  await ownedRow(req, areasCrud(), req.params.id);
  ok(res, await removeWithDependants(pool, {
    table: 'areas',
    id: req.params.id,
    restaurantId: rid(req),
    dependants: [{ table: 'dining_tables', column: 'area_id', label: 'tables' }],
  }));
}));

router.post('/tables', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  // SEC-M7: table ids are restaurant-scoped (a bare "T1" is shared by every restaurant). A branch gets a fresh id, so two
  // branches can both have a table 1.
  const id = req.body.id || (!bound && req.body.number != null ? `${r}_T${req.body.number}` : scopedId(r, 'table'));
  const body = { ...req.body, id };
  body.branch_id = bound || (req.user?.role === 'super' ? body.branch_id : null);
  await assertTenantRefs(pool, r, body, { area_id: 'areas' });
  if (body.area_id) await ownedRow(req, areasCrud(), body.area_id);
  created(res, await tablesCrud().create(body, r));
}));

router.put('/tables/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  await ownedRow(req, tablesCrud(), req.params.id);
  const body = { ...req.body };
  if (req.user?.role !== 'super') delete body.branch_id;
  await assertTenantRefs(pool, r, body, { area_id: 'areas' });
  if (body.area_id) await ownedRow(req, areasCrud(), body.area_id);
  ok(res, await tablesCrud().update(req.params.id, body, r));
}));

router.delete('/tables/:id', asyncHandler(async (req, res) => {
  await ownedRow(req, tablesCrud(), req.params.id);
  ok(res, await tablesCrud().remove(req.params.id, rid(req)));
}));

/** Phase B.4: per-user UI prefs (sidebar, terminal) — not restaurant business settings. Table: scripts/init-db.sql (SEC-M10). */
function prefsUserId(req) {
  const id = req.user?.sub || req.user?.id;
  if (!id) throw unauthorized('No user session');
  return String(id);
}

router.get('/settings/prefs', asyncHandler(async (req, res) => {
  const uid = prefsUserId(req);
  const { rows } = await pool.query('SELECT data FROM user_prefs WHERE user_id = $1', [uid]);
  ok(res, rows[0]?.data || {});
}));

router.put('/settings/prefs', asyncHandler(async (req, res) => {
  const uid = prefsUserId(req);
  const incoming = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // Merge patch into existing prefs (shallow)
  const { rows: cur } = await pool.query('SELECT data FROM user_prefs WHERE user_id = $1', [uid]);
  const merged = Object.assign({}, (cur[0]?.data && typeof cur[0].data === 'object') ? cur[0].data : {}, incoming);
  let raw;
  try {
    raw = JSON.stringify(merged);
  } catch {
    throw badRequest('Prefs payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw badRequest('Prefs exceed 64 KiB');
  const { rows } = await pool.query(
    `INSERT INTO user_prefs (user_id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [uid, raw],
  );
  ok(res, rows[0].data);
}));

/** A branch login's own settings row, or null when the branch has not saved its own yet. */
async function ownBranchSettings(r, bound) {
  const { rows } = await pool.query(
    `SELECT data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key = 'settings'`,
    [r, bound],
  );
  return rows[0]?.data ?? null;
}

router.get('/settings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  if (bound) {
    const own = await ownBranchSettings(r, bound);
    if (own) return ok(res, own);
  }
  const { rows } = await pool.query('SELECT settings FROM restaurant_settings WHERE restaurant_id = $1', [r]);
  ok(res, rows[0]?.settings || {});
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const settings = req.body || {};
  const bound = branchId(req);
  if (bound) {
    const { rows } = await pool.query(
      `INSERT INTO branch_settings (restaurant_id, branch_id, key, data, updated_at)
       VALUES ($1, $2, 'settings', $3, NOW())
       ON CONFLICT (restaurant_id, branch_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
       RETURNING data`,
      [r, bound, JSON.stringify(settings)],
    );
    return ok(res, rows[0].data);
  }
  const { rows } = await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id, settings, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (restaurant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
     RETURNING settings`,
    [r, JSON.stringify(settings)],
  );
  ok(res, rows[0].settings);
}));

router.get('/restaurant', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!rows[0]) throw notFound('Restaurant not found');
  const bound = branchId(req);
  const row = rows[0];
  // A branch login sees only the panel users of its own branch.
  if (row.data && Array.isArray(row.data.users)) {
    const all = row.data.users;
    if (bound) row.data = { ...row.data, users: all.filter((u) => String(u?.branch_id) === String(bound)) };
    else if (req.user?.role !== 'super') row.data = { ...row.data, users: all.filter((u) => !u?.branch_id) };
  }
  ok(res, row);
}));

/**
 * Restaurant admin self-update. Tenants may only patch profile / terms / panel ACL keys.
 * modules, api_key, access_level, billing, invoices, etc. require platform super
 * via PATCH /restaurants/:id — never this tenant endpoint.
 */
router.patch('/restaurant', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows: existing } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!existing[0]) throw notFound('Restaurant not found');
  const cur = existing[0];
  const body = req.body || {};
  let data;

  if (isPlatformSuper(req)) {
    data = Object.assign({}, cur.data || {}, body.data || {});
    if (body.billing) data.billing = Object.assign({}, data.billing || {}, body.billing);
    ['users', 'admins', 'restaurantTerms', 'platformTermsAccepted', 'platform_terms_version', 'invoices'].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
  } else {
    if (req.user?.role === 'epos') throw forbidden('EPOS cannot update restaurant profile');
    const bound = branchId(req);
    // A branch login changes only its own panel users. The profile, terms, branch list and billing are not the branch's to change.
    data = bound ? { ...(cur.data || {}) } : pickTenantData(cur.data, body.data);
    // A branch login sends its panel users as the top-level `users` list (the same shape the owner sends).
    const incomingUsers = body.users !== undefined ? body.users : body.data?.users;
    if (bound && Array.isArray(incomingUsers)) data.users = incomingUsers;
    if (!bound) {
      TENANT_BODY_TO_DATA.forEach((k) => {
        if (body[k] !== undefined) data[k] = body[k];
      });
    }
    // Ignore privileged top-level fields from tenants (billing, invoices, modules, …)
    if (Array.isArray(data.users)) {
      // Each scope saves only its own panel users. Users of other branches are kept as they are.
      const scopeOf = (u) => (u?.branch_id ? String(u.branch_id) : null);
      const myScope = bound ? String(bound) : null;
      // A branch saves only the users that belong to it. Restaurant-level users are never copied into a branch.
      const others = (cur.data?.users || []).filter((u) => scopeOf(u) !== myScope);
      // A branch may add a new user (no branch_id yet) but never re-save a restaurant-level user under its own branch.
      const restaurantIds = new Set((cur.data?.users || []).filter((u) => !u?.branch_id).map((u) => u.id));
      const mine = data.users
        .filter((u) => u && (bound ? scopeOf(u) === myScope || (!u.branch_id && !restaurantIds.has(u.id)) : !u.branch_id))
        .map((u) => ({ ...u, branch_id: bound ? String(bound) : null }));
      data.users = [...others, ...mine];
    }
  }

  const branchLogin = !isPlatformSuper(req) && Boolean(branchId(req));
  const name = !branchLogin && body.name != null ? body.name : cur.name;
  const phone = !branchLogin && body.phone != null ? body.phone : cur.phone;
  const address = !branchLogin && body.address != null ? body.address : cur.address;
  const { rows } = await pool.query(
    `UPDATE restaurants SET name = $2, phone = $3, address = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [r, name, phone, address, JSON.stringify(data)],
  );
  ok(res, rows[0]);
}));

/**
 * Branch services (restaurant admin, one branch per call). A branch's services can only be switched within the
 * restaurant's own services (the Super Admin limit), so an unknown service is refused with 400. The branch record lives
 * in restaurants.data.branch_list. The row lock and the audit row are written in one transaction.
 */
router.patch('/restaurant/branches/:branchId/services', asyncHandler(async (req, res) => {
  if (req.user?.role !== 'restaurant') throw forbidden('Only restaurant admins can set branch services');
  const r = rid(req);
  const branch = String(req.params.branchId || '');
  // A branch-bound caller can only change its own branch (throws 403 for another branch).
  assertBranchAccess(req, branch);

  const body = req.body || {};
  // services and dash_widgets are each optional, but one must be sent. dash_widgets: null clears the branch's own list,
  // so the branch inherits the restaurant's list again.
  const touchServices = body.services !== undefined;
  const touchWidgets = body.dash_widgets !== undefined;
  if (!touchServices && !touchWidgets) throw badRequest('services must be an array of service keys');
  if (touchServices && !Array.isArray(body.services)) throw badRequest('services must be an array of service keys');
  if (touchWidgets && body.dash_widgets !== null && !Array.isArray(body.dash_widgets)) {
    throw badRequest('dash_widgets must be an array of widget keys, or null to inherit the restaurant list');
  }
  const requested = new Set((touchServices ? body.services : []).map((s) => String(s)));
  const requestedWidgets = touchWidgets && body.dash_widgets !== null ? [...new Set(body.dash_widgets.map((s) => String(s)))] : [];
  if (requestedWidgets.some((k) => !k || k.length > 64)) throw badRequest('dash_widgets must be widget keys');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM restaurants WHERE id = $1 FOR UPDATE', [r]);
    if (!rows[0]) throw notFound('Restaurant not found');
    const restaurantData = rows[0].data && typeof rows[0].data === 'object' ? rows[0].data : {};
    const branches = Array.isArray(restaurantData.branch_list) ? restaurantData.branch_list : [];
    const index = branches.findIndex((b) => b && String(b.id) === branch);
    if (index < 0) throw notFound('Branch not found');

    const nextBranch = { ...branches[index] };
    const servicesBefore = Array.isArray(branches[index].services) ? branches[index].services : null;
    const widgetsBefore = Array.isArray(branches[index].dash_widgets) ? branches[index].dash_widgets : null;

    let nextServices = null;
    if (touchServices) {
      // Only services the restaurant has may be on a branch. Keep the restaurant's own order.
      const own = Array.isArray(restaurantData.services) ? restaurantData.services.map((s) => String(s)) : [];
      const unknown = [...requested].filter((s) => !own.includes(s));
      if (unknown.length) throw badRequest(`The restaurant does not have these services: ${unknown.join(', ')}`);
      nextServices = own.filter((s) => requested.has(s));
      nextBranch.services = nextServices;
    }

    if (touchWidgets) {
      if (body.dash_widgets === null) {
        delete nextBranch.dash_widgets;
      } else {
        // Only widgets the restaurant allows may be on a branch. With no restaurant list, every widget is allowed.
        const allowedWidgets = Array.isArray(restaurantData.dash_widgets) ? restaurantData.dash_widgets.map((s) => String(s)) : null;
        const unknownWidgets = allowedWidgets ? requestedWidgets.filter((k) => !allowedWidgets.includes(k)) : [];
        if (unknownWidgets.length) throw badRequest(`The restaurant does not allow these dashboard widgets: ${unknownWidgets.join(', ')}`);
        nextBranch.dash_widgets = allowedWidgets ? allowedWidgets.filter((k) => requestedWidgets.includes(k)) : requestedWidgets;
      }
    }

    const nextBranches = branches.map((b, i) => (i === index ? nextBranch : b));
    await client.query(
      `UPDATE restaurants SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{branch_list}', $2::jsonb), updated_at = NOW()
        WHERE id = $1`,
      [r, JSON.stringify(nextBranches)],
    );
    const audit = (action, detail, data) => client.query(
      `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data)
       VALUES ($1, $2, $3, 'branch', $4, $5, $6, $7::jsonb)`,
      [
        `aud_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
        req.user?.name || req.user?.sub || 'unknown',
        action,
        branch,
        r,
        detail,
        JSON.stringify({ ...data, role: req.user?.role || null }),
      ],
    );
    if (touchServices) {
      await audit('branch.services.update', `Branch services set to: ${nextServices.join(', ') || 'none'}`, {
        before: servicesBefore,
        after: nextServices,
      });
    }
    if (touchWidgets) {
      const widgetsAfter = nextBranch.dash_widgets ?? null;
      await audit(
        'branch.dashboard_widgets.update',
        widgetsAfter ? `Branch dashboard widgets set to: ${widgetsAfter.join(', ') || 'none'}` : 'Branch dashboard widgets reset to the restaurant list',
        { before: widgetsBefore, after: widgetsAfter },
      );
    }
    await client.query('COMMIT');
    ok(res, nextBranches[index]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/** Logins bound to a branch of this restaurant (read only, no password data). A branch-bound caller sees its own branch. */
router.get('/restaurant/branch-logins', asyncHandler(async (req, res) => {
  if (req.user?.role !== 'restaurant' && req.user?.role !== 'super') throw forbidden('Only restaurant admins can see branch logins');
  const { rows } = await pool.query(
    `SELECT id, name, email, status, branch_id FROM users
      WHERE restaurant_id = $1 AND branch_id IS NOT NULL AND ($2::text IS NULL OR branch_id = $2)
      ORDER BY email`,
    [rid(req), branchId(req)],
  );
  ok(res, rows);
}));

router.patch('/approvals/:id/resolve', asyncHandler(async (req, res) => {
  // Till-bound EPOS must use manager PIN path — not raw API self-approve
  if (req.user?.role === 'epos' || req.user?.till_id) {
    throw forbidden('EPOS cannot resolve approvals via API — use manager PIN / remote approval');
  }
  if (req.user?.role !== 'restaurant' && req.user?.role !== 'super') {
    throw forbidden('Only restaurant or platform admins can resolve approvals');
  }
  const { status = 'approved', resolved_by } = req.body || {};
  const next = String(status).toLowerCase();
  if (!['approved', 'rejected'].includes(next)) throw badRequest('status must be approved or rejected');
  const crud = buildCrud(pool, 'approval_requests', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing || !rowInBranchScope(req, existing.branch_id)) throw notFound();
  if (existing.status && existing.status !== 'pending') {
    throw badRequest(`Approval already ${existing.status}`);
  }
  ok(res, await crud.update(req.params.id, {
    status: next,
    resolved_at: new Date().toISOString(),
    resolved_by: resolved_by || req.user?.name,
  }, rid(req)));
}));

// Generic store blobs for inventory / payroll / banners / etc.
// Phase 3.1: allowlisted keys + size cap (H2 — no arbitrary key overwrite).
// Inventory / payroll / accounting moved to /domain/* (domain_docs) — not writable via blobs.
const BLOB_KEY_ALLOW = new Set([
  'report_schedules', 'custom_pages', 'faqs', 'social_links',
  'offline_methods', 'banners', 'mobile_banners', 'auto_discounts',
  'push_notifications',
  'subscribed', 'subscribers', 'dm_requests', 'dm_reviews',
  'offline_verifications', 'reviews', 'languages',
  'promotions', 'conversations', 'notifications_feed',
  'payouts', 'audit_log',
  'deals_enabled', 'integrations', 'driver_pay_policies', 'driver_payments',
  'restaurantTerms', 'platformTermsAccepted', 'staff_activity',
  'settings_integration_handoff', 'mobile_app_brand',
  'invoices',
  'print_log', 'call_log', 'calls_live', 'call_seq', 'print_queue',
  'remote_state', 'report_state',
]);
const BLOB_SENSITIVE = new Set([
  'wallet_txns', 'wallet_bonus', 'loyalty_txns', 'payouts', 'invoices',
  'integrations', 'audit_log', 'driver_payments', 'driver_pay_policies',
  'settings_integration_handoff', 'subscribed', 'subscribers',
]);
function isEposSession(req) {
  return req.user?.role === 'epos' || !!req.user?.till_id;
}

/** EPOS cannot read sensitive blobs, nor the payroll and accounting blobs that moved to domain storage (SEC-H8). */
function eposBlocked(key) {
  return BLOB_SENSITIVE.has(key) || BLOB_MOVED_TO_DOMAIN.has(key);
}

function assertBlobReadable(key, req) {
  const k = normalizeBlobKey(key);
  if (eposBlocked(k) && isEposSession(req)) {
    throw forbidden('EPOS cannot read sensitive blobs');
  }
  return k;
}
const BLOB_MOVED_TO_DOMAIN = new Set([
  'ingredients', 'wastage', 'recipes', 'stock_moves', 'suppliers',
  'purchase_po', 'purchase_grn', 'purchase_payments', 'purchase_reports',
  'coa', 'acc_mapping', 'acc_journals', 'acc_manual', 'acc_ledger', 'acc_expenses',
  'acc_drawer', 'acc_ar', 'acc_ap', 'acc_tb', 'acc_pl', 'acc_bs',
  'payroll_staff', 'payroll_shifts', 'payroll_roster', 'payroll_attendance',
  'payroll_runs', 'payroll_reports',
  // Phase B.2 → domain ops
  'branches', 'delivery_zones', 'delivery_areas', 'reservation_settings',
  'approval_rules', 'epos_settings', 'menuPresentation', 'tips_config',
  'employee_roles', 'time_slots', 'print_settings', 'print_rules', 'print_routes',
  'card_terminals', 'epos_devices', 'pos_devices', 'printers',
  'epos_customers', 'till_counts',
]);
const BLOB_MAX_BYTES = 512 * 1024; // 512 KiB per key

function normalizeBlobKey(key) {
  const k = String(key || '');
  if (!/^[a-z][a-z0-9_]{1,63}$/i.test(k)) throw badRequest('Invalid blob key');
  return k;
}

/** SEC-M9: payout, invoice and audit records are written by the server only. No blob write path exists for them. */
const BLOB_SERVER_ONLY = new Set(['payouts', 'audit_log', 'invoices']);

function assertBlobWritable(key, req) {
  const k = normalizeBlobKey(key);
  if (BLOB_SERVER_ONLY.has(k)) {
    throw forbidden(`"${k}" is written by the server only`);
  }
  if (BLOB_MOVED_TO_DOMAIN.has(k)) {
    throw forbidden(`Use /domain APIs for "${k}" (inventory/payroll/accounting ledgers)`);
  }
  // Integration credentials have one write path: /integrations (encrypted, admin-only). Raw blob writes are refused (D2, audit IP-2).
  if (k === 'integrations') {
    throw forbidden('Use /integrations APIs for integration settings');
  }
  if (k === 'driver_pay_policies' || k === 'driver_payments') {
    throw forbidden(`Use /drivers APIs for "${k}"`);
  }
  const allowed = BLOB_KEY_ALLOW.has(k) || k.startsWith('settings_');
  if (!allowed) throw forbidden(`Blob key "${k}" is not allowlisted`);
  if (BLOB_SENSITIVE.has(k) && isEposSession(req)) {
    throw forbidden('EPOS cannot write sensitive blobs');
  }
  return k;
}

/** A branch login's own value for a settings_* blob, or null when the branch has not saved its own. */
async function ownBranchBlob(r, bound, key) {
  const { rows } = await pool.query(
    'SELECT data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key = $3',
    [r, bound, key],
  );
  return rows[0]?.data ?? null;
}

router.get('/blobs', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  const epos = isEposSession(req);
  const out = {};
  // A branch admin sees only its own copies. A till of that branch also gets the restaurant defaults under them.
  if (!bound || epos) {
    const { rows } = await pool.query('SELECT key, data FROM restaurant_blobs WHERE restaurant_id = $1', [r]);
    rows.forEach((row) => {
      if (epos && eposBlocked(normalizeBlobKey(row.key))) return;
      out[row.key] = row.data;
    });
  }
  if (bound) {
    const { rows: own } = await pool.query(
      'SELECT key, data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key <> $3',
      [r, bound, 'settings'],
    );
    own.forEach((row) => { out[row.key] = row.data; });
  }
  ok(res, out);
}));

router.get('/blobs/:key', asyncHandler(async (req, res) => {
  const r = rid(req);
  const key = assertBlobReadable(req.params.key, req);
  const bound = branchId(req);
  if (bound) {
    const own = await ownBranchBlob(r, bound, key);
    if (own !== null) return ok(res, own);
    // A branch admin starts empty. A till of the branch falls back to the restaurant default below.
    if (!isEposSession(req)) return ok(res, []);
  }
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [r, key],
  );
  ok(res, rows[0]?.data ?? []);
}));

router.put('/blobs/:key', asyncHandler(async (req, res) => {
  const r = rid(req);
  const key = assertBlobWritable(req.params.key, req);
  const data = req.body === undefined ? [] : req.body;
  let raw;
  try {
    raw = JSON.stringify(data);
  } catch {
    throw badRequest('Blob payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > BLOB_MAX_BYTES) {
    throw badRequest(`Blob exceeds ${BLOB_MAX_BYTES} byte limit`);
  }
  const bound = branchId(req);
  if (bound) {
    // A branch login writes its own copy of the blob. The restaurant copy is left as it is.
    const { rows } = await pool.query(
      `INSERT INTO branch_settings (restaurant_id, branch_id, key, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (restaurant_id, branch_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
       RETURNING data`,
      [r, bound, key, raw],
    );
    return ok(res, rows[0].data);
  }
  const { rows } = await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [r, key, raw],
  );
  ok(res, rows[0].data);
}));

router.use(require('./domain'));

module.exports = router;
