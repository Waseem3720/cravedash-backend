-- 003: a password for website customers who register with an e-mail address (POST /api/v1/auth/registration).
-- Additive and idempotent: the column is added only when it is missing, and nothing else changes.
-- Applied by shared/scripts/migrate.js after 002. Customers who sign in by phone code keep a NULL password.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
