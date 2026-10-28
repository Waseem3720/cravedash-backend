-- 005_add_rider_chef_auth_and_workflow.down.sql
-- Reverts courier and kitchen credential additions.

DROP INDEX IF EXISTS idx_chefs_restaurant;
DROP INDEX IF EXISTS idx_deliverymen_restaurant;

ALTER TABLE chefs DROP COLUMN IF EXISTS branch_id;
ALTER TABLE chefs DROP COLUMN IF EXISTS pin_hash;
ALTER TABLE chefs DROP COLUMN IF EXISTS password_hash;

ALTER TABLE deliverymen DROP COLUMN IF EXISTS branch_id;
ALTER TABLE deliverymen DROP COLUMN IF EXISTS pin_hash;
ALTER TABLE deliverymen DROP COLUMN IF EXISTS password_hash;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super', 'restaurant', 'epos'));
