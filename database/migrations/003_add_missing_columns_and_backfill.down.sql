-- 003_add_missing_columns_and_backfill.down.sql
-- Emergency manual recovery script for 003_add_missing_columns_and_backfill.up.sql
--
-- SAFEGUARD NOTICE: Automatic destructive rollbacks are strictly prohibited.
-- This script removes added columns on customers, epos_tills, till_staff, employees, and orders.
-- Execute manually only under explicit operational change control after a verified backup.

DROP INDEX IF EXISTS idx_orders_delivery_man;
DROP INDEX IF EXISTS idx_epos_tills_branch;
DROP INDEX IF EXISTS idx_till_staff_branch;
DROP INDEX IF EXISTS idx_employees_branch;
DROP INDEX IF EXISTS idx_customers_branch;

ALTER TABLE orders DROP COLUMN IF EXISTS driver_distance_km;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_man_id;

ALTER TABLE employees DROP COLUMN IF EXISTS branch_id;
ALTER TABLE till_staff DROP COLUMN IF EXISTS branch_id;
ALTER TABLE epos_tills DROP COLUMN IF EXISTS branch_id;

ALTER TABLE customers DROP COLUMN IF EXISTS loyalty_points;
ALTER TABLE customers DROP COLUMN IF EXISTS wallet_balance;
ALTER TABLE customers DROP COLUMN IF EXISTS branch_id;
ALTER TABLE customers DROP COLUMN IF EXISTS branch;
ALTER TABLE customers DROP COLUMN IF EXISTS address;
ALTER TABLE customers DROP COLUMN IF EXISTS l_name;
ALTER TABLE customers DROP COLUMN IF EXISTS f_name;
