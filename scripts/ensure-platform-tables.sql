-- Extra platform tables for Super Admin features previously on demoStore
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  restaurant_name TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  channel TEXT DEFAULT 'epos',
  requester TEXT,
  assignee TEXT,
  body TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_meta (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  ref TEXT,
  paid_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  order_id TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  note TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  restaurant_id TEXT,
  detail TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_payouts_restaurant ON payouts(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);

INSERT INTO platform_meta (id, data) VALUES
  ('settings', '{"name":"CraveDash","support_email":"support@cravedash.co.uk","currency":"GBP","maintenance":false}'),
  ('terms', '{"version":1,"html":"<p>Partner terms</p>","published_at":null}'),
  ('languages', '[{"code":"en","name":"English","default":true},{"code":"ur","name":"Urdu"}]'),
  ('remote', '{"code":""}')
ON CONFLICT (id) DO NOTHING;
