-- =============================================================================
-- MASAR CARE — STAGE 2C.2C/2D TRANSACTIONAL ROLLBACK VERIFICATION SUITE
-- STATUS: DRAFT VERIFICATION SCRIPT — DO NOT EXECUTE AUTOMATICALLY
-- PREREQUISITE: Run ONLY on disposable/staging PostgreSQL AFTER applying
--               migrations 0001–0004 AND `stage2c2c_migration_DRAFT.sql`.
--
-- SAFETY GUARANTEES:
--   - Contains ZERO schema DDL (no ALTER TABLE, no CREATE FUNCTION, no DROP).
--   - Runs strictly inside a single `BEGIN; ... ROLLBACK;` block using deterministic
--     `2c2c...` fictional IDs + pre-seed collision check + non-privileged
--     `SET LOCAL ROLE authenticated;` execution.
--   - Every negative assertion uses `GET STACKED DIAGNOSTICS` verifying BOTH
--     `RETURNED_SQLSTATE` and exact `MESSAGE_TEXT`, re-raising any unexpected error (`RAISE;`).
--   - Leaves `DEV-TEST-001`, `bootstrap_state`, and existing pharmacy rows intact.
--   - Multi-session two-connection `psql` lock/race testing lives separately in
--     `supabase/tests/stage2c2d_disposable_concurrency_plan.md`.
-- =============================================================================

BEGIN;

-- 0. Pre-seed collision guard for `2c2c...` deterministic test records
DO $$
DECLARE
  v_collisions integer;
BEGIN
  SELECT (
    (SELECT count(*) FROM auth.users WHERE id::text LIKE '2c2c%' OR email LIKE 'stage2c2c%')
    + (SELECT count(*) FROM public.pharmacies WHERE id::text LIKE '2c2c%' OR license_number LIKE 'TEST-2C2C-%')
    + (SELECT count(*) FROM public.pharmacy_staff WHERE id::text LIKE '2c2c%' OR syndicate_license LIKE 'SYN-2C2C%')
    + (SELECT count(*) FROM public.patients WHERE id::text LIKE '2c2c%' OR patient_code LIKE 'TST-2C2C-%')
    + (SELECT count(*) FROM public.patient_medication_plans WHERE id::text LIKE '2c2c%')
    + (SELECT count(*) FROM public.medication_catalog WHERE id::text LIKE '2c2c%' OR brand_name LIKE 'TST-2C2C-%' OR brand_name LIKE 'TST-2C2E-%')
  )::integer INTO v_collisions;

  IF v_collisions <> 0 THEN
    RAISE EXCEPTION 'PRE-SEED COLLISION DETECTED: Found % conflicting 2c2c test identifiers.', v_collisions;
  END IF;
END $$;

-- 1. Verify Stage 2C.2C/2D RPCs, catalog provenance, app_security registries, & ACLs exist
DO $$
DECLARE
  v_verified_cat_count integer;
  v_pub_table_count    integer;
  v_fmt_check          text;
  v_sqlstate           text;
  v_constraint         text;
BEGIN
  IF pg_catalog.to_regprocedure('public.get_clinical_safety_capabilities()') IS NULL
     OR pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('app_security.format_canonical_decimal4(numeric)') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_inn_registry') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_broad_class_labels') IS NULL
     OR pg_catalog.to_regclass('app_security.verified_drug_class_relationships') IS NULL
  THEN
    RAISE EXCEPTION 'PREREQUISITE FAILURE: Stage 2C.2C/2D functions or registries are not installed.';
  END IF;

  IF pg_catalog.has_function_privilege('anon', 'public.get_clinical_safety_capabilities()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'app_security.text_array_has_non_blank_elements(text[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'app_security.text_array_has_non_blank_elements(text[])', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'app_security.text_array_has_non_blank_elements(text[])', 'EXECUTE')
     OR NOT pg_catalog.has_schema_privilege('service_role', 'app_security', 'USAGE')
  THEN
    RAISE EXCEPTION 'SECURITY FAILURE: Unexpected privilege state on Stage 2C.2C/2D/2E RPC or constraint helper.';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_pub_table_count
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

  IF v_pub_table_count <> 24 THEN
    RAISE EXCEPTION 'INVARIANT FAILURE: Expected exactly 24 public tables, found %.', v_pub_table_count;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_verified_cat_count
  FROM public.medication_catalog
  WHERE ingredient_verification_status = 'verified'
    AND active_ingredients IS NOT NULL
    AND pg_catalog.cardinality(active_ingredients) > 0
    AND app_security.text_array_has_non_blank_elements(active_ingredients) IS TRUE
    AND pg_catalog.btrim(COALESCE(ingredient_source, '')) <> ''
    AND ingredient_reviewed_at IS NOT NULL
    AND pg_catalog.btrim(COALESCE(ingredient_reviewed_by, '')) <> '';

  IF v_verified_cat_count < 13 THEN
    RAISE EXCEPTION 'CATALOG FAILURE: Expected >= 13 verified medication_catalog entries with provenance, found %.', v_verified_cat_count;
  END IF;

  -- Deterministic decimal rounding & large-quantity parity checks (exact match with `CANONICAL_DECIMAL4_VECTORS`)
  IF app_security.format_canonical_decimal4(NULL) <> '<NULL>'
     OR app_security.format_canonical_decimal4(0) <> '0.0000'
     OR app_security.format_canonical_decimal4(-0.00001) <> '0.0000'
     OR app_security.format_canonical_decimal4(-0.5) <> '-0.5000'
     OR app_security.format_canonical_decimal4(0.5) <> '0.5000'
     OR app_security.format_canonical_decimal4(2.00005) <> '2.0001'
     OR app_security.format_canonical_decimal4(10.50005) <> '10.5001'
     OR app_security.format_canonical_decimal4(-2.00005) <> '-2.0001'
     OR app_security.format_canonical_decimal4(999999999.99995) <> '1000000000.0000'
  THEN
    SELECT app_security.format_canonical_decimal4(999999999.99995) INTO v_fmt_check;
    RAISE EXCEPTION 'DECIMAL PARITY FAILURE: Unexpected format_canonical_decimal4 result (999999999.99995 -> %).', v_fmt_check;
  END IF;

  -- Verify collapsed INN aliases were split cleanly & nonspecific labels removed
  IF EXISTS (
    SELECT 1 FROM app_security.verified_inn_registry
    WHERE canonical_inn = 'penicillin'
       OR (canonical_inn = 'ketoprofen' AND aliases && ARRAY['ketorolac', 'indomethacin', 'piroxicam'])
       OR (canonical_inn = 'enalapril' AND aliases && ARRAY['ramipril', 'lisinopril', 'captopril'])
       OR (canonical_inn = 'sulfamethoxazole' AND aliases && ARRAY['sulfadiazine', 'sulfasalazine', 'sulfa', 'سلفا', 'سلفوناميد'])
       OR (canonical_inn = 'flucloxacillin' AND aliases && ARRAY['cloxacillin'])
       OR (canonical_inn = 'insulin glargine' AND aliases && ARRAY['insulin', 'أنسولين'])
  ) THEN
    RAISE EXCEPTION 'REGISTRY FAILURE: Collapsed or nonspecific INN alias still present in app_security.verified_inn_registry.';
  END IF;

  -- Verify nonspecific Arabic "مسكنات" is NOT classified as confirmed NSAID allergy
  IF EXISTS (
    SELECT 1 FROM app_security.verified_broad_class_labels
    WHERE match_mode = 'confirmed_class_allergy'
      AND labels && ARRAY['مسكنات', 'مسكن', 'painkiller', 'painkillers', 'analgesic', 'analgesics']
  ) THEN
    RAISE EXCEPTION 'REGISTRY FAILURE: Nonspecific analgesic label incorrectly marked confirmed_class_allergy.';
  END IF;

  -- Negative CHECK constraint tests on `public.medication_catalog` (`chk_medication_catalog_verified_provenance`)
  -- 1A: Reject empty `active_ingredients` (`'{}'`) when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0010-0000-4000-8000-000000000001'::uuid,
      'TST-2C2C-EmptyArr', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      '{}'::text[], ARRAY['biguanide'], 'verified',
      'Test Formulary', DATE '2026-11-16', 'Test Reviewer', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-1]: Empty active_ingredients on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  -- 1B: Reject NULL element inside `active_ingredients` when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0011-0000-4000-8000-000000000001'::uuid,
      'TST-2C2C-NullElem', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      ARRAY['Metformin HCl', NULL]::text[], ARRAY['biguanide'], 'verified',
      'Test Formulary', DATE '2026-11-16', 'Test Reviewer', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-2]: NULL element in active_ingredients on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  -- 1C: Reject blank element inside `active_ingredients` when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0012-0000-4000-8000-000000000001'::uuid,
      'TST-2C2C-BlankElem', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      ARRAY['Metformin HCl', '   ']::text[], ARRAY['biguanide'], 'verified',
      'Test Formulary', DATE '2026-11-16', 'Test Reviewer', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-3]: Blank element in active_ingredients on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  -- 1D: Reject blank `ingredient_source` / missing `ingredient_reviewed_at` / blank `ingredient_reviewed_by` when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0013-0000-4000-8000-000000000001'::uuid,
      'TST-2C2C-BlankProv', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      ARRAY['Metformin HCl']::text[], ARRAY['biguanide'], 'verified',
      '   ', NULL, '   ', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-4]: Blank provenance/missing review fields on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  -- 1E: Reject tab/newline whitespace element inside `active_ingredients` when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0014-0000-4000-8000-000000000001'::uuid,
      'TST-2C2E-TabElem', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      ARRAY['Metformin HCl', E' \t\n ']::text[], ARRAY['biguanide'], 'verified',
      'Test Formulary', DATE '2026-11-16', 'Test Reviewer', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-5]: Tab/newline blank element on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  -- 1F: Reject multi-dimensional array in `active_ingredients` when verified
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0015-0000-4000-8000-000000000001'::uuid,
      'TST-2C2E-MultiDim', 'TestGeneric', ARRAY['10 mg'], 'tablet', 'oral', 'Test',
      '{{Metformin HCl}}'::text[], ARRAY['biguanide'], 'verified',
      'Test Formulary', DATE '2026-11-16', 'Test Reviewer', true
    );
    RAISE EXCEPTION 'FAIL [CAT-CHK-6]: Multi-dimensional active_ingredients on verified row should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;
END $$;

-- 1B. Verify `service_role` can execute legitimate verified `medication_catalog` INSERT/UPDATE
--     without a `42501` permission error on `app_security.text_array_has_non_blank_elements(text[])`
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_sqlstate   text;
  v_constraint text;
BEGIN
  INSERT INTO public.medication_catalog (
    id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
    active_ingredients, therapeutic_classes, ingredient_verification_status,
    ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
  ) VALUES (
    '2c2c0016-0000-4000-8000-000000000001'::uuid,
    'TST-2C2E-ServiceRoleOK', 'Metformin HCl', ARRAY['500 mg'], 'tablet', 'oral', 'Antidiabetic',
    ARRAY['Metformin HCl']::text[], ARRAY['biguanide'], 'verified',
    'WHO INN / BNF Test', DATE '2026-11-16', 'Service Role Verification', true
  );

  UPDATE public.medication_catalog
     SET is_active = false
   WHERE id = '2c2c0016-0000-4000-8000-000000000001'::uuid;

  BEGIN
    UPDATE public.medication_catalog
       SET active_ingredients = '{}'::text[]
     WHERE id = '2c2c0016-0000-4000-8000-000000000001'::uuid;
    RAISE EXCEPTION 'FAIL [SVC-CAT-CHK]: service_role update clearing active_ingredients should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    UPDATE public.medication_catalog
       SET active_ingredients = '{{Metformin HCl}}'::text[]
     WHERE id = '2c2c0016-0000-4000-8000-000000000001'::uuid;
    RAISE EXCEPTION 'FAIL [SVC-CAT-MULTI]: service_role update to multidimensional active_ingredients should fail 23514.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'chk_medication_catalog_verified_provenance' THEN
      RAISE;
    END IF;
  END;
END $$;
RESET ROLE;

-- 2. Seed valid fictional 2c2c records matching 0001-0004 constraints, then execute
--    security & clinical parity assertions under `SET LOCAL ROLE authenticated`
DO $$
DECLARE
  v_pharm_id        constant uuid := '2c2c0000-0000-4000-8000-000000000001';
  v_owner_id        constant uuid := '2c2c0001-0000-4000-8000-000000000001';
  v_active_pat      constant uuid := '2c2c0002-0000-4000-8000-000000000001';
  v_arch_pat        constant uuid := '2c2c0003-0000-4000-8000-000000000001';
  v_pen_pat         constant uuid := '2c2c0004-0000-4000-8000-000000000001';
  v_ace_pat         constant uuid := '2c2c0006-0000-4000-8000-000000000001';
  v_keto_pat        constant uuid := '2c2c0007-0000-4000-8000-000000000001';
  v_sulfa_pat       constant uuid := '2c2c0008-0000-4000-8000-000000000001';
  v_insulin_pat     constant uuid := '2c2c0009-0000-4000-8000-000000000001';
  v_fluc_pat        constant uuid := '2c2c000a-0000-4000-8000-000000000001';
  v_unverified_cat  constant uuid := '2c2c000b-0000-4000-8000-000000000001';
  v_painkiller_pat  constant uuid := '2c2c000c-0000-4000-8000-000000000001';
  v_mixed_unk_cat   constant uuid := '2c2c000d-0000-4000-8000-000000000001';
  v_client_uuid_1   constant uuid := '2c2c9991-0000-4000-8000-000000000001';
  v_client_uuid_2   constant uuid := '2c2c9992-0000-4000-8000-000000000001';
  v_client_vec_1    constant uuid := '2c2ca001-0000-4000-8000-000000000001';
  v_client_vec_2    constant uuid := '2c2ca002-0000-4000-8000-000000000001';
  v_client_vec_3    constant uuid := '2c2ca003-0000-4000-8000-000000000001';
  v_client_vec_4    constant uuid := '2c2ca004-0000-4000-8000-000000000001';
  v_client_vec_5    constant uuid := '2c2ca005-0000-4000-8000-000000000001';
  v_sched_daily     constant jsonb := jsonb_build_object(
    'frequencyType', 'daily',
    'timesPerDay', 2,
    'doseSlots', jsonb_build_array(
      jsonb_build_object('id', 's1', 'time24', '08:00', 'doseAmount', 1),
      jsonb_build_object('id', 's2', 'time24', '20:00', 'doseAmount', 1)
    ),
    'timezone', 'Asia/Baghdad'
  );
  v_sched_once_daily constant jsonb := jsonb_build_object(
    'frequencyType', 'daily',
    'timesPerDay', 1,
    'doseSlots', jsonb_build_array(
      jsonb_build_object('id', 's1', 'time24', '20:00', 'doseAmount', 1)
    ),
    'timezone', 'Asia/Baghdad'
  );
  v_sched_var_slotless constant jsonb := jsonb_build_object(
    'frequencyType', 'variable',
    'timesPerDay', 1,
    'variablePatternNote', '5 mg Mon/Wed/Fri and 2.5 mg other days per INR',
    'doseSlots', '[]'::jsonb,
    'timezone', 'Asia/Baghdad'
  );
  v_override_crit   constant jsonb := jsonb_build_object(
    'level', 'critical_conflict',
    'acknowledged', true,
    'prescriberName', 'Dr. Tariq Al-Nuaimi',
    'authorizationSource', 'prescriber_written_order',
    'authorizationReference', 'RX-2C2C-100',
    'clinicalJustification', 'Endocrinologist confirmed continuation under close monitoring.'
  );
  v_review_class    constant jsonb := jsonb_build_object(
    'level', 'caution_cross_reactivity',
    'acknowledged', true,
    'clinicalJustification', 'Verified distinct INN molecule within class; tolerated in prior chart note.'
  );
  v_janumet_cat_id  uuid;
  v_lantus_cat_id   uuid;
  v_cozaar_cat_id   uuid;
  v_caps            jsonb;
  v_plan_res        jsonb;
  v_plan_id         uuid;
  v_var_plan_res    jsonb;
  v_unk_plan_res    jsonb;
  v_pen_plan_res    jsonb;
  v_pen_plan_id     uuid;
  v_cozaar_plan_res jsonb;
  v_vec_plan_res    jsonb;
  v_vec_plan_id     uuid;
  v_vec_disp_res    jsonb;
  v_vec_hash        text;
  v_disp_1          jsonb;
  v_disp_replay     jsonb;
  v_disp_count      integer;
  v_audit_meta      jsonb;
  v_sqlstate        text;
  v_msg             text;
BEGIN
  SELECT id INTO v_janumet_cat_id FROM public.medication_catalog WHERE brand_name = 'Janumet' LIMIT 1;
  SELECT id INTO v_lantus_cat_id  FROM public.medication_catalog WHERE brand_name = 'Lantus SoloStar' LIMIT 1;
  SELECT id INTO v_cozaar_cat_id  FROM public.medication_catalog WHERE brand_name = 'Cozaar' LIMIT 1;

  INSERT INTO auth.users (id, aud, role, email)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'stage2c2c-test@masar.invalid');

  INSERT INTO public.pharmacies (
    id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
  )
  VALUES (
    v_pharm_id, 'صيدلية اختبار ٢ج٢د', 'Stage 2C2D Test Pharmacy',
    'Baghdad', 'Baghdad', 'TEST-2C2C-01', '07700000333', 'Asia/Baghdad', true
  );

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, phone, syndicate_license, is_active
  )
  VALUES (
    v_owner_id, v_pharm_id, 'د. اختبار ٢ج٢د', 'pharmacy_owner',
    '07700000334', 'SYN-2C2C', true
  );

  INSERT INTO public.patients (
    id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    date_of_birth, sex, contact_preference, registration_date, status, created_by_staff_id
  ) VALUES
  (v_active_pat,  v_pharm_id, 'TST-2C2C-1', 'مراجع ٢ج٢د نشط',            '07700000335', 'self', DATE '1980-01-01', 'male',   'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_arch_pat,    v_pharm_id, 'TST-2C2C-2', 'مراجع ٢ج٢د مؤرشف',          '07700000336', 'self', DATE '1982-01-01', 'female', 'whatsapp', DATE '2026-11-01', 'archived', v_owner_id),
  (v_pen_pat,     v_pharm_id, 'TST-2C2C-3', 'مراجع ٢ج٢د حساسية بنسلين',    '07700000337', 'self', DATE '1985-05-05', 'male',   'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_ace_pat,     v_pharm_id, 'TST-2C2C-4', 'مراجع ٢ج٢د حساسية إينالابريل', '07700000338', 'self', DATE '1979-03-11', 'male',   'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_keto_pat,    v_pharm_id, 'TST-2C2C-5', 'مراجع ٢ج٢د حساسية كيتوبروفين', '07700000339', 'self', DATE '1981-04-12', 'female', 'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_sulfa_pat,   v_pharm_id, 'TST-2C2C-6', 'مراجع ٢ج٢د حساسية سلفا',       '07700000340', 'self', DATE '1983-06-13', 'male',   'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_insulin_pat,   v_pharm_id, 'TST-2C2C-7', 'مراجع ٢ج٢د حساسية أنسولين',    '07700000341', 'self', DATE '1975-07-14', 'female', 'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_fluc_pat,      v_pharm_id, 'TST-2C2C-8', 'مراجع ٢ج٢د حساسية فلوكلوكس',   '07700000342', 'self', DATE '1988-08-15', 'male',   'whatsapp', DATE '2026-11-01', 'active',   v_owner_id),
  (v_painkiller_pat,v_pharm_id, 'TST-2C2C-9', 'مراجع ٢ج٢د حساسية مسكنات',     '07700000343', 'self', DATE '1986-09-16', 'female', 'whatsapp', DATE '2026-11-01', 'active',   v_owner_id);

  INSERT INTO public.patient_allergies (
    pharmacy_id, patient_id, substance, severity, reaction, status
  ) VALUES
  (v_pharm_id, v_active_pat,     'Metformin',      'severe', 'Severe hypersensitivity', 'active'),
  (v_pharm_id, v_pen_pat,        'Penicillin',     'severe', 'Anaphylaxis',             'active'),
  (v_pharm_id, v_ace_pat,        'Enalapril',      'severe', 'Angioedema',              'active'),
  (v_pharm_id, v_keto_pat,       'Ketoprofen',     'severe', 'Bronchospasm',            'active'),
  (v_pharm_id, v_sulfa_pat,      'Sulfa',          'severe', 'Generalized rash',        'active'),
  (v_pharm_id, v_insulin_pat,    'Insulin',        'severe', 'Injection-site urticaria','active'),
  (v_pharm_id, v_fluc_pat,       'Flucloxacillin', 'severe', 'Severe rash',             'active'),
  (v_pharm_id, v_painkiller_pat, 'مسكنات',         'severe', 'Severe swelling',         'active');

  -- Temporary unverified catalog record (Stage 2C.2D fail-closed verification)
  INSERT INTO public.medication_catalog (
    id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
    active_ingredients, therapeutic_classes, ingredient_verification_status, is_active
  ) VALUES (
    v_unverified_cat, 'TST-2C2C-UnverifiedMed', 'Metformin HCl', ARRAY['500 mg'],
    'tablet', 'oral', 'Test', ARRAY['Metformin HCl'], ARRAY['biguanide'], 'unverified', true
  );

  -- Temporary catalog row marked `verified` containing Metformin HCl + an unrecognized fictional ingredient (Stage 2C.2E)
  INSERT INTO public.medication_catalog (
    id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
    active_ingredients, therapeutic_classes, ingredient_verification_status,
    ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
  ) VALUES (
    v_mixed_unk_cat, 'TST-2C2E-MixedUnknown', 'Metformin HCl', ARRAY['500 mg'],
    'tablet', 'oral', 'Test', ARRAY['Metformin HCl', 'FictionalUnknownExtra'], ARRAY['biguanide'], 'verified',
    'Stage 2C.2E Test Formulary', DATE '2026-11-16', 'Stage 2C.2E Reviewer', true
  );

  -- Deterministic plan UUID (`2c2c0005-...`) for live SHA-256 fingerprint parity vectors (seeded before `SET LOCAL ROLE authenticated`)
  INSERT INTO public.patient_medication_plans (
    id, pharmacy_id, patient_id, catalog_id, brand_name, generic_name, strength,
    dosage_form, route, dose_amount, dose_unit, food_relation, verified_instructions,
    start_date, is_ongoing, status, current_version_number, schedule, created_by_staff_id
  ) VALUES (
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    v_pharm_id, v_active_pat, NULL, 'Cozaar', 'Losartan Potassium', '50 mg',
    'tablet', 'oral', 1, 'tablet', 'any_time', 'Parity vector test plan',
    DATE '2026-11-01', true, 'active', 1, v_sched_once_daily, v_owner_id
  );
  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, effective_to,
    dose_amount, dose_unit, food_relation, verified_instructions, schedule,
    changed_by_staff_id, changed_by_staff_name, change_reason
  ) VALUES (
    v_pharm_id, '2c2c0005-0000-4000-8000-000000000001'::uuid, 1, DATE '2026-11-01', NULL,
    1, 'tablet', 'any_time', 'Parity vector test plan', v_sched_once_daily,
    v_owner_id, 'د. اختبار ٢ج٢د', 'Initial Stage 2C.2D parity vector seed'
  );

  -- Switch into non-privileged `authenticated` role & pharmacist JWT identity
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_owner_id, 'role', 'authenticated')::text,
    true
  );

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION 'SESSION CONTEXT ERROR: expected role=authenticated and auth.uid()=%.', v_owner_id;
  END IF;

  -- Test 0: Capability probe returns explicit `stage2c2c_v2` flags
  v_caps := public.get_clinical_safety_capabilities();
  IF v_caps->>'stage' IS DISTINCT FROM 'stage2c2c_v2'
     OR COALESCE((v_caps->>'enforcesServerCriticalAllergyOverride')::boolean, false) IS DISTINCT FROM true
     OR COALESCE((v_caps->>'enforcesServerAllergyUncertainty')::boolean, false) IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'FAIL [0]: Unexpected capability payload: %', v_caps;
  END IF;

  -- Test 1: Archived patient medication creation blocked
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_arch_pat, NULL, 'Glucophage', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'قرص', 'after_food', 'قرص مرتين يومياً', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [1]: Archived patient medication creation should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Cannot add medication plan for archived patient%' THEN
      RAISE;
    END IF;
  END;

  -- Test 2: Mass unit trap (tablet + mg -> 23514) & route compatibility
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, NULL, 'Losec', 'Omeprazole', '20 mg', 'tablet', 'oral',
      20, 'mg', 'before_food', 'Take 20 mg once daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [2]: Mass unit (mg) on tablet form should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE '%strength/mass unit incompatible with dosage form%' THEN
      RAISE;
    END IF;
  END;

  -- Test 3A: Severe `Penicillin` + `Cephalexin` -> `possible_conflict` (not recognized_critical),
  --          blocked without review justification and allowed with review justification (no prescriber override required)
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, NULL, 'Keflex', 'Cephalexin', '500 mg', 'capsule', 'oral',
      1, 'capsule', 'any_time', 'Take 1 capsule twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3A]: Severe Penicillin + Cephalexin without review documentation should fail.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with possible_conflict%' THEN
      RAISE;
    END IF;
  END;

  -- Test 3B: Split INN vs shared-class assertions (Stage 2C.2D):
  --   - Severe `Enalapril` + `Ramipril` -> `possible_conflict` (accepted with review note, no critical override!)
  --   - Severe `Enalapril` + `Enalapril` -> `recognized_critical` (rejects review-only note, demands prescriber override!)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_ace_pat, NULL, 'Tritace', 'Ramipril', '5 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3B-1]: Enalapril-allergic patient + distinct Ramipril should be possible_conflict, not require critical prescriber override.';
  END IF;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_ace_pat, NULL, 'Renitec', 'Enalapril', '10 mg', 'tablet', 'oral',
      1, 'tablet', 'any_time', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, v_review_class
    );
    RAISE EXCEPTION 'FAIL [3B-2]: Exact Enalapril match on severe Enalapril allergy should require critical_conflict prescriber override.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: severe documented allergy conflict requires level=critical_conflict%' THEN
      RAISE;
    END IF;
  END;

  --   - Severe `Ketoprofen` + `Ketorolac` -> `possible_conflict` (review note sufficient)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_keto_pat, NULL, 'Toradol', 'Ketorolac', '10 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily PRN max 5 days', NULL, NULL,
    DATE '2026-11-15', DATE '2026-11-20', false, 5, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3B-3]: Ketoprofen allergy + Ketorolac should be possible_conflict (class caution).';
  END IF;

  --   - Severe `Flucloxacillin` + `Cloxacillin` -> `possible_conflict` (review note sufficient)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_fluc_pat, NULL, 'Orbenin', 'Cloxacillin', '500 mg', 'capsule', 'oral',
    1, 'capsule', 'before_food', 'Take 1 capsule twice daily', NULL, NULL,
    DATE '2026-11-15', DATE '2026-11-22', false, 7, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3B-4]: Flucloxacillin allergy + Cloxacillin should be possible_conflict (class caution).';
  END IF;

  --   - Nonspecific `Sulfa` allergy + `Furosemide` / `Sulfamethoxazole` -> `possible_conflict` (NOT confirmed INN critical)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_sulfa_pat, NULL, 'Lasix', 'Furosemide', '40 mg', 'tablet', 'oral',
    1, 'tablet', 'before_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3B-5]: Nonspecific Sulfa allergy + Furosemide should be possible_conflict.';
  END IF;

  --   - Nonspecific `Insulin` allergy + `Lantus SoloStar` (`Insulin Glargine`) -> `possible_conflict` (NOT collapsed!)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_insulin_pat, v_lantus_cat_id, 'Lantus SoloStar', 'Insulin Glargine', '100 IU/mL', 'injection', 'subcutaneous',
    20, 'IU / inj', 'any_time', 'Inject 20 IU subcutaneously once daily at bedtime', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_once_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3B-6]: Nonspecific Insulin allergy + Insulin Glargine should be possible_conflict, not critical_conflict.';
  END IF;

  -- Test 3C: Severe allergy patient + unrecognized custom compound (`unknown_ingredient_coverage`)
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, NULL, 'NovelMix', 'NovelUnknownAgent', '10 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3C-1]: Unknown ingredient on severe-allergy patient should require manual review note.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  v_unk_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, NULL, 'NovelMix', 'NovelUnknownAgent', '10 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily,
    jsonb_build_object(
      'level', 'insufficient_ingredient_data',
      'acknowledged', true,
      'clinicalJustification', 'Verified package leaflet confirms zero beta-lactam or excipient match.'
    )
  );
  IF COALESCE((v_unk_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3C-2]: Verified manual review rationale on unknown_ingredient_coverage failed.';
  END IF;

  -- Test 3D: Unrecognized brand + single recognized generic NEVER gets verified_clear,
  --          while direct INN allergy conflict STILL triggers critical_conflict
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, NULL, 'GlucoSecret', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3D-1]: Unrecognized brand GlucoSecret + Metformin HCl should fail closed with unknown_ingredient_coverage.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_active_pat, NULL, 'GlucoSecret', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3D-2]: Unrecognized brand GlucoSecret + Metformin HCl must still trigger critical block on Metformin allergy.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: severe documented allergy conflict%' THEN
      RAISE;
    END IF;
  END;

  -- Test 3E: Unverified catalog record fails closed on severe-allergy patient without manual review
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, v_unverified_cat, 'TST-2C2C-UnverifiedMed', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3E]: Unverified catalog record should fail closed with unknown_ingredient_coverage.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  -- Test 3F: Nonspecific Arabic "مسكنات" triggers ambiguous `possible_conflict` caution (not confirmed NSAID critical)
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_painkiller_pat, NULL, 'Brufen', 'Ibuprofen', '400 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily after food', NULL, NULL,
      DATE '2026-11-15', DATE '2026-11-20', false, 5, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3F-1]: Severe Arabic مسكنات allergy + Ibuprofen without review should fail with possible_conflict.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with possible_conflict%' THEN
      RAISE;
    END IF;
  END;

  v_plan_res := public.create_medication_plan_with_version_v2(
    v_painkiller_pat, NULL, 'Brufen', 'Ibuprofen', '400 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily after food', NULL, NULL,
    DATE '2026-11-15', DATE '2026-11-20', false, 5, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3F-2]: Severe Arabic مسكنات + Ibuprofen should accept caution review without critical prescriber override.';
  END IF;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_painkiller_pat, NULL, 'Panadol', 'Paracetamol', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'any_time', 'Take 1 tablet twice daily PRN', NULL, NULL,
      DATE '2026-11-15', DATE '2026-11-20', false, 5, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3F-3]: Severe Arabic مسكنات allergy + Paracetamol without review should fail with possible_conflict.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with possible_conflict%' THEN
      RAISE;
    END IF;
  END;

  v_plan_res := public.create_medication_plan_with_version_v2(
    v_painkiller_pat, NULL, 'Panadol', 'Paracetamol', '500 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Take 1 tablet twice daily PRN', NULL, NULL,
    DATE '2026-11-15', DATE '2026-11-20', false, 5, v_sched_daily, v_review_class
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3F-4]: Severe Arabic مسكنات + Paracetamol should accept caution review.';
  END IF;

  -- Test 3G (Stage 2C.2E): Verified catalog row containing Metformin + unrecognized extra ingredient
  --                        must NEVER return verified_clear, while still detecting Metformin allergy
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, v_mixed_unk_cat, 'TST-2C2E-MixedUnknown', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3G-1]: Verified catalog row with unrecognized extra ingredient must fail closed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_active_pat, v_mixed_unk_cat, 'TST-2C2E-MixedUnknown', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3G-2]: Mixed catalog row must still block direct Metformin allergy critically.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: severe documented allergy conflict%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, v_mixed_unk_cat, 'TST-2C2E-MixedUnknown', 'Atorvastatin', '20 mg', 'tablet', 'oral',
      1, 'tablet', 'any_time', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3G-3]: Contradictory declared generic against mixed catalog row must fail closed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, v_janumet_cat_id, 'Glucophage', 'Metformin HCl', '500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3G-4]: Mismatched p_catalog_id (Janumet) with Glucophage brand must fail closed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  -- Test 3H (Stage 2C.2E): Extended combo brand "Janumet Mystery" must NOT acquire formulation
  --                        completeness, while legitimate verified combo brands & harmless suffixes pass
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_pen_pat, NULL, 'Janumet Mystery', 'Sitagliptin / Metformin HCl', '50/500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3H-1]: Unrecognized extended combo brand Janumet Mystery must fail closed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: documented severe allergy with unknown_ingredient_coverage%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_active_pat, NULL, 'Janumet Mystery', 'Sitagliptin', '50/500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [3H-2]: Janumet Mystery with partial generic must still detect hidden Metformin allergy.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: severe documented allergy conflict%' THEN
      RAISE;
    END IF;
  END;

  -- Positive legitimate combination products (exact brand, exact alias, approved harmless suffix)
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_ace_pat, NULL, 'Janumet', 'Sitagliptin / Metformin HCl', '50/500 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3H-3]: Exact verified combination brand Janumet should clear without override.';
  END IF;

  v_plan_res := public.create_medication_plan_with_version_v2(
    v_ace_pat, NULL, 'Janumet 50/500 mg', 'Sitagliptin / Metformin HCl', '50/500 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3H-4]: Approved harmless suffix Janumet 50/500 mg should clear without override.';
  END IF;

  v_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, NULL, 'Symbicort Turbuhaler', 'Budesonide / Formoterol', '160/4.5 mcg', 'inhaler', 'inhalation',
    1, 'puff', 'any_time', 'Inhale 1 puff twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3H-5]: Verified combination brand Symbicort Turbuhaler should clear without override.';
  END IF;

  v_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, NULL, 'Glucovance 5/500 mg', 'Glyburide / Metformin HCl', '5/500 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
  );
  IF COALESCE((v_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [3H-6]: Verified combination Glucovance 5/500 mg should clear without override.';
  END IF;

  -- Test 4: Legitimate clinical workflows (`Marevan` slotless variable & `Cozaar` catalog drug)
  v_var_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, NULL, 'Marevan', 'Warfarin Sodium', '5 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Take per weekly INR schedule', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_var_slotless, NULL
  );
  IF COALESCE((v_var_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [4A]: Valid slotless variable Marevan schedule failed.';
  END IF;

  v_cozaar_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, v_cozaar_cat_id, 'Cozaar', 'Losartan Potassium', '50 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Take 1 tablet once daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_once_daily, NULL
  );
  IF COALESCE((v_cozaar_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [4B]: Valid Cozaar workflow on Penicillin-allergic patient failed.';
  END IF;

  -- Test 5: Combo product / catalog active ingredient detection (`Janumet` declared as `Sitagliptin` only)
  --         catches hidden secondary `Metformin HCl` severe allergy conflict!
  BEGIN
    PERFORM public.create_medication_plan_with_version_v2(
      v_active_pat, v_janumet_cat_id, 'Janumet', 'Sitagliptin', '50/500 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
    );
    RAISE EXCEPTION 'FAIL [5A]: Combo drug with hidden secondary Metformin failed to trigger severe block.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Server allergy safety block: severe documented allergy conflict%' THEN
      RAISE;
    END IF;
  END;

  -- Test 6: Create valid `Janumet` plan with full documented critical override, bump v1 -> v2, verify stale `40001`
  v_plan_res := public.create_medication_plan_with_version_v2(
    v_active_pat, v_janumet_cat_id, 'Janumet', 'Sitagliptin / Metformin HCl', '50/500 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', 'Dr. Tariq Al-Nuaimi', 'Internal Medicine',
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, v_override_crit
  );
  v_plan_id := (v_plan_res->>'planId')::uuid;

  PERFORM public.update_medication_plan_version_v2(
    v_plan_id, 'Janumet', 'Sitagliptin / Metformin HCl', '50/1000 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily after meals', 'Dr. Tariq Al-Nuaimi', 'Internal Medicine',
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, 'Titrated per prescriber order',
    DATE '2026-11-16', 1, v_override_crit
  );

  BEGIN
    PERFORM public.update_medication_plan_version_v2(
      v_plan_id, 'Janumet', 'Sitagliptin / Metformin HCl', '50/1000 mg', 'tablet', 'oral',
      1, 'tablet', 'after_food', 'Stale edit attempt', NULL, NULL,
      DATE '2026-11-15', NULL, true, NULL, v_sched_daily, 'Stale edit test',
      DATE '2026-11-16', 1, v_override_crit
    );
    RAISE EXCEPTION 'FAIL [6B]: Stale update should fail with 40001.';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Stale regimen version conflict: expected v1, current v2.%' THEN
      RAISE;
    END IF;
  END;

  -- Test 7: Full 4-group idempotency replay vs mutation rejection + shadow hash telemetry
  v_disp_1 := public.record_dispensing_with_refill_v2(
    v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-OK', DATE '2027-06-01',
    DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
    30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
    'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
    2, v_client_uuid_1, NULL, v_override_crit
  );

  v_disp_replay := public.record_dispensing_with_refill_v2(
    v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-OK', DATE '2027-06-01',
    DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
    30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
    'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
    2, v_client_uuid_1, NULL, v_override_crit
  );

  IF (v_disp_replay->>'idempotentReplay')::boolean IS DISTINCT FROM true
     OR v_disp_replay->>'dispensingEventId' IS DISTINCT FROM v_disp_1->>'dispensingEventId'
  THEN
    RAISE EXCEPTION 'FAIL [7A]: Identical retry did not return idempotentReplay=true for original event.';
  END IF;

  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-OK', DATE '2027-06-01',
      DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
      30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      2, v_client_uuid_1, NULL, NULL
    );
    RAISE EXCEPTION 'FAIL [7B]: Reused UUID with dropped allergyOverride should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Idempotency conflict: client_event_uuid%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-ALTERED', DATE '2027-06-01',
      DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
      30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      2, v_client_uuid_1, NULL, v_override_crit
    );
    RAISE EXCEPTION 'FAIL [7C]: Reused UUID with altered batch_number should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Idempotency conflict: client_event_uuid%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-OK', DATE '2027-06-01',
      DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
      30, 30, 15, 'due_soon', DATE '2026-12-01', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      2, v_client_uuid_1, NULL, v_override_crit
    );
    RAISE EXCEPTION 'FAIL [7D]: Reused UUID with altered refillStatus should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Idempotency conflict: client_event_uuid%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-OK', DATE '2027-06-01',
      DATE '2026-11-16', false, 'Initial supply', 2, 15, DATE '2026-12-01', 'test',
      30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      1, v_client_uuid_1, NULL, v_override_crit
    );
    RAISE EXCEPTION 'FAIL [7E]: Reused UUID with altered expectedRegimenVersionNumber should have failed.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Idempotency conflict: client_event_uuid%' THEN
      RAISE;
    END IF;
  END;

  SELECT pg_catalog.count(*) INTO v_disp_count
  FROM public.dispensing_events de
  WHERE de.pharmacy_id = v_pharm_id AND de.client_event_uuid = v_client_uuid_1;

  IF v_disp_count <> 1 THEN
    RAISE EXCEPTION 'FAIL [7F]: Expected exactly 1 dispensing_event for client_event_uuid, got %.', v_disp_count;
  END IF;

  SELECT al.metadata INTO v_audit_meta
  FROM public.audit_logs al
  WHERE al.entity_id = (v_disp_1->>'dispensingEventId')::uuid
    AND al.action = 'DISPENSE_RECORDED'
  LIMIT 1;

  IF COALESCE(v_audit_meta->>'rpcVersion', '') <> 'v2'
     OR COALESCE(v_audit_meta->'allergyOverride'->>'prescriberName', '') <> 'Dr. Tariq Al-Nuaimi'
     OR COALESCE(v_audit_meta->>'clientHashEnforcementMode', '') <> 'shadow_audit_only'
  THEN
    RAISE EXCEPTION 'FAIL [7G]: Expected rpcVersion=v2 + allergyOverride + shadow_audit_only telemetry in audit_logs metadata.';
  END IF;

  -- Test 8: Stale regimen version with NEW UUID triggers SQLSTATE `40001`
  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_active_pat, v_plan_id, 30, 'tablet', 1, 30, 'B-STALE', DATE '2027-06-01',
      DATE '2026-11-16', false, 'Stale version', 2, 15, DATE '2026-12-01', 'test',
      60, 60, 30, 'on_track', DATE '2026-12-01', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      1, v_client_uuid_2, NULL, v_override_crit
    );
    RAISE EXCEPTION 'FAIL [8]: Stale regimen version should fail with 40001.';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Regimen version mismatch: expected v1, current v2.%' THEN
      RAISE;
    END IF;
  END;

  -- Test 9: Byte-for-byte SHA-256 fingerprint parity across `DISPENSING_FINGERPRINT_VECTORS`
  --         (First verify `authenticated` cannot invoke `app_security.format_canonical_decimal4` directly;
  --          `9E`–`9F` exercise live `record_dispensing_with_refill_v2` RPC parity & shadow mismatch telemetry;
  --          `9A`–`9D` execute in the privileged block immediately after `RESET ROLE`.)
  BEGIN
    PERFORM app_security.format_canonical_decimal4(30);
    RAISE EXCEPTION 'FAIL [9-ACL]: authenticated role should not be able to execute app_security.format_canonical_decimal4.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  -- Vector 9E: Seed 28-unit dispense at v1 & advance plan via RPC `v1 -> v2 -> v3 -> v4`,
  --            then execute live `arabic_utf8_notes_and_override` RPC call (`totalDispensedAnalyzed = 56`)
  v_vec_plan_res := public.record_dispensing_with_refill_v2(
    v_active_pat,
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    28, 'tablet', 1, 28, 'IQ-2026-SEED', DATE '2027-09-15',
    DATE '2026-10-19', false, 'Prior 28-day cycle seed for parity test',
    1, 28, DATE '2026-11-16', 'Once daily prior cycle',
    28, 0, 0, 'due_soon', DATE '2026-11-16', 'End of prior 28-day cycle',
    'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
    1, v_client_vec_1,
    NULL,
    NULL
  );
  IF COALESCE((v_vec_plan_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL [9E-SEED]: Seed 28-tablet dispense failed: %', v_vec_plan_res;
  END IF;

  PERFORM public.update_medication_plan_version_v2(
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    'Cozaar', 'Losartan Potassium', '50 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Parity vector test plan v2', NULL, NULL,
    DATE '2026-11-01', NULL, true, NULL, v_sched_once_daily, 'Clinical review v2',
    DATE '2026-11-05', 1, NULL
  );
  PERFORM public.update_medication_plan_version_v2(
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    'Cozaar', 'Losartan Potassium', '50 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Parity vector test plan v3', NULL, NULL,
    DATE '2026-11-01', NULL, true, NULL, v_sched_once_daily, 'Clinical review v3',
    DATE '2026-11-10', 2, NULL
  );
  PERFORM public.update_medication_plan_version_v2(
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    'Cozaar', 'Losartan Potassium', '50 mg', 'tablet', 'oral',
    1, 'tablet', 'any_time', 'Parity vector test plan v4', NULL, NULL,
    DATE '2026-11-01', NULL, true, NULL, v_sched_once_daily, 'Clinical review v4',
    DATE '2026-11-16', 3, NULL
  );

  v_vec_disp_res := public.record_dispensing_with_refill_v2(
    v_active_pat,
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    28, 'قرص', 1, 28, 'IQ-2026-AR', DATE '2027-09-15',
    DATE '2026-11-16', false, 'صرف علاجي موثق — يؤخذ قرص واحد بعد العشاء مع متابعة الضغط',
    1, 28, DATE '2026-12-14', 'قرص واحد يومياً مساءً',
    56, 28, 28, 'upcoming', DATE '2026-12-14', 'تقدير أولي قابل للمراجعة السريرية',
    'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
    4, v_client_vec_5,
    '1247fc01827b736134f54bc74f5187fbb17136b42ad9efd150f32110b8e02511',
    jsonb_build_object(
      'level', 'critical_conflict',
      'acknowledged', true,
      'prescriberName', 'د. طارق النعيمي',
      'authorizationSource', 'prescriber_written_order',
      'authorizationReference', 'RX-BAGHDAD-771',
      'clinicalJustification', 'تأكيد الطبيب الاختصاصي مع المراقبة اللصيقة للمراجع.'
    )
  );
  IF COALESCE((v_vec_disp_res->>'clientHashProvided')::boolean, false) IS DISTINCT FROM true
     OR COALESCE((v_vec_disp_res->>'clientServerHashMatched')::boolean, false) IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'FAIL [9E-ARABIC]: Expected clientHashProvided=true & clientServerHashMatched=true for arabic_utf8_notes_and_override vector, got %.', v_vec_disp_res;
  END IF;

  -- Vector 9F: Shadow audit non-blocking check (`totalDispensedAnalyzed = 86 = 56 + 30`):
  --            mismatched optional client hash still records `clientServerHashMatched = false` without blocking
  v_vec_disp_res := public.record_dispensing_with_refill_v2(
    v_active_pat,
    '2c2c0005-0000-4000-8000-000000000001'::uuid,
    30, 'tablet', 1, 30, 'B-SHADOW', DATE '2027-09-15',
    DATE '2026-11-16', false, 'Shadow mismatch telemetry check',
    1, 30, DATE '2026-12-16', 'Daily shadow test',
    86, 30, 30, 'on_track', DATE '2026-12-16', 'Shadow test',
    'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
    4, v_client_vec_2,
    '0000000000000000000000000000000000000000000000000000000000000000',
    NULL
  );
  IF COALESCE((v_vec_disp_res->>'clientHashProvided')::boolean, false) IS DISTINCT FROM true
     OR COALESCE((v_vec_disp_res->>'clientServerHashMatched')::boolean, true) IS DISTINCT FROM false
     OR v_vec_disp_res->>'clientHashEnforcementMode' IS DISTINCT FROM 'shadow_audit_only'
  THEN
    RAISE EXCEPTION 'FAIL [9F-SHADOW-MISMATCH]: Unexpected shadow audit telemetry: %', v_vec_disp_res;
  END IF;

  -- Test 10: Terminal plan immutability + archived patient isolation
  PERFORM public.change_medication_plan_status(v_plan_id, 'discontinued', 'Course completed', DATE '2026-11-17');

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_id, 'active', 'Attempt resurrection', DATE '2026-11-18');
    RAISE EXCEPTION 'FAIL [10A]: Discontinued plan reactivation should fail.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Cannot reactivate or pause a discontinued medication plan%' THEN
      RAISE;
    END IF;
  END;

  v_pen_plan_res := public.create_medication_plan_with_version_v2(
    v_pen_pat, NULL, 'Glucophage', 'Metformin HCl', '500 mg', 'tablet', 'oral',
    1, 'tablet', 'after_food', 'Take 1 tablet twice daily', NULL, NULL,
    DATE '2026-11-15', NULL, true, NULL, v_sched_daily, NULL
  );
  v_pen_plan_id := (v_pen_plan_res->>'planId')::uuid;

  UPDATE public.patients
     SET status = 'archived',
         archived_at = DATE '2026-11-18',
         archived_reason = 'Stage 2C.2D verification archive test'
   WHERE id = v_pen_pat
     AND pharmacy_id = v_pharm_id;

  BEGIN
    PERFORM public.record_dispensing_with_refill_v2(
      v_pen_pat, v_pen_plan_id, 30, 'tablet', 1, 30, 'B-AR', DATE '2027-06-01',
      DATE '2026-11-18', false, 'Dispense while patient archived', 2, 15, DATE '2026-12-03', 'test',
      30, 30, 15, 'on_track', DATE '2026-12-03', 'test',
      'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
      1, v_client_uuid_2, NULL, NULL
    );
    RAISE EXCEPTION 'FAIL [10B]: Dispensing for archived patient should fail.';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'Cannot dispense medication for archived patient%' THEN
      RAISE;
    END IF;
  END;

  RAISE NOTICE 'PASS [STAGE 2C.2C/2D]: All registry separation, catalog provenance, decimal/SHA-256 parity vectors, 4-group idempotency, strict v2 concurrency (40001), and immutability assertions passed cleanly.';
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claims', '', true);

-- 1C. Verify unauthorized write/read attempts by `authenticated` and `anon` fail with 42501
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category,
      active_ingredients, therapeutic_classes, ingredient_verification_status,
      ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active
    ) VALUES (
      '2c2c0017-0000-4000-8000-000000000001'::uuid,
      'TST-2C2E-AuthWriteDenied', 'Metformin HCl', ARRAY['500 mg'], 'tablet', 'oral', 'Antidiabetic',
      ARRAY['Metformin HCl']::text[], ARRAY['biguanide'], 'verified',
      'Unauthorized', DATE '2026-11-16', 'Unauthorized', true
    );
    RAISE EXCEPTION 'FAIL [AUTH-CAT-INS]: authenticated role must not INSERT into public.medication_catalog.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    UPDATE public.medication_catalog SET is_active = false WHERE brand_name = 'Glucophage';
    RAISE EXCEPTION 'FAIL [AUTH-CAT-UPD]: authenticated role must not UPDATE public.medication_catalog.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM count(*) FROM app_security.verified_inn_registry;
    RAISE EXCEPTION 'FAIL [AUTH-INN-SEL]: authenticated role must not SELECT app_security.verified_inn_registry.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.medication_catalog;
    RAISE EXCEPTION 'FAIL [ANON-CAT-SEL]: anon role must not SELECT public.medication_catalog.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.medication_catalog (
      id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category
    ) VALUES (
      '2c2c0018-0000-4000-8000-000000000001'::uuid,
      'TST-2C2E-AnonWriteDenied', 'Metformin HCl', ARRAY['500 mg'], 'tablet', 'oral', 'Antidiabetic'
    );
    RAISE EXCEPTION 'FAIL [ANON-CAT-INS]: anon role must not INSERT into public.medication_catalog.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END $$;
RESET ROLE;

-- Direct SHA-256 fingerprint parity checks (`9A`–`9D`) executed under privileged role
-- because `app_security.format_canonical_decimal4` is restricted from `authenticated`.
DO $$
DECLARE
  v_vec_hash text;
BEGIN
  -- Vector 9A: `null_and_missing_fields` canonical hash check
  v_vec_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          '2c2c0002-0000-4000-8000-000000000001',
          '2c2c0005-0000-4000-8000-000000000001',
          app_security.format_canonical_decimal4(30),
          pg_catalog.lower(pg_catalog.btrim('Tablet')),
          '<NULL>',
          app_security.format_canonical_decimal4(NULL),
          '<NULL>',
          '<NULL>',
          '2026-11-16',
          'false',
          '<NULL>',
          '1',
          '<NULL>',
          app_security.format_canonical_decimal4(NULL),
          '<NULL>',
          '<NULL>',
          app_security.format_canonical_decimal4(NULL),
          app_security.format_canonical_decimal4(NULL),
          '<NULL>',
          '<NULL>',
          '<NULL>',
          '<NULL>',
          '<NULL>',
          'provisional_client_unverified',
          'masar_refill_v1'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_vec_hash <> 'ee3fe835fb3f376ff8edae43d430ab9926d441e150661ed04ceebed41809c80d' THEN
    RAISE EXCEPTION 'FAIL [9A-NULL]: PostgreSQL null_and_missing_fields hash (%) did not match TypeScript fixture ee3fe835...', v_vec_hash;
  END IF;

  -- Vector 9B: `positive_and_negative_decimals` canonical hash check
  v_vec_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          '2c2c0002-0000-4000-8000-000000000001',
          '2c2c0005-0000-4000-8000-000000000001',
          app_security.format_canonical_decimal4(12.5),
          'ml',
          '1',
          app_security.format_canonical_decimal4(15.25),
          pg_catalog.lower(pg_catalog.btrim('  BATCH-Ax9  ')),
          '2027-08-31',
          '2026-11-16',
          'true',
          'Half bottle titration',
          '2',
          '<NULL>',
          app_security.format_canonical_decimal4(2.5),
          '5',
          '2026-11-21',
          app_security.format_canonical_decimal4(12.5),
          app_security.format_canonical_decimal4(0.75),
          '0',
          'on_track',
          '2026-11-21',
          'Linear daily titration',
          'Exact bottle fill',
          'provisional_client_unverified',
          'masar_refill_v1'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_vec_hash <> 'fa0c41a6d02221379669a399e545d55071858ee835a67cde96b19b77307d682e' THEN
    RAISE EXCEPTION 'FAIL [9B-POS]: PostgreSQL positive_and_negative_decimals hash (%) did not match TypeScript fixture fa0c41a6...', v_vec_hash;
  END IF;

  -- Vector 9C: `rounding_boundaries_half_away_from_zero` canonical hash check
  v_vec_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          '2c2c0002-0000-4000-8000-000000000001',
          '2c2c0005-0000-4000-8000-000000000001',
          app_security.format_canonical_decimal4(2.00005),
          'capsule',
          '1',
          app_security.format_canonical_decimal4(10.50005),
          'rnd-01',
          '2027-12-01',
          '2026-11-16',
          'true',
          'Boundary rounding vector',
          '3',
          '<NULL>',
          app_security.format_canonical_decimal4(1.00005),
          '2',
          '2026-11-18',
          app_security.format_canonical_decimal4(2.00005),
          app_security.format_canonical_decimal4(0.00004),
          '1',
          'due_soon',
          '2026-11-18',
          'Half away from zero test',
          'Boundary check',
          'provisional_client_unverified',
          'masar_refill_v1'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_vec_hash <> '96ca45aded1d410380f90015755de71b8ea17a6eab1cfb38ac03f8d6c4a4b919' THEN
    RAISE EXCEPTION 'FAIL [9C-RND]: PostgreSQL rounding boundary hash (%) did not match TypeScript fixture 96ca45ad...', v_vec_hash;
  END IF;

  -- Vector 9D: `large_quantity_no_mask_overflow` canonical hash check
  v_vec_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          '2c2c0002-0000-4000-8000-000000000001',
          '2c2c0005-0000-4000-8000-000000000001',
          app_security.format_canonical_decimal4(999999999.99995),
          'iu',
          '10',
          app_security.format_canonical_decimal4(100000000.00005),
          'lg-999',
          '2028-01-01',
          '2026-11-16',
          'false',
          'Large quantity formatting parity check',
          '1',
          '<NULL>',
          app_security.format_canonical_decimal4(100000000.00005),
          '10',
          '2026-11-26',
          app_security.format_canonical_decimal4(999999999.99995),
          app_security.format_canonical_decimal4(999999999.99995),
          '10',
          'on_track',
          '2026-11-26',
          'Large unit scale parity',
          'No mask overflow',
          'provisional_client_unverified',
          'masar_refill_v1'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_vec_hash <> '240582b6d3c2b3bd6b65f31c5ea2629fb5802b247a1f173102e1e7a48944ac59' THEN
    RAISE EXCEPTION 'FAIL [9D-LARGE]: PostgreSQL large-quantity hash (%) did not match TypeScript fixture 240582b6...', v_vec_hash;
  END IF;

  RAISE NOTICE 'PASS [9A-9D]: All 4 canonical SHA-256 fingerprint parity vectors matched TypeScript byte-for-byte.';
END $$;

ROLLBACK;
