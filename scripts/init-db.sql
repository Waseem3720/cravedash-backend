-- CraveDash PostgreSQL schema (v1)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super', 'restaurant', 'epos')),
  name TEXT,
  restaurant_id TEXT,
  till_id TEXT,
  branch_id TEXT,
  pin_hash TEXT,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret TEXT,
  mfa_backup_codes JSONB DEFAULT '[]'::jsonb,
  status BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Bumped on password or account change. A token carries the version it was issued with, so older tokens stop working (SEC-H4).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Kitchen chefs and drivers sign in with their own login. users.id matches the chefs.id / deliverymen.id row
-- they belong to. Idempotent: the constraint is rebuilt so it always lists the current roles.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super', 'restaurant', 'epos', 'chef', 'driver'));

-- Phase B.4: per-user UI prefs (sidebar collapse, last terminal, …)
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan_type TEXT DEFAULT 'restaurant',
  description TEXT,
  price_monthly NUMERIC(12,2) DEFAULT 0,
  price_yearly NUMERIC(12,2) DEFAULT 0,
  max_orders INT,
  features JSONB DEFAULT '[]',
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  live_id INT,
  name TEXT NOT NULL,
  owner TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  plan_id TEXT REFERENCES plans(id),
  sub_status TEXT DEFAULT 'inactive',
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  payment_status TEXT DEFAULT 'paid',
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_admins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  role TEXT DEFAULT 'support',
  status BOOLEAN DEFAULT TRUE,
  perms JSONB,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  num INT,
  name TEXT NOT NULL,
  image TEXT,
  colour TEXT,
  text_colour TEXT,
  priority INT DEFAULT 0,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subcategories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  colour TEXT,
  inherit_colour BOOLEAN DEFAULT TRUE,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  live_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category_id TEXT REFERENCES categories(id),
  sub_category_id TEXT REFERENCES subcategories(id),
  price NUMERIC(12,2) DEFAULT 0,
  from_price NUMERIC(12,2) DEFAULT 0,
  data JSONB DEFAULT '{}',
  status BOOLEAN DEFAULT TRUE,
  visible BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(12,2) DEFAULT 0,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cuisines (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sub_title TEXT,
  priority INT DEFAULT 0,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(12,2) DEFAULT 0,
  slots JSONB DEFAULT '[]',
  one_tap BOOLEAN DEFAULT FALSE,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch TEXT,
  branch_id TEXT,
  source TEXT,
  order_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT DEFAULT 'unpaid',
  payment_method TEXT,
  customer JSONB,
  table_id TEXT,
  guests INT,
  items JSONB NOT NULL DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  discount NUMERIC(12,2) DEFAULT 0,
  coupon_code TEXT,
  delivery_charge NUMERIC(12,2) DEFAULT 0,
  service_charge NUMERIC(12,2) DEFAULT 0,
  tip NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  note TEXT,
  history JSONB DEFAULT '[]',
  acknowledged BOOLEAN DEFAULT FALSE,
  alert_dismissed_at TIMESTAMPTZ,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS orders_id_seq START 100200;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  phone TEXT,
  branch_id TEXT,
  wallet_balance NUMERIC(12,2) DEFAULT 0,
  loyalty_points INT DEFAULT 0,
  data JSONB DEFAULT '{}',
  status BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title TEXT,
  code TEXT NOT NULL,
  coupon_type TEXT DEFAULT 'default',
  discount_type TEXT DEFAULT 'percent',
  discount NUMERIC(12,2) DEFAULT 0,
  min_purchase NUMERIC(12,2) DEFAULT 0,
  max_discount NUMERIC(12,2) DEFAULT 0,
  usage_limit INT DEFAULT 0,
  used INT DEFAULT 0,
  start_at TIMESTAMPTZ,
  expire_at TIMESTAMPTZ,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (restaurant_id, code)
);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  number INT,
  area_id TEXT REFERENCES areas(id),
  shape TEXT,
  seats INT DEFAULT 2,
  pos_x INT DEFAULT 0,
  pos_y INT DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  reserved BOOLEAN DEFAULT FALSE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_name TEXT,
  customer_phone TEXT,
  party_size INT,
  table_id TEXT,
  booked_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  note TEXT,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  f_name TEXT,
  l_name TEXT,
  email TEXT,
  phone TEXT,
  role_id TEXT,
  branch TEXT,
  branch_id TEXT,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_roles (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  perms JSONB DEFAULT '[]',
  status BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_settings (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  app TEXT DEFAULT 'epos',
  till TEXT,
  action TEXT,
  status TEXT DEFAULT 'pending',
  order_id BIGINT,
  payload JSONB DEFAULT '{}',
  at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS epos_tills (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS till_staff (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT DEFAULT 'cashier',
  till_id TEXT,
  branch_id TEXT,
  status BOOLEAN DEFAULT TRUE,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS till_checkins (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id TEXT NOT NULL,
  staff_id TEXT,
  opening_float NUMERIC(12,2) DEFAULT 0,
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  checked_out_at TIMESTAMPTZ,
  data JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS held_orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id TEXT,
  label TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_counters (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  period_start DATE,
  x_counter INT DEFAULT 0,
  z_counter INT DEFAULT 0,
  opening_float NUMERIC(12,2) DEFAULT 0,
  data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS z_reports (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id TEXT,
  z_no INT NOT NULL,
  report JSONB NOT NULL DEFAULT '{}',
  counted_cash NUMERIC(12,2),
  variance NUMERIC(12,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_z_reports_restaurant ON z_reports(restaurant_id, generated_at);

CREATE TABLE IF NOT EXISTS restaurant_blobs (
  restaurant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- Seed (idempotent)
INSERT INTO plans (id, name, plan_type, description, price_monthly, price_yearly, max_orders, features, data)
VALUES
  ('plan_starter', 'Starter Plan', 'restaurant', 'Perfect for small restaurants', 29.99, 299.90, 100, '["EPOS","Online ordering"]', '{"terminals":1}'),
  ('plan_pro', 'Professional Plan', 'restaurant', 'Growing restaurants', 79.99, 799.90, 500, '["EPOS","Table QR"]', '{"terminals":3,"popular":true}'),
  ('plan_enterprise', 'Enterprise Plan', 'restaurant', 'Large chains', 199.99, 1999.90, NULL, '["Unlimited"]', '{"terminals":10}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO restaurants (id, live_id, name, owner, email, phone, address, city, plan_id, sub_status, data)
VALUES ('r1', 11, 'Porto Piri Piri', 'Faisal', 'owner@portopiripiri.example', '0141 000 1000',
  '49 Kilmarnock Road, Shawlands, Glasgow G41 3YN', 'Glasgow', 'plan_starter', 'active',
  '{"vat_registered":"yes","vat_number":"GB894220190","currency":"GBP"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO stripe_config (id, data) VALUES (1, '{"mode":"test","app_fee_percent":1.5}')
ON CONFLICT (id) DO NOTHING;

-- BUG-001: no owner-level platform admin (perms "ALL") and no super-admin login is created here. Those exist only in the
-- local development seed (scripts/seed-full.js), which refuses to run in production.
INSERT INTO platform_admins (id, name, email, phone, role, status, perms)
VALUES
  ('a2', 'Ayesha Khan', 'finance@cravedash.co.uk', '+44 7700 900002', 'finance', TRUE, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (id, restaurant_id, plan_id, start_at, end_at, status)
VALUES ('sub_r1', 'r1', 'plan_starter', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', 'active')
ON CONFLICT (id) DO NOTHING;

-- Demo restaurant and till logins (password for these demo users: demo12345). Super-admin logins are NOT created here (BUG-001).
INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id)
VALUES
  ('u_owner', 'owner@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'restaurant', 'Faisal', 'r1', NULL),
  ('u_epos', 'till1@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'epos', 'Till 1', 'r1', 'till-1'),
  ('u_epos_legacy', 'till@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'epos', 'Till User', 'r1', 'till-1')
-- DO NOTHING: re-running the migration must never reset a password or re-enable a disabled account (SEC-C1).
-- Demo accounts are created on a fresh database only. Dev re-seeding is scripts/seed-full.js (local only).
ON CONFLICT (email) DO NOTHING;

INSERT INTO restaurant_settings (restaurant_id, settings)
VALUES ('r1', '{"vat_rate":20,"vat_inclusive":true,"restaurant_name":"Porto Piri Piri","auto_accept_pos":true}')
ON CONFLICT (restaurant_id) DO NOTHING;

INSERT INTO epos_tills (id, restaurant_id, name) VALUES ('till-1', 'r1', 'Till 1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO till_staff (id, restaurant_id, name, pin_hash, role, till_id)
VALUES ('ts1', 'r1', 'Alex Khan', '$2b$10$SDVmB/0aC5IXEalVR2KgEOknOTuFeCwLSzvIXsOBl/VM8J7aLQNn.', 'manager', 'till-1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO categories (id, restaurant_id, num, name, colour, text_colour, priority, status)
VALUES ('cat1', 'r1', 1, 'Burger', '#0b84f3', '#ffffff', 1, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, restaurant_id, name, category_id, price, from_price, data, status, visible)
VALUES ('p1', 'r1', 'Classic Burger', 'cat1', 8.99, 8.99, '{"product_type":"nonveg"}', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO addons (id, restaurant_id, name, price, status)
VALUES ('ad1', 'r1', 'Extra Cheese', 0.60, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cuisines (id, restaurant_id, name, priority, status)
VALUES ('cu1', 'r1', 'Fast Food', 1, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO deals (id, restaurant_id, name, price, slots, one_tap, status)
VALUES ('deal1', 'r1', 'Family Feast', 29.95, '[{"label":"Main","qty":2}]', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO coupons (id, restaurant_id, title, code, discount_type, discount, min_purchase, status)
VALUES ('cp1', 'r1', 'Summer Sale', 'SUMMER10', 'percent', 10, 10, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO customers (id, restaurant_id, name, email, phone, wallet_balance)
VALUES ('cust1', 'r1', 'Liam Smith', 'liam@example.com', '07123456789', 12.50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO areas (id, restaurant_id, name) VALUES ('area1', 'r1', 'Main Hall')
ON CONFLICT (id) DO NOTHING;

INSERT INTO dining_tables (id, restaurant_id, number, area_id, shape, seats, pos_x, pos_y)
VALUES ('T1', 'r1', 1, 'area1', 'square', 2, 1, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO employee_roles (id, restaurant_id, name, perms)
VALUES ('er1', 'r1', 'Manager', '["ALL"]')
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, restaurant_id, f_name, l_name, email, phone, role_id, branch, status)
VALUES ('emp1', 'r1', 'Sarah', 'Johnson', 'sarah@portopiripiri.example', '07111111111', 'er1', 'Main Branch', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO report_counters (restaurant_id, period_start, x_counter, z_counter, opening_float)
VALUES ('r1', CURRENT_DATE, 482, 1041, 150)
ON CONFLICT (restaurant_id) DO NOTHING;

-- Delivery drivers (restaurant-service /deliverymen). Mirrors database/migrations definition, idempotent.
CREATE TABLE IF NOT EXISTS deliverymen (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  vehicle         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  wallet_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliverymen_restaurant ON deliverymen(restaurant_id);

-- Kitchen chefs (restaurant-service /chefs). Columns follow lib/crud chefMapper; extra fields live in metadata.
CREATE TABLE IF NOT EXISTS chefs (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chefs_restaurant ON chefs(restaurant_id);

-- Support tickets raised from EPOS tills (platform-service /support-tickets). Restaurant scope is in restaurant_id.
CREATE TABLE IF NOT EXISTS support_tickets (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT REFERENCES restaurants(id) ON DELETE CASCADE,
  restaurant_name   TEXT,
  subject           TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal',
  status            TEXT NOT NULL DEFAULT 'queue',
  channel           TEXT NOT NULL DEFAULT 'epos',
  assignee          TEXT,
  requester         TEXT,
  messages          JSONB NOT NULL DEFAULT '[]'::jsonb,
  data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_restaurant ON support_tickets(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);


-- ==== Merged from scripts/ensure-*.sql (SEC-H9): one canonical schema. Every statement is idempotent. ====

-- from ensure-platform-tables.sql
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


-- from ensure-domain-tables.sql
-- Domain ledgers (inventory / payroll / accounting / ops) — replaces restaurant_blobs for these collections.
CREATE TABLE IF NOT EXISTS domain_docs (
  restaurant_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce')),
  collection TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, domain, collection)
);

CREATE INDEX IF NOT EXISTS domain_docs_restaurant_idx ON domain_docs (restaurant_id);

-- Widen domain check for ops + commerce
ALTER TABLE domain_docs DROP CONSTRAINT IF EXISTS domain_docs_domain_check;
ALTER TABLE domain_docs ADD CONSTRAINT domain_docs_domain_check
  CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce'));

CREATE TABLE IF NOT EXISTS domain_rows (
  restaurant_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce')),
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, domain, collection, id)
);

ALTER TABLE domain_rows DROP CONSTRAINT IF EXISTS domain_rows_domain_check;
ALTER TABLE domain_rows ADD CONSTRAINT domain_rows_domain_check
  CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce'));

ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS domain_rows_lookup_idx ON domain_rows (restaurant_id, domain, collection);

-- Super-admin MFA (TOTP)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes JSONB DEFAULT '[]'::jsonb;


-- from ensure-restaurant-blobs.sql
-- Generic JSON blobs for restaurant admin modules (inventory, payroll, etc.)
CREATE TABLE IF NOT EXISTS restaurant_blobs (
  restaurant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_blobs_rid ON restaurant_blobs(restaurant_id);


-- from ensure-branch-acl.sql
-- Phase C.1: branch_id columns for ACL scoping (safe if tables missing)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE till_staff ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE epos_tills ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS branch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_till_staff_branch ON till_staff (restaurant_id, branch_id);

-- Option A: each branch has its own menu. NULL = restaurant-level (owner-created) row, hidden from branch logins.
ALTER TABLE products ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE subcategories ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE addons ADD COLUMN IF NOT EXISTS branch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_products_branch ON products (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_categories_branch ON categories (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_branch ON subcategories (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_addons_branch ON addons (restaurant_id, branch_id);

-- Deals follow the product model. NULL = restaurant-level deal, shown on a branch only when assigned to it below.
-- A branch id = a deal the branch owns. The owner's deals stay on the master menu.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_deals_branch ON deals (restaurant_id, branch_id);

CREATE TABLE IF NOT EXISTS deal_branch_assignments (
  restaurant_id TEXT NOT NULL,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_branch_assignments_branch ON deal_branch_assignments (restaurant_id, branch_id);

-- Branch-owned operational data: floor plan, bookings, customers and settings. NULL = restaurant-level (owner-created),
-- hidden from branch logins. Coupons, integrations, banners, terms and languages stay restaurant-wide.
ALTER TABLE areas ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE deliverymen ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE employee_roles ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE till_checkins ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_coupons_branch ON coupons (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_deals_branch ON deals (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_deliverymen_branch ON deliverymen (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_branch ON employee_roles (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_till_checkins_branch ON till_checkins (restaurant_id, branch_id);
ALTER TABLE cuisines ADD COLUMN IF NOT EXISTS branch_id TEXT;
-- Held orders belong to the branch of their till. Legacy held orders keep branch_id NULL (restaurant-level), unchanged.
ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_held_orders_branch ON held_orders (restaurant_id, branch_id);
-- Approval requests belong to the branch of the session that raised them (NULL = restaurant-level). Legacy rows keep NULL.
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_approval_requests_branch ON approval_requests (restaurant_id, branch_id);
-- Support tickets raised by a branch login belong to that branch (NULL = restaurant-level). Legacy tickets keep NULL.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_support_tickets_branch ON support_tickets (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_cuisines_branch ON cuisines (restaurant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_areas_branch ON areas (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_dining_tables_branch ON dining_tables (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_bookings_branch ON bookings (restaurant_id, branch_id);

-- Per-branch settings and settings_* blobs. A branch with no row falls back to the restaurant row.
CREATE TABLE IF NOT EXISTS branch_settings (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, branch_id, key)
);


-- Tables that were created at runtime by the EPOS service (SEC-H9). The same definitions, so a fresh database has them.
CREATE TABLE IF NOT EXISTS sync_idempotency (
  restaurant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity TEXT,
  op TEXT,
  server_id TEXT,
  client_id TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS z_approvals (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  till_id TEXT,
  action TEXT NOT NULL,
  expected_z_no INT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  approver_staff_id TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- ORD-M3: one order per client_id per branch. Idempotent; a duplicate is answered with the existing order.
-- Branch-scoped, not restaurant-wide: an idempotent replay from another branch must create that branch's own order
-- (ORD-H4, tests/orders-branch-scope.test.js). The earlier restaurant-wide index is dropped here if it was created.
DROP INDEX IF EXISTS orders_restaurant_client_id_uniq;
UPDATE orders
SET data = data - 'client_id'
WHERE data->>'client_id' IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (restaurant_id, COALESCE(branch_id, 'main'), (data->>'client_id')) id
    FROM orders
    WHERE data->>'client_id' IS NOT NULL
    ORDER BY restaurant_id, COALESCE(branch_id, 'main'), (data->>'client_id'), created_at DESC
  );
CREATE UNIQUE INDEX IF NOT EXISTS orders_branch_client_id_uniq
  ON orders (restaurant_id, branch_id, (data->>'client_id'))
  WHERE data->>'client_id' IS NOT NULL;

-- ORD-M4: a till has at most one open check-in (checked_out_at IS NULL).
UPDATE till_checkins
SET checked_out_at = NOW()
WHERE checked_out_at IS NULL
  AND id NOT IN (
    SELECT DISTINCT ON (restaurant_id, till_id) id
    FROM till_checkins
    WHERE checked_out_at IS NULL
    ORDER BY restaurant_id, till_id, checked_in_at DESC
  );
CREATE UNIQUE INDEX IF NOT EXISTS till_checkins_one_open_idx
  ON till_checkins (restaurant_id, till_id)
  WHERE checked_out_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- SEC-M10 / SEC-M11 / SEC-M12: tables and columns that request handlers used to create at runtime.
-- Every statement is idempotent (IF NOT EXISTS), so this file can run again on an existing database.
-- ---------------------------------------------------------------------------------------------

-- Rider pay plans (restaurant-service drivers.js). Older builds kept these as restaurant_blobs; drivers.js copies them in once.
CREATE TABLE IF NOT EXISTS driver_pay_policies (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  unit TEXT NOT NULL DEFAULT 'mile',
  effective_from DATE NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, driver_id, effective_from)
);

-- Payments made to riders (never edited or deleted).
CREATE TABLE IF NOT EXISTS driver_payments (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  pay_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_pay_policies_driver ON driver_pay_policies (restaurant_id, driver_id);
-- Rider pay belongs to the rider's branch (NULL = restaurant-level rider). Legacy rows keep NULL, unchanged.
ALTER TABLE driver_pay_policies ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE driver_payments ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_driver_payments_branch ON driver_payments (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_driver_pay_policies_branch ON driver_pay_policies (restaurant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_driver_payments_driver ON driver_payments (restaurant_id, driver_id);

-- Cash a rider hands in to the restaurant from cash deliveries (the rider's cash in hand is computed from orders).
-- Rows are never edited or deleted. Branch rows follow the rider's branch (NULL = restaurant-level rider).
CREATE TABLE IF NOT EXISTS driver_cash_settlements (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  branch_id TEXT,
  driver_id TEXT NOT NULL,
  settle_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_cash_settlements_driver ON driver_cash_settlements (restaurant_id, driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_cash_settlements_branch ON driver_cash_settlements (restaurant_id, branch_id);

-- Delivery man joining requests. pending -> approved (creates the rider record and login) or rejected (reason kept).
-- Branch rows follow the branch the request was made for (NULL = restaurant-level).
CREATE TABLE IF NOT EXISTS deliveryman_requests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id TEXT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  vehicle TEXT,
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,
  deliveryman_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by TEXT,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deliveryman_requests_scope ON deliveryman_requests (restaurant_id, branch_id, state);
-- One open request per phone per restaurant: a repeat submission is refused, not queued twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveryman_requests_pending_phone ON deliveryman_requests (restaurant_id, phone) WHERE state = 'pending';

-- Customer reviews of a delivery. One review per order. Staff hide and restore; hidden reviews are kept, not deleted.
CREATE TABLE IF NOT EXISTS delivery_reviews (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id TEXT,
  order_id BIGINT NOT NULL,
  customer_id TEXT NOT NULL,
  deliveryman_id TEXT NOT NULL,
  customer_name TEXT,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'hidden')),
  hidden_reason TEXT,
  hidden_by TEXT,
  hidden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_reviews_scope ON delivery_reviews (restaurant_id, branch_id, state);
CREATE INDEX IF NOT EXISTS idx_delivery_reviews_rider ON delivery_reviews (restaurant_id, deliveryman_id);

-- Document version for optimistic concurrency on PUT /domain/... (If-Match). 0 = never written as a document.
ALTER TABLE domain_docs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Stripe webhook dedupe (platform-service stripeOps.js). The event id is claimed before processing.
-- status 'processing' is a claim in progress; 'done' means processed and acknowledged.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- SEC-M17: print queue rows (claimed with FOR UPDATE SKIP LOCKED) and per-restaurant call counters.
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_b64 TEXT,
  claimed_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON print_jobs (restaurant_id, status, created_at);
-- Print jobs belong to the branch of the session that made them (NULL = restaurant-level). Legacy jobs keep NULL.
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS branch_id TEXT;
CREATE INDEX IF NOT EXISTS print_jobs_branch_idx ON print_jobs (restaurant_id, branch_id, status);

CREATE TABLE IF NOT EXISTS call_counters (
  restaurant_id TEXT PRIMARY KEY,
  last_no BIGINT NOT NULL
);

-- SEC-M10: tables the EPOS service used to create while handling requests (security audit and PIN throttle).
CREATE TABLE IF NOT EXISTS security_audit (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id TEXT,
  actor TEXT,
  actor_role TEXT,
  event TEXT NOT NULL,
  subject TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS security_audit_restaurant_idx ON security_audit (restaurant_id, created_at);
CREATE TABLE IF NOT EXISTS pin_throttle (
  key TEXT PRIMARY KEY,
  fails INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Restaurant-level master products and categories can be assigned to branches (one master record, no copies).
-- Each assignment carries that branch's own overrides; NULL means "use the master value". Assignments are never
-- deleted by a branch login; the restaurant admin removes them. Historical orders keep their own snapshots.
CREATE TABLE IF NOT EXISTS product_branch_assignments (
  restaurant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  price NUMERIC(12,2),
  image TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_product_branch_assignments_branch ON product_branch_assignments (restaurant_id, branch_id);

CREATE TABLE IF NOT EXISTS category_branch_assignments (
  restaurant_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_category_branch_assignments_branch ON category_branch_assignments (restaurant_id, branch_id);

-- Chef / kitchen app: password reset OTPs (6-digit code, then a single-use reset token) and kitchen alerts.
CREATE TABLE IF NOT EXISTS password_resets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  email         TEXT NOT NULL,
  otp_hash      TEXT NOT NULL,
  reset_hash    TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id, created_at);

CREATE TABLE IF NOT EXISTS kitchen_notifications (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      TEXT,
  title          TEXT NOT NULL,
  message        TEXT,
  order_id       TEXT,
  is_read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_notifications_restaurant ON kitchen_notifications (restaurant_id, is_read, created_at);

-- Rider (deliveryman) app: work shifts with their Z figures, cash handovers to the restaurant, app preferences, GPS.
CREATE TABLE IF NOT EXISTS rider_shifts (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id    TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  opening_cash      NUMERIC(12,2) NOT NULL DEFAULT 0,
  float_owner       TEXT NOT NULL DEFAULT 'restaurant',
  actual_closing    NUMERIC(12,2),
  expected_closing  NUMERIC(12,2),
  variance          NUMERIC(12,2),
  restaurant_due    NUMERIC(12,2),
  orders_count      INT,
  cash_collected    NUMERIC(12,2),
  cash_tips         NUMERIC(12,2),
  online_tips       NUMERIC(12,2),
  note              TEXT,
  z_number          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rider_shifts_rider ON rider_shifts (restaurant_id, deliveryman_id, started_at);

CREATE TABLE IF NOT EXISTS rider_cash_handovers (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id    TEXT NOT NULL,
  shift_id          TEXT,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending_confirmation',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at      TIMESTAMPTZ,
  confirmed_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rider_cash_handovers_rider ON rider_cash_handovers (restaurant_id, deliveryman_id, created_at);

CREATE TABLE IF NOT EXISTS rider_preferences (
  deliveryman_id    TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rider_locations (
  id                BIGSERIAL PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  deliveryman_id    TEXT NOT NULL,
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  heading           DOUBLE PRECISION,
  speed             DOUBLE PRECISION,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rider_locations_rider ON rider_locations (restaurant_id, deliveryman_id, recorded_at);
