-- Generic JSON blobs for restaurant admin modules (inventory, payroll, etc.)
CREATE TABLE IF NOT EXISTS restaurant_blobs (
  restaurant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_blobs_rid ON restaurant_blobs(restaurant_id);
