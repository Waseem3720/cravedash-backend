-- 001_add_missing_platform_tables.down.sql
-- Emergency manual recovery script for 001_add_missing_platform_tables.up.sql
--
-- SAFEGUARD NOTICE: Automatic destructive rollbacks are strictly prohibited.
-- This script drops platform management tables and will destroy existing tickets, payouts, and audits.
-- Execute manually only under explicit operational change control after a verified backup.

DROP TABLE IF EXISTS audit_events CASCADE;
DROP TABLE IF EXISTS refund_requests CASCADE;
DROP TABLE IF EXISTS payouts CASCADE;
DROP TABLE IF EXISTS platform_meta CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;
