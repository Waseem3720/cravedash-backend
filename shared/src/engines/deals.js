const pool = require('../db');
const { badRequest, notFound } = require('../errors');

/**
 * Authoritatively validates deal combo slot selections, checks repeat rules,
 * verifies allowed/excluded products and addons against the database, and
 * calculates the authoritative total deal price.
 *
 * @param {string} restaurantId - The tenant restaurant ID
 * @param {object} body - Request body containing deal_id and slot selections
 * @param {object} [dbPool] - Optional DB pool override
 * @returns {Promise<object>} The calculated deal preview and line item structure
 */
async function calculateDealPreview(restaurantId, body, dbPool) {
  const db = dbPool || pool;
  if (!restaurantId) throw badRequest('Restaurant ID is required');

  const dealId = body.deal_id || body.id;
  if (!dealId) throw badRequest('deal_id is required');

  const { rows: dealRows } = await db.query(
    'SELECT * FROM deals WHERE id = $1 AND restaurant_id = $2 AND status = true',
    [dealId, restaurantId]
  );
  const deal = dealRows[0];
  if (!deal) throw notFound('Deal not found or inactive');

  let slotsDef = deal.slots;
  if (typeof slotsDef === 'string') {
    try {
      slotsDef = JSON.parse(slotsDef);
    } catch {
      slotsDef = [];
    }
  }
  if (!Array.isArray(slotsDef)) slotsDef = [];

  const rawSelections = body.items || body.selections || body.slots || [];
  let selectionList = [];
  if (Array.isArray(rawSelections)) {
    selectionList = rawSelections;
  } else if (rawSelections && typeof rawSelections === 'object') {
    for (const [sId, sItems] of Object.entries(rawSelections)) {
      if (Array.isArray(sItems)) {
        sItems.forEach((it) => selectionList.push({ ...it, slot_id: it.slot_id || sId }));
      } else if (sItems && typeof sItems === 'object') {
        selectionList.push({ ...sItems, slot_id: sItems.slot_id || sId });
      }
    }
  }

  const basePrice = Number(deal.price) || 0;
  let extraCharges = 0;
  const verifiedSlots = [];
  const lineItemDetails = [];
  const summaryLines = [];

  for (let idx = 0; idx < slotsDef.length; idx++) {
    const slot = slotsDef[idx] || {};
    const slotId = slot.id != null ? String(slot.id) : String(idx);
    const slotName = slot.name || `Slot ${idx + 1}`;
    const requiredQty = Number(slot.required ?? slot.quantity ?? slot.min ?? 1);
    const allowRepeats = slot.allow_repeats !== false && slot.repeatable !== false;
    const allowedProductIds = Array.isArray(slot.product_ids) && slot.product_ids.length
      ? slot.product_ids.map(String)
      : null;
    const excludedProductIds = Array.isArray(slot.excluded_product_ids)
      ? slot.excluded_product_ids.map(String)
      : [];

    const slotItems = selectionList.filter((item) => {
      const matchId = item.slot_id != null ? String(item.slot_id) : null;
      const matchIdx = item.slot_index != null ? Number(item.slot_index) : null;
      return matchId === slotId || matchId === String(idx) || matchIdx === idx;
    });

    const totalQty = slotItems.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0);
    if (totalQty !== requiredQty) {
      throw badRequest(`Slot "${slotName}" requires exactly ${requiredQty} item(s), but ${totalQty} provided`);
    }

    if (!allowRepeats) {
      const seen = new Set();
      for (const it of slotItems) {
        const pid = String(it.product_id);
        const qty = Number(it.quantity) || 1;
        if (qty > 1 || seen.has(pid)) {
          throw badRequest(`Slot "${slotName}" does not allow repeated items ("${pid}")`);
        }
        seen.add(pid);
      }
    }

    for (const it of slotItems) {
      if (!it.product_id) throw badRequest(`product_id is required for slot "${slotName}"`);
      const pid = String(it.product_id);
      if (allowedProductIds && !allowedProductIds.includes(pid)) {
        throw badRequest(`Product "${pid}" is not allowed for slot "${slotName}"`);
      }
      if (excludedProductIds.includes(pid)) {
        throw badRequest(`Product "${pid}" is excluded from slot "${slotName}"`);
      }
    }

    const pids = slotItems.map((it) => String(it.product_id));
    const { rows: prodRows } = await db.query(
      'SELECT id, name, price, data FROM products WHERE restaurant_id = $1 AND id = ANY($2::text[]) AND status = true',
      [restaurantId, pids]
    );
    const prodMap = new Map(prodRows.map((p) => [String(p.id), p]));

    for (const it of slotItems) {
      const pid = String(it.product_id);
      const qty = Math.max(1, parseInt(it.quantity || 1, 10));
      const prod = prodMap.get(pid);
      if (!prod) {
        throw badRequest(`Product "${pid}" not found or inactive for restaurant`);
      }

      let itemExtra = 0;

      // Derive item-level surcharge strictly from trusted slot configuration, never client input
      const slotItemCharges = (slot.item_extra_charges && typeof slot.item_extra_charges === 'object')
        ? slot.item_extra_charges
        : {};
      const trustedItemCharge = Number(slotItemCharges[pid] || 0);
      if (trustedItemCharge > 0) {
        itemExtra += trustedItemCharge * qty;
      }

      const verifiedAddons = [];
      if (Array.isArray(it.addons) && it.addons.length > 0) {
        const addonIds = it.addons
          .map((a) => (typeof a === 'object' && a !== null ? a.id : a))
          .filter(Boolean);

        if (addonIds.length) {
          const { rows: addonRows } = await db.query(
            'SELECT id, name, price FROM addons WHERE restaurant_id = $1 AND id = ANY($2::text[]) AND status = true',
            [restaurantId, addonIds]
          );
          const addonMap = new Map(addonRows.map((a) => [String(a.id), a]));

          for (const rawAddon of it.addons) {
            const aid = String(typeof rawAddon === 'object' && rawAddon !== null ? rawAddon.id : rawAddon);
            const aDoc = addonMap.get(aid);
            if (aDoc) {
              const aQty = Math.max(1, parseInt(rawAddon.quantity || 1, 10));
              const aPrice = Number(aDoc.price) || 0;
              const aTotal = Number((aPrice * aQty * qty).toFixed(2));
              itemExtra += aTotal;
              verifiedAddons.push({
                id: aDoc.id,
                name: aDoc.name,
                price: aPrice,
                quantity: aQty,
                total: aTotal,
              });
            }
          }
        }
      }

      extraCharges += itemExtra;
      lineItemDetails.push({
        slot_id: slotId,
        slot_name: slotName,
        product_id: prod.id,
        name: prod.name,
        quantity: qty,
        addons: verifiedAddons,
        extra_charge: Number(itemExtra.toFixed(2)),
      });

      summaryLines.push(
        `${qty}x ${prod.name}${verifiedAddons.length ? ` (+${verifiedAddons.map((a) => a.name).join(', ')})` : ''}`
      );
    }

    // Add trusted slot-level base extra charge if configured
    if (slot.extra_charge && Number(slot.extra_charge) > 0) {
      extraCharges += Number(slot.extra_charge);
    }

    verifiedSlots.push({
      slot_id: slotId,
      name: slotName,
      required: requiredQty,
      selected_count: totalQty,
      items: slotItems,
    });
  }

  const finalExtra = Number(extraCharges.toFixed(2));
  const totalPrice = Number((basePrice + finalExtra).toFixed(2));

  return {
    deal_id: deal.id,
    name: deal.name,
    base_price: basePrice,
    extra_charges: finalExtra,
    total_price: totalPrice,
    slots: verifiedSlots,
    items: lineItemDetails,
    summary: summaryLines,
  };
}

module.exports = { calculateDealPreview };
