/**
 * Public, read-only catalogue for the website (no login). Only active and visible rows of one restaurant are returned.
 * Rows keep the database field names. Writes are not routed here, and the gateway allows only these GET paths anonymously.
 */
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { badRequest, notFound } = require('@cravedash/shared/src/errors');
const { isRestaurantBranch } = require('@cravedash/shared/src/branches');
const { DEAL_BRANCH_SCOPE_SQL } = require('@cravedash/shared/src/dealScope');
const { branchProducts } = require('./branchCatalog');
const { normalizeDealSlots, dealProductLookups } = require('@cravedash/shared/src/dealSlots');

const router = express.Router();
const LIMIT = 500;

/** The restaurant comes from the query (restaurant_id). It must exist and be active. */
async function restaurantOf(req) {
  const id = String(req.query.restaurant_id || '').trim();
  if (!id) throw badRequest('restaurant_id is required');
  const { rows } = await pool.query('SELECT id FROM restaurants WHERE id = $1 AND status IS DISTINCT FROM FALSE', [id]);
  if (!rows[0]) throw badRequest('Unknown restaurant');
  return id;
}

/** A branch's status: a branch is on unless it is saved as off (false or 0). */
const branchOn = (b) => !(b && (b.status === false || b.status === 0));

/** A setting flag as the dashboard saves it: true, 'true', 1 or '1' mean on. Missing means off. */
const flagOn = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** A number from a setting. Missing or invalid means 0, so no value is invented. */
const amountOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The storefront configuration: the restaurant's branches, the order settings the website needs (bag charge, service
 * fee, free delivery) and the delivery areas. Nothing here is a default value: a missing setting is off or 0.
 */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** Phone, e-mail and address from the business setup, and the map position from the main branch setup. Blank values come back as null. */
function contactOf(business, mainBranch) {
  const latitude = text(mainBranch.latitude);
  const longitude = text(mainBranch.longitude);
  return {
    restaurant_phone: text(business.phone),
    restaurant_email: text(business.email),
    restaurant_address: text(business.address),
    restaurant_location_coverage: latitude && longitude ? { latitude, longitude } : null,
  };
}

const STORY_FIELDS = ['story_eyebrow', 'story_title', 'story_paragraph_1', 'story_paragraph_2', 'story_circle_label', 'story_image'];

/** The story fields as stored on the restaurant record; blank or missing fields come back as null. */
function storyOf(data) {
  const out = {};
  for (const key of STORY_FIELDS) {
    const value = data && typeof data[key] === 'string' ? data[key].trim() : '';
    out[key] = value || null;
  }
  return out;
}

router.get('/config', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const [{ rows: restRows }, { rows: opsRows }, { rows: settingRows }, { rows: areaRows }, { rows: bannerRows }, { rows: businessRows }, { rows: mainBranchRows }] = await Promise.all([
    pool.query('SELECT name, data FROM restaurants WHERE id = $1', [restaurant]),
    pool.query("SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'branches'", [restaurant]),
    pool.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurant, 'settings_order_settings']),
    pool.query("SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'delivery_areas'", [restaurant]),
    pool.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurant, 'banners']),
    // The business setup form (dashboard) saves the story with the rest of the business settings.
    pool.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurant, 'settings_business']),
    pool.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurant, 'settings_main_branch']),
  ]);

  // Branches: the restaurant record's branch_list and the panel document, merged by id (as shared/src/branches.js does).
  const fromRestaurant = Array.isArray(restRows[0] && restRows[0].data && restRows[0].data.branch_list) ? restRows[0].data.branch_list : [];
  const fromPanel = Array.isArray(opsRows[0] && opsRows[0].data) ? opsRows[0].data : [];
  const byId = new Map();
  for (const b of [...fromRestaurant, ...fromPanel]) {
    if (b && b.id !== undefined && b.id !== null && String(b.id) !== '') {
      byId.set(String(b.id), { id: String(b.id), name: b.name || String(b.id), status: branchOn(b) });
    }
  }

  const s = settingRows[0] && settingRows[0].data && typeof settingRows[0].data === 'object' && !Array.isArray(settingRows[0].data)
    ? settingRows[0].data
    : {};
  const areas = Array.isArray(areaRows[0] && areaRows[0].data) ? areaRows[0].data : [];
  // The "Our Story" section, set by the restaurant in the dashboard. Each field is null when it is not filled in.
  // The dashboard saves this blob as a one-item list, so the settings object is its first item.
  const businessData = businessRows[0] && businessRows[0].data;
  const story = storyOf(Array.isArray(businessData) ? businessData[0] : businessData);
  // Contact details from the business setup; the map position from the main branch setup.
  const businessSettings = Array.isArray(businessData) ? businessData[0] || {} : businessData || {};
  const mainBranchData = mainBranchRows[0] && mainBranchRows[0].data;
  const mainBranch = Array.isArray(mainBranchData) ? mainBranchData[0] || {} : mainBranchData || {};
  const contact = contactOf(businessSettings, mainBranch);

  // The logo is the restaurant's own image (a data URL or a path). Banners are the website banners that are switched on.
  const logo = restRows[0] && restRows[0].data && typeof restRows[0].data.logo === 'string' ? restRows[0].data.logo : null;
  const bannerList = Array.isArray(bannerRows[0] && bannerRows[0].data) ? bannerRows[0].data : [];
  const banners = bannerList
    .filter((b) => b && b.image && (b.status === true || b.status === 1 || b.status === 'true'))
    .map((b) => ({
      id: String(b.id ?? ''),
      image: String(b.image),
      title: b.title ? String(b.title) : null,
      item_type: b.item_type ? String(b.item_type) : null,
      product_id: b.product_id ? String(b.product_id) : null,
      category_id: b.category_id ? String(b.category_id) : null,
    }));

  ok(res, {
    restaurant: { id: restaurant, name: restRows[0] ? restRows[0].name : null, logo },
    ...story,
    ...contact,
    banners,
    branches: [...byId.values()],
    order_settings: {
      bag_charge_status: flagOn(s.bag_charge_status),
      bag_charge: amountOf(s.bag_charge),
      service_fee_status: flagOn(s.service_fee_status),
      service_fee: amountOf(s.service_fee),
      free_delivery_over_status: flagOn(s.free_delivery_over_status),
      free_delivery_over_amount: amountOf(s.free_delivery_over_amount),
    },
    delivery_areas: areas
      .filter((a) => a && a.area_name)
      .map((a) => ({ area_name: String(a.area_name), delivery_charge: amountOf(a.delivery_charge) })),
  });
}));

/**
 * Categories for the website. Without branch_id: the restaurant's master categories only. With branch_id: the branch's
 * own categories, plus the master categories assigned to it (the same rule as branchCategories in the staff catalogue).
 */
router.get('/categories', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const branch = await branchOf(req, restaurant);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.image, c.colour, c.text_colour, c.priority, c.num, c.status, c.data
       FROM categories c
       LEFT JOIN category_branch_assignments a ON a.category_id = c.id AND a.branch_id = $2 AND a.restaurant_id = $1
      WHERE c.restaurant_id = $1 AND c.status = TRUE
        AND (CASE WHEN $2::text IS NULL THEN c.branch_id IS NULL
                  ELSE (c.branch_id = $2 OR (c.branch_id IS NULL AND a.category_id IS NOT NULL AND a.active IS TRUE)) END)
      ORDER BY c.priority ASC, c.name ASC LIMIT $3`,
    [restaurant, branch, LIMIT],
  );
  ok(res, rows);
}));

/**
 * Products for the website. Without branch_id: the restaurant's master products only. With branch_id (a branch of this
 * restaurant): the same menu the staff see for that branch (branchProducts), with the branch's price and image overrides.
 */
async function publicProducts(restaurant, branch, { categoryId = null, productId = null } = {}) {
  if (!branch) {
    const params = [restaurant];
    let filter = '';
    if (categoryId) {
      params.push(categoryId);
      filter += ` AND category_id = $${params.length}`;
    }
    if (productId) {
      params.push(productId);
      filter += ` AND id = $${params.length}`;
    }
    params.push(LIMIT);
    const { rows } = await pool.query(
      `SELECT id, name, description, price, from_price, category_id, sub_category_id, status, visible, data
       FROM products WHERE restaurant_id = $1 AND status = TRUE AND visible = TRUE AND branch_id IS NULL${filter}
       ORDER BY name ASC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }
  // branchProducts returns each product once for the branch (one assignment per product and branch), so no duplicates.
  const rows = await branchProducts(restaurant, branch, productId);
  return rows
    .filter((p) => p.status === true && p.visible === true)
    .filter((p) => !categoryId || String(p.category_id) === String(categoryId))
    .slice(0, LIMIT)
    .map((p) => ({
      id: p.id, name: p.name, description: p.description, price: p.price, from_price: p.from_price,
      category_id: p.category_id, sub_category_id: p.sub_category_id, status: p.status, visible: p.visible, data: p.data,
    }));
}

/** The branch from the query. It must be a branch of this restaurant, or the request is refused. */
async function branchOf(req, restaurant) {
  if (req.query.branch_id === undefined || req.query.branch_id === '') return null;
  const branch = String(req.query.branch_id);
  if (!(await isRestaurantBranch(pool, restaurant, branch))) throw badRequest('Unknown branch for this restaurant');
  return branch;
}

router.get('/products', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const branch = await branchOf(req, restaurant);
  const categoryId = req.query.category_id ? String(req.query.category_id) : null;
  ok(res, await publicProducts(restaurant, branch, { categoryId }));
}));

router.get('/products/:id', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const branch = await branchOf(req, restaurant);
  const [product] = await publicProducts(restaurant, branch, { productId: String(req.params.id) });
  if (!product) throw notFound('Product not found');
  ok(res, product);
}));

router.get('/deals', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const branch = await branchOf(req, restaurant);
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.price, d.slots, d.one_tap, d.status, d.data->>'image' AS image
       FROM deals d
      WHERE d.restaurant_id = $1 AND d.status = TRUE AND ${DEAL_BRANCH_SCOPE_SQL}
      ORDER BY d.name ASC LIMIT $3`,
    [restaurant, branch, LIMIT],
  );
  /* All the restaurant's products: the names of the picked items, and the products of each category slot. */
  const { rows: products } = await pool.query(
    'SELECT id, name, status, visible, category_id FROM products WHERE restaurant_id = $1',
    [restaurant],
  );
  const { nameById, categoryItems } = dealProductLookups(products);
  ok(res, rows.map((deal) => ({ ...deal, id: String(deal.id), price: Number(deal.price) || 0, slots: normalizeDealSlots(deal.slots, nameById, categoryItems) })));
}));

/**
 * Add-ons the storefront offers: the restaurant's active add-ons, or a branch's own when branch_id is sent (a branch row
 * with the same name wins over the master row, as in the staff catalogue).
 */
router.get('/addons', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOf(req);
  const branch = await branchOf(req, restaurant);
  const { rows } = await pool.query(
    `SELECT id, name, price, branch_id FROM addons
      WHERE restaurant_id = $1 AND status IS DISTINCT FROM FALSE
        AND (CASE WHEN $2::text IS NULL THEN branch_id IS NULL ELSE (branch_id IS NULL OR branch_id = $2) END)
      ORDER BY name ASC LIMIT $3`,
    [restaurant, branch, LIMIT],
  );
  const byName = new Map();
  for (const row of rows) {
    const key = String(row.name || '').toLowerCase();
    const current = byName.get(key);
    if (!current || (row.branch_id != null && current.branch_id == null)) byName.set(key, row);
  }
  ok(res, [...byName.values()].map((row) => ({ id: String(row.id), name: row.name, price: Number(row.price) || 0 })));
}));

module.exports = router;
