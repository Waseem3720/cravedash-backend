/**
 * Server-side catalogue pricing for order lines (ORD-M1, ORD-H2).
 *
 * A line's price is never taken from the client. The base price and the variation option come from the product row,
 * and each add-on price comes from the add-ons table, matched by name. Shared by the order-service (online and
 * restaurant-created orders) and the epos-service sync (offline outbox), so both price lines the same way.
 */

/** Thrown for a line the catalogue cannot price. The line is refused for good, not retried. */
class RejectedLine extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectedLine';
    this.rejected = true;
  }
}

/** Finds a variation option's catalogue price by its label, searching nested option groups. */
function findOptionPrice(groups, label) {
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const opt of Array.isArray(group.values) ? group.values : []) {
      if (String(opt.label || '') === label) return Number(opt.price) || 0;
      const nested = findOptionPrice(opt.optionGroups, label);
      if (nested != null) return nested;
    }
  }
  return null;
}

/**
 * Prices order lines from the server catalogue: base price from the product, option price from the product's
 * variations, and add-on prices from the add-ons table. Unknown or unavailable products, options and add-ons throw
 * RejectedLine. The client prices are ignored.
 *
 * @param {{query: Function}} db pg pool or client
 * @param {string} restaurantId
 * @param {Array<object>} items order lines as sent by the client
 * @param {{branchId?: string|null}} [opts] a branch-bound caller prices only products of its own branch (Option A);
 *   a product of another branch, or one with no branch, is refused. Owners pass nothing and see every product.
 * @returns {Promise<Array<object>>} the same lines with server prices (price and addon prices)
 */
async function priceLinesFromCatalogue(db, restaurantId, items, opts = {}) {
  const lines = Array.isArray(items) ? items : [];
  // 'main' is the legacy name for "no branch" (the restaurant itself), so it prices master-only, like no branch at all.
  const branch = opts.branchId && String(opts.branchId) !== 'main' ? String(opts.branchId) : null;
  const productIds = [...new Set(lines.map((it) => String((it && it.product_id) || '')).filter(Boolean))];
  // A branch prices its own products, and the restaurant products assigned to it at the branch's price. An assignment
  // that is switched off makes the product unavailable at that branch. The owner (no branch) prices the master.
  // With no branch the line is master-only: restaurant-level products, and nothing that belongs to a branch.
  // With a branch: the branch's own products, plus the master products explicitly assigned to it.
  const { rows: products } = productIds.length
    ? await db.query(
      `SELECT p.id, COALESCE(a.price, p.price) AS price, (p.status AND COALESCE(a.active, TRUE)) AS status, p.data
         FROM products p
         LEFT JOIN product_branch_assignments a ON a.product_id = p.id AND a.branch_id = $3
        WHERE p.restaurant_id = $1 AND p.id = ANY($2::text[])
          AND (CASE WHEN $3::text IS NULL THEN p.branch_id IS NULL
                    ELSE (p.branch_id = $3 OR (p.branch_id IS NULL AND a.product_id IS NOT NULL)) END)`,
      [restaurantId, productIds, branch],
    )
    : { rows: [] };
  const productById = new Map(products.map((p) => [String(p.id), p]));
  // BUG-014: add-ons follow the same scope as products. No branch: master add-ons only. A branch: its own add-ons,
  // and a branch add-on wins over a master add-on with the same name, so one branch can never price another branch's add-on.
  const { rows: addonRows } = await db.query(
    `SELECT name, price, branch_id FROM addons
      WHERE restaurant_id = $1
        AND (CASE WHEN $2::text IS NULL THEN branch_id IS NULL ELSE (branch_id IS NULL OR branch_id = $2) END)`,
    [restaurantId, branch],
  );
  const addonByName = new Map();
  for (const a of addonRows) {
    const key = String(a.name || '').toLowerCase();
    const current = addonByName.get(key);
    if (!current || (a.branch_id != null && current.branch_id == null)) addonByName.set(key, a);
  }

  return lines.map((it) => {
    const product = productById.get(String((it && it.product_id) || ''));
    if (!product) {
      throw new RejectedLine(branch ? "This product is not on this branch's menu" : 'Product is not on the menu');
    }
    if (product.status === false) throw new RejectedLine('Product is not on the menu');
    // BUG-012: a line is a whole number of items from 1 up. Zero or negative quantities would reduce the order total.
    const qty = it.qty === undefined || it.qty === null ? 1 : Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new RejectedLine('Quantity must be a whole number from 1');
    let optionPrice = 0;
    if (it.variation) {
      const found = findOptionPrice(product.data && product.data.variations, String(it.variation));
      if (found == null) throw new RejectedLine(`Option "${it.variation}" is not on this product`);
      optionPrice = found;
    }
    const addons = (Array.isArray(it.addons) ? it.addons : []).map((a) => {
      const row = addonByName.get(String((a && a.name) || '').toLowerCase());
      if (!row) throw new RejectedLine(`Add-on "${a && a.name}" is not on the menu`);
      return { ...a, price: Number(row.price) || 0 };
    });
    return { ...it, qty, price: (Number(product.price) || 0) + optionPrice, addons };
  });
}

module.exports = { priceLinesFromCatalogue, findOptionPrice, RejectedLine };
