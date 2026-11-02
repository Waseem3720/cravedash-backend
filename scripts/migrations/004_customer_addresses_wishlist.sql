-- 004: saved delivery addresses and wishlist for website customers. Additive and idempotent: only new tables are created.
-- Both tables belong to one restaurant and one customer (the composite key matches customers (restaurant_id, id) from 002).

CREATE TABLE IF NOT EXISTS customer_addresses (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  address_type    TEXT NOT NULL DEFAULT 'home',
  house           TEXT,
  floor           TEXT,
  road            TEXT,
  town            TEXT,
  postcode        TEXT,
  instructions    TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_addresses_customer_fk
    FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses (restaurant_id, customer_id);

CREATE TABLE IF NOT EXISTS customer_wishlist (
  restaurant_id   TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, customer_id, product_id),
  CONSTRAINT customer_wishlist_customer_fk
    FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE
);
