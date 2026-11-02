/**
 * Restaurant-level products and categories assigned to branches.
 *
 * One master record (branch_id NULL) can be assigned to several branches. Each assignment carries that branch's own
 * overrides (price, image, active). A branch sees a master row only when it is assigned to the branch, and sees its
 * own branch rows as before. Nothing here copies or deletes a product or category.
 *
 *   GET    /product-assignments?branch_id=      owner: assignments of the restaurant
 *   POST   /product-assignments                 owner: assign master products to branches (idempotent)
 *   PATCH  /product-assignments/:productId/:branchId  owner: set overrides (null clears one)
 *   DELETE /product-assignments/:productId/:branchId  owner: unassign (the product stays)
 *   (the same four for /category-assignments, with active only)
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, notFound } = require('@cravedash/shared/src/errors');
const { isRestaurantBranch } = require('@cravedash/shared/src/branches');

const router = express.Router();
const MAX_IDS = 200;
const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;
const BRANCH_IMAGE_MAX_CHARS = 1.5 * 1024 * 1024;

/** Only the restaurant admin (or super) assigns. A branch login is refused whatever it sends. */
function assertRestaurantAdmin(req) {
  if (branchId(req) || req.user?.till_id || req.user?.role === 'epos') {
    throw forbidden('Only the restaurant admin can assign products and categories to branches');
  }
}

function idList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${label} must be a non-empty list`);
  if (value.length > MAX_IDS) throw badRequest(`Assign at most ${MAX_IDS} ${label} at a time`);
  const ids = [...new Set(value.map((v) => String(v)))];
  if (ids.some((id) => !/^[A-Za-z0-9_.-]{1,120}$/.test(id))) throw badRequest(`${label} contains an invalid id`);
  return ids;
}

async function assertBranches(r, branchIds) {
  for (const b of branchIds) {
    if (!(await isRestaurantBranch(pool, r, b))) throw badRequest(`Branch ${b} does not belong to this restaurant`);
  }
}

/** A branch price is explicit: a number from 0 to 99999.99 with at most two decimals. Nothing falls back silently. */
function branchPrice(value) {
  if (value === undefined || value === null || value === '') throw badRequest('price is required: set this branch\'s own price');
  const s = String(value).trim();
  const n = Number(s);
  if (!PRICE_RE.test(s) || !Number.isFinite(n) || n < 0 || n > 99999.99) {
    throw badRequest('price must be a number from 0 to 99999.99 with at most two decimals');
  }
  return s;
}

function overrideValue(value, label) {
  if (value === undefined) return undefined;
  if (label === 'price') return branchPrice(value);
  if (value === null) return null;
  const s = String(value).trim();
  if (label === 'image') {
    // Images are stored as data URLs, like the product form. The 1 MB file limit keeps the request under the 2 MB JSON limit.
    if (s.length > BRANCH_IMAGE_MAX_CHARS) throw badRequest('image is too large: use an image under 1 MB');
    if (s.startsWith('data:') && !s.startsWith('data:image/')) throw badRequest('image must be an image file');
  }
  return s;
}

/** A branch login is a restaurant login bound to one branch. An owner viewing a branch (branch context) is not. */
function isBranchLogin(req) {
  return Boolean(branchId(req)) && !req.user?.branch_context;
}

function parseActive(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest('active must be true or false');
  return value;
}

// ---- products ----

router.get('/product-assignments', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const r = restaurantId(req);
  const params = [r];
  let filter = '';
  if (req.query.branch_id) {
    params.push(String(req.query.branch_id));
    filter = ` AND a.branch_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT a.product_id, a.branch_id, a.price, a.image, a.active, a.assigned_at, p.name AS product_name
       FROM product_branch_assignments a JOIN products p ON p.id = a.product_id
      WHERE a.restaurant_id = $1${filter} ORDER BY p.name, a.branch_id`,
    params,
  );
  ok(res, rows);
}));

router.post('/product-assignments', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const r = restaurantId(req);
  const productIds = idList(req.body?.product_ids, 'product_ids');
  const branchIds = idList(req.body?.branch_ids, 'branch_ids');
  // The branch price is required and explicit. It applies to every product and branch in this request.
  const price = branchPrice(req.body?.price);
  await assertBranches(r, branchIds);
  const { rows: masters } = await pool.query(
    'SELECT id FROM products WHERE restaurant_id = $1 AND branch_id IS NULL AND id = ANY($2::text[])',
    [r, productIds],
  );
  const known = new Set(masters.map((m) => m.id));
  const unknown = productIds.filter((id) => !known.has(id));
  if (unknown.length) throw badRequest(`Not restaurant-level products: ${unknown.join(', ')}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let assigned = 0;
    for (const productId of productIds) {
      for (const branch of branchIds) {
        const { rowCount } = await client.query(
          `INSERT INTO product_branch_assignments (restaurant_id, product_id, branch_id, price, active, assigned_by)
           VALUES ($1, $2, $3, $5, TRUE, $4) ON CONFLICT (product_id, branch_id) DO NOTHING`,
          [r, productId, branch, req.user?.name || req.user?.email || 'owner', price],
        );
        assigned += rowCount;
      }
    }
    await client.query('COMMIT');
    const total = productIds.length * branchIds.length;
    created(res, { assigned, already_assigned: total - assigned });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[assignments] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

router.patch('/product-assignments/:productId/:branchId', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const r = restaurantId(req);
  const body = req.body || {};
  const price = overrideValue(body.price, 'price');
  const image = overrideValue(body.image, 'image');
  const active = parseActive(body.active);
  if (price === undefined && image === undefined && active === undefined) throw badRequest('Nothing to change');
  const { rows } = await pool.query(
    `UPDATE product_branch_assignments
        SET price = CASE WHEN $4::boolean THEN $5::numeric ELSE price END,
            image = CASE WHEN $6::boolean THEN $7::text ELSE image END,
            active = COALESCE($8::boolean, active),
            updated_at = NOW()
      WHERE restaurant_id = $1 AND product_id = $2 AND branch_id = $3
      RETURNING product_id, branch_id, price, image, active`,
    [r, String(req.params.productId), String(req.params.branchId), price !== undefined, price ?? null, image !== undefined, image ?? null, active ?? null],
  );
  if (!rows[0]) throw notFound('Assignment not found');
  ok(res, rows[0]);
}));

router.delete('/product-assignments/:productId/:branchId', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const { rowCount } = await pool.query(
    'DELETE FROM product_branch_assignments WHERE restaurant_id = $1 AND product_id = $2 AND branch_id = $3',
    [restaurantId(req), String(req.params.productId), String(req.params.branchId)],
  );
  if (!rowCount) throw notFound('Assignment not found');
  ok(res, { removed: true });
}));

// ---- categories ----

router.get('/category-assignments', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const params = [restaurantId(req)];
  let filter = '';
  if (req.query.branch_id) {
    params.push(String(req.query.branch_id));
    filter = ` AND a.branch_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT a.category_id, a.branch_id, a.active, a.assigned_at, c.name AS category_name
       FROM category_branch_assignments a JOIN categories c ON c.id = a.category_id
      WHERE a.restaurant_id = $1${filter} ORDER BY c.name, a.branch_id`,
    params,
  );
  ok(res, rows);
}));

router.post('/category-assignments', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const r = restaurantId(req);
  const categoryIds = idList(req.body?.category_ids, 'category_ids');
  const branchIds = idList(req.body?.branch_ids, 'branch_ids');
  await assertBranches(r, branchIds);
  const { rows: masters } = await pool.query(
    'SELECT id FROM categories WHERE restaurant_id = $1 AND branch_id IS NULL AND id = ANY($2::text[])',
    [r, categoryIds],
  );
  const known = new Set(masters.map((m) => m.id));
  const unknown = categoryIds.filter((id) => !known.has(id));
  if (unknown.length) throw badRequest(`Not restaurant-level categories: ${unknown.join(', ')}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let assigned = 0;
    for (const categoryId of categoryIds) {
      for (const branch of branchIds) {
        const { rowCount } = await client.query(
          `INSERT INTO category_branch_assignments (restaurant_id, category_id, branch_id, active, assigned_by)
           VALUES ($1, $2, $3, TRUE, $4) ON CONFLICT (category_id, branch_id) DO NOTHING`,
          [r, categoryId, branch, req.user?.name || req.user?.email || 'owner'],
        );
        assigned += rowCount;
      }
    }
    await client.query('COMMIT');
    created(res, { assigned, already_assigned: categoryIds.length * branchIds.length - assigned });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[assignments] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

router.patch('/category-assignments/:categoryId/:branchId', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const active = parseActive(req.body?.active);
  if (active === undefined) throw badRequest('active must be true or false');
  const { rows } = await pool.query(
    `UPDATE category_branch_assignments SET active = $4, updated_at = NOW()
      WHERE restaurant_id = $1 AND category_id = $2 AND branch_id = $3 RETURNING category_id, branch_id, active`,
    [restaurantId(req), String(req.params.categoryId), String(req.params.branchId), active],
  );
  if (!rows[0]) throw notFound('Assignment not found');
  ok(res, rows[0]);
}));

router.delete('/category-assignments/:categoryId/:branchId', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const { rowCount } = await pool.query(
    'DELETE FROM category_branch_assignments WHERE restaurant_id = $1 AND category_id = $2 AND branch_id = $3',
    [restaurantId(req), String(req.params.categoryId), String(req.params.branchId)],
  );
  if (!rowCount) throw notFound('Assignment not found');
  ok(res, { removed: true });
}));

// ---- what a branch sees ----

/** Products a branch sees: its own rows plus the master rows assigned to it, with the branch's overrides applied. */
async function branchProducts(r, bound, id = null) {
  const { rows } = await pool.query(
    // The category and subcategory names come with the product, so a branch can read a restaurant product whose category
    // is not assigned to the branch. The names are read-only.
    `SELECT p.*, a.price AS a_price, a.image AS a_image, a.active AS a_active,
            pc.name AS category_name, ps.name AS sub_category_name
       FROM products p
       LEFT JOIN product_branch_assignments a ON a.product_id = p.id AND a.branch_id = $2
       LEFT JOIN categories pc ON pc.id = p.category_id AND pc.restaurant_id = p.restaurant_id
       LEFT JOIN subcategories ps ON ps.id = p.sub_category_id AND ps.restaurant_id = p.restaurant_id
      WHERE p.restaurant_id = $1 AND (p.branch_id = $2 OR (p.branch_id IS NULL AND a.product_id IS NOT NULL))
        AND ($3::text IS NULL OR p.id = $3)
      ORDER BY p.name`,
    [r, bound, id],
  );
  return rows.map(overlayProduct);
}

function overlayProduct(row) {
  const { a_price, a_image, a_active, ...base } = row;
  const isMaster = row.branch_id === null;
  if (!isMaster) return { ...base, is_master: false };
  const data = { ...(base.data || {}) };
  if (a_image) data.image = a_image;
  return {
    ...base,
    price: a_price !== null && a_price !== undefined ? a_price : base.price,
    status: Boolean(base.status) && Boolean(a_active),
    data,
    is_master: true,
    branch_override: { price: a_price ?? null, image: a_image ?? null, active: a_active ?? null },
  };
}

/** Categories a branch sees: its own plus the masters assigned to it. */
async function branchCategories(r, bound, id = null) {
  const { rows } = await pool.query(
    `SELECT c.*, a.active AS a_active
       FROM categories c
       LEFT JOIN category_branch_assignments a ON a.category_id = c.id AND a.branch_id = $2
      WHERE c.restaurant_id = $1 AND (c.branch_id = $2 OR (c.branch_id IS NULL AND a.category_id IS NOT NULL))
        AND ($3::text IS NULL OR c.id = $3)
      ORDER BY c.name`,
    [r, bound, id],
  );
  return rows.map((row) => {
    const { a_active, ...base } = row;
    if (row.branch_id !== null) return { ...base, is_master: false };
    return { ...base, status: Boolean(base.status) && Boolean(a_active), is_master: true, branch_override: { active: a_active ?? null } };
  });
}

/**
 * Subcategories a branch sees: its own, plus the restaurant's subcategories under a category the branch can see (assigned
 * or its own). A restaurant subcategory has no assignment of its own, so it is off for the branch when its parent is off.
 */
async function branchSubcategories(r, bound, id = null) {
  const { rows } = await pool.query(
    `SELECT s.*, a.active AS a_active
       FROM subcategories s
       LEFT JOIN category_branch_assignments a ON a.category_id = s.parent_id AND a.branch_id = $2 AND a.restaurant_id = $1
      WHERE s.restaurant_id = $1 AND ($3::text IS NULL OR s.id = $3)
        AND (s.branch_id = $2 OR (s.branch_id IS NULL AND a.category_id IS NOT NULL))
      ORDER BY s.name`,
    [r, bound, id],
  );
  return rows.map(({ a_active, ...row }) => {
    if (row.branch_id !== null) return { ...row, is_master: false };
    return { ...row, status: Boolean(row.status) && Boolean(a_active), is_master: true, branch_override: { active: a_active ?? null } };
  });
}

/** The ON/OFF a branch sets (status, or active): true, false, or undefined when the patch does not set it. */
function statusPatch(patch) {
  return parseActive(patch.status !== undefined ? patch.status : patch.active);
}

/** True when the patch changes something a branch may change for this table. */
function changesBranchFields(table, patch) {
  if (statusPatch(patch) !== undefined) return true;
  if (table !== 'products') return false;
  return patch.price !== undefined || patch.image !== undefined || patch.data?.image !== undefined;
}

/** A branch's own category or subcategory: any field other than its ON/OFF is refused when it would change. */
function assertStatusOnlyPatch(row, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'status' || key === 'active' || IGNORED_ON_PATCH.has(key)) continue;
    if (JSON.stringify(value) !== JSON.stringify(row[key] ?? null)) {
      throw forbidden(`A branch can change only the ON/OFF status here (not ${key})`);
    }
  }
}

/** A branch's own product: price, image and ON/OFF are set on the product row. Only that branch can reach the row. */
async function applyBranchOwnPatch(r, bound, table, id, patch) {
  const status = statusPatch(patch);
  if (table !== 'products') {
    const sql = table === 'categories'
      ? 'UPDATE categories SET status = COALESCE($4::boolean, status), updated_at = NOW() WHERE restaurant_id = $1 AND id = $2 AND branch_id = $3'
      : 'UPDATE subcategories SET status = COALESCE($4::boolean, status), updated_at = NOW() WHERE restaurant_id = $1 AND id = $2 AND branch_id = $3';
    await pool.query(sql, [r, id, bound, status ?? null]);
    return;
  }
  const price = patch.price !== undefined ? overrideValue(patch.price, 'price') : undefined;
  const imageSource = patch.image !== undefined ? patch.image : patch.data?.image;
  const image = imageSource !== undefined ? overrideValue(imageSource, 'image') : undefined;
  await pool.query(
    `UPDATE products
        SET price = CASE WHEN $4::boolean THEN $5::numeric ELSE price END,
            status = COALESCE($6::boolean, status),
            data = CASE WHEN $7::boolean THEN jsonb_set(COALESCE(data, '{}'::jsonb), '{image}', to_jsonb($8::text)) ELSE data END,
            updated_at = NOW()
      WHERE restaurant_id = $1 AND id = $2 AND branch_id = $3`,
    [r, id, bound, price !== undefined, price ?? null, status ?? null, image !== undefined, image ?? null],
  );
}

/** A restaurant category's ON/OFF for this branch only: the branch's assignment, never the category itself. */
async function applyBranchCategoryActive(r, bound, categoryId, active) {
  const { rowCount } = await pool.query(
    `UPDATE category_branch_assignments SET active = $4, updated_at = NOW()
      WHERE restaurant_id = $1 AND category_id = $2 AND branch_id = $3`,
    [r, categoryId, bound, active],
  );
  if (!rowCount) throw notFound();
}

const MASTER_EDITABLE = new Set(['price', 'status', 'active', 'image', 'data']);
const IGNORED_ON_PATCH = new Set(['id', 'restaurant_id', 'branch_id', 'created_at', 'updated_at']);

/**
 * A branch may change only the image, the price and active on a master product assigned to it. Any other field that
 * differs from the master is refused, so the form cannot change the master name, description or configuration.
 */
function assertBranchMasterPatch(row, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (MASTER_EDITABLE.has(key) || IGNORED_ON_PATCH.has(key)) continue;
    if (JSON.stringify(value) !== JSON.stringify(row[key] ?? null)) {
      throw forbidden(`A branch can change only image, price and active on restaurant products (not ${key})`);
    }
  }
  if (patch && patch.data && typeof patch.data === 'object') {
    for (const [key, value] of Object.entries(patch.data)) {
      if (key === 'image') continue;
      if (JSON.stringify(value) !== JSON.stringify((row.data || {})[key] ?? null)) {
        throw forbidden(`A branch can change only the image on restaurant products (not data.${key})`);
      }
    }
  }
}

/** Applies a permitted branch change to the branch's assignment, never to the master row. */
async function applyBranchMasterPatch(r, bound, productId, patch) {
  const price = patch.price !== undefined ? overrideValue(patch.price, 'price') : undefined;
  const imageSource = patch.image !== undefined ? patch.image : patch.data && patch.data.image !== undefined ? patch.data.image : undefined;
  const image = imageSource !== undefined ? overrideValue(imageSource, 'image') : undefined;
  const activeSource = patch.active !== undefined ? patch.active : patch.status !== undefined ? patch.status : undefined;
  const active = parseActive(activeSource);
  const { rowCount } = await pool.query(
    `UPDATE product_branch_assignments
        SET price = CASE WHEN $4::boolean THEN $5::numeric ELSE price END,
            image = CASE WHEN $6::boolean THEN $7::text ELSE image END,
            active = COALESCE($8::boolean, active),
            updated_at = NOW()
      WHERE restaurant_id = $1 AND product_id = $2 AND branch_id = $3`,
    [r, productId, bound, price !== undefined, price ?? null, image !== undefined, image ?? null, active ?? null],
  );
  if (!rowCount) throw notFound();
}

module.exports = {
  router,
  branchProducts,
  branchCategories,
  branchSubcategories,
  isBranchLogin,
  assertBranchMasterPatch,
  applyBranchMasterPatch,
  assertStatusOnlyPatch,
  changesBranchFields,
  applyBranchOwnPatch,
  applyBranchCategoryActive,
  statusPatch,
};
