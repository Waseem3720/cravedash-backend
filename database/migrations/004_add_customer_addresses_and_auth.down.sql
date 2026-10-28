-- 004_add_customer_addresses_and_auth.down.sql
-- Manual recovery / rollback script for 004_add_customer_addresses_and_auth.up.sql

DROP INDEX IF EXISTS idx_orders_customer;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_address;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_address_id;
ALTER TABLE orders DROP COLUMN IF EXISTS customer_id;

DROP TABLE IF EXISTS customer_addresses CASCADE;

ALTER TABLE customers DROP COLUMN IF EXISTS is_phone_verified;
ALTER TABLE customers DROP COLUMN IF EXISTS is_email_verified;
ALTER TABLE customers DROP COLUMN IF EXISTS password_hash;
