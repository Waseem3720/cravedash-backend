-- =============================================================================
-- CraveDash Baseline Schema Manual Recovery Script (000_baseline.down.sql)
--
-- CAUTION: DO NOT EXECUTE AUTOMATICALLY.
-- CraveDash migration policy prohibits automatic destructive rollbacks.
-- This file serves solely as documented manual recovery instructions in the
-- event of catastrophic initial deployment failure under explicit supervision.
--
-- To execute manual recovery:
--   psql "$DATABASE_URL" -f 000_baseline.down.sql
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS report_counters CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS employee_roles CASCADE;
DROP TABLE IF EXISTS dining_tables CASCADE;
DROP TABLE IF EXISTS dining_areas CASCADE;
DROP TABLE IF EXISTS epos_activity_logs CASCADE;
DROP TABLE IF EXISTS epos_sync_events CASCADE;
DROP TABLE IF EXISTS epos_tills CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;
DROP TABLE IF EXISTS payment_transactions CASCADE;
DROP TABLE IF EXISTS order_approvals CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS product_addons CASCADE;
DROP TABLE IF EXISTS product_variations CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS stripe_config CASCADE;
DROP TABLE IF EXISTS platform_admins CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS restaurants CASCADE;
DROP TABLE IF EXISTS plans CASCADE;
DROP TABLE IF EXISTS user_prefs CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS schema_migrations CASCADE;

COMMIT;
