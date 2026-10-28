const { readDoc, writeDoc, appendRow, listRows, round4, round2, pool } = require('./helpers');

/** Simple advisory lock per restaurant ingredient to reduce stock races. */
async function withStockLock(restaurantId, ingredientId, fn) {
  const key = `inv:${restaurantId}:${ingredientId}`;
  const client = await pool.connect();
  let locked = false;
  try {
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      locked = true;
    } catch (err) {
      // In production, advisory locks must be strictly enforced.
      // Only bypass in non-production environments if the driver or sandbox lacks advisory lock support.
      if (process.env.NODE_ENV === 'production' || (err.code !== '42883' && !err.message?.includes('advisory'))) {
        throw err;
      }
    }
    return await fn(client);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          console.error('[inventory-lock] Failed to release advisory lock:', err.message);
        }
      }
    }
    client.release();
  }
}

async function getIngredients(restaurantId) {
  const list = await readDoc(restaurantId, 'inventory', 'ingredients', []);
  return Array.isArray(list) ? list : [];
}

async function saveIngredients(restaurantId, list) {
  return writeDoc(restaurantId, 'inventory', 'ingredients', list);
}

async function getRecipes(restaurantId) {
  const list = await readDoc(restaurantId, 'inventory', 'recipes', []);
  return Array.isArray(list) ? list : [];
}

function findIngredient(list, nameOrId) {
  const key = String(nameOrId || '').trim().toLowerCase();
  return list.find((i) => String(i.id) === String(nameOrId)
    || String(i.name || '').trim().toLowerCase() === key
    || String(i.sku || '').trim().toLowerCase() === key) || null;
}

/** Parse recipe items string: "Chicken thigh 0.18kg, Brioche bun 1" or structured array. */
function parseRecipeItems(items, ingredients) {
  if (Array.isArray(items)) {
    return items.map((it) => ({
      ingredient_id: it.ingredient_id || it.id,
      name: it.name || it.ingredient,
      qty: +it.qty || +it.quantity || 0,
    })).filter((x) => x.qty > 0);
  }
  const out = [];
  String(items || '').split(',').forEach((part) => {
    const s = part.trim();
    if (!s) return;
    const m = s.match(/^(.+?)\s+([\d.]+)\s*[a-zA-Z%]*$/);
    if (!m) return;
    const name = m[1].trim();
    const qty = +m[2];
    const ing = findIngredient(ingredients, name);
    out.push({ ingredient_id: ing?.id, name: ing?.name || name, qty });
  });
  return out.filter((x) => x.qty > 0);
}

/**
 * Post a stock movement and update ingredient.stock.
 * @param {'in'|'out'} dir
 */
async function postStockMove(restaurantId, {
  ingredient_id, ingredient, dir, qty, reason, cost, note, ref, by,
}) {
  const lockId = String(ingredient_id || ingredient || 'unknown');
  return withStockLock(restaurantId, lockId, async () => {
    const list = await getIngredients(restaurantId);
    const ing = findIngredient(list, ingredient_id || ingredient);
    if (!ing) {
      const err = new Error('Ingredient not found');
      err.status = 400; err.code = 'BAD_REQUEST'; throw err;
    }
    const q = round4(Math.abs(+qty || 0));
    if (!q) {
      const err = new Error('qty must be > 0');
      err.status = 400; err.code = 'BAD_REQUEST'; throw err;
    }
    if (dir !== 'in' && dir !== 'out') {
      const err = new Error('dir must be in or out');
      err.status = 400; err.code = 'BAD_REQUEST'; throw err;
    }
    const prev = round4(+ing.stock || 0);
    const next = dir === 'in' ? round4(prev + q) : round4(prev - q);
    if (dir === 'out' && next < -0.0001) {
      const err = new Error(`Insufficient stock for ${ing.name} (have ${prev}, need ${q})`);
      err.status = 400; err.code = 'BAD_REQUEST'; throw err;
    }
    ing.stock = next;
    if (dir === 'in' && cost != null && q > 0) {
      const unit = (+cost || 0) / q;
      const prevCost = +ing.avg_cost || 0;
      if (prev > 0 && prevCost > 0) {
        ing.avg_cost = round2(((prev * prevCost) + (+cost || 0)) / (prev + q));
      } else {
        ing.avg_cost = round2(unit);
      }
    }
    await saveIngredients(restaurantId, list);
    const move = await appendRow(restaurantId, 'inventory', 'stock_moves', {
      ingredient_id: ing.id,
      ingredient: ing.name,
      dir,
      qty: q,
      balance: next,
      reason: reason || (dir === 'in' ? 'adjustment_in' : 'adjustment_out'),
      cost: cost != null ? round2(cost) : round2(q * (+ing.avg_cost || 0)),
      note: note || null,
      ref: ref || null,
      by: by || null,
    });
    return { move, ingredient: ing };
  });
}

async function postWastage(restaurantId, body) {
  const list = await getIngredients(restaurantId);
  const ing = findIngredient(list, body.ingredient_id || body.ingredient);
  if (!ing) {
    const err = new Error('Ingredient not found');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const result = await postStockMove(restaurantId, {
    ingredient_id: ing.id,
    dir: 'out',
    qty: body.quantity || body.qty,
    reason: 'wastage',
    note: body.note || body.reason || null,
    by: body.by,
  });
  const waste = await appendRow(restaurantId, 'inventory', 'wastage', {
    ingredient_id: ing.id,
    ingredient: ing.name,
    quantity: result.move.qty,
    type: body.type || 'Wastage',
    reason: body.reason || 'Write-off',
    note: body.note || null,
    stock_move_id: result.move.id,
    by: body.by || null,
  });
  return { wastage: waste, move: result.move, ingredient: result.ingredient };
}

async function postStockTake(restaurantId, { counts, note, by }) {
  const list = await getIngredients(restaurantId);
  const moves = [];
  for (const c of counts || []) {
    const ing = findIngredient(list, c.ingredient_id || c.id);
    if (!ing) continue;
    const counted = round4(+c.counted ?? +c.qty ?? +c.stock);
    if (Number.isNaN(counted)) continue;
    const prev = round4(+ing.stock || 0);
    const diff = round4(counted - prev);
    if (Math.abs(diff) < 0.0001) {
      ing.stock = counted;
      continue;
    }
    const dir = diff > 0 ? 'in' : 'out';
    const r = await postStockMove(restaurantId, {
      ingredient_id: ing.id,
      dir,
      qty: Math.abs(diff),
      reason: 'stock_take',
      note: note || null,
      by,
    });
    moves.push(r.move);
  }
  return { moves, ingredients: await getIngredients(restaurantId) };
}

async function postGrn(restaurantId, { supplier, reference, lines, note, by, amount }) {
  const list = await getIngredients(restaurantId);
  const moves = [];
  let totalCost = 0;
  for (const line of lines || []) {
    const ing = findIngredient(list, line.ingredient_id || line.ingredient);
    if (!ing) continue;
    const qty = round4(line.qty || line.quantity);
    const cost = round2(line.cost != null ? line.cost : qty * (+line.unit_cost || +ing.avg_cost || 0));
    totalCost += cost;
    const r = await postStockMove(restaurantId, {
      ingredient_id: ing.id,
      dir: 'in',
      qty,
      reason: 'grn',
      cost,
      note: note || reference || null,
      ref: reference || null,
      by,
    });
    moves.push(r.move);
  }
  const grns = await readDoc(restaurantId, 'inventory', 'purchase_grn', []);
  const arr = Array.isArray(grns) ? grns : [];
  const grn = {
    id: `grn_${Date.now().toString(36)}`,
    supplier: supplier || null,
    reference: reference || null,
    amount: amount != null ? round2(amount) : round2(totalCost),
    date: new Date().toISOString().slice(0, 10),
    note: note || null,
    lines: lines || [],
    move_ids: moves.map((m) => m.id),
    created_at: new Date().toISOString(),
  };
  arr.unshift(grn);
  await writeDoc(restaurantId, 'inventory', 'purchase_grn', arr.slice(0, 500));
  return { grn, moves };
}

/** Deduct BOM ingredients for a paid/accepted order. */
async function deductForOrder(restaurantId, order) {
  const ingredients = await getIngredients(restaurantId);
  if (!ingredients.length) return { moves: [], skipped: 'no_ingredients' };
  const recipes = await getRecipes(restaurantId);
  const moves = [];
  const items = order.items || (order.data && order.data.items) || [];
  for (const item of items) {
    const productId = item.product_id || item.product || item.id;
    const variation = item.variation || item.variation_name || '';
    const recipe = recipes.find((r) => String(r.product) === String(productId)
      && (!r.variation || !variation || String(r.variation).toLowerCase() === String(variation).toLowerCase()))
      || recipes.find((r) => String(r.product) === String(productId));
    if (!recipe) continue;
    const yieldQty = Math.max(1, +recipe.yield || 1);
    const bom = parseRecipeItems(recipe.items, ingredients);
    const orderQty = Math.max(1, +item.qty || +item.quantity || 1);
    for (const line of bom) {
      const need = round4((line.qty / yieldQty) * orderQty);
      try {
        const r = await postStockMove(restaurantId, {
          ingredient_id: line.ingredient_id || line.name,
          dir: 'out',
          qty: need,
          reason: 'sale_deduction',
          ref: order.id,
          note: `Order #${order.id} · ${item.name || productId}`,
        });
        moves.push(r.move);
      } catch (err) {
        // Soft-fail insufficient stock so order flow is not blocked; log as wastage-style note
        moves.push({
          error: err.message,
          ingredient: line.name,
          qty: need,
          order_id: order.id,
        });
      }
    }
  }
  return { moves };
}

async function balances(restaurantId) {
  const ingredients = await getIngredients(restaurantId);
  const moves = await listRows(restaurantId, 'inventory', 'stock_moves');
  return {
    ingredients: ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      unit: i.unit,
      stock: +i.stock || 0,
      reorder_level: +i.reorder_level || 0,
      avg_cost: +i.avg_cost || 0,
      low: (+i.stock || 0) < (+i.reorder_level || 0),
    })),
    move_count: moves.length,
  };
}

module.exports = {
  getIngredients,
  postStockMove,
  postWastage,
  postStockTake,
  postGrn,
  deductForOrder,
  balances,
  parseRecipeItems,
};
