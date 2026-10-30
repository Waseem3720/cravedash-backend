-- 010_align_frontend_contracts.up.sql
-- Enables deliveryman shifts, cash handovers, locations, and events tracking tables.

CREATE TABLE IF NOT EXISTS deliveryman_shifts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id TEXT NOT NULL REFERENCES deliverymen(id) ON DELETE CASCADE,
  opening_cash NUMERIC(10,2) NOT NULL DEFAULT 0,
  float_owner TEXT NOT NULL DEFAULT 'restaurant',
  actual_closing NUMERIC(10,2),
  expected_closing NUMERIC(10,2),
  variance NUMERIC(10,2) DEFAULT 0,
  restaurant_due NUMERIC(10,2) DEFAULT 0,
  orders_count INT DEFAULT 0,
  cash_collected NUMERIC(10,2) DEFAULT 0,
  cash_tips NUMERIC(10,2) DEFAULT 0,
  online_tips NUMERIC(10,2) DEFAULT 0,
  z_number TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_shifts_rider_status ON deliveryman_shifts(restaurant_id, deliveryman_id, status);
CREATE INDEX IF NOT EXISTS idx_dm_shifts_date ON deliveryman_shifts(restaurant_id, deliveryman_id, started_at DESC);

CREATE TABLE IF NOT EXISTS deliveryman_handovers (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id TEXT NOT NULL REFERENCES deliverymen(id) ON DELETE CASCADE,
  shift_id TEXT REFERENCES deliveryman_shifts(id) ON DELETE SET NULL,
  amount NUMERIC(10,2) NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_handovers_rider ON deliveryman_handovers(restaurant_id, deliveryman_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deliveryman_locations (
  deliveryman_id TEXT PRIMARY KEY REFERENCES deliverymen(id) ON DELETE CASCADE,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  latitude NUMERIC(10,6) NOT NULL,
  longitude NUMERIC(10,6) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliveryman_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id TEXT NOT NULL REFERENCES deliverymen(id) ON DELETE CASCADE,
  shift_id TEXT,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  amount NUMERIC(10,2),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_events_rider ON deliveryman_events(restaurant_id, deliveryman_id, created_at DESC);

