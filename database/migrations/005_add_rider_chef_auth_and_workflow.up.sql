-- 005_add_rider_chef_auth_and_workflow.up.sql
-- Enables courier (rider) and kitchen (chef) credentials, branch assignments, and role checks.

-- 1. Extend users.role check constraint to include 'rider' and 'chef'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super', 'restaurant', 'epos', 'rider', 'chef', 'customer'));

-- 2. Add credential and branch scoping columns to deliverymen
ALTER TABLE deliverymen ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE deliverymen ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE deliverymen ADD COLUMN IF NOT EXISTS branch_id TEXT;

-- 3. Add credential and branch scoping columns to chefs
ALTER TABLE chefs ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE chefs ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE chefs ADD COLUMN IF NOT EXISTS branch_id TEXT;

-- 4. Multi-tenant lookups
CREATE INDEX IF NOT EXISTS idx_deliverymen_restaurant ON deliverymen(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_chefs_restaurant ON chefs(restaurant_id);
