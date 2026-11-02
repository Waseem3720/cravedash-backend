/**
 * Prices the deal lines of a website order. A deal costs its own price (not the sum of its items); the customer's
 * choices must fill every slot the required number of times, and each choice must be an item of that slot. Deals and
 * products are read from the restaurant's own rows, so a deal from another restaurant is refused.
 */
const { RejectedLine } = require('@cravedash/shared/src/catalogPricing');
const { normalizeDealSlots, dealProductLookups } = require('@cravedash/shared/src/dealSlots');
const { DEAL_BRANCH_SCOPE_SQL } = require('@cravedash/shared/src/dealScope');

/**
 * opts.branchId: the branch the order is for. A deal the branch cannot show (another branch's, or a master deal not
 * assigned to it) is refused as unavailable. No branch prices the master menu only.
 */
async function priceDealLines(db, restaurantId, lines, opts = {}) {
  if (!lines.length) return [];
  const dealIds = [...new Set(lines.map((line) => String(line.deal_id)))];
  const branch = opts.branchId && String(opts.branchId) !== 'main' ? String(opts.branchId) : null;
  const { rows: deals } = await db.query(
    `SELECT d.id, d.name, d.price, d.slots, d.status FROM deals d
      WHERE d.restaurant_id = $1 AND ${DEAL_BRANCH_SCOPE_SQL} AND d.id = ANY($3::text[])`,
    [restaurantId, branch, dealIds],
  );
  const dealById = new Map(deals.map((deal) => [String(deal.id), deal]));
  /* All the restaurant's products: the names of the picked items, and the products of each category slot. */
  const { rows: products } = await db.query(
    'SELECT id, name, status, visible, category_id FROM products WHERE restaurant_id = $1',
    [restaurantId],
  );
  const productById = new Map(products.map((p) => [String(p.id), p]));
  const { nameById, categoryItems } = dealProductLookups(products);

  return lines.map((line) => {
    const deal = dealById.get(String(line.deal_id));
    if (!deal || deal.status === false) throw new RejectedLine('This deal is not available');
    const qty = Number(line.qty ?? line.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new RejectedLine('Quantity must be a whole number from 1');
    const slots = normalizeDealSlots(deal.slots, nameById, categoryItems);
    const selections = Array.isArray(line.selections) ? line.selections : [];
    const chosen = [];
    for (const slot of slots) {
      const picks = selections.filter((pick) => String(pick && pick.slot_id) === slot.id);
      if (picks.length !== slot.required) {
        throw new RejectedLine(`Choose ${slot.required} for "${slot.label}"`);
      }
      for (const pick of picks) {
        const wanted = String((pick && pick.name) || '').trim().toLowerCase();
        const item = slot.items.find((entry) => entry.name.trim().toLowerCase() === wanted);
        if (!item) throw new RejectedLine('That choice is not part of this deal');
        const product = productById.get(item.product_id);
        if (product && (product.status === false || product.visible === false)) {
          throw new RejectedLine(`${item.name} is not available right now`);
        }
        chosen.push(item.name);
      }
    }
    if (chosen.length !== selections.length) throw new RejectedLine('This deal has a choice that does not belong to it');
    return {
      deal_id: String(deal.id),
      name: deal.name,
      product_id: null,
      qty,
      price: Number(deal.price) || 0,
      addons: [],
      selections: chosen,
    };
  });
}

module.exports = { priceDealLines };
