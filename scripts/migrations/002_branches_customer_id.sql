-- 002: branches table, orders.customer_id, and the orders foreign keys (AUD-plan Phase 1).
-- Applied after scripts/init-db.sql by shared/scripts/migrate.js. Idempotent: re-running changes nothing.
-- Run the orphan pre-checks (see the phase report) before the foreign keys can be added to live data.

-- 1. Branches. Composite key, because branch ids are unique only inside one restaurant.
CREATE TABLE IF NOT EXISTS branches (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        BOOLEAN NOT NULL DEFAULT TRUE,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  data          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_branches_restaurant ON branches (restaurant_id);

-- 2. The 'main' row: orders with no branch are stored under branch_id 'main' (services/order-service orders.js).
--    Every restaurant that has such orders gets its own row, marked as the default branch.
INSERT INTO branches (restaurant_id, id, name, is_default)
SELECT DISTINCT o.restaurant_id, 'main', 'Main Branch', TRUE
FROM orders o
WHERE o.branch_id = 'main'
ON CONFLICT (restaurant_id, id) DO NOTHING;

-- 3. Composite foreign-key target on customers.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_restaurant_id_key') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_restaurant_id_key UNIQUE (restaurant_id, id);
  END IF;
END $$;

-- 4. orders.customer_id (nullable). Backfilled only on an exact id match inside the same restaurant.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT;
UPDATE orders o
SET customer_id = o.customer->>'id'
WHERE o.customer_id IS NULL
  AND o.customer->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM customers c
    WHERE c.restaurant_id = o.restaurant_id AND c.id = o.customer->>'id'
  );

-- Ensure no orphan customer_id violates the foreign key constraint
UPDATE orders o
SET customer_id = NULL
WHERE o.customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.restaurant_id = o.restaurant_id AND c.id = o.customer_id
  );

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_customer_fk') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
      FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id)
      ON DELETE SET NULL (customer_id);
  END IF;
END $$;

-- 5. orders.branch_id has no foreign key. The branch is checked in the application (POST /orders), because branches
--    are still created through the ops/branches document, and a foreign key would reject orders for a new branch.

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (restaurant_id, customer_id);
