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

INSERT INTO platform_admins (id, name, email, phone, role, status, perms)
VALUES
  ('a1', 'Master Admin', 'admin@cravedash.co.uk', '+44 7700 900001', 'owner', TRUE, '"ALL"'),
  ('a2', 'Ayesha Khan', 'finance@cravedash.co.uk', '+44 7700 900002', 'finance', TRUE, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (id, restaurant_id, plan_id, start_at, end_at, status)
VALUES ('sub_r1', 'r1', 'plan_starter', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', 'active')
ON CONFLICT (id) DO NOTHING;

-- Password for all demo users: demo12345
INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id)
VALUES
  ('u_super', 'owner@cravedash.co.uk', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'super', 'Platform Owner', NULL, NULL),
  ('u_super_legacy', 'admin@cravedash.co.uk', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'super', 'Master Admin', NULL, NULL),
  ('u_owner', 'owner@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'restaurant', 'Faisal', 'r1', NULL),
  ('u_admin_super', 'admin@cravedash.com', '$2a$10$cEj/R9KiI648sbiXVxlTIOacxFO3POfNneZ8/4Q7Nq6Zc/LxfxQA6', 'super', 'Master Super Admin', NULL, NULL),
  ('u_epos', 'till1@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'epos', 'Till 1', 'r1', 'till-1'),
  ('u_epos_alias', 'till1@cravedash.com', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'epos', 'Till 1 - Front Counter', 'r1', 'till-1'),
  ('u_epos_legacy', 'till@portopiripiri.example', '$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq', 'epos', 'Till User', 'r1', 'till-1')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, name = EXCLUDED.name,
  restaurant_id = EXCLUDED.restaurant_id, till_id = EXCLUDED.till_id, status = TRUE;

INSERT INTO restaurant_settings (restaurant_id, settings)
VALUES ('r1', '{"vat_rate":20,"vat_inclusive":true,"restaurant_name":"Porto Piri Piri","auto_accept_pos":true}')
ON CONFLICT (restaurant_id) DO NOTHING;

INSERT INTO epos_tills (id, restaurant_id, name) VALUES
  ('till-1', 'r1', 'Till 1'),
  ('till_01', 'r1', 'Till 1 - Front Counter'),
  ('till_main_01', 'r1', 'Till Main')
ON CONFLICT (id) DO NOTHING;

INSERT INTO till_staff (id, restaurant_id, name, pin_hash, role, till_id, status, data)
VALUES
  ('ts1', 'r1', 'Alex Khan', '$2a$10$LOIJqFvEWW2LnVHUZqiM9O7NjVcFvYXHd5XGslc3DTX.YIBP8n23m', 'manager', 'till-1', TRUE, '{"can_approve":true}'),
  ('stf_alex_01', 'r1', 'Alex Khan', '$2a$10$LOIJqFvEWW2LnVHUZqiM9O7NjVcFvYXHd5XGslc3DTX.YIBP8n23m', 'manager', 'till-1', TRUE, '{"can_approve":true}'),
  ('ts2', 'r1', 'Sarah Johnson', '$2a$10$lQworfokaGNCkPPd.8meZ.Sdi8F2TBnEGpJhDrCFKmFD6WaCIHHVO', 'supervisor', 'till-1', TRUE, '{"can_approve":true}'),
  ('ts3', 'r1', 'Maria Clarke', '$2a$10$9q8Rjaetbjf9Oy/ZevegTeMYrFG.cc56JMs/lPqFjI1w.2auouOmy', 'cashier', 'till-1', TRUE, '{"can_approve":false}'),
  ('ts4', 'r1', 'Omar Ali', '$2a$10$ROi2ViYgYX77zT9AqeCIXO9ce.oZM0q447fCKJwDotBkVJC57ffPK', 'cashier', 'till-1', TRUE, '{"can_approve":false}')
ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, name = EXCLUDED.name, role = EXCLUDED.role, data = EXCLUDED.data, status = TRUE;

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

INSERT INTO customers (id, restaurant_id, name, email, phone, wallet_balance, loyalty_points, data, status)
VALUES
  ('cust1', 'r1', 'Liam Smith', 'liam@example.com', '07123456789', 12.50, 0, '{}'::jsonb, TRUE),
  ('cust_example', 'r1', 'Example Customer', 'customer@example.com', '07123456789', 0, 0, '{"password_hash":"$2a$10$gY0WjJqIhtTUjrje2wyQdeoXh5KvNJ60y5tP4gDX0imqfJdnSXGMi"}'::jsonb, TRUE),
  ('cust_1002', 'r1', 'Alex Johnson', 'alex.j@example.com', '+447123456789', 15.00, 120, '{"address":"12 High Street","city":"Glasgow","postcode":"SW1A 1AA","notes":"Door code #4321","allergies":["nuts"],"rating":5}'::jsonb, TRUE),
  ('cust_demo_delete', 'r1', 'Demo Deletable Customer', 'deletable@example.com', '+447000000999', 0, 0, '{"address":"Demo Lane"}'::jsonb, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO categories (id, restaurant_id, num, name, colour, text_colour, priority, status)
VALUES ('cat_demo_delete', 'r1', 99, 'Temporary Test Category', '#999999', '#ffffff', 99, TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, restaurant_id, name, category_id, price, from_price, data, status, visible, description)
VALUES ('p_demo_delete', 'r1', 'Temporary Test Burger', 'cat_demo_delete', 4.50, 4.50, '{"product_type":"veg"}'::jsonb, TRUE, TRUE, 'Temporary test item for DELETE endpoint')
ON CONFLICT (id) DO NOTHING;

INSERT INTO held_orders (id, restaurant_id, till_id, label, payload)
VALUES ('hold_m29bk14', 'r1', 'till-1', 'Window Table 7 - Sarah', '{"id":"hold_m29bk14","till_id":"till-1","label":"Window Table 7 - Sarah","cart":{"items":[{"product_id":"p1","name":"Classic Burger","price":8.99,"qty":2,"addons":[]}],"subtotal":17.98,"total":17.98},"customer":{"name":"Sarah","phone":"+447700900123"}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (
  id, restaurant_id, branch, branch_id, source, order_type, status, payment_status, payment_method,
  customer, table_id, guests, items, subtotal, discount, delivery_charge, service_charge, tip,
  total, note, history, acknowledged, data
) VALUES (
  10041, 'r1', 'Main Branch', 'main', 'epos', 'dine_in', 'pending', 'unpaid', 'cash',
  '{"name":"Walk-in Customer","phone":"+447123456789"}'::jsonb, 'T1', 2,
  '[{"id":"p1","name":"Classic Burger","price":8.99,"quantity":2,"total":17.98},{"id":"ad1","name":"Extra Cheese","price":0.60,"quantity":2,"total":1.20}]'::jsonb,
  19.18, 0, 0, 1.82, 0, 21.00, 'Table 1 - Dine In',
  '[{"status":"pending","at":"2026-11-02T10:00:00.000Z","by":"Till 1"}]'::jsonb,
  FALSE, '{"client_id":"ord_client_10041","source":"epos","dining_type":"dine_in","table_number":"1"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

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

INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
VALUES
  ('u_chef_musa', 'musamasufi.dev@gmail.com', '$2a$10$1ClHi6rkLPo0HWHw1myFp.XW0uaAwNwj6k0bdLQPfnhoXABKbcDu2', 'chef', 'Musa Chef', 'r1')
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, name = EXCLUDED.name, restaurant_id = EXCLUDED.restaurant_id, status = TRUE;

INSERT INTO chefs (id, restaurant_id, name, email, phone, status, password_hash, data)
VALUES
  ('chef_musa', 'r1', 'Musa Chef', 'musamasufi.dev@gmail.com', '07700900222', TRUE, '$2a$10$1ClHi6rkLPo0HWHw1myFp.XW0uaAwNwj6k0bdLQPfnhoXABKbcDu2', '{"password_hash":"$2a$10$1ClHi6rkLPo0HWHw1myFp.XW0uaAwNwj6k0bdLQPfnhoXABKbcDu2","alt_password_hash":"$2a$10$sp7k4avkTd3tbQvq32dJCOLjKleS.km9nuTdvmppm6ANKdJgIhMOq","pin_hash":"$2a$10$LOIJqFvEWW2LnVHUZqiM9O7NjVcFvYXHd5XGslc3DTX.YIBP8n23m"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = EXCLUDED.status, data = EXCLUDED.data, email = EXCLUDED.email;

INSERT INTO deliverymen (id, restaurant_id, name, phone, email, vehicle, status, password_hash, data)
VALUES
  ('dm_rider_co_uk', 'r1', 'Porto Delivery Rider', '07700900111', 'rider@portopiripiri.co.uk', 'motorcycle', 'active', '$2a$10$Df2S2d7f7zMbx3l9XQEWQ.XNiP1fF2TQD7ibXKJF9cpRII1IZWgWa', '{"password_hash":"$2a$10$Df2S2d7f7zMbx3l9XQEWQ.XNiP1fF2TQD7ibXKJF9cpRII1IZWgWa","restaurant_name":"Porto Piri Piri","vehicle":"motorcycle","reg":"DEMO 01"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = EXCLUDED.status, data = EXCLUDED.data, email = EXCLUDED.email;
