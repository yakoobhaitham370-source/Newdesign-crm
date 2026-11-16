-- ============================================================================
-- MASAR CARE — STAGE 2C.2C/2D PHASE 2: LEGACY `0004` RPC RETIREMENT MIGRATION
-- STATUS: DRAFT PROPOSAL ONLY — DO NOT EXECUTE AGAINST LIVE DATABASE
--
-- PREREQUISITES (ALL MUST PASS BEFORE RUNNING):
--   1. Apply `stage2c2c_migration_DRAFT.sql` (Phase 1 + Stage 2C.2D fixes) first.
--   2. Roll out Stage 2C.2D frontend bundle to 100% of active browser sessions
--      and verify compatibility with every active client/integration.
--   3. Confirm positive live `_v2` clinical writes AND zero legacy `0004` writes
--      across the full 7-day pre-cutover observation window, PLUS positive live
--      `_v2` dispensing parity telemetry where EVERY observed `_v2` dispensing
--      operation supplied `clientHashProvided = true` and `clientServerHashMatched = true`
--      with zero missing hashes and zero `clientPayloadHashMismatch = true` events.
--   4. Execute explicit operator cutover sign-off GUCs in the same session:
--        SET LOCAL masar.phase2_cutover_approved = 'true';
--        SET LOCAL masar.phase2_rollout_verified = 'true';
--        SET LOCAL masar.phase2_approver = '<operator_name_and_ticket>';
--
-- PURPOSE:
--   During Phase 1 rollout, legacy `0004` signatures remain available for
--   in-flight browser sessions. Once cutover gates pass, an attacker or stale
--   client could still invoke `0004` RPCs directly via PostgREST to bypass
--   Stage 2C.2D server allergy/uncertainty checks, optimistic locking (`40001`),
--   and canonical idempotency checks. Phase 2 revokes and drops the legacy
--   `0004` signatures so ONLY `_v2` clinical write RPCs remain callable.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Multi-gate pre-cutover readiness & fail-closed operator approval guard
-- ============================================================================
DO $$
DECLARE
  v_legacy_write_count_7d           integer;
  v_v2_write_count_7d               integer;
  v_v2_dispense_count_7d            integer;
  v_v2_dispense_missing_hash_7d     integer;
  v_v2_dispense_matched_hash_7d     integer;
  v_v2_dispense_unmatched_hash_7d   integer;
  v_cutover_approved                text := COALESCE(pg_catalog.current_setting('masar.phase2_cutover_approved', true), '');
  v_rollout_verified                text := COALESCE(pg_catalog.current_setting('masar.phase2_rollout_verified', true), '');
  v_approver                        text := pg_catalog.btrim(COALESCE(pg_catalog.current_setting('masar.phase2_approver', true), ''));
BEGIN
  -- Gate 1: Verify all Phase 1 / Stage 2C.2D schema, registries, & `_v2` RPCs are installed
  IF pg_catalog.to_regprocedure('public.get_clinical_safety_capabilities()') IS NULL
     OR pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.format_canonical_decimal4(numeric)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.text_array_has_non_blank_elements(text[])') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_inn_registry') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_drug_class_relationships') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_broad_class_labels') IS NULL
  THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 1]: Phase 1 / Stage 2C.2D _v2 RPCs or registries are not installed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.medication_catalog'::regclass
      AND conname = 'chk_medication_catalog_verified_provenance'
  ) THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 1]: Catalog provenance constraint chk_medication_catalog_verified_provenance is missing.';
  END IF;

  -- Gate 2: Require positive live `_v2` activity, zero legacy writes across a broader 7-day
  --         retention window, AND positive verification that EVERY observed `_v2` dispensing
  --         operation supplied a client hash (`clientHashProvided = true`) AND matched on server
  --         (`clientServerHashMatched = true`), with zero missing hashes and zero mismatches.
  SELECT
    pg_catalog.count(*) FILTER (WHERE COALESCE(al.metadata->>'rpcVersion', '') <> 'v2')::integer,
    pg_catalog.count(*) FILTER (WHERE al.metadata->>'rpcVersion' = 'v2')::integer,
    pg_catalog.count(*) FILTER (
      WHERE al.action = 'DISPENSE_RECORDED'
        AND al.metadata->>'rpcVersion' = 'v2'
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE al.action = 'DISPENSE_RECORDED'
        AND al.metadata->>'rpcVersion' = 'v2'
        AND COALESCE((al.metadata->>'clientHashProvided')::boolean, false) IS NOT TRUE
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE al.action = 'DISPENSE_RECORDED'
        AND al.metadata->>'rpcVersion' = 'v2'
        AND COALESCE((al.metadata->>'clientHashProvided')::boolean, false) IS TRUE
        AND COALESCE((al.metadata->>'clientServerHashMatched')::boolean, false) IS TRUE
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE al.action = 'DISPENSE_RECORDED'
        AND al.metadata->>'rpcVersion' = 'v2'
        AND (
          COALESCE((al.metadata->>'clientServerHashMatched')::boolean, false) IS NOT TRUE
          OR COALESCE((al.metadata->>'clientPayloadHashMismatch')::boolean, false) IS TRUE
        )
    )::integer
  INTO
    v_legacy_write_count_7d,
    v_v2_write_count_7d,
    v_v2_dispense_count_7d,
    v_v2_dispense_missing_hash_7d,
    v_v2_dispense_matched_hash_7d,
    v_v2_dispense_unmatched_hash_7d
  FROM public.audit_logs al
  WHERE al.action IN ('MEDICATION_PLAN_ADDED', 'REGIMEN_VERSION_CREATED', 'DISPENSE_RECORDED')
    AND al.timestamp >= (pg_catalog.now() - interval '7 days');

  IF v_legacy_write_count_7d > 0 THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 2]: Detected % legacy 0004 clinical write(s) in audit_logs within the last 7 days without rpcVersion=v2.',
      v_legacy_write_count_7d;
  END IF;

  IF v_v2_write_count_7d < 1 THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 2]: Zero verified rpcVersion=v2 clinical writes recorded in the last 7 days. Do NOT retire legacy 0004 RPCs solely on absence of traffic without positive live _v2 verification.';
  END IF;

  IF v_v2_dispense_count_7d < 1 THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 2]: Zero verified rpcVersion=v2 DISPENSE_RECORDED events recorded in the last 7 days. Positive live dispensing hash parity evidence is required before retiring legacy RPCs.';
  END IF;

  IF v_v2_dispense_missing_hash_7d > 0 THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 2]: Detected % v2 DISPENSE_RECORDED event(s) in the last 7 days without a client canonical hash (clientHashProvided <> true). Zero mismatches alone is insufficient when hashes are missing.',
      v_v2_dispense_missing_hash_7d;
  END IF;

  IF v_v2_dispense_unmatched_hash_7d > 0 OR v_v2_dispense_matched_hash_7d <> v_v2_dispense_count_7d THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 2]: Observed % unmatched/mismatched v2 dispensing hash event(s) (% matched of % total). Resolve 100%% hash parity before retiring legacy RPCs.',
      v_v2_dispense_unmatched_hash_7d, v_v2_dispense_matched_hash_7d, v_v2_dispense_count_7d;
  END IF;

  -- Gate 3: Fail-closed explicit operator cutover approval GUCs
  IF v_cutover_approved IS DISTINCT FROM 'true'
     OR v_rollout_verified IS DISTINCT FROM 'true'
     OR pg_catalog.char_length(v_approver) < 3
  THEN
    RAISE EXCEPTION 'PHASE 2 ABORTED [GATE 3]: Explicit operator cutover sign-off required. Set masar.phase2_cutover_approved=''true'', masar.phase2_rollout_verified=''true'', and masar.phase2_approver=''<name/ticket>'' inside the session before running Phase 2.';
  END IF;
END $$;

-- ============================================================================
-- 2. Update capability RPC so clients know legacy 0004 RPCs have been retired
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_clinical_safety_capabilities()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff record;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'stage', 'stage2c2c_v2',
    'supportsV2MedicationPlans', true,
    'supportsV2DispensingIdempotency', true,
    'enforcesServerCriticalAllergyOverride', true,
    'enforcesServerAllergyUncertainty', true,
    'legacy0004RpcsRetired', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_clinical_safety_capabilities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_clinical_safety_capabilities() TO authenticated;

-- ============================================================================
-- 3. Revoke EXECUTE explicitly and DROP exact legacy `0004` RPC signatures
-- ============================================================================
REVOKE ALL ON FUNCTION public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
);

DROP FUNCTION IF EXISTS public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
);

DROP FUNCTION IF EXISTS public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
);

-- ============================================================================
-- 4. Post-retirement assertions & negative proof (`42883`) that retired 0004
--    signatures are no longer callable while `_v2` RPCs remain intact
-- ============================================================================
DO $$
DECLARE
  v_sqlstate text;
  v_msg      text;
BEGIN
  IF pg_catalog.to_regprocedure('public.create_medication_plan_with_version(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.update_medication_plan_version(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.record_dispensing_with_refill(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb)') IS NOT NULL
  THEN
    RAISE EXCEPTION 'PHASE 2 FAILURE: One or more legacy 0004 RPC signatures still exist.';
  END IF;

  IF pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NULL
  THEN
    RAISE EXCEPTION 'PHASE 2 FAILURE: Required _v2 RPC signature missing after legacy drop.';
  END IF;

  -- Negative invocation proof: calling retired `0004` signature must raise SQLSTATE `42883`
  BEGIN
    EXECUTE 'SELECT public.record_dispensing_with_refill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)'
      USING NULL::uuid, NULL::uuid, 1::numeric, 'tablet'::text, NULL::integer, NULL::numeric,
            NULL::text, NULL::date, CURRENT_DATE, false, NULL::text,
            NULL::numeric, NULL::integer, NULL::date, NULL::text,
            NULL::numeric, NULL::numeric, NULL::integer, 'on_track'::text, NULL::date, NULL::text,
            'provisional_client_unverified'::text, 'masar_refill_v1'::text, '{}'::jsonb;
    RAISE EXCEPTION 'PHASE 2 FAILURE: Legacy 0004 dispensing RPC remained callable after DROP.';
  EXCEPTION WHEN SQLSTATE '42883' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    -- Expected undefined_function (`42883`)
    NULL;
  END;
END $$;

COMMIT;

-- ============================================================================
-- 5. DOCUMENTED ROLLBACK & EMERGENCY RECOVERY STRATEGY (DO NOT AUTO-RUN)
-- ============================================================================
-- If an emergency client regression requires temporarily restoring the 3 legacy
-- `0004` RPC signatures after Phase 2 cutover:
--   1. Open an explicit `BEGIN; ... COMMIT;` recovery transaction as DB owner.
--   2. Re-create the exact 3 function definitions from
--      `supabase/migrations/0004_stage2b_fix_arabic_encoding_and_unit_normalization.sql`:
--        * `public.create_medication_plan_with_version(18 args)`
--        * `public.update_medication_plan_version(19 args)`
--        * `public.record_dispensing_with_refill(24 args)`
--   3. Restore exact `0004` ACL grants:
--        REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;
--        GRANT EXECUTE ON FUNCTION ... TO authenticated;
--   4. Update `public.get_clinical_safety_capabilities()` so
--      `'legacy0004RpcsRetired'` returns `false` until the forward fix lands.
--   5. SECURITY NOTE: Emergency restoration re-exposes non-versioned `0004`
--      paths (`40001` & server allergy override bypass risk); treat any emergency
--      rollback as time-boxed and re-run Phase 2 after resolving client rollout.
-- ============================================================================

