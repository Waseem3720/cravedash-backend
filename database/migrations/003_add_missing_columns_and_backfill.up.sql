-- 003_add_missing_columns_and_backfill.up.sql
-- Provisions missing columns on customers, epos_tills, till_staff, employees, and orders,
-- executes safe name splitting backfill on customers, and adds branch/courier indexes.

-- 1. Customers columns
ALTER TABLE customers ADD COLUMN IF NOT EXISTS f_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS l_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0;

-- 2. Safe name splitting backfill on customers
UPDATE customers
SET
  f_name = COALESCE(NULLIF(SPLIT_PART(name, ' ', 1), ''), name),
  l_name = COALESCE(NULLIF(SUBSTRING(name FROM LENGTH(SPLIT_PART(name, ' ', 1)) + 2), ''), '')
WHERE f_name IS NULL AND name IS NOT NULL;

-- 3. Branch ACL scoping columns on till and employee tables
ALTER TABLE epos_tills ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE till_staff ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id TEXT;

-- 4. Courier assignment and telemetry on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_man_id TEXT REFERENCES deliverymen(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_distance_km NUMERIC(8,2);

-- 5. Branch and courier query indexes
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_till_staff_branch ON till_staff (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_epos_tills_branch ON epos_tills (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_man ON orders (delivery_man_id);
