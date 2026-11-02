const express = require('express');
const pool = require('@cravedash/shared/src/db');
const crypto = require('crypto');
const { buildCrud, assertTenantRefs, removeWithDependants } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, branchScopeFilter, rowInBranchScope } = require('@cravedash/shared/src/authMiddleware');
const { notFound, badRequest, forbidden } = require('@cravedash/shared/src/errors');
const { requireBranchService } = require('@cravedash/shared/src/branchServiceGuard');
const branchCatalog = require('./branchCatalog');

const router = express.Router();
router.use(requireBranchService);
router.use(branchCatalog.router);
router.use(require('./branchCopy').router);
const {
  branchProducts, branchCategories, branchSubcategories, isBranchLogin, assertBranchMasterPatch, applyBranchMasterPatch,
  assertStatusOnlyPatch, changesBranchFields, applyBranchOwnPatch, applyBranchCategoryActive, statusPatch,
} = branchCatalog;

const BRANCH_CANNOT_CREATE = 'A branch cannot create products, categories or subcategories. The restaurant admin creates them and assigns them to the branch.';

function rid(req) {
  return restaurantId(req);
}

/** SEC-M7: ids generated here carry the restaurant, so two restaurants never generate the same id. */
function scopedId(restaurant, prefix) {
  return `${restaurant}_${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Option A (branch catalogues): a branch-bound caller sees, creates, edits and deletes only rows whose branch_id is its
 * own branch. A row with no branch (created by the owner) is invisible to every branch login. Owners and super are unchanged.
 */
function branchOwns(req, row) {
  return rowInBranchScope(req, row.branch_id);
}

/**
 * A row linked from a branch's product must be the branch's own, or a restaurant row the branch can see: a restaurant
 * category assigned to the branch, or a restaurant subcategory under such a category. (The restaurant check runs first
 * in assertTenantRefs.)
 */
const VISIBLE_TO_BRANCH = {
  categories: 'EXISTS (SELECT 1 FROM category_branch_assignments a WHERE a.category_id = t.id AND a.branch_id = $3 AND a.restaurant_id = $2)',
  subcategories: 'EXISTS (SELECT 1 FROM category_branch_assignments a WHERE a.category_id = t.parent_id AND a.branch_id = $3 AND a.restaurant_id = $2)',
};

async function assertBranchRefs(bound, r, body, refs) {
  for (const [column, table] of Object.entries(refs)) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, column)) continue;
    const value = body[column];
    if (value === undefined || value === null || value === '') continue;
    const { rows } = await pool.query(
      `SELECT 1 FROM ${table} t WHERE t.id = $1 AND t.restaurant_id = $2
          AND (t.branch_id = $3 OR (t.branch_id IS NULL AND ${VISIBLE_TO_BRANCH[table]}))`,
      [String(value), r, bound],
    );
    if (!rows[0]) throw badRequest(`${column} does not refer to a record of this branch`);
  }
}

/**
 * opts.foreignKeys: { column: 'table' } ids in the body must belong to the caller's restaurant (SEC-M7).
 * opts.dependants: [{ table, column, label }] a delete is refused with 409 while any of these rows exist (SEC-M8).
 * opts.branchScoped: the table has a branch_id column and branch logins are limited to their own branch (Option A).
 */
function mountResource(path, table, opts = {}) {
  const crud = buildCrud(pool, table, { restaurantColumn: 'restaurant_id', jsonColumns: opts.jsonColumns || ['data', 'slots'], ...opts });
  const foreignKeys = opts.foreignKeys || {};
  const scoped = Boolean(opts.branchScoped);

  // Products, categories and subcategories belong to the restaurant. A branch sees the rows assigned to it, and only a
  // branch login's changes are limited (see updateAsBranch). Products and categories also have a branch assignment view.
  const assignable = table === 'products' || table === 'categories';
  const restaurantOwned = assignable || table === 'subcategories';
  const viewFor = (bound, r, id = null) => {
    if (table === 'products') return branchProducts(r, bound, id);
    if (table === 'categories') return branchCategories(r, bound, id);
    return branchSubcategories(r, bound, id);
  };

  router.get(path, asyncHandler(async (req, res) => {
    const bound = scoped ? branchId(req) : null;
    if (restaurantOwned && bound) return ok(res, await viewFor(bound, rid(req)));
    ok(res, await crud.list(rid(req), scoped ? branchScopeFilter(req) : {}));
  }));

  router.get(`${path}/:id`, asyncHandler(async (req, res) => {
    const bound = scoped ? branchId(req) : null;
    if (restaurantOwned && bound) {
      const [row] = await viewFor(bound, rid(req), String(req.params.id));
      if (!row) throw notFound();
      return ok(res, row);
    }
    const row = await crud.getById(req.params.id, rid(req));
    if (!row || (scoped && !branchOwns(req, row))) throw notFound();
    ok(res, row);
  }));

  router.post(path, asyncHandler(async (req, res) => {
    const r = rid(req);
    if (restaurantOwned && isBranchLogin(req)) throw forbidden(BRANCH_CANNOT_CREATE);
    const body = { ...req.body };
    if (!body.id) body.id = scopedId(r, table.slice(0, 3));
    const bound = scoped ? branchId(req) : null;
    // A branch login always writes its own branch, whatever the body says. An owner keeps branch_id as given.
    // Branch rows belong to the branch. The owner's rows have no branch (NULL); only the super admin may set one.
    if (scoped && req.user?.role !== 'super') body.branch_id = bound || null;
    await assertTenantRefs(pool, r, body, foreignKeys);
    if (bound) await assertBranchRefs(bound, r, body, foreignKeys);
    created(res, await crud.create(body, r));
  }));

  /**
   * What a branch login may change. Its own rows: products get price, image and ON/OFF; categories and subcategories get
   * ON/OFF. A restaurant product assigned to it gets price, image and ON/OFF on the assignment; a restaurant category
   * assigned to it gets ON/OFF on the assignment. A restaurant subcategory is read-only. Other branches' rows are not found.
   */
  async function updateAsBranch(req, res) {
    const r = rid(req);
    const bound = branchId(req);
    const id = String(req.params.id);
    const row = await crud.getById(id, r);
    // Another branch's row is not found, the same as on every other read.
    if (!row || (row.branch_id !== null && row.branch_id !== bound)) throw notFound();
    const patch = { ...req.body };
    // Ownership and identity are never a branch's to move, even when the value matches nothing (not silently dropped).
    for (const key of ['id', 'restaurant_id', 'branch_id']) {
      if (patch[key] !== undefined && String(patch[key] ?? '') !== String(row[key] ?? '')) throw forbidden(`A branch cannot change ${key}`);
    }
    // Protected fields are refused first, then an empty change is refused.
    const requireChange = () => {
      if (!changesBranchFields(table, patch)) {
        throw badRequest(table === 'products' ? 'Nothing to change: a branch can set price, image or status' : 'Nothing to change: a branch can set ON/OFF');
      }
    };
    if (row.branch_id === bound) {
      if (table === 'products') assertBranchMasterPatch(row, patch);
      else assertStatusOnlyPatch(row, patch);
      requireChange();
      await applyBranchOwnPatch(r, bound, table, id, patch);
    } else if (table === 'products') {
      const [assigned] = await viewFor(bound, r, id);
      if (!assigned) throw notFound();
      assertBranchMasterPatch(row, patch);
      requireChange();
      await applyBranchMasterPatch(r, bound, id, patch);
    } else if (table === 'categories') {
      const [assigned] = await viewFor(bound, r, id);
      if (!assigned) throw notFound();
      assertStatusOnlyPatch(row, patch);
      requireChange();
      await applyBranchCategoryActive(r, bound, id, statusPatch(patch));
    } else {
      throw forbidden('A branch cannot change the restaurant\'s subcategories. The restaurant admin manages them.');
    }
    const [after] = await viewFor(bound, r, id);
    ok(res, after);
  }

  async function updateRow(req, res) {
    if (restaurantOwned && isBranchLogin(req)) return updateAsBranch(req, res);
    const r = rid(req);
    const patch = { ...req.body };
    const bound = scoped ? branchId(req) : null;
    if (assignable && bound) {
      const master = await crud.getById(req.params.id, r);
      if (master && master.branch_id === null) {
        // Owner in branch context: the same assignment view, with the owner's rights as before.
        const [assigned] = await viewFor(bound, r, String(req.params.id));
        if (!assigned) throw notFound();
        assertBranchMasterPatch(master, patch);
        await applyBranchMasterPatch(r, bound, String(req.params.id), patch);
        const [after] = await viewFor(bound, r, String(req.params.id));
        return ok(res, after);
      }
    }
    if (scoped) {
      const existing = await crud.getById(req.params.id, r);
      // 404, not 403, so another branch's row does not show as existing.
      if (!existing || !branchOwns(req, existing)) throw notFound();
      if (req.user?.role !== 'super') delete patch.branch_id; // only the super admin moves a row between branches
    }
    if (bound) await assertBranchRefs(bound, r, patch, foreignKeys);
    await assertTenantRefs(pool, r, patch, foreignKeys);
    ok(res, await crud.update(req.params.id, patch, r));
  }

  router.put(`${path}/:id`, asyncHandler(updateRow));
  router.patch(`${path}/:id`, asyncHandler(updateRow));

  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    // A branch never deletes a product, category or subcategory, its own or a restaurant master (the owner does that).
    if (restaurantOwned && branchId(req)) throw forbidden('A branch cannot delete products, categories or subcategories');
    if (scoped) {
      const existing = await crud.getById(req.params.id, rid(req));
      if (!existing || !branchOwns(req, existing)) throw notFound();
    }
    ok(res, await removeWithDependants(pool, {
      table,
      id: req.params.id,
      restaurantId: rid(req),
      dependants: opts.dependants || [],
    }));
  }));
}

mountResource('/categories', 'categories', {
  branchScoped: true,
  dependants: [
    { table: 'products', column: 'category_id', label: 'products' },
    { table: 'subcategories', column: 'parent_id', label: 'subcategories' },
  ],
});
mountResource('/subcategories', 'subcategories', {
  branchScoped: true,
  foreignKeys: { parent_id: 'categories' },
  dependants: [{ table: 'products', column: 'sub_category_id', label: 'products' }],
});
mountResource('/products', 'products', {
  branchScoped: true,
  jsonColumns: ['data'],
  foreignKeys: { category_id: 'categories', sub_category_id: 'subcategories' },
});
mountResource('/addons', 'addons', { branchScoped: true, jsonColumns: ['data'] });
mountResource('/cuisines', 'cuisines', { branchScoped: true, jsonColumns: ['data'] });
mountResource('/deals', 'deals', { branchScoped: true, jsonColumns: ['data', 'slots'] });

router.get('/catalog', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  const scope = branchScopeFilter(req);
  // A branch's menu is its own rows plus the masters assigned to it, with the branch's overrides (the POS reads this).
  const [categories, subcategories, products, addons, cuisines, deals] = await Promise.all([
    bound ? branchCategories(r, bound) : buildCrud(pool, 'categories', { restaurantColumn: 'restaurant_id' }).list(r, scope),
    buildCrud(pool, 'subcategories', { restaurantColumn: 'restaurant_id' }).list(r, scope),
    bound ? branchProducts(r, bound) : buildCrud(pool, 'products', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] }).list(r, scope),
    buildCrud(pool, 'addons', { restaurantColumn: 'restaurant_id' }).list(r, scope),
    buildCrud(pool, 'cuisines', { restaurantColumn: 'restaurant_id' }).list(r, scope),
    buildCrud(pool, 'deals', { restaurantColumn: 'restaurant_id', jsonColumns: ['slots'] }).list(r, scope),
  ]);
  ok(res, { categories, subcategories, products, addons, cuisines, deals });
}));

const BULK_MAX_ROWS = 500;
const PRODUCT_TYPES = new Set(['', 'veg', 'nonveg']);
const RATE_TYPES = new Set(['percent', 'amount']);

function nonNegative(value) {
  const n = Number(value === undefined || value === null || value === '' ? 0 : value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Validates one imported product row. Returns the list of problems (empty when the row is valid)
 * and the normalised values used for the insert.
 */
function checkBulkRow(raw, categoryIds, subCategoryIds) {
  const problems = [];
  const name = String(raw.name || '').trim();
  if (!name) problems.push('name is required');
  if (name.length > 200) problems.push('name is longer than 200 characters');

  const categoryId = String(raw.category_id || '').trim();
  if (!categoryId || !categoryIds.has(categoryId)) problems.push('category_id does not match a category');

  const subCategoryId = String(raw.sub_category_id || '').trim() || null;
  if (subCategoryId && !subCategoryIds.has(subCategoryId)) problems.push('sub_category_id does not match a sub category');

  const price = nonNegative(raw.price);
  if (price === null || raw.price === undefined || raw.price === '') problems.push('price must be a number of 0 or more');
  const tax = nonNegative(raw.tax);
  if (tax === null) problems.push('tax must be a number of 0 or more');
  const discount = nonNegative(raw.discount);
  if (discount === null) problems.push('discount must be a number of 0 or more');

  const taxType = String(raw.tax_type || 'percent');
  if (!RATE_TYPES.has(taxType)) problems.push('tax_type must be percent or amount');
  const discountType = String(raw.discount_type || 'percent');
  if (!RATE_TYPES.has(discountType)) problems.push('discount_type must be percent or amount');
  const productType = String(raw.product_type || '');
  if (!PRODUCT_TYPES.has(productType)) problems.push('product_type must be veg, nonveg or empty');

  return {
    problems,
    row: {
      name,
      description: String(raw.description || ''),
      category_id: categoryId,
      sub_category_id: subCategoryId,
      price: price ?? 0,
      data: {
        tax: tax ?? 0,
        tax_type: taxType,
        discount: discount ?? 0,
        discount_type: discountType,
        product_type: productType,
        available_time_starts: String(raw.available_time_starts || ''),
        available_time_ends: String(raw.available_time_ends || ''),
        allergens: {},
        variations: [],
        addon_ids: [],
        tags: [],
        cuisines: [],
        tills: [],
        stock_type: 'unlimited',
        product_stock: 0,
        pos_visible: true,
        web_visible: true,
        app_visible: true,
        table_visible: true,
        img: '🍽️',
      },
    },
  };
}

/**
 * Bulk product import from the admin Bulk Import page. Every row is validated first; if any row is invalid
 * nothing is written and the response lists each problem by CSV line. Valid batches are inserted in one transaction.
 */
router.post('/products/bulk', asyncHandler(async (req, res) => {
  if (isBranchLogin(req)) throw forbidden(BRANCH_CANNOT_CREATE);
  const r = rid(req);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || rows.length === 0) throw badRequest('rows must be a non-empty array');
  if (rows.length > BULK_MAX_ROWS) throw badRequest(`Import at most ${BULK_MAX_ROWS} rows at a time`);

  // A branch login imports into its own branch: only its categories are valid, and every row gets its branch_id.
  const bound = branchId(req);
  const branchClause = bound ? ' AND branch_id = $2' : '';
  const scopeParams = bound ? [r, bound] : [r];
  const [{ rows: cats }, { rows: subs }] = await Promise.all([
    pool.query(`SELECT id FROM categories WHERE restaurant_id = $1${branchClause}`, scopeParams),
    pool.query(`SELECT id FROM subcategories WHERE restaurant_id = $1${branchClause}`, scopeParams),
  ]);
  const categoryIds = new Set(cats.map((c) => c.id));
  const subCategoryIds = new Set(subs.map((s) => s.id));

  const errors = [];
  const prepared = [];
  rows.forEach((raw, index) => {
    const { problems, row } = checkBulkRow(raw || {}, categoryIds, subCategoryIds);
    if (problems.length) errors.push({ line: index + 2, problems });
    else prepared.push(row);
  });
  if (errors.length) {
    res.status(422).json({ success: false, error: { code: 'VALIDATION_FAILED', message: `${errors.length} row(s) need fixing`, details: errors } });
    return;
  }

  const batch = Date.now().toString(36);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [index, row] of prepared.entries()) {
      await client.query(
        `INSERT INTO products (id, restaurant_id, name, description, category_id, sub_category_id, price, from_price, data, status, visible, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, TRUE, $10)`,
        [`prd_${batch}_${index}`, r, row.name, row.description, row.category_id, row.sub_category_id, row.price, row.price, JSON.stringify(row.data), bound || null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  ok(res, { imported: prepared.length });
}));

module.exports = router;
