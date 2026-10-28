-- 002_add_missing_merchant_tables.down.sql
-- Emergency manual recovery script for 002_add_missing_merchant_tables.up.sql
--
-- SAFEGUARD NOTICE: Automatic destructive rollbacks are strictly prohibited.
-- This script drops merchant tables: branches, deliverymen, chefs, subscribers, subscriber_events.
-- Execute manually only under explicit operational change control after a verified backup.

DROP TABLE IF EXISTS subscriber_events CASCADE;
DROP TABLE IF EXISTS subscribers CASCADE;
DROP TABLE IF EXISTS chefs CASCADE;
DROP TABLE IF EXISTS deliverymen CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
