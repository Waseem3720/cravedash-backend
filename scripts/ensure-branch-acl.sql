-- Phase C.1: branch_id columns for ACL scoping (safe if tables missing)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE till_staff ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE epos_tills ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_till_staff_branch ON till_staff (restaurant_id, branch_id);
