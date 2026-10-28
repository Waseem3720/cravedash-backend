-- 006_add_users_email_verified.down.sql
-- Reverts is_email_verified from users and drops consumed_verification_tokens.

DROP TABLE IF EXISTS consumed_verification_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS is_email_verified;
