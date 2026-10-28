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
