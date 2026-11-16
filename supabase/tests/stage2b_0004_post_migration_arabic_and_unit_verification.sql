-- =============================================================================
-- MASAR Care — Stage 2B Migration 0004 Pre- & Post-Installation Read-Only Verification SQL
-- Target Database: PostgreSQL 17+ (Supabase Development Project bkidngfzsubmyunacnju)
-- Status: DRAFT ONLY — DO NOT EXECUTE WITHOUT EXPLICIT APPROVAL
--
-- READ-ONLY GUARANTEE:
--   This script performs ONLY read-only SELECT and in-memory DO $$ verification
--   blocks. It executes zero INSERT, UPDATE, DELETE, ALTER, DROP, or DDL writes.
-- =============================================================================

-- =============================================================================
-- PART A: PRE-INSTALLATION UTF-8 ROUND-TRIP CHECK (Run in SQL Editor BEFORE 0004)
-- Confirms your SQL Editor / client connection preserves UTF-8 Arabic cleanly
-- without double-encoding before applying migration 0004.
-- =============================================================================
SELECT
  pg_catalog.current_setting('server_encoding') AS server_encoding,
  pg_catalog.current_setting('client_encoding') AS client_encoding,
  pg_catalog.char_length('قرص') AS expected_3_chars,
  pg_catalog.octet_length('قرص') AS expected_6_utf8_bytes,
  pg_catalog.encode(pg_catalog.convert_to('قرص', 'UTF8'), 'hex') = 'd982d8b1d8b5' AS arabic_unit_utf8_roundtrip_ok,
  pg_catalog.encode(pg_catalog.convert_to('تحديث بيانات المراجع', 'UTF8'), 'hex')
    = 'd8aad8add8afd98ad8ab20d8a8d98ad8a7d986d8a7d8aa20d8a7d984d985d8b1d8a7d8acd8b9' AS arabic_phrase_utf8_roundtrip_ok;

DO $$
BEGIN
  IF pg_catalog.encode(pg_catalog.convert_to('قرص', 'UTF8'), 'hex') <> 'd982d8b1d8b5' THEN
    RAISE EXCEPTION 'PRE-CHECK FAILED: SQL client corrupted UTF-8 Arabic literal ''قرص'' before execution.';
  END IF;
  IF pg_catalog.encode(pg_catalog.convert_to('تحديث بيانات المراجع', 'UTF8'), 'hex')
     <> 'd8aad8add8afd98ad8ab20d8a8d98ad8a7d986d8a7d8aa20d8a7d984d985d8b1d8a7d8acd8b9'
  THEN
    RAISE EXCEPTION 'PRE-CHECK FAILED: SQL client corrupted UTF-8 Arabic phrase before execution.';
  END IF;
END $$;

-- =============================================================================
-- PART B: POST-INSTALLATION READ-ONLY VERIFICATION (Run AFTER Migration 0004)
-- =============================================================================

-- 1. Verify all 14 affected live functions exist, contain clean Arabic, and contain ZERO mojibake
DO $$
DECLARE
  v_expected_functions text[] := ARRAY[
    'app_security.normalize_clinical_unit_category(text)',
    'public.finalize_first_owner_bootstrap(uuid, uuid, text, text, text, text, text, text, text, text, text)',
    'public.provision_pharmacy_staff_by_owner(uuid, uuid, text, text, text, text, uuid)',
    'public.create_patient_with_clinical_tags(text, text, text, text, text, date, text, text, text, date, jsonb, jsonb)',
    'public.update_patient_with_clinical_tags(uuid, jsonb, jsonb, jsonb)',
    'public.create_medication_plan_with_version(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb)',
    'public.update_medication_plan_version(uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date)',
    'public.change_medication_plan_status(uuid, text, text, date)',
    'public.record_dispensing_with_refill(uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text, numeric, integer, date, text, numeric, numeric, integer, text, date, text, text, text, jsonb)',
    'public.send_consultation_reply(uuid, text, text)',
    'public.revoke_patient_apk_invitation(uuid, text)',
    'app_security.write_clinical_audit_log()',
    'public.issue_patient_apk_invitation(uuid, text, text, integer, boolean)',
    'public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)'
  ];
  v_sig         text;
  v_oid         oid;
  v_src         text;
BEGIN
  FOREACH v_sig IN ARRAY v_expected_functions LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'MISSING FUNCTION AFTER 0004: %', v_sig;
    END IF;

    SELECT p.prosrc INTO v_src
    FROM pg_catalog.pg_proc p
    WHERE p.oid = v_oid;

    -- Detect double-encoded Arabic UTF-8 mojibake (U+00D8..U+00DB + U+0080..U+00BF / Win-1252) or U+FFFD
    IF v_src ~ E'([\u00D8-\u00DB][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|\uFFFD)' THEN
      RAISE EXCEPTION 'MOJIBAKE DETECTED IN FUNCTION SOURCE: %', v_sig;
    END IF;

    IF v_src !~ E'[\u0600-\u06FF]' THEN
      RAISE EXCEPTION 'EXPECTED CLEAN ARABIC LITERALS MISSING IN FUNCTION SOURCE: %', v_sig;
    END IF;
  END LOOP;
END $$;

-- 2. Verify clinical Arabic & English unit normalization in app_security.normalize_clinical_unit_category
DO $$
DECLARE
  v_cases text[][] := ARRAY[
    ARRAY['قرص', 'tablet'],
    ARRAY['أقراص', 'tablet'],
    ARRAY['حبة', 'tablet'],
    ARRAY['حبات', 'tablet'],
    ARRAY['tablet', 'tablet'],
    ARRAY['tablets', 'tablet'],
    ARRAY['كبسولة', 'capsule'],
    ARRAY['كبسولات', 'capsule'],
    ARRAY['capsule', 'capsule'],
    ARRAY['capsules', 'capsule'],
    ARRAY['مل', 'ml'],
    ARRAY['ملي', 'ml'],
    ARRAY['ml', 'ml'],
    ARRAY['بخة', 'puff'],
    ARRAY['بخات', 'puff'],
    ARRAY['puff', 'puff'],
    ARRAY['puffs', 'puff'],
    ARRAY['قطرة', 'drop'],
    ARRAY['قطرات', 'drop'],
    ARRAY['drop', 'drop'],
    ARRAY['drops', 'drop'],
    ARRAY['كيس', 'sachet'],
    ARRAY['أكياس', 'sachet'],
    ARRAY['ظرف', 'sachet'],
    ARRAY['sachet', 'sachet'],
    ARRAY['sachets', 'sachet'],
    ARRAY['وحدة', 'iu'],
    ARRAY['وحدات', 'iu'],
    ARRAY['iu', 'iu'],
    ARRAY['unit', 'iu'],
    ARRAY['units', 'iu'],
    ARRAY['أمبولة', 'injection_vial'],
    ARRAY['إبرة', 'injection_vial'],
    ARRAY['فيال', 'injection_vial'],
    ARRAY['ampoule', 'injection_vial'],
    ARRAY['vial', 'injection_vial'],
    ARRAY['injection', 'injection_vial']
  ];
  v_i   integer;
  v_got text;
BEGIN
  FOR v_i IN 1 .. pg_catalog.array_length(v_cases, 1) LOOP
    v_got := app_security.normalize_clinical_unit_category(v_cases[v_i][1]);
    IF v_got IS DISTINCT FROM v_cases[v_i][2] THEN
      RAISE EXCEPTION 'UNIT NORMALIZATION MISMATCH: input=%, expected=%, got=%',
        v_cases[v_i][1], v_cases[v_i][2], v_got;
    END IF;
  END LOOP;

  IF app_security.normalize_clinical_unit_category('قرص')
     = app_security.normalize_clinical_unit_category('كبسولة') THEN
    RAISE EXCEPTION 'UNIT SAFETY FAILURE: tablet and capsule normalized identically.';
  END IF;

  IF app_security.normalize_clinical_unit_category('مل')
     = app_security.normalize_clinical_unit_category('قطرة') THEN
    RAISE EXCEPTION 'UNIT SAFETY FAILURE: ml and drop normalized identically.';
  END IF;
END $$;

-- 3. Verify preserved security settings (SECURITY DEFINER, search_path, and role EXECUTE grants)
DO $$
DECLARE
  v_fn_0003_service_only text[] := ARRAY[
    'app_security.normalize_clinical_unit_category(text)',
    'public.finalize_first_owner_bootstrap(uuid, uuid, text, text, text, text, text, text, text, text, text)',
    'public.provision_pharmacy_staff_by_owner(uuid, uuid, text, text, text, text, uuid)'
  ];
  v_fn_0003_authenticated text[] := ARRAY[
    'public.create_patient_with_clinical_tags(text, text, text, text, text, date, text, text, text, date, jsonb, jsonb)',
    'public.update_patient_with_clinical_tags(uuid, jsonb, jsonb, jsonb)',
    'public.create_medication_plan_with_version(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb)',
    'public.update_medication_plan_version(uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date)',
    'public.change_medication_plan_status(uuid, text, text, date)',
    'public.record_dispensing_with_refill(uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text, numeric, integer, date, text, numeric, numeric, integer, text, date, text, text, text, jsonb)',
    'public.send_consultation_reply(uuid, text, text)',
    'public.revoke_patient_apk_invitation(uuid, text)'
  ];
  v_sig       text;
  v_prosecdef boolean;
  v_proconfig text[];
BEGIN
  -- 0003 service_role-only helpers/RPCs
  FOREACH v_sig IN ARRAY v_fn_0003_service_only LOOP
    SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_proconfig
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig);

    IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_proconfig, '{}'::text[]))) THEN
      RAISE EXCEPTION 'SEARCH_PATH MISMATCH on %: %', v_sig, v_proconfig;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'PRIVILEGE MISMATCH on service_role-only function: %', v_sig;
    END IF;
  END LOOP;

  -- 0003 authenticated pharmacist RPCs
  FOREACH v_sig IN ARRAY v_fn_0003_authenticated LOOP
    SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_proconfig
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig);

    IF v_prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'SECURITY DEFINER MISSING on %', v_sig;
    END IF;
    IF NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_proconfig, '{}'::text[]))) THEN
      RAISE EXCEPTION 'SEARCH_PATH MISMATCH on %: %', v_sig, v_proconfig;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'PRIVILEGE MISMATCH on authenticated RPC: %', v_sig;
    END IF;
  END LOOP;

  -- Trigger function write_clinical_audit_log()
  SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_proconfig
  FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('app_security.write_clinical_audit_log()');
  IF v_prosecdef IS DISTINCT FROM true
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(v_proconfig, '{}'::text[])))
     OR has_function_privilege('anon', 'app_security.write_clinical_audit_log()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_security.write_clinical_audit_log()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'SECURITY MISMATCH on app_security.write_clinical_audit_log()';
  END IF;

  -- 0002 issue_patient_apk_invitation: authenticated + service_role, NOT anon; search_path = pg_catalog, public, app_security, pg_temp
  SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_proconfig
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.issue_patient_apk_invitation(uuid, text, text, integer, boolean)');
  IF v_prosecdef IS DISTINCT FROM true
     OR NOT ('search_path=pg_catalog, public, app_security, pg_temp' = ANY(COALESCE(v_proconfig, '{}'::text[])))
     OR has_function_privilege('anon', 'public.issue_patient_apk_invitation(uuid, text, text, integer, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_patient_apk_invitation(uuid, text, text, integer, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.issue_patient_apk_invitation(uuid, text, text, integer, boolean)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'SECURITY/PRIVILEGE MISMATCH on public.issue_patient_apk_invitation';
  END IF;

  -- 0002 redeem_patient_apk_invitation: service_role ONLY, NOT authenticated or anon; search_path = pg_catalog, public, app_security, pg_temp
  SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_proconfig
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)');
  IF v_prosecdef IS DISTINCT FROM true
     OR NOT ('search_path=pg_catalog, public, app_security, pg_temp' = ANY(COALESCE(v_proconfig, '{}'::text[])))
     OR has_function_privilege('anon', 'public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'SECURITY/PRIVILEGE MISMATCH on public.redeem_patient_apk_invitation';
  END IF;
END $$;

-- 4. Read-only inspection summary confirming existing records remain intact
SELECT
  (SELECT pg_catalog.count(*) FROM public.pharmacies WHERE is_active = true) AS active_pharmacies_count,
  (SELECT pg_catalog.count(*) FROM public.pharmacy_staff WHERE role = 'pharmacy_owner' AND is_active = true) AS active_owners_count,
  (SELECT pg_catalog.count(*) FROM public.patients) AS total_patients_count,
  (SELECT pg_catalog.count(*) FROM public.patients WHERE patient_code = 'DEV-TEST-001') AS dev_test_001_count,
  (SELECT pg_catalog.count(*) FROM public.patient_allergies pa
    JOIN public.patients pt ON pt.id = pa.patient_id
    WHERE pt.patient_code = 'DEV-TEST-001' AND pa.status = 'active') AS dev_test_001_active_allergies_count,
  (SELECT pg_catalog.count(*) FROM public.audit_logs) AS audit_logs_total_count;
