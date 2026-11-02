/**
 * Copy products and categories from one branch to other branches of the same restaurant.
 *
 *   POST /branch-copy   restaurant admin only
 *     { source_branch_id, destination_branch_ids: [..], product_ids: 'all' | [..], category_ids: 'all' | [..], dry_run }
 *
 * dry_run (the default) returns the plan and writes nothing. A real run writes everything in one transaction:
 *  - a restaurant master item is assigned to the destination (one master record, never a duplicate);
 *  - a branch-owned item is copied once. A copy is recorded in data.copied_from, so a repeat run skips it;
 *  - the assignment keeps the source branch's price, image and active state as the starting point, and then the two
 *    branches are independent;
 *  - orders, sales, stock and payments are never touched.
 */
const express = require('express');
const crypto = require('crypto');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden } = require('@cravedash/shared/src/errors');
const { isRestaurantBranch } = require('@cravedash/shared/src/branches');
const { branchProducts, branchCategories } = require('./branchCatalog');

const router = express.Router();
const MAX_IDS = 200;

function assertRestaurantAdmin(req) {
  if (branchId(req) || req.user?.till_id || req.user?.role === 'epos') {
    throw forbidden('Only the restaurant admin can copy products and categories between branches');
  }
}

function idList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${label} must be a non-empty list`);
  if (value.length > MAX_IDS) throw badRequest(`Copy at most ${MAX_IDS} ${label} at a time`);
  const ids = [...new Set(value.map((v) => String(v)))];
  if (ids.some((id) => !/^[A-Za-z0-9_.-]{1,120}$/.test(id))) throw badRequest(`${label} contains an invalid id`);
  return ids;
}

/**
 * Optional prices for this copy: { product_id: price }. Same rule as a branch price: 0 to 99999.99, at most 2 decimals.
 * The map is checked against the picked products inside planCopy.
 */
function priceOverrideMap(value) {
  const out = new Map();
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('price_overrides must be an object of product id to price');
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw badRequest('price_overrides contains an invalid id');
    const text = String(raw ?? '').trim();
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) throw badRequest(`The price for ${id} must be a number from 0 to 99999.99 with at most 2 decimals`);
    out.set(id, Number(text));
  }
  return out;
}

function newId(restaurant, prefix) {
  return `${restaurant}_${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The plan for each destination, computed from the current state (so a repeat run plans nothing new).
 * A product's category must exist at the destination: masters are assigned, owned categories are copied with it.
 * A branch's own subcategory is copied with its category, and a copied product keeps its subcategory. A restaurant
 * subcategory keeps its link when its category is assigned to the destination. Anything else is left out and reported.
 */
async function planCopy(db, { r, source, destinations, productIds, categoryIds, priceOverrides = new Map() }) {
  const srcProducts = await branchProducts(r, source);
  const srcCategories = await branchCategories(r, source);
  const pickedCats = categoryIds === 'all' ? srcCategories : srcCategories.filter((c) => categoryIds.includes(c.id));
  const pickedProds = productIds === 'all' ? srcProducts : srcProducts.filter((p) => productIds.includes(p.id));
  for (const id of priceOverrides.keys()) {
    if (!pickedProds.some((p) => p.id === id)) throw badRequest('price_overrides has a product that is not part of this copy');
  }
  const catById = new Map(srcCategories.map((c) => [c.id, c]));
  // Restaurant-level categories the source branch may not see. A restaurant product in one of them is still copied.
  const { rows: restaurantCats } = await db.query('SELECT id, name FROM categories WHERE restaurant_id = $1 AND branch_id IS NULL', [r]);
  const restaurantCatById = new Map(restaurantCats.map((c) => [c.id, { id: c.id, name: c.name, is_master: true }]));
  // Every subcategory of the restaurant: the source branch's own ones are copied, the restaurant's are linked as they are.
  const { rows: allSubs } = await db.query('SELECT id, parent_id, branch_id, name FROM subcategories WHERE restaurant_id = $1', [r]);
  const subById = new Map(allSubs.map((s) => [s.id, s]));
  const ownSubs = allSubs.filter((s) => s.branch_id === source);
  const { rows: rawProds } = await db.query(
    'SELECT id, category_id, sub_category_id FROM products WHERE restaurant_id = $1 AND id = ANY($2::text[])',
    [r, pickedProds.map((p) => p.id)],
  );
  const rawProdById = new Map(rawProds.map((p) => [p.id, p]));
  // The destination price of each product is the source branch's effective price: its assignment price, or the
  // product's own price. The preview and the copy both use this value. A product with no usable price is refused,
  // so a preview never shows a made-up number and nothing is written.
  const { rows: priced } = await db.query(
    `SELECT p.id, COALESCE(a.price, p.price) AS price
       FROM products p LEFT JOIN product_branch_assignments a ON a.product_id = p.id AND a.branch_id = $3
      WHERE p.restaurant_id = $1 AND p.id = ANY($2::text[])`,
    [r, pickedProds.map((p) => p.id), source],
  );
  const priceById = new Map(priced.map((x) => [x.id, x.price === null ? null : Number(x.price)]));
  const priceOf = (id, name) => {
    // A price the user set for this copy wins. It is used only for rows this run creates; a skipped row keeps its price.
    if (priceOverrides.has(id)) return priceOverrides.get(id);
    const v = priceById.get(id);
    if (v === null || v === undefined || !Number.isFinite(v) || v < 0) {
      throw badRequest(`${name} has no usable price at the source branch, so it cannot be copied`);
    }
    return v;
  };

  const plans = [];
  for (const dest of destinations) {
    const plan = { branch_id: dest, assign_products: [], assign_categories: [], copy_categories: [], copy_subcategories: [], copy_products: [], skipped: [], conflicts: [] };
    const { rows: assignedP } = await db.query('SELECT product_id FROM product_branch_assignments WHERE restaurant_id = $1 AND branch_id = $2', [r, dest]);
    const { rows: assignedC } = await db.query('SELECT category_id FROM category_branch_assignments WHERE restaurant_id = $1 AND branch_id = $2', [r, dest]);
    const { rows: copiedC } = await db.query(
      "SELECT id, data->>'copied_from' AS src FROM categories WHERE restaurant_id = $1 AND branch_id = $2 AND data ? 'copied_from'",
      [r, dest],
    );
    const { rows: copiedP } = await db.query(
      "SELECT id, data->>'copied_from' AS src FROM products WHERE restaurant_id = $1 AND branch_id = $2 AND data ? 'copied_from'",
      [r, dest],
    );
    const assignedProducts = new Set(assignedP.map((x) => x.product_id));
    const assignedCategories = new Set(assignedC.map((x) => x.category_id));
    const copiedCatOf = new Map(copiedC.map((x) => [x.src, x.id]));
    const { rows: copiedS } = await db.query(
      "SELECT id, data->>'copied_from' AS src FROM subcategories WHERE restaurant_id = $1 AND branch_id = $2 AND data ? 'copied_from'",
      [r, dest],
    );
    const copiedProdOf = new Map(copiedP.map((x) => [x.src, x.id]));
    const copiedSubOf = new Map(copiedS.map((x) => [x.src, x.id]));
    const destCategory = new Map(); // source category id -> destination category id, for the categories this plan uses
    const destSub = new Map(); // source subcategory id -> destination subcategory id, for the subcategories this plan uses

    const needed = new Set(pickedCats.map((c) => c.id));
    // A product needs its category at the destination: a copied product's category is copied with it, and a restaurant
    // product's restaurant category is assigned to the destination, so the product is not left in an unassigned category.
    for (const p of pickedProds) {
      const raw = rawProdById.get(p.id);
      if (raw && raw.category_id) needed.add(raw.category_id);
    }
    for (const catId of needed) {
      const c = catById.get(catId) || restaurantCatById.get(catId);
      if (!c) {
        plan.conflicts.push({ type: 'category', id: catId, reason: 'This category is not visible to the source branch' });
        continue;
      }
      if (c.is_master) {
        destCategory.set(c.id, c.id);
        if (assignedCategories.has(c.id)) plan.skipped.push({ type: 'category', id: c.id, name: c.name, reason: 'Already assigned' });
        else plan.assign_categories.push({ id: c.id, name: c.name });
      } else {
        const existing = copiedCatOf.get(c.id);
        if (existing) {
          destCategory.set(c.id, existing);
          plan.skipped.push({ type: 'category', id: c.id, name: c.name, reason: 'Already copied', existing_id: existing });
        } else {
          const newCat = newId(r, 'cat');
          destCategory.set(c.id, newCat);
          plan.copy_categories.push({ id: c.id, name: c.name, new_id: newCat });
        }
      }
    }

    // Subcategories to copy: the source's own ones under a copied category, and the own one a copied product uses.
    const subsToCopy = new Map(
      ownSubs.filter((s) => needed.has(s.parent_id) && !catById.get(s.parent_id)?.is_master).map((s) => [s.id, s]),
    );
    for (const p of pickedProds) {
      const raw = rawProdById.get(p.id) || {};
      const s = raw.sub_category_id ? subById.get(raw.sub_category_id) : null;
      if (!p.is_master && s && s.branch_id === source && destCategory.has(s.parent_id)) subsToCopy.set(s.id, s);
    }
    for (const s of subsToCopy.values()) {
      if (!destCategory.has(s.parent_id)) continue;
      const existing = copiedSubOf.get(s.id);
      if (existing) {
        destSub.set(s.id, existing);
        plan.skipped.push({ type: 'subcategory', id: s.id, name: s.name, reason: 'Already copied', existing_id: existing });
      } else {
        const newSub = newId(r, 'sub');
        destSub.set(s.id, newSub);
        plan.copy_subcategories.push({ id: s.id, name: s.name, new_id: newSub, parent_id: destCategory.get(s.parent_id) });
      }
    }
    // The subcategory a product keeps at this destination: its copy, or a restaurant subcategory whose category is there.
    const subAtDest = (subId) => {
      if (!subId) return null;
      if (destSub.has(subId)) return destSub.get(subId);
      const s = subById.get(subId);
      return s && s.branch_id === null && destCategory.has(s.parent_id) ? subId : null;
    };

    for (const p of pickedProds) {
      const raw = rawProdById.get(p.id) || {};
      if (p.is_master) {
        if (assignedProducts.has(p.id)) plan.skipped.push({ type: 'product', id: p.id, name: p.name, reason: 'Already assigned' });
        else plan.assign_products.push({ id: p.id, name: p.name, price: priceOf(p.id, p.name) });
        continue;
      }
      if (copiedProdOf.has(p.id)) {
        plan.skipped.push({ type: 'product', id: p.id, name: p.name, reason: 'Already copied', existing_id: copiedProdOf.get(p.id) });
        continue;
      }
      if (raw.category_id && !destCategory.has(raw.category_id)) {
        plan.conflicts.push({ type: 'product', id: p.id, name: p.name, reason: 'Its category is not part of this copy, so it was not copied' });
        continue;
      }
      const subId = subAtDest(raw.sub_category_id);
      if (raw.sub_category_id && !subId) {
        plan.conflicts.push({ type: 'product', id: p.id, name: p.name, reason: 'Its subcategory is not part of this copy, so the copy has none' });
      }
      plan.copy_products.push({ id: p.id, name: p.name, price: priceOf(p.id, p.name), new_id: newId(r, 'prd'), category_id: raw.category_id ? destCategory.get(raw.category_id) : null, sub_category_id: subId });
    }
    plans.push(plan);
  }
  return plans;
}

async function executeCopy(client, { r, source, plans, by }) {
  for (const plan of plans) {
    const dest = plan.branch_id;
    for (const c of plan.assign_categories) {
      await client.query(
        `INSERT INTO category_branch_assignments (restaurant_id, category_id, branch_id, active, assigned_by)
         SELECT $1, $2, $3, COALESCE((SELECT active FROM category_branch_assignments WHERE category_id = $2 AND branch_id = $4), TRUE), $5
         ON CONFLICT (category_id, branch_id) DO NOTHING`,
        [r, c.id, dest, source, by],
      );
    }
    for (const p of plan.assign_products) {
      await client.query(
        `INSERT INTO product_branch_assignments (restaurant_id, product_id, branch_id, price, image, active, assigned_by)
         SELECT $1, $2, $3, $6::numeric, a.image, COALESCE(a.active, TRUE), $5
           FROM (SELECT 1) AS one LEFT JOIN product_branch_assignments a ON a.product_id = $2 AND a.branch_id = $4
         ON CONFLICT (product_id, branch_id) DO NOTHING`,
        [r, p.id, dest, source, by, p.price],
      );
    }
    for (const c of plan.copy_categories) {
      await client.query(
        `INSERT INTO categories (id, restaurant_id, num, name, image, colour, text_colour, priority, status, data, branch_id)
         SELECT $3, restaurant_id, num, name, image, colour, text_colour, priority, status,
                COALESCE(data, '{}'::jsonb) || jsonb_build_object('copied_from', id::text, 'copied_from_branch', $4::text), $2
           FROM categories WHERE id = $1 AND restaurant_id = $5`,
        [c.id, dest, c.new_id, source, r],
      );
    }
    for (const s of plan.copy_subcategories) {
      await client.query(
        `INSERT INTO subcategories (id, restaurant_id, parent_id, name, colour, inherit_colour, status, data, branch_id)
         SELECT $3, restaurant_id, $4, name, colour, inherit_colour, status,
                COALESCE(data, '{}'::jsonb) || jsonb_build_object('copied_from', id::text, 'copied_from_branch', $5::text), $2
           FROM subcategories WHERE id = $1 AND restaurant_id = $6`,
        [s.id, dest, s.new_id, s.parent_id, source, r],
      );
    }
    for (const p of plan.copy_products) {
      await client.query(
        `INSERT INTO products (id, restaurant_id, name, description, category_id, sub_category_id, price, from_price, data, status, visible, branch_id)
         SELECT $3, pr.restaurant_id, pr.name, pr.description, $4, $8::text, $7::numeric, pr.from_price,
                COALESCE(pr.data, '{}'::jsonb)
                  || jsonb_build_object('copied_from', pr.id::text, 'copied_from_branch', $5::text)
                  || CASE WHEN a.image IS NOT NULL THEN jsonb_build_object('image', a.image) ELSE '{}'::jsonb END,
                COALESCE(a.active, pr.status), pr.visible, $2
           FROM products pr LEFT JOIN product_branch_assignments a ON a.product_id = pr.id AND a.branch_id = $5
          WHERE pr.id = $1 AND pr.restaurant_id = $6`,
        [p.id, dest, p.new_id, p.category_id, source, r, p.price, p.sub_category_id],
      );
    }
  }
}

router.post('/branch-copy', asyncHandler(async (req, res) => {
  assertRestaurantAdmin(req);
  const r = restaurantId(req);
  const body = req.body || {};
  const source = String(body.source_branch_id || '');
  if (!source) throw badRequest('source_branch_id is required');
  const destinations = idList(body.destination_branch_ids, 'destination_branch_ids');
  if (destinations.length > 20) throw badRequest('Copy to at most 20 branches at a time');
  if (destinations.includes(source)) throw badRequest('The source branch cannot also be a destination');
  for (const b of [source, ...destinations]) {
    if (!(await isRestaurantBranch(pool, r, b))) throw badRequest(`Branch ${b} does not belong to this restaurant`);
  }
  const productIds = body.product_ids === undefined || body.product_ids === 'all' ? 'all' : idList(body.product_ids, 'product_ids');
  // An empty category list means "no categories picked": the copied products bring their own categories anyway.
  const categoryIds = body.category_ids === undefined || body.category_ids === 'all' ? 'all'
    : Array.isArray(body.category_ids) && body.category_ids.length === 0 ? []
      : idList(body.category_ids, 'category_ids');
  const priceOverrides = priceOverrideMap(body.price_overrides);
  const by = req.user?.name || req.user?.email || 'owner';

  if (body.dry_run !== false) {
    const plans = await planCopy(pool, { r, source, destinations, productIds, categoryIds, priceOverrides });
    return ok(res, { dry_run: true, source_branch_id: source, plans });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`branch-copy:${r}`]);
    const plans = await planCopy(client, { r, source, destinations, productIds, categoryIds, priceOverrides });
    await executeCopy(client, { r, source, plans, by });
    await client.query('COMMIT');
    ok(res, { dry_run: false, source_branch_id: source, plans });
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('[branch-copy] rollback failed', rollbackErr));
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = { router };
