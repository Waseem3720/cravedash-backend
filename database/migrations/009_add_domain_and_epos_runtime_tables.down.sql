-- ============================================================================
-- CraveDash Canonical Migration: 009_add_domain_and_epos_runtime_tables.down.sql
-- CD-CON-058 Change B: Down Migration Safety Safeguard
-- ============================================================================
-- POLICY SAFEGUARD:
-- In accordance with CraveDash data preservation rules, automated destructive rollbacks
-- (DROP TABLE ... CASCADE) on operational runtime tables are strictly prohibited.
--
-- Tables managed by Migration 009:
--   - public.domain_docs (replaces restaurant_blobs for operational configuration)
--   - public.domain_rows (immutable append-only ledgers and courier job events)
--   - public.sync_idempotency (offline EPOS transaction synchronization deduplication)
--   - public.staff_timeclock (employee shift and break tracking state)
--   - public.staff_timeclock_events (immutable audit log for employee timeclock changes)
--
-- Justification:
-- These tables may contain active production data created before or during Migration 009.
-- Executing an automated DROP TABLE would result in irreversible loss of cashier shifts,
-- offline POS transaction deduplication records, and accounting/inventory documents.
--
-- Manual Administrative Rollback Procedure (Development/Staging Only):
-- If teardown is explicitly approved on an isolated development or test database:
--   1. Confirm all five tables contain zero operational rows:
--      SELECT 'domain_docs' AS tbl, count(*) FROM public.domain_docs
--      UNION ALL SELECT 'domain_rows', count(*) FROM public.domain_rows
--      UNION ALL SELECT 'sync_idempotency', count(*) FROM public.sync_idempotency
--      UNION ALL SELECT 'staff_timeclock', count(*) FROM public.staff_timeclock
--      UNION ALL SELECT 'staff_timeclock_events', count(*) FROM public.staff_timeclock_events;
--
--   2. Remove version '009' tracking record:
--      DELETE FROM schema_migrations WHERE version = '009';
--
--   3. Only after data preservation is verified, drop tables manually:
--      DROP TABLE IF EXISTS public.staff_timeclock_events;
--      DROP TABLE IF EXISTS public.staff_timeclock;
--      DROP TABLE IF EXISTS public.sync_idempotency;
--      DROP TABLE IF EXISTS public.domain_rows;
--      DROP TABLE IF EXISTS public.domain_docs;
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 009 down script invoked. Automated destructive DROP TABLE is disabled to preserve operational application data.';
END $$;
