/**
 * The restaurant's order settings and delivery areas, as the dashboard saves them. Shared by the signed-in order route
 * and the public delivery checks, so both read the same rows.
 */
const pool = require('@cravedash/shared/src/db');

const SETTINGS_KEY = 'settings_order_settings';

/** The restaurant's order settings. A missing value is off (0). */
async function loadOrderSettings(restaurant, db = pool) {
  const { rows } = await db.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurant, SETTINGS_KEY]);
  const data = rows[0] && rows[0].data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/** The delivery area list for the restaurant (dashboard "Area/Zip Code List"). */
async function loadDeliveryAreas(restaurant, db = pool) {
  const { rows } = await db.query(
    "SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'delivery_areas'",
    [restaurant],
  );
  return Array.isArray(rows[0] && rows[0].data) ? rows[0].data : [];
}

module.exports = { loadOrderSettings, loadDeliveryAreas };
