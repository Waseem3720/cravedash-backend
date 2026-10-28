-- CraveDash minimal SQL seed (reference data + super admin placeholder)
-- Full demo data: run `npm run seed` in this directory after migrations.
--
-- Password for owner@cravedash.co.uk: demo12345
-- Hash generated with bcrypt cost 10 (matches seed.js)

BEGIN;

INSERT INTO platform_settings (id, stripe, access_policy, platform_terms)
VALUES (
  'platform',
  '{"mode":"test","app_fee_percent":1.5,"statement_descriptor":"CRAVEDASH"}'::jsonb,
  '{"grace_days":3,"restrict_after":7,"suspend_after":21,"restricted_modules":["online","table_qr"],"notify_owner":true,"auto_retry":true,"retry_days":[1,3,5]}'::jsonb,
  '{"version":"2.3","require_reaccept":true,"allow_restaurant_terms":true}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Super admin (password: demo12345). Prefer re-seeding via seed.js for full catalogue.
INSERT INTO users (id, email, password_hash, name, phone, role, permissions, restaurant_id, status)
VALUES (
  'u_super',
  'owner@cravedash.co.uk',
  '$2b$10$vOg2nk7x0Awq2JiPfRYsPuvcyLwsRQqC9z6U7W2lK3JnT3vXmi.KO',
  'Platform Owner',
  '+44 7700 900000',
  'super_admin',
  '"ALL"'::jsonb,
  NULL,
  'active'
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role,
  permissions = EXCLUDED.permissions;

COMMIT;
