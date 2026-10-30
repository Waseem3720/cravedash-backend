const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { buildCrud } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { notFound, badRequest, conflict } = require('@cravedash/shared/src/errors');
const { calculateDealPreview } = require('@cravedash/shared/src/engines/deals');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

function mountResource(path, table, opts = {}) {
  const crud = buildCrud(pool, table, { restaurantColumn: 'restaurant_id', jsonColumns: opts.jsonColumns || ['data', 'slots'], ...opts });

  router.get(path, asyncHandler(async (req, res) => {
    const rows = await crud.list(rid(req));
    ok(res, opts.parseRow ? rows.map(opts.parseRow) : rows);
  }));

  router.get(`${path}/:id`, asyncHandler(async (req, res) => {
    const row = await crud.getById(req.params.id, rid(req));
    if (!row) throw notFound();
    ok(res, opts.parseRow ? opts.parseRow(row) : row);
  }));

  router.post(path, asyncHandler(async (req, res) => {
    const body = { ...req.body };
    if (!body.id) body.id = `${table.slice(0, 3)}_${Date.now().toString(36)}`;
    created(res, await crud.create(body, rid(req)));
  }));

  router.put(`${path}/:id`, asyncHandler(async (req, res) => {
    ok(res, await crud.update(req.params.id, req.body, rid(req)));
  }));

  router.patch(`${path}/:id`, asyncHandler(async (req, res) => {
    ok(res, await crud.update(req.params.id, req.body, rid(req)));
  }));

  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    ok(res, await crud.remove(req.params.id, rid(req)));
  }));
}

function parseProduct(row) {
  if (!row) return row;
  const p = { ...row };
  ['data', 'variations', 'addons', 'attributes', 'choice_options'].forEach((k) => {
    if (typeof p[k] === 'string') {
      try { p[k] = JSON.parse(p[k]); } catch { }
    }
  });
  if (p.data && typeof p.data === 'object') {
    if (!p.addons && p.data.addons) p.addons = p.data.addons;
    if (!p.variations && p.data.variations) p.variations = p.data.variations;
    if (!p.choice_options && p.data.choice_options) p.choice_options = p.data.choice_options;
    if (p.priority == null && p.data.priority != null) p.priority = p.data.priority;
  }
  if (p.price != null) p.price = Number(p.price);
  return p;
}

/** Route alias for storefront categories product listing */
router.get('/categories/products/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const categoryId = req.params.id;
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id AND c.restaurant_id = p.restaurant_id
     WHERE p.restaurant_id = $1 AND (p.category_id = $2 OR p.sub_category_id = $2) AND p.status = true
     ORDER BY COALESCE((p.data->>'priority')::int, 0) ASC, p.id ASC`,
    [r, categoryId],
  );
  ok(res, rows.map(parseProduct));
}));

/** Route alias for storefront product details with enriched addons */
router.get('/products/details/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const productId = req.params.id;
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id AND c.restaurant_id = p.restaurant_id
     WHERE p.restaurant_id = $1 AND p.id = $2`,
    [r, productId],
  );
  if (!rows[0]) throw notFound('Product not found');
  const product = parseProduct(rows[0]);
  if (Array.isArray(product.addons) && product.addons.length) {
    const addonIds = product.addons.map((a) => (typeof a === 'object' ? a.id : a)).filter(Boolean);
    if (addonIds.length) {
      const { rows: addonRows } = await pool.query(
        'SELECT * FROM addons WHERE restaurant_id = $1 AND id = ANY($2::text[]) AND status = true',
        [r, addonIds],
      );
      product.addon_details = addonRows;
    }
  }
  ok(res, product);
}));

/**
 * CSV parser helper for product catalog import
 */
function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = [];
  let current = '';
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const nextChar = normalized[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);
  if (lines.length < 2) return [];

  const parseLine = (line) => {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const nc = line[j + 1];
      if (c === '"') {
        if (inQ && nc === '"') {
          field += '"';
          j++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const rawHeaders = parseLine(lines[0]);
  const headers = rawHeaders.map((h) => h.toLowerCase().replace(/[\s_-]+/g, '_').replace(/^"|"$/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const values = parseLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      let val = values[idx] != null ? values[idx].trim() : '';
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/""/g, '"');
      }
      obj[h] = val;
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * POST /api/v1/products/bulk-import
 * Batch imports product catalog rows transactionally from CSV or JSON.
 */
async function handleBulkImport(req, res) {
  const r = rid(req);
  let rawRows = [];

  if (Array.isArray(req.body?.products)) {
    rawRows = req.body.products;
  } else if (Array.isArray(req.body)) {
    rawRows = req.body;
  } else if (req.body?.csv && typeof req.body.csv === 'string') {
    rawRows = parseCsv(req.body.csv);
  } else if (typeof req.body === 'string' && req.body.includes(',')) {
    rawRows = parseCsv(req.body);
  } else {
    throw badRequest('Invalid format: provide CSV string in "csv" property or products array');
  }

  if (!rawRows || rawRows.length === 0) {
    throw badRequest('CSV or products array contains no data rows');
  }

  // Pre-validate categories
  const categoryIds = [...new Set(
    rawRows
      .map((row) => row.category_id || row.category)
      .filter((c) => c && typeof c === 'string' && c.trim())
  )];

  if (categoryIds.length > 0) {
    const { rows: existingCats } = await pool.query(
      'SELECT id FROM categories WHERE restaurant_id = $1 AND id = ANY($2::text[])',
      [r, categoryIds]
    );
    const existingCatSet = new Set(existingCats.map((c) => c.id));
    for (const catId of categoryIds) {
      if (!existingCatSet.has(catId)) {
        throw badRequest(`Category "${catId}" does not exist for this restaurant`);
      }
    }
  }

  // Validate items
  const validatedItems = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rowNum = i + 1;
    const name = (row.name || row.product_name || row.title || '').trim();
    if (!name) {
      throw badRequest(`Row ${rowNum}: product name is required`);
    }

    const priceRaw = row.price;
    const price = Number(priceRaw);
    if (priceRaw == null || isNaN(price) || price < 0) {
      throw badRequest(`Row ${rowNum}: price must be a valid non-negative number`);
    }

    const fromPriceRaw = row.from_price ?? price;
    const fromPrice = Number(fromPriceRaw);
    if (isNaN(fromPrice) || fromPrice < 0) {
      throw badRequest(`Row ${rowNum}: from_price must be a valid non-negative number`);
    }

    const tax = Number(row.tax || (row.data && row.data.tax) || 0);
    const discount = Number(row.discount || (row.data && row.data.discount) || 0);
    const isVeg = String(row.veg || row.is_veg || (row.data && row.data.veg) || '').toLowerCase() === 'true'
      || row.veg === true || row.veg === 1 || row.veg === '1';

    let status = true;
    if (row.status !== undefined) {
      const sStr = String(row.status).toLowerCase();
      status = sStr === 'true' || sStr === '1' || sStr === 'yes' || sStr === 'active';
    }

    validatedItems.push({
      id: row.id || `prod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      description: row.description || null,
      category_id: row.category_id || row.category || null,
      sub_category_id: row.sub_category_id || row.subcategory_id || row.subcategory || null,
      price,
      from_price: fromPrice,
      status,
      visible: row.visible !== false && String(row.visible).toLowerCase() !== 'false',
      data: {
        tax: isNaN(tax) ? 0 : tax,
        discount: isNaN(discount) ? 0 : discount,
        veg: isVeg,
        ...(typeof row.data === 'object' && row.data !== null ? row.data : {}),
      },
    });
  }

  // Check for duplicate product IDs within the import batch
  const seenIds = new Set();
  for (const item of validatedItems) {
    if (item.id && seenIds.has(item.id)) {
      throw conflict(`Duplicate product ID in import batch: "${item.id}"`);
    }
    if (item.id) seenIds.add(item.id);
  }

  // Transactional batch insert
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const item of validatedItems) {
      const { rows } = await client.query(
        `INSERT INTO products (
          id, restaurant_id, name, description, category_id, sub_category_id,
          price, from_price, data, status, visible, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, NOW(), NOW())
        RETURNING *`,
        [
          item.id,
          r,
          item.name,
          item.description,
          item.category_id,
          item.sub_category_id,
          item.price,
          item.from_price,
          JSON.stringify(item.data),
          item.status,
          item.visible,
        ]
      );
      inserted.push(rows[0]);
    }
    await client.query('COMMIT');
    const parsedProducts = inserted.map(parseProduct);
    const count = inserted.length;
    return res.status(201).json({
      success: true,
      imported_count: count,
      products: parsedProducts,
      data: {
        success: true,
        imported_count: count,
        products: parsedProducts,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      throw conflict('Duplicate product ID already exists in catalogue');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/products/bulk-export
 * Exports product catalog as CSV.
 */
async function handleBulkExport(req, res) {
  const r = rid(req);
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id AND c.restaurant_id = p.restaurant_id
     WHERE p.restaurant_id = $1
     ORDER BY p.id ASC`,
    [r]
  );
  const csvHeaders = ['id', 'name', 'category_id', 'sub_category_id', 'price', 'from_price', 'tax', 'discount', 'veg', 'status', 'description'];
  const csvRows = [csvHeaders.join(',')];
  for (const row of rows) {
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const tax = data.tax ?? 0;
    const discount = data.discount ?? 0;
    const veg = data.veg ? 'true' : 'false';
    const sanitizeFormula = (val) => {
      const s = String(val ?? '');
      // Neutralize formula characters (=, +, -, @, tab, CR) even if preceded by whitespace
      if (/^\s*[=+\-@\t\r]/.test(s)) {
        return `'${s}`;
      }
      return s;
    };
    const escapeCsv = (val) => {
      const s = sanitizeFormula(val);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    csvRows.push([
      escapeCsv(row.id),
      escapeCsv(row.name),
      escapeCsv(row.category_id),
      escapeCsv(row.sub_category_id),
      Number(row.price || 0).toFixed(2),
      Number(row.from_price || row.price || 0).toFixed(2),
      tax,
      discount,
      veg,
      row.status ? 'true' : 'false',
      escapeCsv(row.description),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="products_export.csv"');
  res.status(200).send(csvRows.join('\n'));
}

function handleBulkTemplate(req, res) {
  const templateCsv = 'name,category_id,sub_category_id,price,from_price,tax,discount,veg,status,description\n' +
    '"Margherita Pizza","cat_pizza","","12.50","12.50","0","0","true","true","Classic tomato, mozzarella and basil"\n' +
    '"Cheeseburger","cat_burgers","","9.99","9.99","0","0","false","true","Beef patty, cheddar, lettuce and special sauce"\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="products_bulk_template.csv"');
  res.status(200).send(templateCsv);
}

async function handleDealPreview(req, res) {
  const result = await calculateDealPreview(rid(req), req.body || {});
  ok(res, { success: true, deal_preview: result });
}

// Bulk product operations
const rawCsvParser = express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' });

router.post('/products/bulk-import', rawCsvParser, asyncHandler(handleBulkImport));
router.post('/catalog/products/bulk-import', rawCsvParser, asyncHandler(handleBulkImport));
router.get('/products/bulk-export', asyncHandler(handleBulkExport));
router.get('/catalog/products/bulk-export', asyncHandler(handleBulkExport));
router.get('/products/bulk-template', handleBulkTemplate);
router.get('/catalog/products/bulk-template', handleBulkTemplate);

// Deal preview routes
router.post('/deals/preview', asyncHandler(handleDealPreview));
router.post('/orders/deal-preview', asyncHandler(handleDealPreview));

mountResource('/categories', 'categories');
mountResource('/subcategories', 'subcategories');
mountResource('/products', 'products', { jsonColumns: ['data'], parseRow: parseProduct });
mountResource('/addons', 'addons', { jsonColumns: ['data'] });
mountResource('/cuisines', 'cuisines', { jsonColumns: ['data'] });
mountResource('/deals', 'deals', { jsonColumns: ['data', 'slots'] });

router.get('/catalog', asyncHandler(async (req, res) => {
  const r = rid(req);
  const [categories, subcategories, rawProducts, addons, cuisines, deals] = await Promise.all([
    buildCrud(pool, 'categories', { restaurantColumn: 'restaurant_id' }).list(r),
    buildCrud(pool, 'subcategories', { restaurantColumn: 'restaurant_id' }).list(r),
    buildCrud(pool, 'products', { restaurantColumn: 'restaurant_id', jsonColumns: ['data'] }).list(r),
    buildCrud(pool, 'addons', { restaurantColumn: 'restaurant_id' }).list(r),
    buildCrud(pool, 'cuisines', { restaurantColumn: 'restaurant_id' }).list(r),
    buildCrud(pool, 'deals', { restaurantColumn: 'restaurant_id', jsonColumns: ['slots'] }).list(r),
  ]);
  const products = rawProducts.map(parseProduct);
  ok(res, { categories, subcategories, products, addons, cuisines, deals });
}));

module.exports = router;
