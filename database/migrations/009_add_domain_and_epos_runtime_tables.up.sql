-- ============================================================================
-- CraveDash Canonical Migration: 009_add_domain_and_epos_runtime_tables.up.sql
-- CD-CON-058 Change B: Canonicalize Domain & EPOS Runtime Tables
-- ============================================================================
-- Tables Managed:
--   1. public.domain_docs
--   2. public.domain_rows
--   3. public.sync_idempotency
--   4. public.staff_timeclock
--   5. public.staff_timeclock_events
--
-- Safety Guarantees:
--   - Single-transaction atomic execution (managed by migrate.js runner)
--   - Exhaustive preflight schema drift assertions for pre-existing tables
--   - NULL-safe data integrity validation prior to constraint modification
--   - Target-scoped, conservative CHECK constraint reconciliation (zero regex)
--   - Unrelated and composite constraints preserved untouched
--   - Schema-wide index collision detection across all relation kinds in pg_class
--   - Rigorous 10-property catalog index equivalence verification
--   - Strictly idempotent: second run produces zero DDL modifications
-- ============================================================================

DO $$
DECLARE
  v_table text;
  v_tbl_oid oid;
  v_rec record;
  v_col record;
  v_bad_rows bigint;
  v_pk_cols text[];
  v_attnum_target int2;
  v_has_canonical boolean;
  v_expected_cols text[];
BEGIN
  -- ==========================================================================
  -- PHASE 1: PREFLIGHT SCHEMA VALIDATION FOR PRE-EXISTING TABLES
  -- ==========================================================================

  -- 1.1 domain_docs preflight
  IF to_regclass('public.domain_docs') IS NOT NULL THEN
    v_tbl_oid := 'public.domain_docs'::regclass::oid;

    -- Assert ordinary table (relkind = 'r')
    IF (SELECT relkind FROM pg_class WHERE oid = v_tbl_oid) != 'r' THEN
      RAISE EXCEPTION 'Preflight failed: public.domain_docs exists but is not an ordinary table (relkind != r).';
    END IF;

    -- Assert composite primary key: (restaurant_id, domain, collection)
    SELECT array_agg(a.attname ORDER BY u.ord) INTO v_pk_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = v_tbl_oid AND c.contype = 'p';

    IF v_pk_cols IS NULL OR v_pk_cols != ARRAY['restaurant_id', 'domain', 'collection'] THEN
      RAISE EXCEPTION 'Preflight failed: public.domain_docs primary key is %, expected (restaurant_id, domain, collection).', v_pk_cols;
    END IF;

    -- Assert required column types, nullability, and unexpected columns
    v_expected_cols := ARRAY['restaurant_id', 'domain', 'collection', 'data', 'updated_at'];
    FOR v_col IN (
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'domain_docs'
    ) LOOP
      IF NOT (v_col.column_name = ANY(v_expected_cols)) THEN
        RAISE EXCEPTION 'Preflight failed: public.domain_docs contains unexpected column "%" (type: %).', v_col.column_name, v_col.udt_name;
      END IF;

      IF v_col.column_name = 'restaurant_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_docs.restaurant_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'domain' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_docs.domain must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'collection' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_docs.collection must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'data' AND (v_col.udt_name != 'jsonb' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_docs.data must be JSONB NOT NULL.';
      ELSIF v_col.column_name = 'updated_at' AND v_col.udt_name != 'timestamptz' THEN
        RAISE EXCEPTION 'Preflight failed: domain_docs.updated_at must be TIMESTAMPTZ.';
      END IF;
    END LOOP;
  END IF;

  -- 1.2 domain_rows preflight
  IF to_regclass('public.domain_rows') IS NOT NULL THEN
    v_tbl_oid := 'public.domain_rows'::regclass::oid;

    IF (SELECT relkind FROM pg_class WHERE oid = v_tbl_oid) != 'r' THEN
      RAISE EXCEPTION 'Preflight failed: public.domain_rows exists but is not an ordinary table (relkind != r).';
    END IF;

    -- Assert composite primary key: (restaurant_id, domain, collection, id)
    SELECT array_agg(a.attname ORDER BY u.ord) INTO v_pk_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = v_tbl_oid AND c.contype = 'p';

    IF v_pk_cols IS NULL OR v_pk_cols != ARRAY['restaurant_id', 'domain', 'collection', 'id'] THEN
      RAISE EXCEPTION 'Preflight failed: public.domain_rows primary key is %, expected (restaurant_id, domain, collection, id).', v_pk_cols;
    END IF;

    v_expected_cols := ARRAY['restaurant_id', 'domain', 'collection', 'id', 'data', 'updated_at'];
    FOR v_col IN (
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'domain_rows'
    ) LOOP
      IF NOT (v_col.column_name = ANY(v_expected_cols)) THEN
        RAISE EXCEPTION 'Preflight failed: public.domain_rows contains unexpected column "%" (type: %).', v_col.column_name, v_col.udt_name;
      END IF;

      IF v_col.column_name = 'restaurant_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.restaurant_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'domain' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.domain must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'collection' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.collection must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'data' AND (v_col.udt_name != 'jsonb' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.data must be JSONB NOT NULL.';
      ELSIF v_col.column_name = 'updated_at' AND v_col.udt_name != 'timestamptz' THEN
        RAISE EXCEPTION 'Preflight failed: domain_rows.updated_at must be TIMESTAMPTZ.';
      END IF;
    END LOOP;
  END IF;

  -- 1.3 sync_idempotency preflight
  IF to_regclass('public.sync_idempotency') IS NOT NULL THEN
    v_tbl_oid := 'public.sync_idempotency'::regclass::oid;

    IF (SELECT relkind FROM pg_class WHERE oid = v_tbl_oid) != 'r' THEN
      RAISE EXCEPTION 'Preflight failed: public.sync_idempotency exists but is not an ordinary table (relkind != r).';
    END IF;

    -- Assert composite primary key: (restaurant_id, idempotency_key)
    SELECT array_agg(a.attname ORDER BY u.ord) INTO v_pk_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = v_tbl_oid AND c.contype = 'p';

    IF v_pk_cols IS NULL OR v_pk_cols != ARRAY['restaurant_id', 'idempotency_key'] THEN
      RAISE EXCEPTION 'Preflight failed: public.sync_idempotency primary key is %, expected (restaurant_id, idempotency_key).', v_pk_cols;
    END IF;

    -- Permitted optional columns: entity, op, server_id, client_id
    v_expected_cols := ARRAY['restaurant_id', 'idempotency_key', 'entity', 'op', 'server_id', 'client_id', 'result', 'created_at'];
    FOR v_col IN (
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sync_idempotency'
    ) LOOP
      IF NOT (v_col.column_name = ANY(v_expected_cols)) THEN
        RAISE EXCEPTION 'Preflight failed: public.sync_idempotency contains unexpected column "%" (type: %).', v_col.column_name, v_col.udt_name;
      END IF;

      IF v_col.column_name = 'restaurant_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: sync_idempotency.restaurant_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'idempotency_key' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: sync_idempotency.idempotency_key must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'result' AND (v_col.udt_name != 'jsonb' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: sync_idempotency.result must be JSONB NOT NULL.';
      ELSIF v_col.column_name = 'created_at' AND (v_col.udt_name != 'timestamptz' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: sync_idempotency.created_at must be TIMESTAMPTZ NOT NULL.';
      END IF;
    END LOOP;
  END IF;

  -- 1.4 staff_timeclock preflight
  IF to_regclass('public.staff_timeclock') IS NOT NULL THEN
    v_tbl_oid := 'public.staff_timeclock'::regclass::oid;

    IF (SELECT relkind FROM pg_class WHERE oid = v_tbl_oid) != 'r' THEN
      RAISE EXCEPTION 'Preflight failed: public.staff_timeclock exists but is not an ordinary table (relkind != r).';
    END IF;

    -- Assert composite primary key: (restaurant_id, staff_id)
    SELECT array_agg(a.attname ORDER BY u.ord) INTO v_pk_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = v_tbl_oid AND c.contype = 'p';

    IF v_pk_cols IS NULL OR v_pk_cols != ARRAY['restaurant_id', 'staff_id'] THEN
      RAISE EXCEPTION 'Preflight failed: public.staff_timeclock primary key is %, expected (restaurant_id, staff_id).', v_pk_cols;
    END IF;

    -- Permitted optional columns: since, break_since, branch_id, data
    v_expected_cols := ARRAY['restaurant_id', 'staff_id', 'status', 'since', 'break_since', 'branch_id', 'data', 'updated_at'];
    FOR v_col IN (
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_timeclock'
    ) LOOP
      IF NOT (v_col.column_name = ANY(v_expected_cols)) THEN
        RAISE EXCEPTION 'Preflight failed: public.staff_timeclock contains unexpected column "%" (type: %).', v_col.column_name, v_col.udt_name;
      END IF;

      IF v_col.column_name = 'restaurant_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock.restaurant_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'staff_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock.staff_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'status' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock.status must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'updated_at' AND v_col.udt_name != 'timestamptz' THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock.updated_at must be TIMESTAMPTZ.';
      END IF;
    END LOOP;
  END IF;

  -- 1.5 staff_timeclock_events preflight
  IF to_regclass('public.staff_timeclock_events') IS NOT NULL THEN
    v_tbl_oid := 'public.staff_timeclock_events'::regclass::oid;

    IF (SELECT relkind FROM pg_class WHERE oid = v_tbl_oid) != 'r' THEN
      RAISE EXCEPTION 'Preflight failed: public.staff_timeclock_events exists but is not an ordinary table (relkind != r).';
    END IF;

    SELECT array_agg(a.attname ORDER BY u.ord) INTO v_pk_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = v_tbl_oid AND c.contype = 'p';

    IF v_pk_cols IS NULL OR v_pk_cols != ARRAY['id'] THEN
      RAISE EXCEPTION 'Preflight failed: public.staff_timeclock_events primary key is %, expected (id).', v_pk_cols;
    END IF;

    -- Permitted optional columns: branch_id, data
    v_expected_cols := ARRAY['id', 'restaurant_id', 'staff_id', 'event', 'at', 'branch_id', 'data'];
    FOR v_col IN (
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_timeclock_events'
    ) LOOP
      IF NOT (v_col.column_name = ANY(v_expected_cols)) THEN
        RAISE EXCEPTION 'Preflight failed: public.staff_timeclock_events contains unexpected column "%" (type: %).', v_col.column_name, v_col.udt_name;
      END IF;

      IF v_col.column_name = 'id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock_events.id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'restaurant_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock_events.restaurant_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'staff_id' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock_events.staff_id must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'event' AND (v_col.udt_name != 'text' OR v_col.is_nullable != 'NO') THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock_events.event must be TEXT NOT NULL.';
      ELSIF v_col.column_name = 'at' AND v_col.udt_name != 'timestamptz' THEN
        RAISE EXCEPTION 'Preflight failed: staff_timeclock_events.at must be TIMESTAMPTZ.';
      END IF;
    END LOOP;
  END IF;

  -- ==========================================================================
  -- PHASE 2: NULL-SAFE DATA INTEGRITY ASSERTIONS (BEFORE CONSTRAINT MUTATION)
  -- ==========================================================================
  IF to_regclass('public.domain_docs') IS NOT NULL THEN
    SELECT count(*) INTO v_bad_rows FROM public.domain_docs
    WHERE domain IS NULL OR domain NOT IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce');
    IF v_bad_rows > 0 THEN
      RAISE EXCEPTION 'Preflight data check failed: public.domain_docs has % row(s) with invalid or NULL domain.', v_bad_rows;
    END IF;
  END IF;

  IF to_regclass('public.domain_rows') IS NOT NULL THEN
    SELECT count(*) INTO v_bad_rows FROM public.domain_rows
    WHERE domain IS NULL OR domain NOT IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce');
    IF v_bad_rows > 0 THEN
      RAISE EXCEPTION 'Preflight data check failed: public.domain_rows has % row(s) with invalid or NULL domain.', v_bad_rows;
    END IF;
  END IF;

  IF to_regclass('public.staff_timeclock') IS NOT NULL THEN
    SELECT count(*) INTO v_bad_rows FROM public.staff_timeclock
    WHERE status IS NULL OR status NOT IN ('in', 'out', 'break');
    IF v_bad_rows > 0 THEN
      RAISE EXCEPTION 'Preflight data check failed: public.staff_timeclock has % row(s) with invalid or NULL status.', v_bad_rows;
    END IF;
  END IF;

  -- ==========================================================================
  -- PHASE 3: CONSERVATIVE CHECK CONSTRAINT RECONCILIATION (ZERO REGEX)
  -- ==========================================================================

  -- 3.1 Reconcile domain_docs CHECK constraint on domain
  IF to_regclass('public.domain_docs') IS NOT NULL THEN
    v_tbl_oid := 'public.domain_docs'::regclass::oid;
    SELECT attnum INTO v_attnum_target FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'domain';
    v_has_canonical := false;

    FOR v_rec IN (
      SELECT conname, convalidated, conkey, pg_get_constraintdef(oid, true) AS condef
      FROM pg_constraint
      WHERE conrelid = v_tbl_oid AND contype = 'c'
    ) LOOP
      -- Only process constraints targeting solely the domain column
      IF v_rec.conkey = ARRAY[v_attnum_target] THEN
        IF NOT v_rec.convalidated THEN
          RAISE EXCEPTION 'Migration 009 aborted: domain_docs has unvalidated constraint "%". Manual review required.', v_rec.conname;
        END IF;

        -- Test definition against known canonical and legacy sets
        IF v_rec.condef LIKE '%inventory%' AND v_rec.condef LIKE '%payroll%' AND v_rec.condef LIKE '%accounting%'
           AND v_rec.condef LIKE '%ops%' AND v_rec.condef LIKE '%commerce%' AND v_rec.condef NOT LIKE '%NOT%' THEN
          -- Already canonical 5-domain constraint -> take zero action (idempotent no-op)
          v_has_canonical := true;
        ELSIF v_rec.condef LIKE '%inventory%' AND v_rec.condef LIKE '%payroll%' AND v_rec.condef LIKE '%accounting%'
           AND v_rec.condef NOT LIKE '%ops%' AND v_rec.condef NOT LIKE '%commerce%' AND v_rec.condef NOT LIKE '%NOT%' THEN
          -- Known legacy 3-domain constraint -> drop safely
          EXECUTE format('ALTER TABLE public.domain_docs DROP CONSTRAINT %I', v_rec.conname);
        ELSE
          RAISE EXCEPTION 'Migration 009 aborted: unrecognized CHECK constraint "%" (def: %) on domain_docs.domain. Manual review required.', v_rec.conname, v_rec.condef;
        END IF;
      END IF;
      -- Unrelated check constraints and composite constraints are preserved untouched
    END LOOP;

    IF NOT v_has_canonical THEN
      ALTER TABLE public.domain_docs ADD CONSTRAINT domain_docs_domain_check
        CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce'));
    END IF;
  END IF;

  -- 3.2 Reconcile domain_rows CHECK constraint on domain
  IF to_regclass('public.domain_rows') IS NOT NULL THEN
    v_tbl_oid := 'public.domain_rows'::regclass::oid;
    SELECT attnum INTO v_attnum_target FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'domain';
    v_has_canonical := false;

    FOR v_rec IN (
      SELECT conname, convalidated, conkey, pg_get_constraintdef(oid, true) AS condef
      FROM pg_constraint
      WHERE conrelid = v_tbl_oid AND contype = 'c'
    ) LOOP
      IF v_rec.conkey = ARRAY[v_attnum_target] THEN
        IF NOT v_rec.convalidated THEN
          RAISE EXCEPTION 'Migration 009 aborted: domain_rows has unvalidated constraint "%". Manual review required.', v_rec.conname;
        END IF;

        IF v_rec.condef LIKE '%inventory%' AND v_rec.condef LIKE '%payroll%' AND v_rec.condef LIKE '%accounting%'
           AND v_rec.condef LIKE '%ops%' AND v_rec.condef LIKE '%commerce%' AND v_rec.condef NOT LIKE '%NOT%' THEN
          v_has_canonical := true;
        ELSIF v_rec.condef LIKE '%inventory%' AND v_rec.condef LIKE '%payroll%' AND v_rec.condef LIKE '%accounting%'
           AND v_rec.condef NOT LIKE '%ops%' AND v_rec.condef NOT LIKE '%commerce%' AND v_rec.condef NOT LIKE '%NOT%' THEN
          EXECUTE format('ALTER TABLE public.domain_rows DROP CONSTRAINT %I', v_rec.conname);
        ELSE
          RAISE EXCEPTION 'Migration 009 aborted: unrecognized CHECK constraint "%" (def: %) on domain_rows.domain. Manual review required.', v_rec.conname, v_rec.condef;
        END IF;
      END IF;
    END LOOP;

    IF NOT v_has_canonical THEN
      ALTER TABLE public.domain_rows ADD CONSTRAINT domain_rows_domain_check
        CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce'));
    END IF;
  END IF;

  -- 3.3 Reconcile staff_timeclock CHECK constraint on status
  IF to_regclass('public.staff_timeclock') IS NOT NULL THEN
    v_tbl_oid := 'public.staff_timeclock'::regclass::oid;
    SELECT attnum INTO v_attnum_target FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'status';
    v_has_canonical := false;

    FOR v_rec IN (
      SELECT conname, convalidated, conkey, pg_get_constraintdef(oid, true) AS condef
      FROM pg_constraint
      WHERE conrelid = v_tbl_oid AND contype = 'c'
    ) LOOP
      IF v_rec.conkey = ARRAY[v_attnum_target] THEN
        IF NOT v_rec.convalidated THEN
          RAISE EXCEPTION 'Migration 009 aborted: staff_timeclock has unvalidated constraint "%". Manual review required.', v_rec.conname;
        END IF;

        IF v_rec.condef LIKE '%in%' AND v_rec.condef LIKE '%out%' AND v_rec.condef LIKE '%break%' AND v_rec.condef NOT LIKE '%NOT%' THEN
          v_has_canonical := true;
        ELSE
          RAISE EXCEPTION 'Migration 009 aborted: unrecognized CHECK constraint "%" (def: %) on staff_timeclock.status. Manual review required.', v_rec.conname, v_rec.condef;
        END IF;
      END IF;
    END LOOP;

    IF NOT v_has_canonical THEN
      ALTER TABLE public.staff_timeclock ADD CONSTRAINT staff_timeclock_status_check
        CHECK (status IN ('in', 'out', 'break'));
    END IF;
  END IF;
END $$;

-- ============================================================================
-- PHASE 4: TABLE PROVISIONING (EXACT AUDITED RUNTIME DEFINITIONS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.domain_docs (
  restaurant_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce')),
  collection TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, domain, collection)
);

CREATE TABLE IF NOT EXISTS public.domain_rows (
  restaurant_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('inventory', 'payroll', 'accounting', 'ops', 'commerce')),
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, domain, collection, id)
);

CREATE TABLE IF NOT EXISTS public.sync_idempotency (
  restaurant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity TEXT,
  op TEXT,
  server_id TEXT,
  client_id TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.staff_timeclock (
  restaurant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('in', 'out', 'break')),
  since TIMESTAMPTZ,
  break_since TIMESTAMPTZ,
  branch_id TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, staff_id)
);

CREATE TABLE IF NOT EXISTS public.staff_timeclock_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  event TEXT NOT NULL,
  at TIMESTAMPTZ DEFAULT NOW(),
  branch_id TEXT,
  data JSONB DEFAULT '{}'::jsonb
);

-- ============================================================================
-- PHASE 5: INDEX PROVISIONING WITH CATALOG EQUIVALENCE & COLLISION CHECKS
-- ============================================================================

DO $$
DECLARE
  v_tbl_oid oid;
  v_idx_oid oid;
  v_collision_rec record;
  v_att1 int2;
  v_att2 int2;
  v_att3 int2;
  v_equiv_found boolean;
BEGIN
  -- --------------------------------------------------------------------------
  -- 5.1 Index on domain_docs (restaurant_id)
  -- --------------------------------------------------------------------------
  v_tbl_oid := 'public.domain_docs'::regclass::oid;
  SELECT attnum INTO v_att1 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'restaurant_id';

  -- Check schema-wide name collision in pg_class
  SELECT c.relname, c.relkind, t.relname AS table_name, i.indisvalid, i.indisready
  INTO v_collision_rec
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_class t ON t.oid = i.indrelid
  WHERE n.nspname = 'public' AND c.relname = 'domain_docs_restaurant_idx';

  IF v_collision_rec.relname IS NOT NULL THEN
    IF v_collision_rec.relkind != 'i' THEN
      RAISE EXCEPTION 'Migration 009 aborted: relation "domain_docs_restaurant_idx" already exists as non-index object (relkind: %).', v_collision_rec.relkind;
    ELSIF v_collision_rec.table_name != 'domain_docs' THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "domain_docs_restaurant_idx" already exists on unrelated table "%".', v_collision_rec.table_name;
    ELSIF NOT (v_collision_rec.indisvalid AND v_collision_rec.indisready) THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "domain_docs_restaurant_idx" exists on domain_docs but is invalid or not ready.';
    END IF;
  END IF;

  -- Search for existing 100% equivalent index
  v_equiv_found := false;
  FOR v_idx_oid IN (
    SELECT i.indexrelid
    FROM pg_index i
    JOIN pg_am am ON am.oid = (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
    WHERE i.indrelid = v_tbl_oid
      AND am.amname = 'btree'
      AND i.indisvalid = true
      AND i.indisready = true
      AND i.indisunique = false
      AND i.indexprs IS NULL
      AND i.indpred IS NULL
      AND i.indnatts = 1
      AND i.indnkeyatts = 1
      AND i.indkey[0] = v_att1
      AND (i.indoption[0] & 1) = 0   -- ASC NULLS LAST
  ) LOOP
    v_equiv_found := true;
    EXIT;
  END LOOP;

  IF NOT v_equiv_found THEN
    CREATE INDEX domain_docs_restaurant_idx ON public.domain_docs (restaurant_id);
  END IF;

  -- --------------------------------------------------------------------------
  -- 5.2 Index on domain_rows (restaurant_id, domain, collection)
  -- --------------------------------------------------------------------------
  v_tbl_oid := 'public.domain_rows'::regclass::oid;
  SELECT attnum INTO v_att1 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'restaurant_id';
  SELECT attnum INTO v_att2 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'domain';
  SELECT attnum INTO v_att3 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'collection';

  SELECT c.relname, c.relkind, t.relname AS table_name, i.indisvalid, i.indisready
  INTO v_collision_rec
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_class t ON t.oid = i.indrelid
  WHERE n.nspname = 'public' AND c.relname = 'domain_rows_lookup_idx';

  IF v_collision_rec.relname IS NOT NULL THEN
    IF v_collision_rec.relkind != 'i' THEN
      RAISE EXCEPTION 'Migration 009 aborted: relation "domain_rows_lookup_idx" already exists as non-index object (relkind: %).', v_collision_rec.relkind;
    ELSIF v_collision_rec.table_name != 'domain_rows' THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "domain_rows_lookup_idx" already exists on unrelated table "%".', v_collision_rec.table_name;
    ELSIF NOT (v_collision_rec.indisvalid AND v_collision_rec.indisready) THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "domain_rows_lookup_idx" exists on domain_rows but is invalid or not ready.';
    END IF;
  END IF;

  v_equiv_found := false;
  FOR v_idx_oid IN (
    SELECT i.indexrelid
    FROM pg_index i
    JOIN pg_am am ON am.oid = (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
    WHERE i.indrelid = v_tbl_oid
      AND am.amname = 'btree'
      AND i.indisvalid = true
      AND i.indisready = true
      AND i.indisunique = false
      AND i.indexprs IS NULL
      AND i.indpred IS NULL
      AND i.indnatts = 3
      AND i.indnkeyatts = 3
      AND i.indkey[0] = v_att1
      AND i.indkey[1] = v_att2
      AND i.indkey[2] = v_att3
      AND (i.indoption[0] & 1) = 0
      AND (i.indoption[1] & 1) = 0
      AND (i.indoption[2] & 1) = 0
  ) LOOP
    v_equiv_found := true;
    EXIT;
  END LOOP;

  IF NOT v_equiv_found THEN
    CREATE INDEX domain_rows_lookup_idx ON public.domain_rows (restaurant_id, domain, collection);
  END IF;

  -- --------------------------------------------------------------------------
  -- 5.3 Index on staff_timeclock_events (restaurant_id ASC, at DESC)
  -- --------------------------------------------------------------------------
  v_tbl_oid := 'public.staff_timeclock_events'::regclass::oid;
  SELECT attnum INTO v_att1 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'restaurant_id';
  SELECT attnum INTO v_att2 FROM pg_attribute WHERE attrelid = v_tbl_oid AND attname = 'at';

  SELECT c.relname, c.relkind, t.relname AS table_name, i.indisvalid, i.indisready
  INTO v_collision_rec
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_class t ON t.oid = i.indrelid
  WHERE n.nspname = 'public' AND c.relname = 'idx_staff_timeclock_events_lookup';

  IF v_collision_rec.relname IS NOT NULL THEN
    IF v_collision_rec.relkind != 'i' THEN
      RAISE EXCEPTION 'Migration 009 aborted: relation "idx_staff_timeclock_events_lookup" already exists as non-index object (relkind: %).', v_collision_rec.relkind;
    ELSIF v_collision_rec.table_name != 'staff_timeclock_events' THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "idx_staff_timeclock_events_lookup" already exists on unrelated table "%".', v_collision_rec.table_name;
    ELSIF NOT (v_collision_rec.indisvalid AND v_collision_rec.indisready) THEN
      RAISE EXCEPTION 'Migration 009 aborted: index "idx_staff_timeclock_events_lookup" exists on staff_timeclock_events but is invalid or not ready.';
    END IF;
  END IF;

  v_equiv_found := false;
  FOR v_idx_oid IN (
    SELECT i.indexrelid
    FROM pg_index i
    JOIN pg_am am ON am.oid = (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
    WHERE i.indrelid = v_tbl_oid
      AND am.amname = 'btree'
      AND i.indisvalid = true
      AND i.indisready = true
      AND i.indisunique = false
      AND i.indexprs IS NULL
      AND i.indpred IS NULL
      AND i.indnatts = 2
      AND i.indnkeyatts = 2
      AND i.indkey[0] = v_att1
      AND i.indkey[1] = v_att2
      AND (i.indoption[0] & 1) = 0   -- ASC NULLS LAST
      AND (i.indoption[1] & 1) = 1   -- DESC
      AND (i.indoption[1] & 2) = 2   -- NULLS FIRST (standard PostgreSQL DESC default)
  ) LOOP
    v_equiv_found := true;
    EXIT;
  END LOOP;

  IF NOT v_equiv_found THEN
    CREATE INDEX idx_staff_timeclock_events_lookup ON public.staff_timeclock_events (restaurant_id ASC, at DESC);
  END IF;
END $$;
