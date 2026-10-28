-- 004_add_customer_addresses_and_auth.up.sql
-- Provisions customer_addresses table, customer password authentication column, and customer_id on orders.

-- 1. Ensure password_hash exists on customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_phone_verified BOOLEAN DEFAULT FALSE;

-- 2. Customer address book table
CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  restaurant_id TEXT REFERENCES restaurants(id) ON DELETE CASCADE,
  address_type TEXT DEFAULT 'home',
  contact_person_name TEXT,
  contact_person_number TEXT,
  address TEXT,
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  postcode TEXT,
  latitude NUMERIC(10,8),
  longitude NUMERIC(11,8),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_restaurant ON customer_addresses(restaurant_id);

-- 3. Link customer_id and delivery address on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
