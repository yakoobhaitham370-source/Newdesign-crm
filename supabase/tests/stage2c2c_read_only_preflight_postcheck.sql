-- =============================================================================
-- MASAR CARE — STAGE 2C.2C READ-ONLY PREFLIGHT & POST-TEST CHECKLIST
-- Target Database: PostgreSQL 17+ (Supabase Development Project bkidngfzsubmyunacnju)
--
-- STATUS: STRICTLY READ-ONLY SELECT CHECKLIST — DO NOT MODIFY DATABASE STATE
-- Run BEFORE and AFTER executing `stage2c2c_rollback_verification_DRAFT.sql`
-- to confirm zero persistent changes, intact `DEV-TEST-001` baseline, and
-- zero leftover Stage 2C.2C (`2c2c%` / `TST-2C2C-%` / `TEST-2C2C-%` / `stage2c2c%`) fixtures.
-- =============================================================================

-- 1. Comparable baseline row counts across auth.users + all 24 MASAR public tables
SELECT
  (SELECT count(*) FROM auth.users) AS auth_users_count,
  (SELECT count(*) FROM public.pharmacies) AS pharmacies_count,
  (SELECT count(*) FROM public.pharmacy_staff) AS pharmacy_staff_count,
  (SELECT count(*) FROM public.patients) AS patients_count,
  (SELECT count(*) FROM public.patient_conditions) AS patient_conditions_count,
  (SELECT count(*) FROM public.patient_allergies) AS patient_allergies_count,
  (SELECT count(*) FROM public.medication_catalog) AS medication_catalog_count,
  (SELECT count(*) FROM public.patient_medication_plans) AS medication_plans_count,
  (SELECT count(*) FROM public.regimen_versions) AS regimen_versions_count,
  (SELECT count(*) FROM public.medication_pause_periods) AS medication_pause_periods_count,
  (SELECT count(*) FROM public.scheduled_doses) AS scheduled_doses_count,
  (SELECT count(*) FROM public.dose_events) AS dose_events_count,
  (SELECT count(*) FROM public.unscheduled_dose_reports) AS unscheduled_dose_reports_count,
  (SELECT count(*) FROM public.dispensing_events) AS dispensing_events_count,
  (SELECT count(*) FROM public.refill_assessments) AS refill_assessments_count,
  (SELECT count(*) FROM public.lab_results) AS lab_results_count,
  (SELECT count(*) FROM public.follow_up_tasks) AS follow_up_tasks_count,
  (SELECT count(*) FROM public.follow_up_contact_logs) AS follow_up_contact_logs_count,
  (SELECT count(*) FROM public.consultation_threads) AS consultation_threads_count,
  (SELECT count(*) FROM public.consultation_messages) AS consultation_messages_count,
  (SELECT count(*) FROM public.patient_apk_invitations) AS patient_apk_invitations_count,
  (SELECT count(*) FROM public.invitation_redemption_attempts) AS invitation_redemption_attempts_count,
  (SELECT count(*) FROM public.audit_logs) AS audit_logs_count,
  (SELECT count(*) FROM public.bootstrap_state) AS bootstrap_state_count,
  (SELECT status FROM public.bootstrap_state WHERE singleton_key = true) AS bootstrap_status,
  (SELECT updated_at FROM public.bootstrap_state WHERE singleton_key = true) AS bootstrap_updated_at,
  (SELECT count(*) FROM public.staff_provisioning_requests) AS staff_provisioning_requests_count;

-- 2. Inspect Stage 2C.2C/2D idempotency schema, catalog provenance columns,
--    server registries, RPC signatures, and Phase 1 / Phase 2 status
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispensing_events' AND column_name = 'client_event_uuid'
  ) AS has_client_event_uuid_col,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispensing_events' AND column_name = 'client_payload_hash'
  ) AS has_client_payload_hash_col,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dispensing_events'
      AND indexname = 'ux_dispensing_events_pharmacy_client_uuid'
  ) AS has_client_uuid_unique_index,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_catalog' AND column_name = 'active_ingredients'
  ) AS has_catalog_active_ingredients_col,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_catalog' AND column_name = 'ingredient_verification_status'
  ) AS has_catalog_verification_status_col,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_catalog' AND column_name = 'ingredient_source'
  ) AS has_catalog_ingredient_source_col,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_catalog' AND column_name = 'ingredient_reviewed_at'
  ) AS has_catalog_ingredient_reviewed_at_col,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.medication_catalog'::regclass
      AND conname = 'chk_medication_catalog_verified_provenance'
  ) AS has_catalog_provenance_check,
  to_regclass('app_security.verified_inn_registry') IS NOT NULL AS has_verified_inn_registry,
  to_regclass('app_security.verified_combination_registry') IS NOT NULL AS has_verified_combination_registry,
  to_regclass('app_security.verified_broad_class_labels') IS NOT NULL AS has_verified_broad_class_labels,
  to_regclass('app_security.verified_drug_class_relationships') IS NOT NULL AS has_verified_drug_class_relationships,
  pg_catalog.to_regprocedure('app_security.format_canonical_decimal4(numeric)') IS NOT NULL AS has_format_canonical_decimal4,
  pg_catalog.to_regprocedure('public.get_clinical_safety_capabilities()') IS NOT NULL AS has_capability_rpc,
  pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NOT NULL AS has_create_plan_v2,
  pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NOT NULL AS has_update_plan_v2,
  pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NOT NULL AS has_record_dispense_v2,
  pg_catalog.to_regprocedure('public.create_medication_plan_with_version(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb)') IS NOT NULL AS has_legacy_0004_create_plan,
  pg_catalog.to_regprocedure('public.update_medication_plan_version(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date)') IS NOT NULL AS has_legacy_0004_update_plan,
  pg_catalog.to_regprocedure('public.record_dispensing_with_refill(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb)') IS NOT NULL AS has_legacy_0004_dispense;

-- 3. Detailed privilege inspection for public clinical safety RPCs & strict 24 forced-RLS count
SELECT
  p.oid::regprocedure::text AS signature,
  p.prosecdef AS is_security_definer,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_clinical_safety_capabilities',
    'create_medication_plan_with_version',
    'create_medication_plan_with_version_v2',
    'update_medication_plan_version',
    'update_medication_plan_version_v2',
    'change_medication_plan_status',
    'record_dispensing_with_refill',
    'record_dispensing_with_refill_v2'
  )
ORDER BY p.proname, signature;

SELECT
  count(*) FILTER (WHERE relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE) AS forced_rls_table_count,
  count(*) AS total_public_tables_in_schema
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p');

-- 4. Inspect Stage 2C.2C/2D cutover readiness & shadow canonical hash parity telemetry (7-day window)
SELECT
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '24 hours')
      AND COALESCE(metadata->>'rpcVersion', '') <> 'v2'
  ) AS recent_legacy_0004_writes_24h,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND COALESCE(metadata->>'rpcVersion', '') <> 'v2'
  ) AS legacy_0004_writes_7d,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND metadata->>'rpcVersion' = 'v2'
  ) AS verified_v2_writes_7d,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND action = 'DISPENSE_RECORDED'
      AND metadata->>'rpcVersion' = 'v2'
  ) AS v2_dispense_total_7d,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND action = 'DISPENSE_RECORDED'
      AND metadata->>'rpcVersion' = 'v2'
      AND COALESCE((metadata->>'clientHashProvided')::boolean, false) IS NOT TRUE
  ) AS v2_dispense_missing_hash_7d,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND action = 'DISPENSE_RECORDED'
      AND metadata->>'rpcVersion' = 'v2'
      AND COALESCE((metadata->>'clientHashProvided')::boolean, false) IS TRUE
      AND COALESCE((metadata->>'clientServerHashMatched')::boolean, false) IS TRUE
  ) AS v2_dispense_hash_matched_7d,
  pg_catalog.count(*) FILTER (
    WHERE timestamp >= (pg_catalog.now() - interval '7 days')
      AND action = 'DISPENSE_RECORDED'
      AND metadata->>'rpcVersion' = 'v2'
      AND (
        COALESCE((metadata->>'clientServerHashMatched')::boolean, false) IS NOT TRUE
        OR COALESCE((metadata->>'clientPayloadHashMismatch')::boolean, false) IS TRUE
      )
  ) AS v2_dispense_hash_mismatched_7d,
  (
    pg_catalog.count(*) FILTER (
      WHERE timestamp >= (pg_catalog.now() - interval '7 days')
        AND action = 'DISPENSE_RECORDED'
        AND metadata->>'rpcVersion' = 'v2'
    ) >= 1
    AND pg_catalog.count(*) FILTER (
      WHERE timestamp >= (pg_catalog.now() - interval '7 days')
        AND action = 'DISPENSE_RECORDED'
        AND metadata->>'rpcVersion' = 'v2'
        AND (
          COALESCE((metadata->>'clientHashProvided')::boolean, false) IS NOT TRUE
          OR COALESCE((metadata->>'clientServerHashMatched')::boolean, false) IS NOT TRUE
          OR COALESCE((metadata->>'clientPayloadHashMismatch')::boolean, false) IS TRUE
        )
    ) = 0
  ) AS phase2_hash_readiness_ok
FROM public.audit_logs
WHERE action IN ('MEDICATION_PLAN_ADDED', 'REGIMEN_VERSION_CREATED', 'DISPENSE_RECORDED')
  AND timestamp >= (pg_catalog.now() - interval '7 days');

-- 4B. Inspect medication_catalog verification & provenance completeness
SELECT
  ingredient_verification_status,
  pg_catalog.count(*) AS catalog_rows,
  pg_catalog.count(*) FILTER (
    WHERE pg_catalog.btrim(COALESCE(ingredient_source, '')) <> ''
      AND ingredient_reviewed_at IS NOT NULL
      AND pg_catalog.btrim(COALESCE(ingredient_reviewed_by, '')) <> ''
  ) AS rows_with_complete_provenance
FROM public.medication_catalog
GROUP BY ingredient_verification_status
ORDER BY ingredient_verification_status;

-- 5. Confirm ZERO leftover Stage 2C.2C (`2c2c%` / `TST-2C2C-%` / `TEST-2C2C-%` / `stage2c2c%`) fixtures
SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE 'stage2c2c%' OR id::text LIKE '2c2c%') AS leftover_auth_users,
  (SELECT count(*) FROM public.pharmacies WHERE id::text LIKE '2c2c%' OR license_number LIKE 'TEST-2C2C-%') AS leftover_pharmacies,
  (SELECT count(*) FROM public.pharmacy_staff WHERE id::text LIKE '2c2c%' OR pharmacy_id::text LIKE '2c2c%' OR syndicate_license LIKE 'SYN-2C2C%') AS leftover_staff,
  (SELECT count(*) FROM public.patients WHERE id::text LIKE '2c2c%' OR pharmacy_id::text LIKE '2c2c%' OR patient_code LIKE 'TST-2C2C-%') AS leftover_patients,
  (SELECT count(*) FROM public.patient_allergies WHERE pharmacy_id::text LIKE '2c2c%' OR patient_id::text LIKE '2c2c%') AS leftover_allergies,
  (SELECT count(*) FROM public.patient_medication_plans WHERE pharmacy_id::text LIKE '2c2c%' OR patient_id::text LIKE '2c2c%') AS leftover_plans,
  (SELECT count(*) FROM public.regimen_versions WHERE pharmacy_id::text LIKE '2c2c%') AS leftover_regimen_versions,
  (SELECT count(*) FROM public.medication_pause_periods WHERE pharmacy_id::text LIKE '2c2c%') AS leftover_pause_periods,
  (SELECT count(*) FROM public.dispensing_events WHERE pharmacy_id::text LIKE '2c2c%' OR patient_id::text LIKE '2c2c%') AS leftover_dispensing_events,
  (SELECT count(*) FROM public.refill_assessments WHERE pharmacy_id::text LIKE '2c2c%' OR patient_id::text LIKE '2c2c%') AS leftover_refill_assessments,
  (SELECT count(*) FROM public.audit_logs WHERE pharmacy_id::text LIKE '2c2c%') AS leftover_audit_logs,
  (SELECT count(*) FROM public.medication_catalog WHERE id::text LIKE '2c2c%' OR brand_name LIKE 'TST-2C2C-%' OR brand_name LIKE 'TST-2C2E-%') AS leftover_catalog;

-- 6. Confirm existing fictional baseline patient `DEV-TEST-001` remains unchanged
SELECT
  p.id AS dev_patient_id,
  p.pharmacy_id,
  p.patient_code,
  p.status,
  p.updated_at,
  (SELECT count(*) FROM public.patient_allergies pa WHERE pa.patient_id = p.id AND pa.status = 'active') AS active_allergies,
  (SELECT count(*) FROM public.patient_medication_plans mp WHERE mp.patient_id = p.id) AS medication_plans,
  (SELECT count(*) FROM public.dispensing_events de WHERE de.patient_id = p.id) AS dispensing_events
FROM public.patients p
WHERE p.patient_code = 'DEV-TEST-001';

-- 7. Confirm clean SQL role and cleared JWT session GUCs
SELECT
  current_user AS active_sql_role,
  COALESCE(pg_catalog.current_setting('request.jwt.claim.sub', true), '') AS jwt_sub,
  COALESCE(pg_catalog.current_setting('request.jwt.claims', true), '') AS jwt_claims;
