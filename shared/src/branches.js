/**
 * The branches of a restaurant, read the same way the login code reads them: the restaurant record's branch_list and
 * the panel's ops/branches document. A branch id is valid only if it appears in this list.
 */
async function restaurantBranches(db, restaurant) {
  const [{ rows: restRows }, { rows: docRows }] = await Promise.all([
    db.query('SELECT data FROM restaurants WHERE id = $1', [restaurant]),
    db.query("SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'branches'", [restaurant]),
  ]);
  const fromRestaurant = Array.isArray(restRows[0]?.data?.branch_list) ? restRows[0].data.branch_list : [];
  const fromPanel = Array.isArray(docRows[0]?.data) ? docRows[0].data : [];
  const byId = new Map();
  for (const b of [...fromRestaurant, ...fromPanel]) {
    if (b && b.id !== undefined && b.id !== null && String(b.id) !== '') byId.set(String(b.id), { id: String(b.id), name: b.name || String(b.id) });
  }
  return [...byId.values()];
}

async function isRestaurantBranch(db, restaurant, branch) {
  const list = await restaurantBranches(db, restaurant);
  return list.some((b) => b.id === String(branch));
}

module.exports = { restaurantBranches, isRestaurantBranch };
