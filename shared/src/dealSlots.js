/**
 * Deal slots as the storefront reads them: { id, label, required, items: [{ product_id, name }] }.
 *
 * The dashboard stores a slot as { id, name, qty, fill, items, category_id }:
 *   - fill 'pick' (or no fill): the customer picks from the slot's items, each { product, name_snapshot? }.
 *   - fill 'category': the customer picks from every available product in category_id.
 * An item's name is its name_snapshot, else the product's current name. A slot without a label is called "Choose N".
 */
function normalizeDealSlots(rawSlots, productNameById = new Map(), categoryItems = new Map()) {
  const slots = Array.isArray(rawSlots) ? rawSlots : [];
  return slots.map((slot, index) => {
    const required = Math.max(1, Number(slot && (slot.required ?? slot.qty)) || 1);
    const storedItems = (Array.isArray(slot && slot.items) ? slot.items : [])
      .map((item) => {
        const productId = item && typeof item === 'object' ? (item.product ?? item.product_id) : item;
        if (productId == null) return null;
        const name = (item && typeof item === 'object' && (item.name_snapshot || item.name)) || productNameById.get(String(productId)) || `Item ${productId}`;
        return { product_id: String(productId), name: String(name) };
      })
      .filter(Boolean);
    const items = slot && slot.fill === 'category'
      ? (categoryItems.get(String(slot.category_id)) || []).map((entry) => ({ ...entry }))
      : storedItems;
    return {
      id: slot && slot.id != null ? String(slot.id) : String(index),
      label: (slot && (slot.label || slot.name)) || `Choose ${required}`,
      required,
      items,
    };
  });
}

/** Every product id a deal's stored slots refer to. */
function dealProductIds(rawSlots) {
  const ids = new Set();
  for (const slot of Array.isArray(rawSlots) ? rawSlots : []) {
    for (const item of Array.isArray(slot && slot.items) ? slot.items : []) {
      const id = item && typeof item === 'object' ? (item.product ?? item.product_id) : item;
      if (id != null) ids.add(String(id));
    }
  }
  return [...ids];
}

/**
 * From a restaurant's product rows ({ id, name, category_id, status, visible }) builds the two lookups the slots need:
 * every product's name, and each category's products that can be ordered now (for 'category' slots).
 */
function dealProductLookups(productRows) {
  const nameById = new Map();
  const categoryItems = new Map();
  for (const product of Array.isArray(productRows) ? productRows : []) {
    const id = String(product.id);
    nameById.set(id, product.name);
    if (product.status === false || product.visible === false || product.category_id == null) continue;
    const key = String(product.category_id);
    if (!categoryItems.has(key)) categoryItems.set(key, []);
    categoryItems.get(key).push({ product_id: id, name: product.name });
  }
  return { nameById, categoryItems };
}

module.exports = { normalizeDealSlots, dealProductIds, dealProductLookups };
