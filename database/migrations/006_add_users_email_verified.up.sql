-- 006_add_users_email_verified.up.sql
-- Adds is_email_verified column to users table and creates consumed_verification_tokens table for replay protection.

-- 1. Add is_email_verified to users (reusing customers.is_email_verified from migration 004)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT FALSE;

-- 2. Concurrency-safe replay protection for single-use verification tokens
CREATE TABLE IF NOT EXISTS consumed_verification_tokens (
  jti TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_verification_tokens_exp ON consumed_verification_tokens(exp);
