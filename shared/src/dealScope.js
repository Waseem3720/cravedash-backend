/**
 * Which deals a menu shows. Deals follow the product rule: a branch sees its own deals, plus the restaurant-level deals
 * assigned and switched on for it. With no branch (the master menu), only the restaurant-level deals.
 *
 * Used by the website deal list and by the order pricing, so a deal a branch cannot show is also refused at checkout.
 * The SQL expects the deals table as `d`, restaurant id as $1 and the branch id (or null for the master menu) as $2.
 */
const DEAL_BRANCH_SCOPE_SQL = `(CASE WHEN $2::text IS NULL THEN d.branch_id IS NULL
  ELSE (d.branch_id = $2 OR (d.branch_id IS NULL AND EXISTS (
         SELECT 1 FROM deal_branch_assignments a
          WHERE a.deal_id = d.id AND a.restaurant_id = $1 AND a.branch_id = $2 AND a.active IS TRUE))) END)`;

module.exports = { DEAL_BRANCH_SCOPE_SQL };
