/**
 * Copies branches into the `branches` table (migration 002). Branches live in two places today:
 *   - restaurants.data.branch_list
 *   - domain_docs (domain 'ops', collection 'branches')
 * They are merged the same way shared/src/branches.js reads them.
 *
 * Dry run by default: prints the counts and writes nothing. Pass --apply to write.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const pool = require('../src/db');

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows: restaurants } = await pool.query('SELECT id, data FROM restaurants ORDER BY id');
  let branchCount = 0;
  let writeCount = 0;
  for (const r of restaurants) {
    const { rows: docs } = await pool.query(
      "SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'branches'",
      [r.id],
    );
    const fromRestaurant = Array.isArray(r.data && r.data.branch_list) ? r.data.branch_list : [];
    const fromPanel = Array.isArray(docs[0] && docs[0].data) ? docs[0].data : [];
    const byId = new Map();
    for (const b of [...fromRestaurant, ...fromPanel]) {
      if (b && b.id !== undefined && b.id !== null && String(b.id) !== '') {
        byId.set(String(b.id), {
          id: String(b.id),
          name: b.name || String(b.id),
          status: b.status !== false && b.status !== 0,
        });
      }
    }
    for (const b of byId.values()) {
      branchCount += 1;
      if (!apply) continue;
      await pool.query(
        `INSERT INTO branches (restaurant_id, id, name, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (restaurant_id, id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = NOW()`,
        [r.id, b.id, b.name, b.status],
      );
      writeCount += 1;
    }
  }
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${branchCount} branch rows found across ${restaurants.length} restaurants`);
  if (apply) console.log(`written: ${writeCount}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
