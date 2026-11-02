/**
 * Read-only reconciliation of sale journals. It only SELECTs. Run it inside a READ ONLY transaction (see
 * scripts/reconcile-sales.js). It never creates journals, changes orders, or recalculates VAT.
 *
 * Categories:
 *  - confirmed_missing: a paid, non-zero order whose sale effect is marked done, but has no sale journal.
 *  - uncertain_legacy: a paid, non-zero order flagged engines_posted with no sale effect flag and no sale journal.
 *    Such orders may predate accounting, so a reviewer must decide.
 *  - uncertain_unflagged: a paid, non-zero order with no sale effect flag and no sale journal.
 *  - incomplete_journal: a sale or sale_reversal journal whose ledger rows do not match it by content.
 *  - orphan_journal: a sale or sale_reversal journal whose ref matches no order of its restaurant.
 */
const { journalLedgerProblems } = require('./accounting');

async function reconcileSales(db, { restaurantId = null } = {}) {
  const params = restaurantId ? [restaurantId] : [];
  const orderScope = restaurantId ? 'AND o.restaurant_id = $1' : '';
  const journalScope = restaurantId ? 'AND j.restaurant_id = $1' : '';

  const { rows: orders } = await db.query(
    `SELECT o.id, o.restaurant_id, o.total, o.payment_status, o.status, o.created_at, o.data
       FROM orders o
      WHERE o.payment_status = 'paid' AND o.total > 0 ${orderScope}
        AND NOT EXISTS (
          SELECT 1 FROM domain_rows j
           WHERE j.restaurant_id = o.restaurant_id AND j.domain = 'accounting' AND j.collection = 'acc_journals'
             AND j.data->>'source' = 'sale' AND j.data->>'ref' = o.id::text)
      ORDER BY o.restaurant_id, o.id`,
    params,
  );
  const missing = [];
  const uncertain = [];
  for (const o of orders) {
    const d = o.data || {};
    const row = {
      order_id: String(o.id),
      restaurant_id: o.restaurant_id,
      total: Number(o.total),
      status: o.status,
      created_at: o.created_at,
      engines_sale: d.engines_sale || null,
      engines_posted: d.engines_posted === true || d.engines_posted === 'true',
    };
    if (d.engines_sale === 'done') missing.push({ ...row, category: 'confirmed_missing' });
    else if (row.engines_posted) uncertain.push({ ...row, category: 'uncertain_legacy' });
    else uncertain.push({ ...row, category: 'uncertain_unflagged' });
  }

  const { rows: journals } = await db.query(
    `SELECT j.id, j.restaurant_id, j.data
       FROM domain_rows j
      WHERE j.domain = 'accounting' AND j.collection = 'acc_journals'
        AND j.data->>'source' IN ('sale', 'sale_reversal') ${journalScope}
      ORDER BY j.restaurant_id, j.id`,
    params,
  );
  const incomplete = [];
  const orphans = [];
  for (const j of journals) {
    const journal = { id: j.id, ...j.data };
    const problems = await journalLedgerProblems(db, j.restaurant_id, journal);
    if (problems.length) {
      incomplete.push({ journal_id: j.id, restaurant_id: j.restaurant_id, source: j.data.source, ref: j.data.ref, problems });
    }
    const { rows: match } = await db.query(
      'SELECT 1 FROM orders WHERE restaurant_id = $1 AND id::text = $2 LIMIT 1',
      [j.restaurant_id, String(j.data.ref)],
    );
    if (!match[0]) orphans.push({ journal_id: j.id, restaurant_id: j.restaurant_id, source: j.data.source, ref: j.data.ref });
  }

  return {
    generated_at: new Date().toISOString(),
    scope: restaurantId || 'all restaurants',
    summary: {
      confirmed_missing: missing.length,
      uncertain: uncertain.length,
      incomplete_journals: incomplete.length,
      orphan_journals: orphans.length,
      sale_and_reversal_journals_checked: journals.length,
    },
    confirmed_missing: missing,
    uncertain,
    incomplete_journals: incomplete,
    orphan_journals: orphans,
  };
}

module.exports = { reconcileSales };
