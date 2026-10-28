-- CraveDash PostgreSQL schema (prototype-aligned TEXT ids: r1, cat1, p173, …)
-- Run: psql $DATABASE_URL -f migrations/001_init.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Utilities
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_logs_deny_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Platform & tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE subscription_plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plan_type       TEXT NOT NULL DEFAULT 'restaurant',
  description     TEXT,
  price_monthly   NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_yearly    NUMERIC(12,2),
  duration_days   INT NOT NULL DEFAULT 30,
  max_orders      INT,
  sort_order      INT NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  trial_days      INT NOT NULL DEFAULT 0,
  terminals       INT NOT NULL DEFAULT 1,
  branches        INT NOT NULL DEFAULT 1,
  commission      NUMERIC(6,3) NOT NULL DEFAULT 0,
  features        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  popular         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE restaurants (
  id                TEXT PRIMARY KEY,
  live_id           INT,
  name              TEXT NOT NULL,
  slug              TEXT,
  city              TEXT,
  address           TEXT,
  owner_name        TEXT,
  email             TEXT,
  phone             TEXT,
  timezone          TEXT NOT NULL DEFAULT 'Europe/London',
  currency          TEXT NOT NULL DEFAULT 'GBP',
  vat_registered    TEXT NOT NULL DEFAULT 'no',
  vat_number        TEXT,
  plan_id           TEXT REFERENCES subscription_plans(id),
  billing_cycle     TEXT NOT NULL DEFAULT 'monthly',
  sub_status        TEXT NOT NULL DEFAULT 'inactive',
  joined_at         TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  branch_count      INT NOT NULL DEFAULT 0,
  max_branches      INT NOT NULL DEFAULT 1,
  api_key           TEXT,
  api_key_status    BOOLEAN NOT NULL DEFAULT FALSE,
  status            BOOLEAN NOT NULL DEFAULT TRUE,
  next_charge       TIMESTAMPTZ,
  auto_deduct       BOOLEAN NOT NULL DEFAULT FALSE,
  card_last4        TEXT,
  card_brand        TEXT,
  stripe_account    TEXT,
  charges_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_balance    NUMERIC(12,2) NOT NULL DEFAULT 0,
  modules           JSONB NOT NULL DEFAULT '{}'::jsonb,
  access_level      TEXT NOT NULL DEFAULT 'full',
  monthly_gmv       NUMERIC(14,2) NOT NULL DEFAULT 0,
  compliance        JSONB NOT NULL DEFAULT '{}'::jsonb,
  branch_list       JSONB NOT NULL DEFAULT '[]'::jsonb,
  machinery         JSONB NOT NULL DEFAULT '{}'::jsonb,
  tills_summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  services          TEXT,
  dash_widgets      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_restaurants_plan ON restaurants(plan_id);
CREATE INDEX idx_restaurants_sub_status ON restaurants(sub_status);
CREATE INDEX idx_restaurants_email ON restaurants(email);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  name            TEXT,
  phone           TEXT,
  role            TEXT NOT NULL,
  permissions     JSONB,
  restaurant_id   TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_role_check CHECK (
    role IN ('super_admin', 'restaurant_admin', 'employee')
  )
);

CREATE INDEX idx_users_restaurant ON users(restaurant_id);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE subscription_assignments (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL REFERENCES subscription_plans(id),
  price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',
  payment_status  TEXT NOT NULL DEFAULT 'paid',
  payment_method  TEXT,
  auto_renew      BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sub_assign_restaurant ON subscription_assignments(restaurant_id);

CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  plan_id         TEXT REFERENCES subscription_plans(id),
  amount          NUMERIC(12,2) NOT NULL,
  invoiced_at     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'paid',
  attempts        INT NOT NULL DEFAULT 1,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_restaurant ON invoices(restaurant_id);
CREATE INDEX idx_invoices_date ON invoices(invoiced_at);

-- ---------------------------------------------------------------------------
-- Branches, tills, terminals
-- ---------------------------------------------------------------------------

CREATE TABLE branches (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  address           TEXT,
  phone             TEXT,
  email             TEXT,
  branch_type       TEXT NOT NULL DEFAULT 'Main',
  tills_need        INT NOT NULL DEFAULT 1,
  tills_give        INT NOT NULL DEFAULT 1,
  preparation_time  INT NOT NULL DEFAULT 20,
  status            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_branches_restaurant ON branches(restaurant_id);

CREATE TABLE tills (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  calls           BOOLEAN NOT NULL DEFAULT TRUE,
  remote          BOOLEAN NOT NULL DEFAULT FALSE,
  ring_secs       INT,
  added_by        TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tills_restaurant ON tills(restaurant_id);
CREATE INDEX idx_tills_branch ON tills(branch_id);

CREATE TABLE till_staff (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT,
  pin_hash        TEXT NOT NULL,
  color           TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  can_approve     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_till_staff_restaurant ON till_staff(restaurant_id);

CREATE TABLE card_terminals (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL,
  label           TEXT NOT NULL,
  provider        TEXT,
  serial_number   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_card_terminals_restaurant ON card_terminals(restaurant_id);

-- ---------------------------------------------------------------------------
-- Menu catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  num             INT,
  name            TEXT NOT NULL,
  image           TEXT,
  colour          TEXT,
  text_colour     TEXT,
  priority        INT NOT NULL DEFAULT 0,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_restaurant ON categories(restaurant_id);

CREATE TABLE subcategories (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  parent_id       TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  colour          TEXT,
  inherit_colour  BOOLEAN NOT NULL DEFAULT TRUE,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subcategories_parent ON subcategories(parent_id);

CREATE TABLE addons (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax             NUMERIC(10,2) NOT NULL DEFAULT 0,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addons_restaurant ON addons(restaurant_id);

CREATE TABLE cuisines (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sub_title       TEXT,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  priority        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cuisines_restaurant ON cuisines(restaurant_id);

CREATE TABLE products (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  live_id           INT,
  name              TEXT NOT NULL,
  description       TEXT,
  category_id       TEXT REFERENCES categories(id) ON DELETE SET NULL,
  sub_category_id   TEXT REFERENCES subcategories(id) ON DELETE SET NULL,
  price             NUMERIC(10,2) NOT NULL DEFAULT 0,
  from_price        NUMERIC(10,2),
  img               TEXT,
  image             TEXT,
  has_image         BOOLEAN NOT NULL DEFAULT FALSE,
  variations        JSONB NOT NULL DEFAULT '[]'::jsonb,
  addon_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_type         TEXT NOT NULL DEFAULT 'product',
  product_type      TEXT NOT NULL DEFAULT 'nonveg',
  halal             BOOLEAN NOT NULL DEFAULT TRUE,
  age_restricted    BOOLEAN NOT NULL DEFAULT FALSE,
  discount_type     TEXT,
  discount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_type          TEXT,
  tax               NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_class         TEXT,
  served_hot        TEXT,
  allergens         JSONB NOT NULL DEFAULT '{}'::jsonb,
  stock_type        TEXT NOT NULL DEFAULT 'unlimited',
  product_stock     INT NOT NULL DEFAULT 0,
  stock             BOOLEAN NOT NULL DEFAULT TRUE,
  status            BOOLEAN NOT NULL DEFAULT TRUE,
  visible           BOOLEAN NOT NULL DEFAULT TRUE,
  available_from    TEXT,
  available_till    TEXT,
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended       BOOLEAN NOT NULL DEFAULT FALSE,
  cuisines          JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_sale        INT NOT NULL DEFAULT 0,
  rating            NUMERIC(3,1),
  tills             JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_restaurant ON products(restaurant_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_live_id ON products(live_id);

-- ---------------------------------------------------------------------------
-- Floor plan
-- ---------------------------------------------------------------------------

CREATE TABLE areas (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_areas_restaurant ON areas(restaurant_id);

CREATE TABLE restaurant_tables (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  area_id         TEXT REFERENCES areas(id) ON DELETE SET NULL,
  number          INT NOT NULL,
  shape           TEXT,
  seats           INT NOT NULL DEFAULT 2,
  pos_x           INT NOT NULL DEFAULT 0,
  pos_y           INT NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  reserved        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, number)
);

CREATE INDEX idx_restaurant_tables_area ON restaurant_tables(area_id);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  orders_count    INT NOT NULL DEFAULT 0,
  total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0,
  loyalty_points  INT NOT NULL DEFAULT 0,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_restaurant ON customers(restaurant_id);
CREATE INDEX idx_customers_phone ON customers(restaurant_id, phone);

CREATE TABLE customer_addresses (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label           TEXT,
  line1           TEXT NOT NULL,
  line2           TEXT,
  city            TEXT,
  postcode        TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  restaurant_id     TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id         TEXT REFERENCES branches(id) ON DELETE SET NULL,
  branch_name       TEXT,
  source            TEXT NOT NULL,
  order_type        TEXT NOT NULL,
  status            TEXT NOT NULL,
  payment_status    TEXT NOT NULL,
  payment_method    TEXT,
  customer_id       TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_snapshot JSONB,
  table_id          TEXT REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  guests            INT NOT NULL DEFAULT 0,
  server_name       TEXT,
  subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  coupon_code       TEXT,
  delivery_charge   NUMERIC(12,2) NOT NULL DEFAULT 0,
  service_charge    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip               NUMERIC(12,2) NOT NULL DEFAULT 0,
  total             NUMERIC(12,2) NOT NULL DEFAULT 0,
  note              TEXT,
  prep_time         INT,
  delivery_man      TEXT,
  refund_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  acknowledged      BOOLEAN,
  till_id           TEXT REFERENCES tills(id) ON DELETE SET NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(restaurant_id, status);

CREATE TABLE order_items (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id      TEXT REFERENCES products(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  category        TEXT,
  qty             INT NOT NULL DEFAULT 1,
  price           NUMERIC(10,2) NOT NULL,
  variation       TEXT,
  addons          JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE order_history (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL,
  changed_by      TEXT,
  note            TEXT
);

CREATE INDEX idx_order_history_order ON order_history(order_id);

-- ---------------------------------------------------------------------------
-- Marketing
-- ---------------------------------------------------------------------------

CREATE TABLE coupons (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  code            TEXT NOT NULL,
  coupon_type     TEXT NOT NULL DEFAULT 'default',
  discount_type   TEXT NOT NULL,
  discount        NUMERIC(10,2) NOT NULL,
  min_purchase    NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_discount    NUMERIC(10,2),
  usage_limit     INT,
  used_count      INT NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, code)
);

CREATE INDEX idx_coupons_restaurant ON coupons(restaurant_id);

CREATE TABLE promotions (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  placement       TEXT,
  branch          TEXT,
  channel         TEXT,
  coupon_code     TEXT,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  colour          TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE discounts (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  discount_type   TEXT NOT NULL,
  value           NUMERIC(10,2) NOT NULL,
  applies_to      JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deals (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  deal_type       TEXT,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE banners (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title           TEXT,
  image_url       TEXT,
  link_url        TEXT,
  placement       TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Bookings & held orders
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        TEXT REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  customer_email  TEXT,
  party_size      INT NOT NULL DEFAULT 2,
  booked_for      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_restaurant ON bookings(restaurant_id, booked_for);

CREATE TABLE held_orders (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  staff_id        TEXT REFERENCES till_staff(id) ON DELETE SET NULL,
  label           TEXT,
  payload         JSONB NOT NULL,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_held_orders_restaurant ON held_orders(restaurant_id);

-- ---------------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------------

CREATE TABLE approval_rules (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT REFERENCES restaurants(id) ON DELETE CASCADE,
  app             TEXT NOT NULL,
  action          TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  requires_pin    BOOLEAN NOT NULL DEFAULT TRUE,
  requires_remote BOOLEAN NOT NULL DEFAULT FALSE,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approval_rules_restaurant ON approval_rules(restaurant_id);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  app             TEXT NOT NULL,
  action          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  staff_id        TEXT REFERENCES till_staff(id) ON DELETE SET NULL,
  via             TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approvals_restaurant_status ON approvals(restaurant_id, status);

CREATE TABLE approval_history (
  id              BIGSERIAL PRIMARY KEY,
  approval_id     TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  actor           TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approval_history_approval ON approval_history(approval_id);

-- ---------------------------------------------------------------------------
-- Till reporting & cash
-- ---------------------------------------------------------------------------

CREATE TABLE till_counts (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  staff_name      TEXT,
  count_type      TEXT NOT NULL,
  total           NUMERIC(12,2),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  counted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_till_counts_restaurant ON till_counts(restaurant_id, counted_at);

CREATE TABLE cash_movements (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  movement_type   TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  reason          TEXT,
  recorded_by     TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cash_movements_restaurant ON cash_movements(restaurant_id);

CREATE TABLE z_reports (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  z_no            INT NOT NULL,
  report          JSONB NOT NULL,
  counted_cash    NUMERIC(12,2),
  variance        NUMERIC(12,2),
  generated_at    TIMESTAMPTZ NOT NULL,
  generated_by    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_z_reports_restaurant ON z_reports(restaurant_id, generated_at);

-- ---------------------------------------------------------------------------
-- Staff & delivery
-- ---------------------------------------------------------------------------

CREATE TABLE employee_roles (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  permissions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employees (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  role_id         TEXT REFERENCES employee_roles(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_restaurant ON employees(restaurant_id);

CREATE TABLE chefs (
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

CREATE TABLE deliverymen (
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

CREATE INDEX idx_deliverymen_restaurant ON deliverymen(restaurant_id);

-- ---------------------------------------------------------------------------
-- Settings & platform
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, key)
);

CREATE TABLE menu_presentation (
  restaurant_id   TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE platform_settings (
  id              TEXT PRIMARY KEY DEFAULT 'platform',
  stripe          JSONB NOT NULL DEFAULT '{}'::jsonb,
  access_policy   JSONB NOT NULL DEFAULT '{}'::jsonb,
  platform_terms  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  restaurant_id   TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  actor_user_id   TEXT,
  actor_email     TEXT,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  action          TEXT NOT NULL,
  before_data     JSONB,
  after_data      JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_restaurant ON audit_logs(restaurant_id, created_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Support, subscribers, reviews, devices
-- ---------------------------------------------------------------------------

CREATE TABLE support_tickets (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queue',
  priority        TEXT NOT NULL DEFAULT 'normal',
  channel         TEXT,
  requester_email TEXT,
  unread_admin    BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_support_tickets_status ON support_tickets(status);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT REFERENCES support_tickets(id) ON DELETE CASCADE,
  restaurant_id   TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  sender          TEXT NOT NULL,
  body            TEXT NOT NULL,
  read_at         TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_ticket ON messages(ticket_id);

CREATE TABLE subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  source          TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  subscribed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reviews (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  product_id      TEXT REFERENCES products(id) ON DELETE SET NULL,
  order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
  customer_name   TEXT,
  stars           NUMERIC(2,1) NOT NULL,
  review_note     TEXT,
  status          TEXT NOT NULL DEFAULT 'published',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reviews_product ON reviews(product_id);

CREATE TABLE printers (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  printer_type    TEXT NOT NULL DEFAULT 'receipt',
  connection      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  till_id         TEXT REFERENCES tills(id) ON DELETE SET NULL,
  device_type     TEXT NOT NULL,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_devices_restaurant ON devices(restaurant_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'subscription_plans', 'restaurants', 'users', 'subscription_assignments', 'invoices',
    'branches', 'tills', 'till_staff', 'card_terminals',
    'categories', 'subcategories', 'addons', 'cuisines', 'products',
    'areas', 'restaurant_tables', 'customers', 'customer_addresses', 'orders',
    'coupons', 'promotions', 'discounts', 'deals', 'banners',
    'bookings', 'held_orders', 'approval_rules', 'approvals',
    'cash_movements', 'employee_roles', 'employees', 'chefs', 'deliverymen',
    'settings', 'menu_presentation', 'platform_settings',
    'support_tickets', 'subscribers', 'reviews', 'printers', 'devices'
  ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE PROCEDURE set_updated_at()',
      t, t
    );
  END LOOP;
END $$;

CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE PROCEDURE audit_logs_deny_mutation();

COMMIT;
