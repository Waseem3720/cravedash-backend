-- Provisions deliveryman_requests and deliveryman_reviews relational tables (CD-CON-050 / BACKEND-006)

CREATE TABLE IF NOT EXISTS deliveryman_requests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  vehicle TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  deliveryman_id TEXT REFERENCES deliverymen(id) ON DELETE SET NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_requests_restaurant_status ON deliveryman_requests(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_dm_requests_email ON deliveryman_requests(restaurant_id, email);

-- Ensure only one pending request per applicant email per restaurant to prevent spamming
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_requests_pending_email
  ON deliveryman_requests (restaurant_id, lower(email))
  WHERE status = 'pending' AND email IS NOT NULL;

CREATE TABLE IF NOT EXISTS deliveryman_reviews (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id TEXT NOT NULL REFERENCES deliverymen(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  rating NUMERIC(2,1) NOT NULL,
  review_note TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_dm_review_rating CHECK (rating >= 1 AND rating <= 5)
);

CREATE INDEX IF NOT EXISTS idx_dm_reviews_deliveryman ON deliveryman_reviews(restaurant_id, deliveryman_id);
CREATE INDEX IF NOT EXISTS idx_dm_reviews_order ON deliveryman_reviews(order_id);

-- Enforce at most one review per order per deliveryman
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_reviews_order_deliveryman
  ON deliveryman_reviews (order_id, deliveryman_id)
  WHERE order_id IS NOT NULL;
