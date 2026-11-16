-- =============================================================================
-- MASAR Care — Stage 2C.1C Two-Tenant Live PostgreSQL Isolation Test Specification
-- Target Database: PostgreSQL 17+ (Supabase Disposable Development Instance)
--
-- STATUS: DRAFT SPECIFICATION — REQUIRES EXPLICIT APPROVAL BEFORE EXECUTION
-- DO NOT EXECUTE AUTOMATICALLY AGAINST ANY LIVE OR DEV DATABASE.
--
-- Purpose:
--   When explicitly approved, execute inside a single `BEGIN; ... ROLLBACK;`
--   transaction after migrations 0001..0004 are installed to prove real
--   PostgreSQL Row-Level Security (RLS), column ACLs, composite foreign keys,
--   triggers, and SECURITY DEFINER RPC isolation across TWO simultaneous
--   fictional pharmacies (`Pharmacy A` and `Pharmacy B`), covering:
--     - Owner A (positive in A + negative against B + immutability + admin denial)
--     - Owner B (positive in B + negative against A + admin denial)
--     - Authorized Pharmacist A (positive in A + owner-only denial + negative against B)
--     - Authorized Pharmacist B (positive in B + owner-only denial + negative against A)
--     - Inactive Staff A (total denial)
--     - Unlinked Authenticated User (total denial)
--     - Anonymous Role (`anon` total denial)
--     - Activated Patient A vs Activated Patient B (symmetric cross-patient isolation)
--
-- Strict Transaction & Safety Guarantees:
--   - Single transaction: `BEGIN; ... ROLLBACK;`.
--   - Deterministic fictional UUIDs prefixed `2c10...` + pre-seed collision guard.
--   - Restores SQL role and JWT GUCs in normal flow and EXCEPTION blocks.
--   - Never modifies `bootstrap_state`, `DEV-TEST-001`, or any existing row.
--   - Never triggers Edge Functions, SMS, or WhatsApp delivery.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. PRE-SEED COLLISION GUARD & EXISTING DATA PROTECTION SNAPSHOT
-- =============================================================================
DO $$
DECLARE
  v_collision_count integer;
BEGIN
  SELECT (
    (SELECT count(*) FROM auth.users WHERE id IN (
      '2c10a001-0000-4000-8000-000000000001'::uuid,
      '2c10a002-0000-4000-8000-000000000001'::uuid,
      '2c10a003-0000-4000-8000-000000000001'::uuid,
      '2c10b001-0000-4000-8000-000000000001'::uuid,
      '2c10b002-0000-4000-8000-000000000001'::uuid,
      '2c10d001-0000-4000-8000-000000000001'::uuid,
      '2c10a101-0000-4000-8000-000000000001'::uuid,
      '2c10b101-0000-4000-8000-000000000001'::uuid
    ) OR email LIKE '%@masar-2c1.invalid')
    + (SELECT count(*) FROM public.pharmacies WHERE id IN (
      '2c10a000-0000-4000-8000-000000000001'::uuid,
      '2c10b000-0000-4000-8000-000000000001'::uuid
    ) OR license_number IN ('IQ-2C1-A', 'IQ-2C1-B'))
    + (SELECT count(*) FROM public.pharmacy_staff WHERE syndicate_license IN (
      'SYND-2C1-A1', 'SYND-2C1-A2', 'SYND-2C1-A3', 'SYND-2C1-B1', 'SYND-2C1-B2'
    ))
    + (SELECT count(*) FROM public.patients WHERE id IN (
      '2c10a201-0000-4000-8000-000000000001'::uuid,
      '2c10a202-0000-4000-8000-000000000001'::uuid,
      '2c10b201-0000-4000-8000-000000000001'::uuid,
      '2c10b202-0000-4000-8000-000000000001'::uuid
    ))
  )::integer INTO v_collision_count;

  IF v_collision_count <> 0 THEN
    RAISE EXCEPTION 'PRE-SEED COLLISION DETECTED: Found % conflicting 2c10 fixture identifiers. Aborting safely.', v_collision_count;
  END IF;
END $$;

-- =============================================================================
-- 0B. STATIC ACL, FORCED-RLS & RPC EXECUTE PRIVILEGE MATRIX VERIFICATION
--     Explicitly distinguishes PostgreSQL privilege denials (`42501` via
--     REVOKE/GRANT) from row-level RLS filtering (`ROW_COUNT = 0`).
-- =============================================================================
DO $$
DECLARE
  v_missing_rls integer;
  v_anon_privs  integer;
  v_v2_sig      text;
BEGIN
  -- 1. All 24 MASAR public tables must have RLS enabled AND forced
  SELECT count(*)::integer INTO v_missing_rls
  FROM (
    VALUES
      ('pharmacies'), ('pharmacy_staff'), ('patients'), ('patient_conditions'),
      ('patient_allergies'), ('medication_catalog'), ('patient_medication_plans'),
      ('regimen_versions'), ('medication_pause_periods'), ('scheduled_doses'),
      ('dose_events'), ('unscheduled_dose_reports'), ('dispensing_events'),
      ('refill_assessments'), ('lab_results'), ('follow_up_tasks'),
      ('follow_up_contact_logs'), ('consultation_threads'), ('consultation_messages'),
      ('patient_apk_invitations'), ('invitation_redemption_attempts'), ('audit_logs'),
      ('bootstrap_state'), ('staff_provisioning_requests')
  ) AS t(tbl)
  LEFT JOIN pg_catalog.pg_class c
    ON c.relname = t.tbl
   AND c.relnamespace = 'public'::regnamespace
  WHERE c.oid IS NULL OR c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE;

  IF v_missing_rls <> 0 THEN
    RAISE EXCEPTION 'ACL/RLS MATRIX FAILURE: % MASAR public tables missing ENABLE/FORCE ROW LEVEL SECURITY.', v_missing_rls;
  END IF;

  -- 2. anon must have ZERO table privileges across all 24 MASAR tables
  SELECT count(*)::integer INTO v_anon_privs
  FROM (
    VALUES
      ('public.pharmacies'), ('public.pharmacy_staff'), ('public.patients'),
      ('public.patient_conditions'), ('public.patient_allergies'), ('public.medication_catalog'),
      ('public.patient_medication_plans'), ('public.regimen_versions'), ('public.medication_pause_periods'),
      ('public.scheduled_doses'), ('public.dose_events'), ('public.unscheduled_dose_reports'),
      ('public.dispensing_events'), ('public.refill_assessments'), ('public.lab_results'),
      ('public.follow_up_tasks'), ('public.follow_up_contact_logs'), ('public.consultation_threads'),
      ('public.consultation_messages'), ('public.patient_apk_invitations'),
      ('public.invitation_redemption_attempts'), ('public.audit_logs'),
      ('public.bootstrap_state'), ('public.staff_provisioning_requests')
  ) AS t(fqn)
  WHERE pg_catalog.has_table_privilege('anon', t.fqn, 'SELECT')
     OR pg_catalog.has_table_privilege('anon', t.fqn, 'INSERT')
     OR pg_catalog.has_table_privilege('anon', t.fqn, 'UPDATE')
     OR pg_catalog.has_table_privilege('anon', t.fqn, 'DELETE');

  IF v_anon_privs <> 0 THEN
    RAISE EXCEPTION 'ACL MATRIX FAILURE: anon role unexpectedly holds privileges on % MASAR tables.', v_anon_privs;
  END IF;

  -- 3. Confirmed live `authenticated` table-level SELECT / UPDATE matrix
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.pharmacies', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.pharmacies', 'UPDATE')
  THEN
    RAISE EXCEPTION 'ACL MATRIX MISMATCH on public.pharmacies: expected SELECT=GRANTED, table UPDATE=REVOKED.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.pharmacy_staff', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.pharmacy_staff', 'UPDATE')
  THEN
    RAISE EXCEPTION 'ACL MATRIX MISMATCH on public.pharmacy_staff: expected SELECT=GRANTED, table UPDATE=REVOKED.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.patients', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.patients', 'UPDATE')
     OR pg_catalog.has_column_privilege('authenticated', 'public.patients', 'clinical_notes', 'UPDATE')
  THEN
    RAISE EXCEPTION 'ACL MATRIX MISMATCH on public.patients: expected SELECT=GRANTED, table/clinical_notes UPDATE=REVOKED.';
  END IF;

  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.follow_up_tasks', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('authenticated', 'public.follow_up_tasks', 'UPDATE')
  THEN
    RAISE EXCEPTION 'ACL MATRIX MISMATCH on public.follow_up_tasks: expected SELECT=GRANTED, UPDATE=GRANTED.';
  END IF;

  IF pg_catalog.has_table_privilege('authenticated', 'public.bootstrap_state', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.staff_provisioning_requests', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.audit_logs', 'DELETE')
  THEN
    RAISE EXCEPTION 'ACL MATRIX MISMATCH on admin/immutable tables for authenticated.';
  END IF;

  -- 3B. Authenticated has narrow column-level UPDATE grants even though table UPDATE is revoked.
  IF NOT pg_catalog.has_column_privilege('authenticated', 'public.pharmacies', 'phone', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.pharmacies', 'name_en', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.pharmacy_staff', 'phone', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.pharmacy_staff', 'is_active', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.patients', 'status', 'UPDATE')
  THEN
    RAISE EXCEPTION 'COLUMN ACL MATRIX FAILURE: expected narrow authenticated UPDATE grants missing.';
  END IF;

  -- 4. RPC EXECUTE matrix: anon denied ALL 10 clinical/patient RPCs (and service_role RPCs); authenticated granted CRM/patient RPCs only
  IF pg_catalog.has_function_privilege('anon', 'public.create_patient_with_clinical_tags(text,text,text,text,text,date,text,text,text,date,jsonb,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.update_patient_with_clinical_tags(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.create_medication_plan_with_version(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.update_medication_plan_version(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.change_medication_plan_status(uuid,text,text,date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.record_dispensing_with_refill(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.send_consultation_reply(uuid,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.issue_patient_apk_invitation(uuid,text,text,integer,boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.revoke_patient_apk_invitation(uuid,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.confirm_scheduled_dose(uuid,text,uuid,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.request_invitation_sms_otp(text,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.redeem_patient_apk_invitation(text,text,text,uuid,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.finalize_first_owner_bootstrap(uuid,uuid,text,text,text,text,text,text,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.claim_staff_provisioning_request(uuid,text,uuid,text,text,text,integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.request_invitation_sms_otp(text,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.redeem_patient_apk_invitation(text,text,text,uuid,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.finalize_first_owner_bootstrap(uuid,uuid,text,text,text,text,text,text,text,text,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.claim_staff_provisioning_request(uuid,text,uuid,text,text,text,integer)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'RPC EXECUTE MATRIX MISMATCH: unauthorized EXECUTE grant detected.';
  END IF;

  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.create_patient_with_clinical_tags(text,text,text,text,text,date,text,text,text,date,jsonb,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.update_patient_with_clinical_tags(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.create_medication_plan_with_version(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.update_medication_plan_version(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.change_medication_plan_status(uuid,text,text,date)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.record_dispensing_with_refill(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.send_consultation_reply(uuid,text,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.issue_patient_apk_invitation(uuid,text,text,integer,boolean)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.revoke_patient_apk_invitation(uuid,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.confirm_scheduled_dose(uuid,text,uuid,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'RPC EXECUTE MATRIX MISMATCH: authenticated missing expected CRM/patient RPC EXECUTE privilege.';
  END IF;

  -- 4B. Conditional Stage 2C.2B capability & _v2 RPC EXECUTE matrix (verified whenever installed)
  FOREACH v_v2_sig IN ARRAY ARRAY[
    'public.get_clinical_safety_capabilities()',
    'public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)',
    'public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)',
    'public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_v2_sig) IS NOT NULL THEN
      IF pg_catalog.has_function_privilege('anon', v_v2_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'STAGE 2C.2B RPC EXECUTE MATRIX FAILURE: anon unexpectedly holds EXECUTE on %.', v_v2_sig;
      END IF;
      IF NOT pg_catalog.has_function_privilege('authenticated', v_v2_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'STAGE 2C.2B RPC EXECUTE MATRIX FAILURE: authenticated missing EXECUTE on %.', v_v2_sig;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS [0B]: Forced RLS (24 tables), table-level ACLs, and RPC EXECUTE privileges match Stage 2C.1C/2C.2B specification.';
END $$;

-- =============================================================================
-- 1. SEED TWO ISOLATED FICTIONAL TENANTS (PHARMACY A & PHARMACY B)
-- =============================================================================
DO $$
DECLARE
  v_pharm_a          constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_pharm_b          constant uuid := '2c10b000-0000-4000-8000-000000000001';

  v_owner_a          constant uuid := '2c10a001-0000-4000-8000-000000000001';
  v_staff_a          constant uuid := '2c10a002-0000-4000-8000-000000000001';
  v_inactive_staff_a constant uuid := '2c10a003-0000-4000-8000-000000000001';

  v_owner_b          constant uuid := '2c10b001-0000-4000-8000-000000000001';
  v_staff_b          constant uuid := '2c10b002-0000-4000-8000-000000000001';

  v_unlinked_user    constant uuid := '2c10d001-0000-4000-8000-000000000001';
  v_patient_a_auth   constant uuid := '2c10a101-0000-4000-8000-000000000001';
  v_patient_b_auth   constant uuid := '2c10b101-0000-4000-8000-000000000001';

  v_patient_a1       constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_patient_a2       constant uuid := '2c10a202-0000-4000-8000-000000000001';
  v_patient_b1       constant uuid := '2c10b201-0000-4000-8000-000000000001';
  v_patient_b2       constant uuid := '2c10b202-0000-4000-8000-000000000001';

  v_plan_a1          constant uuid := '2c10a301-0000-4000-8000-000000000001';
  v_plan_b1          constant uuid := '2c10b301-0000-4000-8000-000000000001';

  v_sched_a1         constant uuid := '2c10a401-0000-4000-8000-000000000001';
  v_sched_b1         constant uuid := '2c10b401-0000-4000-8000-000000000001';

  v_disp_a1          constant uuid := '2c10a451-0000-4000-8000-000000000001';
  v_disp_b1          constant uuid := '2c10b451-0000-4000-8000-000000000001';

  v_followup_a1      constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_followup_b1      constant uuid := '2c10b501-0000-4000-8000-000000000001';

  v_thread_a1        constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_thread_b1        constant uuid := '2c10b601-0000-4000-8000-000000000001';

  v_inv_a2           constant uuid := '2c10a701-0000-4000-8000-000000000001';
  v_inv_b2           constant uuid := '2c10b701-0000-4000-8000-000000000001';

  v_sched_json_a     constant jsonb := '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_sched_json_b     constant jsonb := '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_pin_hash         text;
  v_token_hash_a     text;
  v_token_hash_b     text;
BEGIN
  v_pin_hash := extensions.crypt('246810', extensions.gen_salt('bf', 4));
  v_token_hash_a := encode(extensions.digest('masar-2c10-invite-token-a2', 'sha256'), 'hex');
  v_token_hash_b := encode(extensions.digest('masar-2c10-invite-token-b2', 'sha256'), 'hex');

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_owner_a,          '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-owner-a@masar-2c1.invalid',    extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_staff_a,          '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-staff-a@masar-2c1.invalid',    extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_inactive_staff_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-inactive-a@masar-2c1.invalid', extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_owner_b,          '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-owner-b@masar-2c1.invalid',    extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_staff_b,          '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-staff-b@masar-2c1.invalid',    extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_unlinked_user,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-unlinked@masar-2c1.invalid',   extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_patient_a_auth,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-patient-a@masar-2c1.invalid',  extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_patient_b_auth,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sec-patient-b@masar-2c1.invalid',  extensions.crypt('TestPass!2026', extensions.gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO public.pharmacies (id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active)
  VALUES
    (v_pharm_a, 'صيدلية الاختبار الأمني أ', 'MASAR Security Test A', 'بغداد', 'بغداد', 'IQ-2C1-A', '07709001001', 'Asia/Baghdad', true),
    (v_pharm_b, 'صيدلية الاختبار الأمني ب', 'MASAR Security Test B', 'أربيل', 'أربيل', 'IQ-2C1-B', '07809002001', 'Asia/Baghdad', true);

  INSERT INTO public.pharmacy_staff (id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id)
  VALUES
    (v_owner_a,          v_pharm_a, 'د. مالك الاختبار أ',   'pharmacy_owner',        'SYND-2C1-A1', '07709001002', true,  v_owner_a),
    (v_staff_a,          v_pharm_a, 'د. صيدلي الاختبار أ', 'authorized_pharmacist', 'SYND-2C1-A2', '07709001003', true,  v_owner_a),
    (v_inactive_staff_a, v_pharm_a, 'د. موظف متوقف أ',     'authorized_pharmacist', 'SYND-2C1-A3', '07709001004', false, v_owner_a),
    (v_owner_b,          v_pharm_b, 'د. مالك الاختبار ب',  'pharmacy_owner',        'SYND-2C1-B1', '07809002002', true,  v_owner_b),
    (v_staff_b,          v_pharm_b, 'د. صيدلي الاختبار ب', 'authorized_pharmacist', 'SYND-2C1-B2', '07809002003', true,  v_owner_b);

  INSERT INTO public.patients (
    id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    verified_account_phone, date_of_birth, sex, contact_preference,
    clinical_notes, registration_date, status, auth_user_id, auth_linked_at, created_by_staff_id
  )
  VALUES
    (v_patient_a1, v_pharm_a, '2C1-A-001', 'مراجع اختبار أ١', '07709101001', 'self', '07709101001', '1975-01-01', 'male',   'whatsapp',   'Secret A1', '2026-02-01', 'active', v_patient_a_auth, now(), v_owner_a),
    (v_patient_a2, v_pharm_a, '2C1-A-002', 'مراجع اختبار أ٢', '07709101002', 'self', NULL,          '1979-03-15', 'female', 'whatsapp',   'Secret A2', '2026-02-01', 'active', NULL,             NULL,  v_owner_a),
    (v_patient_b1, v_pharm_b, '2C1-B-001', 'مراجع اختبار ب١', '07809201001', 'self', '07809201001', '1980-02-02', 'female', 'phone_call', 'Secret B1', '2026-02-02', 'active', v_patient_b_auth, now(), v_owner_b),
    (v_patient_b2, v_pharm_b, '2C1-B-002', 'مراجع اختبار ب٢', '07809201002', 'self', NULL,          '1982-06-20', 'male',   'phone_call', 'Secret B2', '2026-02-02', 'active', NULL,             NULL,  v_owner_b);

  INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name, status)
  VALUES
    (v_pharm_a, v_patient_a1, 'Type 2 Diabetes', 'active'),
    (v_pharm_b, v_patient_b1, 'Essential Hypertension', 'active');

  INSERT INTO public.patient_allergies (pharmacy_id, patient_id, substance, severity, reaction, status)
  VALUES
    (v_pharm_a, v_patient_a1, 'Penicillin-A', 'severe',   'Anaphylaxis', 'active'),
    (v_pharm_b, v_patient_b1, 'Sulfa-B',      'moderate', 'Skin rash',   'active');

  INSERT INTO public.patient_medication_plans (
    id, pharmacy_id, patient_id, brand_name, generic_name, strength, dosage_form, route,
    dose_amount, dose_unit, food_relation, verified_instructions, start_date, is_ongoing,
    status, current_version_number, schedule, created_by_staff_id
  )
  VALUES
    (v_plan_a1, v_pharm_a, v_patient_a1, 'Glucophage A', 'Metformin',  '500 mg', 'tablet', 'oral', 1, 'tablet', 'with_food', 'Take 1 tablet daily with breakfast', '2026-02-01', true, 'active', 1, v_sched_json_a, v_owner_a),
    (v_plan_b1, v_pharm_b, v_patient_b1, 'Norvasc B',    'Amlodipine', '5 mg',   'tablet', 'oral', 1, 'tablet', 'any_time',  'Take 1 tablet daily in the evening', '2026-02-02', true, 'active', 1, v_sched_json_b, v_owner_b);

  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, dose_amount, dose_unit,
    food_relation, verified_instructions, schedule, changed_by_staff_id, changed_by_staff_name, change_reason
  )
  VALUES
    (v_pharm_a, v_plan_a1, 1, '2026-02-01', 1, 'tablet', 'with_food', 'Take 1 tablet daily with breakfast', v_sched_json_a, v_owner_a, 'د. مالك الاختبار أ', 'Initial verified plan A'),
    (v_pharm_b, v_plan_b1, 1, '2026-02-02', 1, 'tablet', 'any_time',  'Take 1 tablet daily in the evening', v_sched_json_b, v_owner_b, 'د. مالك الاختبار ب', 'Initial verified plan B');

  INSERT INTO public.medication_pause_periods (
    pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, recorded_by_staff_id
  )
  VALUES
    (v_pharm_a, v_plan_a1, '2026-02-10', '2026-02-11', 'Fasting procedure A', v_owner_a),
    (v_pharm_b, v_plan_b1, '2026-02-12', '2026-02-13', 'Monitoring hold B',   v_owner_b);

  INSERT INTO public.scheduled_doses (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
  )
  VALUES
    (v_sched_a1, v_pharm_a, v_patient_a1, v_plan_a1, 1, '2026-02-20', '08:00', 1, 'tablet'),
    (v_sched_b1, v_pharm_b, v_patient_b1, v_plan_b1, 1, '2026-02-20', '20:00', 1, 'tablet');

  INSERT INTO public.unscheduled_dose_reports (
    pharmacy_id, patient_id, medication_plan_id, report_type,
    reported_dose_amount, dose_unit, patient_reported_at, client_event_uuid, is_verified_schedule
  )
  VALUES
    (v_pharm_a, v_patient_a1, v_plan_a1, 'unscheduled_extra', 1, 'tablet', '2026-02-18T12:00:00Z', '2c10a421-0000-4000-8000-000000000001', false),
    (v_pharm_b, v_patient_b1, v_plan_b1, 'unscheduled_extra', 1, 'tablet', '2026-02-18T13:00:00Z', '2c10b421-0000-4000-8000-000000000001', false);

  INSERT INTO public.dispensing_events (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    dispensed_quantity, quantity_unit, dispensing_date, dispensed_by_staff_id,
    dispensed_by_staff_name, estimated_daily_consumption, estimated_supply_days,
    estimated_supply_end_date, forecast_assumptions, is_partial_fill,
    calculation_source, verification_status, algorithm_version, calculation_inputs
  )
  VALUES
    (v_disp_a1, v_pharm_a, v_patient_a1, v_plan_a1, 1, 30, 'tablet', '2026-02-01', v_owner_a, 'د. مالك الاختبار أ', 1, 30, '2026-03-03', 'Daily 1 tablet', false, 'provisional_client_unverified', 'provisional_unverified', 'masar_refill_v1', '{}'::jsonb),
    (v_disp_b1, v_pharm_b, v_patient_b1, v_plan_b1, 1, 30, 'tablet', '2026-02-02', v_owner_b, 'د. مالك الاختبار ب', 1, 30, '2026-03-04', 'Daily 1 tablet', false, 'provisional_client_unverified', 'provisional_unverified', 'masar_refill_v1', '{}'::jsonb);

  INSERT INTO public.refill_assessments (
    pharmacy_id, patient_id, medication_plan_id, last_dispensing_event_id,
    last_dispensed_date, last_dispensed_quantity, total_dispensed_analyzed, quantity_unit,
    estimated_daily_consumption, estimated_remaining_units, estimated_days_remaining,
    estimated_supply_end_date, refill_status, uncertainty_note,
    calculation_source, verification_status, algorithm_version
  )
  VALUES
    (v_pharm_a, v_patient_a1, v_plan_a1, v_disp_a1, '2026-02-01', 30, 30, 'tablet', 1, 15, 15, '2026-03-03', 'on_track', 'Provisional estimate A', 'provisional_client_unverified', 'provisional_unverified', 'masar_refill_v1'),
    (v_pharm_b, v_patient_b1, v_plan_b1, v_disp_b1, '2026-02-02', 30, 30, 'tablet', 1, 5,  5,  '2026-03-04', 'due_soon', 'Provisional estimate B', 'provisional_client_unverified', 'provisional_unverified', 'masar_refill_v1');

  INSERT INTO public.lab_results (
    pharmacy_id, patient_id, test_name, value, unit, reference_range, is_abnormal,
    test_date, recorded_by_staff_id, recorded_by_staff_name
  )
  VALUES
    (v_pharm_a, v_patient_a1, 'HbA1c-A',      '7.2', '%',     '< 7.0',    true,  '2026-02-01', v_owner_a, 'د. مالك الاختبار أ'),
    (v_pharm_b, v_patient_b1, 'Creatinine-B', '1.1', 'mg/dL', '0.7-1.3',  false, '2026-02-02', v_owner_b, 'د. مالك الاختبار ب');

  INSERT INTO public.follow_up_tasks (
    id, pharmacy_id, patient_id, related_medication_plan_id, type, due_date, status,
    notes, assigned_staff_id, assigned_staff_name
  )
  VALUES
    (v_followup_a1, v_pharm_a, v_patient_a1, v_plan_a1, 'refill',    '2026-02-25', 'pending', 'Task A', v_owner_a, 'د. مالك الاختبار أ'),
    (v_followup_b1, v_pharm_b, v_patient_b1, v_plan_b1, 'adherence', '2026-02-26', 'pending', 'Task B', v_owner_b, 'د. مالك الاختبار ب');

  INSERT INTO public.follow_up_contact_logs (
    pharmacy_id, follow_up_task_id, channel, outcome, summary, staff_id, staff_name
  )
  VALUES
    (v_pharm_a, v_followup_a1, 'whatsapp_manual', 'answered',  'Contact Log A', v_owner_a, 'د. مالك الاختبار أ'),
    (v_pharm_b, v_followup_b1, 'phone_call',      'no_answer', 'Contact Log B', v_owner_b, 'د. مالك الاختبار ب');

  INSERT INTO public.consultation_threads (id, pharmacy_id, patient_id, subject, status)
  VALUES
    (v_thread_a1, v_pharm_a, v_patient_a1, 'استفسار دوائي أ', 'open'),
    (v_thread_b1, v_pharm_b, v_patient_b1, 'استفسار دوائي ب', 'open');

  INSERT INTO public.consultation_messages (
    pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
  )
  VALUES
    (v_pharm_a, v_thread_a1, 'patient', NULL, 'مراجع اختبار أ١', 'رسالة المراجع أ', false),
    (v_pharm_b, v_thread_b1, 'patient', NULL, 'مراجع اختبار ب١', 'رسالة المراجع ب', false);

  INSERT INTO public.patient_apk_invitations (
    id, pharmacy_id, patient_id, invitation_purpose, target_phone, token_hash, pharmacist_pin_hash,
    status, expires_at, issued_by_staff_id, issued_by_staff_name
  )
  VALUES
    (v_inv_a2, v_pharm_a, v_patient_a2, 'initial_activation', '07709101002', v_token_hash_a, v_pin_hash, 'pending', now() + interval '7 days', v_owner_a, 'د. مالك الاختبار أ'),
    (v_inv_b2, v_pharm_b, v_patient_b2, 'initial_activation', '07809201002', v_token_hash_b, v_pin_hash, 'pending', now() + interval '7 days', v_owner_b, 'د. مالك الاختبار ب');

  INSERT INTO public.invitation_redemption_attempts (
    invitation_id, pharmacy_id, patient_id, network_ip_hmac, phase, outcome, failure_reason
  )
  VALUES
    (v_inv_a2, v_pharm_a, v_patient_a2, 'ip-hmac-a-2c10', 'redemption', 'FAILED', 'TEST_A'),
    (v_inv_b2, v_pharm_b, v_patient_b2, 'ip-hmac-b-2c10', 'redemption', 'FAILED', 'TEST_B');

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role, action, entity_type, entity_id, summary_ar, summary_en
  )
  VALUES
    (v_pharm_a, v_owner_a, 'د. مالك الاختبار أ', 'pharmacy_owner', 'PATIENT_REGISTERED', 'patient', v_patient_a1, 'سجل أ', 'Audit A'),
    (v_pharm_b, v_owner_b, 'د. مالك الاختبار ب', 'pharmacy_owner', 'PATIENT_REGISTERED', 'patient', v_patient_b1, 'سجل ب', 'Audit B');

  RAISE NOTICE 'PASS [1]: Seeded two isolated fictional pharmacies (A & B) with valid constraints.';
END $$;

-- =============================================================================
-- 2. OWNER A SESSION: POSITIVE PHARMACY A + FULL NEGATIVE AGAINST PHARMACY B
-- =============================================================================
DO $$
DECLARE
  v_orig_user  text := current_user;
  v_pharm_a    constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_pharm_b    constant uuid := '2c10b000-0000-4000-8000-000000000001';
  v_owner_a    constant uuid := '2c10a001-0000-4000-8000-000000000001';
  v_staff_a    constant uuid := '2c10a002-0000-4000-8000-000000000001';
  v_staff_b    constant uuid := '2c10b002-0000-4000-8000-000000000001';
  v_patient_a1 constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_patient_a2 constant uuid := '2c10a202-0000-4000-8000-000000000001';
  v_patient_b1 constant uuid := '2c10b201-0000-4000-8000-000000000001';
  v_patient_b2 constant uuid := '2c10b202-0000-4000-8000-000000000001';
  v_plan_a1    constant uuid := '2c10a301-0000-4000-8000-000000000001';
  v_plan_b1    constant uuid := '2c10b301-0000-4000-8000-000000000001';
  v_followup_a1 constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_followup_b1 constant uuid := '2c10b501-0000-4000-8000-000000000001';
  v_thread_a1  constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_thread_b1  constant uuid := '2c10b601-0000-4000-8000-000000000001';
  v_sched_a    constant jsonb := '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_cnt        integer;
  v_res        jsonb;
  v_new_pat_id uuid;
  v_new_plan_id uuid;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner_a::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_owner_a::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Verify strict SQL auth context (never privileged)
  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_owner_a THEN
    RAISE EXCEPTION 'Auth context check failed for Owner A: role=% uid=%', current_user, auth.uid();
  END IF;

  -- 2a. POSITIVE: Owner A sees own Pharmacy A records across tenant tables
  SELECT count(*)::integer INTO v_cnt FROM public.pharmacies WHERE id = v_pharm_a;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A positive read failed on pharmacies (cnt=%)', v_cnt; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.pharmacy_staff WHERE pharmacy_id = v_pharm_a;
  IF v_cnt <> 3 THEN RAISE EXCEPTION 'Owner A positive read failed on pharmacy_staff (cnt=%)', v_cnt; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE pharmacy_id = v_pharm_a;
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'Owner A positive read failed on patients (cnt=%)', v_cnt; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.invitation_redemption_attempts WHERE pharmacy_id = v_pharm_a;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A positive read failed on invitation_redemption_attempts (cnt=%)', v_cnt; END IF;

  -- Positive direct UPDATE on ACL-granted table (`public.follow_up_tasks`) succeeds with ROW_COUNT = 1
  UPDATE public.follow_up_tasks SET notes = 'Task A updated by Owner A' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A positive update on own follow_up_tasks failed (rows=%)', v_cnt; END IF;

  -- Owner A column-privileged UPDATEs succeed; unauthorized clinical_notes UPDATE still denied
  UPDATE public.pharmacies SET phone = '07709001099' WHERE id = v_pharm_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A must update own pharmacy phone via column grant (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacy_staff SET phone = '07709001088' WHERE id = v_staff_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A must update same-pharmacy staff phone via column grant (affected=%)', v_cnt; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Direct bypass A1' WHERE id = v_patient_a1;
    RAISE EXCEPTION 'Owner A direct UPDATE on public.patients clinical_notes unexpectedly succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  v_res := public.create_patient_with_clinical_tags(
    '2C1-A-003', 'مراجع أ٣', '07709101003', 'self', NULL, '1990-01-01', 'male', 'whatsapp',
    'New A', '2026-02-20', '["Asthma"]'::jsonb, '[{"substance":"Aspirin","severity":"moderate"}]'::jsonb
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A create_patient_with_clinical_tags failed: %', v_res;
  END IF;
  v_new_pat_id := (v_res->>'patientId')::uuid;

  v_res := public.create_medication_plan_with_version(
    v_new_pat_id, NULL, 'Ventolin', 'Salbutamol', '100 mcg', 'inhaler', 'inhalation',
    1, 'puff', 'any_time', 'Use 1 puff daily as prescribed', NULL, NULL,
    '2026-02-20', NULL, true, NULL, v_sched_a
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A create_medication_plan_with_version failed: %', v_res;
  END IF;
  v_new_plan_id := (v_res->>'planId')::uuid;

  v_res := public.update_medication_plan_version(
    v_new_plan_id, 'Ventolin', 'Salbutamol', '100 mcg', 'inhaler', 'inhalation',
    2, 'puff', 'any_time', 'Use 2 puffs daily as prescribed', NULL, NULL,
    '2026-02-20', NULL, true, NULL, v_sched_a, 'Owner A verified regimen adjustment', '2026-02-20'
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A update_medication_plan_version failed: %', v_res;
  END IF;

  v_res := public.record_dispensing_with_refill(
    v_patient_a1, v_plan_a1, 30, 'tablet', 1, 30, 'B-A2', '2027-12-01', '2026-02-20', false, 'Refill A',
    1, 30, '2026-03-22', 'Daily 1 tablet', 60, 30, 30, 'on_track', '2026-03-22', 'Estimated'
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A record_dispensing_with_refill failed: %', v_res;
  END IF;

  v_res := public.send_consultation_reply(v_thread_a1, 'رد موثق من المالك أ', 'follow_up');
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A send_consultation_reply failed: %', v_res;
  END IF;

  -- Positive revoke & re-issue on unactivated Patient A2 (DB-only inside ROLLBACK; no APK activation or SMS)
  v_res := public.revoke_patient_apk_invitation(v_patient_a2, 'Owner A rotation test');
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A revoke_patient_apk_invitation failed: %', v_res;
  END IF;
  v_res := public.issue_patient_apk_invitation(v_patient_a2, 'initial_activation', NULL, 72, false);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner A issue_patient_apk_invitation failed: %', v_res;
  END IF;

  -- 2b. NEGATIVE: Owner A reads ZERO rows from Pharmacy B across ALL tenant tables
  SELECT (
    (SELECT count(*) FROM public.pharmacies WHERE id = v_pharm_b)
    + (SELECT count(*) FROM public.pharmacy_staff WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.patients WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.patient_conditions WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.patient_allergies WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.patient_medication_plans WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.regimen_versions WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.medication_pause_periods WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.scheduled_doses WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.dose_events WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.unscheduled_dose_reports WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.dispensing_events WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.refill_assessments WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.lab_results WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.follow_up_tasks WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.follow_up_contact_logs WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.consultation_threads WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.consultation_messages WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.patient_apk_invitations WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.invitation_redemption_attempts WHERE pharmacy_id = v_pharm_b)
    + (SELECT count(*) FROM public.audit_logs WHERE pharmacy_id = v_pharm_b)
  )::integer INTO v_cnt;

  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'ISOLATION BREACH: Owner A saw % Pharmacy B rows across tenant tables.', v_cnt;
  END IF;

  -- Admin tables must deny SELECT with 42501
  BEGIN
    PERFORM 1 FROM public.bootstrap_state LIMIT 1;
    RAISE EXCEPTION 'Owner A unexpectedly accessed bootstrap_state.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM 1 FROM public.staff_provisioning_requests LIMIT 1;
    RAISE EXCEPTION 'Owner A unexpectedly accessed staff_provisioning_requests.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- 2c. NEGATIVE: Distinguish column-granted UPDATE RLS filtering (ROW_COUNT = 0) from truly revoked-column ACL denial (42501)
  UPDATE public.pharmacy_staff SET is_active = false WHERE id = v_staff_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner A must not modify Pharmacy B staff (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacies SET phone = '07700000000' WHERE id = v_pharm_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner A must not modify Pharmacy B phone (affected=%)', v_cnt; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Cross-tenant tamper' WHERE id = v_patient_b1;
    RAISE EXCEPTION 'Owner A direct UPDATE on Pharmacy B patients unexpectedly succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    UPDATE public.patient_medication_plans SET brand_name = 'Tamper' WHERE id = v_plan_b1;
    RAISE EXCEPTION 'Owner A direct UPDATE on Pharmacy B patient_medication_plans unexpectedly succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- `follow_up_tasks` has UPDATE granted to authenticated -> RLS USING filters out Pharmacy B -> 0 rows
  UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_b1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner A modified Pharmacy B follow-up (cnt=%).', v_cnt; END IF;

  -- 2d. NEGATIVE: Manipulated pharmacy_id INSERT -> 42501; composite FK probe -> 23503
  BEGIN
    INSERT INTO public.lab_results (
      pharmacy_id, patient_id, test_name, value, unit, reference_range, is_abnormal, test_date, recorded_by_staff_id, recorded_by_staff_name
    ) VALUES (
      v_pharm_b, v_patient_b1, 'Cross-Tenant Lab', '1', '%', '<5', false, '2026-02-20', v_owner_a, 'Owner A'
    );
    RAISE EXCEPTION 'Owner A inserted into Pharmacy B lab_results.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    INSERT INTO public.lab_results (
      pharmacy_id, patient_id, test_name, value, unit, reference_range, is_abnormal, test_date, recorded_by_staff_id, recorded_by_staff_name
    ) VALUES (
      v_pharm_a, v_patient_b1, 'Composite FK Probe', '1', '%', '<5', false, '2026-02-20', v_owner_a, 'Owner A'
    );
    RAISE EXCEPTION 'Owner A linked Pharmacy B patient under Pharmacy A lab_results.';
  EXCEPTION WHEN SQLSTATE '23503' THEN NULL; END;

  -- 2e. NEGATIVE: All cross-tenant RPCs targeting Pharmacy B MUST raise 42501 (or reject)
  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_b1, '{"clinical_notes":"tamper"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Owner A updated Pharmacy B patient via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.create_medication_plan_with_version(
      v_patient_b1, NULL, 'X', 'Y', '10mg', 'tablet', 'oral', 1, 'tablet', 'any_time',
      'Cross-tenant plan', NULL, NULL, '2026-02-20', NULL, true, NULL, v_sched_a
    );
    RAISE EXCEPTION 'Owner A created plan for Pharmacy B patient via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.update_medication_plan_version(
      v_plan_b1, 'X', 'Y', '10mg', 'tablet', 'oral', 1, 'tablet', 'any_time',
      'Cross-tenant update', NULL, NULL, '2026-02-02', NULL, true, NULL, v_sched_a,
      'Tamper reason', '2026-02-20'
    );
    RAISE EXCEPTION 'Owner A updated Pharmacy B medication plan version via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_b1, 'paused', 'Cross-tenant pause', '2026-02-20');
    RAISE EXCEPTION 'Owner A paused Pharmacy B medication plan via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.record_dispensing_with_refill(
      v_patient_b1, v_plan_b1, 10, 'tablet', NULL, NULL, NULL, NULL, '2026-02-20', false, NULL,
      1, 10, '2026-03-02', 'Tamper', 40, 10, 10, 'on_track', '2026-03-02', 'Tamper'
    );
    RAISE EXCEPTION 'Owner A recorded dispensing for Pharmacy B plan via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  IF pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.create_medication_plan_with_version_v2($1, NULL, ''X'', ''Y'', ''10mg'', ''tablet'', ''oral'', 1, ''tablet'', ''any_time'', ''Cross-tenant v2'', NULL, NULL, ''2026-02-20'', NULL, true, NULL, $2, NULL)'
        USING v_patient_b1, v_sched_a;
      RAISE EXCEPTION 'Owner A created plan for Pharmacy B patient via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  IF pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.update_medication_plan_version_v2($1, ''X'', ''Y'', ''10mg'', ''tablet'', ''oral'', 1, ''tablet'', ''any_time'', ''Cross-tenant v2'', NULL, NULL, ''2026-02-02'', NULL, true, NULL, $2, ''Tamper reason'', ''2026-02-20'', 1, NULL)'
        USING v_plan_b1, v_sched_a;
      RAISE EXCEPTION 'Owner A updated Pharmacy B medication plan via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  IF pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.record_dispensing_with_refill_v2($1, $2, 10, ''tablet'', NULL, NULL, NULL, NULL, ''2026-02-20'', false, NULL, 1, 10, ''2026-03-02'', ''Tamper'', 40, 10, 10, ''on_track'', ''2026-03-02'', ''Tamper'', ''provisional_client_unverified'', ''masar_refill_v1'', NULL, 1, $3, ''hash'', NULL)'
        USING v_patient_b1, v_plan_b1, '2c10a999-0000-4000-8000-000000000001'::uuid;
      RAISE EXCEPTION 'Owner A recorded dispensing for Pharmacy B plan via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  BEGIN
    PERFORM public.send_consultation_reply(v_thread_b1, 'Cross-tenant reply', NULL);
    RAISE EXCEPTION 'Owner A replied to Pharmacy B thread via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.revoke_patient_apk_invitation(v_patient_b2, 'Cross-tenant revoke');
    RAISE EXCEPTION 'Owner A revoked Pharmacy B invitation via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  v_res := public.issue_patient_apk_invitation(v_patient_b2, 'initial_activation', NULL, 72, false);
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'PATIENT_NOT_FOUND_OR_CROSS_TENANT'
  THEN
    RAISE EXCEPTION 'Owner A expected PATIENT_NOT_FOUND_OR_CROSS_TENANT for Pharmacy B patient, got %', v_res;
  END IF;

  -- Immutability: audit_logs UPDATE/DELETE denied (42501)
  BEGIN
    UPDATE public.audit_logs SET summary_en = 'Tampered Audit A' WHERE pharmacy_id = v_pharm_a;
    RAISE EXCEPTION 'Owner A updated audit_logs.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    DELETE FROM public.audit_logs WHERE pharmacy_id = v_pharm_a;
    RAISE EXCEPTION 'Owner A deleted audit_logs.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  IF current_user IS DISTINCT FROM v_orig_user THEN
    RAISE EXCEPTION 'Failed to restore original SQL role after Owner A block (expected %, got %).', v_orig_user, current_user;
  END IF;
  RAISE NOTICE 'PASS [2]: Owner A positive A operations & negative A->B RLS/RPC isolation verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 3. OWNER B SESSION: SYMMETRIC POSITIVE B + NEGATIVE AGAINST PHARMACY A
-- =============================================================================
DO $$
DECLARE
  v_orig_user   text := current_user;
  v_pharm_a     constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_pharm_b     constant uuid := '2c10b000-0000-4000-8000-000000000001';
  v_owner_b     constant uuid := '2c10b001-0000-4000-8000-000000000001';
  v_staff_a     constant uuid := '2c10a002-0000-4000-8000-000000000001';
  v_staff_b     constant uuid := '2c10b002-0000-4000-8000-000000000001';
  v_patient_a1  constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_patient_a2  constant uuid := '2c10a202-0000-4000-8000-000000000001';
  v_patient_b1  constant uuid := '2c10b201-0000-4000-8000-000000000001';
  v_plan_a1     constant uuid := '2c10a301-0000-4000-8000-000000000001';
  v_plan_b1     constant uuid := '2c10b301-0000-4000-8000-000000000001';
  v_followup_a1 constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_followup_b1 constant uuid := '2c10b501-0000-4000-8000-000000000001';
  v_thread_a1   constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_thread_b1   constant uuid := '2c10b601-0000-4000-8000-000000000001';
  v_sched_b     constant jsonb := '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_cnt         integer;
  v_res         jsonb;
  v_fstatus     text;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner_b::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_owner_b::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_owner_b THEN
    RAISE EXCEPTION 'Auth context check failed for Owner B.';
  END IF;

  -- Positive in B (and confirm Owner A RLS-filtered update did NOT touch Task B)
  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE pharmacy_id = v_pharm_b;
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'Owner B positive read failed on patients (cnt=%)', v_cnt; END IF;

  SELECT status INTO v_fstatus FROM public.follow_up_tasks WHERE id = v_followup_b1;
  IF v_fstatus <> 'pending' THEN
    RAISE EXCEPTION 'ISOLATION BREACH: Task B1 status changed unexpectedly to %.', v_fstatus;
  END IF;

  -- Positive direct UPDATE on ACL-granted table (`public.follow_up_tasks`)
  UPDATE public.follow_up_tasks SET notes = 'Task B updated by Owner B' WHERE id = v_followup_b1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner B positive update on own follow_up_tasks failed (rows=%)', v_cnt; END IF;

  -- Owner B column-privileged UPDATEs succeed
  UPDATE public.pharmacies SET phone = '07809002099' WHERE id = v_pharm_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner B must update own pharmacy phone via column grant (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacy_staff SET phone = '07809002088' WHERE id = v_staff_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner B must update same-pharmacy staff phone via column grant (affected=%)', v_cnt; END IF;

  v_res := public.record_dispensing_with_refill(
    v_patient_b1, v_plan_b1, 30, 'tablet', 1, 30, 'B-B2', '2027-12-01', '2026-02-20', false, 'Refill B',
    1, 30, '2026-03-22', 'Daily 1 tablet', 60, 30, 30, 'on_track', '2026-03-22', 'Estimated'
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner B positive dispensing RPC failed: %', v_res;
  END IF;

  v_res := public.send_consultation_reply(v_thread_b1, 'رد موثق من المالك ب', 'follow_up');
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Owner B positive consultation reply failed: %', v_res;
  END IF;

  -- Negative reads against A across all tenant tables
  SELECT (
    (SELECT count(*) FROM public.pharmacies WHERE id = v_pharm_a)
    + (SELECT count(*) FROM public.pharmacy_staff WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patients WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patient_conditions WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patient_allergies WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patient_medication_plans WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.regimen_versions WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.medication_pause_periods WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.scheduled_doses WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.unscheduled_dose_reports WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.dispensing_events WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.refill_assessments WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.lab_results WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.follow_up_tasks WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.follow_up_contact_logs WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.consultation_threads WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.consultation_messages WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patient_apk_invitations WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.invitation_redemption_attempts WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.audit_logs WHERE pharmacy_id = v_pharm_a)
  )::integer INTO v_cnt;

  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'ISOLATION BREACH: Owner B saw % Pharmacy A rows.', v_cnt;
  END IF;

  -- Negative writes & RPCs B -> A (42501 revoked-column permissions vs 0 rows RLS-filtered columns)
  UPDATE public.pharmacy_staff SET is_active = false WHERE id = v_staff_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner B must not modify Pharmacy A staff (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacies SET phone = '07800000000' WHERE id = v_pharm_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner B must not modify Pharmacy A phone (affected=%)', v_cnt; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Tamper B->A' WHERE id = v_patient_a1;
    RAISE EXCEPTION 'Owner B direct UPDATE on Patient A1 unexpectedly succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner B modified Pharmacy A follow-up (cnt=%).', v_cnt; END IF;

  BEGIN
    INSERT INTO public.follow_up_tasks (
      pharmacy_id, patient_id, type, due_date, status, notes, assigned_staff_id, assigned_staff_name
    ) VALUES (
      v_pharm_a, v_patient_a1, 'refill', '2026-03-01', 'pending', 'Tamper', v_owner_b, 'Owner B'
    );
    RAISE EXCEPTION 'Owner B inserted follow-up into Pharmacy A.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_a1, '{"clinical_notes":"tamper"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Owner B updated Patient A1 via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.create_medication_plan_with_version(
      v_patient_a1, NULL, 'X', 'Y', '10mg', 'tablet', 'oral', 1, 'tablet', 'any_time',
      'Tamper', NULL, NULL, '2026-02-20', NULL, true, NULL, v_sched_b
    );
    RAISE EXCEPTION 'Owner B created plan for Patient A1 via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_a1, 'paused', 'Tamper B->A', '2026-02-20');
    RAISE EXCEPTION 'Owner B paused Plan A1 via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.record_dispensing_with_refill(
      v_patient_a1, v_plan_a1, 10, 'tablet', NULL, NULL, NULL, NULL, '2026-02-20', false, NULL,
      1, 10, '2026-03-02', 'Tamper', 40, 10, 10, 'on_track', '2026-03-02', 'Tamper'
    );
    RAISE EXCEPTION 'Owner B recorded dispensing for Pharmacy A plan via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  IF pg_catalog.to_regprocedure('public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.create_medication_plan_with_version_v2($1, NULL, ''X'', ''Y'', ''10mg'', ''tablet'', ''oral'', 1, ''tablet'', ''any_time'', ''Tamper v2'', NULL, NULL, ''2026-02-20'', NULL, true, NULL, $2, NULL)'
        USING v_patient_a1, v_sched_b;
      RAISE EXCEPTION 'Owner B created plan for Patient A1 via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  IF pg_catalog.to_regprocedure('public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.update_medication_plan_version_v2($1, ''X'', ''Y'', ''10mg'', ''tablet'', ''oral'', 1, ''tablet'', ''any_time'', ''Tamper v2'', NULL, NULL, ''2026-02-02'', NULL, true, NULL, $2, ''Tamper reason'', ''2026-02-20'', 1, NULL)'
        USING v_plan_a1, v_sched_b;
      RAISE EXCEPTION 'Owner B updated Plan A1 via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  IF pg_catalog.to_regprocedure('public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.record_dispensing_with_refill_v2($1, $2, 10, ''tablet'', NULL, NULL, NULL, NULL, ''2026-02-20'', false, NULL, 1, 10, ''2026-03-02'', ''Tamper'', 40, 10, 10, ''on_track'', ''2026-03-02'', ''Tamper'', ''provisional_client_unverified'', ''masar_refill_v1'', NULL, 1, $3, ''hash'', NULL)'
        USING v_patient_a1, v_plan_a1, '2c10b999-0000-4000-8000-000000000001'::uuid;
      RAISE EXCEPTION 'Owner B recorded dispensing for Pharmacy A plan via _v2 RPC.';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  END IF;

  BEGIN
    PERFORM public.send_consultation_reply(v_thread_a1, 'Tamper B->A', NULL);
    RAISE EXCEPTION 'Owner B replied to Thread A1 via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.revoke_patient_apk_invitation(v_patient_a2, 'Tamper B->A');
    RAISE EXCEPTION 'Owner B revoked Patient A2 invitation via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  v_res := public.issue_patient_apk_invitation(v_patient_a2, 'initial_activation', NULL, 72, false);
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'PATIENT_NOT_FOUND_OR_CROSS_TENANT'
  THEN
    RAISE EXCEPTION 'Owner B expected PATIENT_NOT_FOUND_OR_CROSS_TENANT for Patient A2, got %', v_res;
  END IF;

  -- Admin tables & direct-write revocations & audit immutability in Owner B
  BEGIN
    PERFORM 1 FROM public.bootstrap_state LIMIT 1;
    RAISE EXCEPTION 'Owner B unexpectedly accessed bootstrap_state.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM 1 FROM public.staff_provisioning_requests LIMIT 1;
    RAISE EXCEPTION 'Owner B unexpectedly accessed staff_provisioning_requests.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    INSERT INTO public.patients (
      pharmacy_id, patient_code, full_name, phone, date_of_birth, sex, created_by_staff_id
    ) VALUES (
      v_pharm_b, 'BYPASS-B', 'Bypass Patient', '07809201099', '1990-01-01', 'male', v_owner_b
    );
    RAISE EXCEPTION 'Owner B bypassed patient RPC with direct INSERT.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    UPDATE public.audit_logs SET summary_en = 'Tampered Audit B' WHERE pharmacy_id = v_pharm_b;
    RAISE EXCEPTION 'Owner B updated audit_logs.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    DELETE FROM public.audit_logs WHERE pharmacy_id = v_pharm_b;
    RAISE EXCEPTION 'Owner B deleted audit_logs.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  IF current_user IS DISTINCT FROM v_orig_user THEN
    RAISE EXCEPTION 'Failed to restore original SQL role after Owner B block (expected %, got %).', v_orig_user, current_user;
  END IF;
  RAISE NOTICE 'PASS [3]: Owner B positive B operations & negative B->A RLS/RPC isolation verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 4. PHARMACIST A & PHARMACIST B: ROLE BOUNDARIES + SYMMETRIC CROSS-TENANT DENIAL
-- =============================================================================
DO $$
DECLARE
  v_orig_user   text := current_user;
  v_pharm_a     constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_pharm_b     constant uuid := '2c10b000-0000-4000-8000-000000000001';
  v_staff_a     constant uuid := '2c10a002-0000-4000-8000-000000000001';
  v_staff_b     constant uuid := '2c10b002-0000-4000-8000-000000000001';
  v_patient_a1  constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_patient_b1  constant uuid := '2c10b201-0000-4000-8000-000000000001';
  v_plan_a1     constant uuid := '2c10a301-0000-4000-8000-000000000001';
  v_plan_b1     constant uuid := '2c10b301-0000-4000-8000-000000000001';
  v_followup_a1 constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_followup_b1 constant uuid := '2c10b501-0000-4000-8000-000000000001';
  v_thread_a1   constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_thread_b1   constant uuid := '2c10b601-0000-4000-8000-000000000001';
  v_cnt         integer;
  v_res         jsonb;
BEGIN
  -- 4a. Pharmacist A
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_a::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_staff_a::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_staff_a THEN
    RAISE EXCEPTION 'Auth context check failed for Staff A.';
  END IF;

  -- Positive A reads, granted follow_up_tasks UPDATE & clinical RPC
  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE pharmacy_id = v_pharm_a;
  IF v_cnt < 2 THEN RAISE EXCEPTION 'Staff A positive read on A patients failed.'; END IF;

  UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Staff A positive update on follow_up_tasks A failed (rows=%)', v_cnt; END IF;

  v_res := public.update_patient_with_clinical_tags(v_patient_a1, '{"clinical_notes":"Updated by Staff A"}'::jsonb, NULL, NULL);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Staff A legitimate clinical update failed: %', v_res;
  END IF;

  -- Owner-only, column-granted UPDATEs for pharmacists are filtered by RLS to 0 rows
  UPDATE public.pharmacies SET phone = '07709998888' WHERE id = v_pharm_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Pharmacist A must not edit pharmacy phone (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacy_staff SET phone = '07709997777' WHERE id = v_staff_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Pharmacist A must not edit staff phone (affected=%)', v_cnt; END IF;

  -- Owner-only SELECT isolation within A (SELECT is granted, RLS filters to 0)
  SELECT count(*)::integer INTO v_cnt FROM public.invitation_redemption_attempts;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff A read owner-only invitation_redemption_attempts.'; END IF;

  -- Negative A -> B
  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE pharmacy_id = v_pharm_b;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff A saw Pharmacy B patients.'; END IF;

  UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_b1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff A updated Pharmacy B follow_up_tasks.'; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Staff A cross-tenant' WHERE id = v_patient_b1;
    RAISE EXCEPTION 'Staff A direct UPDATE on Pharmacy B patients succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_b1, '{"clinical_notes":"tamper"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Staff A updated Pharmacy B patient via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_b1, 'paused', 'Tamper Staff A->B', '2026-02-20');
    RAISE EXCEPTION 'Staff A paused Pharmacy B plan via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.send_consultation_reply(v_thread_b1, 'Tamper Staff A->B', NULL);
    RAISE EXCEPTION 'Staff A replied to Pharmacy B thread via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- 4b. Pharmacist B
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_b::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_staff_b::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_staff_b THEN
    RAISE EXCEPTION 'Auth context check failed for Staff B.';
  END IF;

  -- Positive B reads, granted follow_up_tasks UPDATE & clinical RPC
  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE pharmacy_id = v_pharm_b;
  IF v_cnt < 2 THEN RAISE EXCEPTION 'Staff B positive read on B patients failed.'; END IF;

  UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_b1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Staff B positive update on follow_up_tasks B failed (rows=%)', v_cnt; END IF;

  v_res := public.update_patient_with_clinical_tags(v_patient_b1, '{"clinical_notes":"Updated by Staff B"}'::jsonb, NULL, NULL);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Staff B legitimate clinical update failed: %', v_res;
  END IF;

  -- Owner-only, column-granted UPDATEs for pharmacists are filtered by RLS to 0 rows
  UPDATE public.pharmacies SET phone = '07809998888' WHERE id = v_pharm_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Pharmacist B must not edit pharmacy phone (affected=%)', v_cnt; END IF;

  UPDATE public.pharmacy_staff SET phone = '07809997777' WHERE id = v_staff_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Pharmacist B must not edit staff phone (affected=%)', v_cnt; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.invitation_redemption_attempts;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff B read owner-only invitation_redemption_attempts.'; END IF;

  -- Negative B -> A
  SELECT (
    (SELECT count(*) FROM public.patients WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.patient_medication_plans WHERE pharmacy_id = v_pharm_a)
    + (SELECT count(*) FROM public.audit_logs WHERE pharmacy_id = v_pharm_a)
  )::integer INTO v_cnt;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff B saw Pharmacy A rows.'; END IF;

  UPDATE public.follow_up_tasks SET status = 'pending' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Staff B updated Pharmacy A follow_up_tasks.'; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Staff B cross-tenant' WHERE id = v_patient_a1;
    RAISE EXCEPTION 'Staff B direct UPDATE on Pharmacy A patients succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_a1, '{"clinical_notes":"tamper"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Staff B updated Pharmacy A patient via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_a1, 'paused', 'Tamper Staff B->A', '2026-02-20');
    RAISE EXCEPTION 'Staff B paused Pharmacy A plan via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.send_consultation_reply(v_thread_a1, 'Tamper Staff B->A', NULL);
    RAISE EXCEPTION 'Staff B replied to Pharmacy A thread via RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  IF current_user IS DISTINCT FROM v_orig_user THEN
    RAISE EXCEPTION 'Failed to restore original SQL role after Pharmacist A/B block (expected %, got %).', v_orig_user, current_user;
  END IF;
  RAISE NOTICE 'PASS [4]: Pharmacist A & B role isolation and cross-tenant denials verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 5. INACTIVE STAFF, UNLINKED AUTHENTICATED USER & ANONYMOUS ROLE DENIALS
-- =============================================================================
DO $$
DECLARE
  v_orig_user        text := current_user;
  v_pharm_a          constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_inactive_staff_a constant uuid := '2c10a003-0000-4000-8000-000000000001';
  v_unlinked_user    constant uuid := '2c10d001-0000-4000-8000-000000000001';
  v_patient_a1       constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_plan_a1          constant uuid := '2c10a301-0000-4000-8000-000000000001';
  v_sched_a1         constant uuid := '2c10a401-0000-4000-8000-000000000001';
  v_followup_a1      constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_thread_a1        constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_cnt              integer;
  v_res              jsonb;
BEGIN
  -- 5a. Inactive Staff A (authenticated, is_active = false)
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_inactive_staff_a::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_inactive_staff_a::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_inactive_staff_a THEN
    RAISE EXCEPTION 'Auth context check failed for Inactive Staff A.';
  END IF;

  SELECT (
    (SELECT count(*) FROM public.pharmacies)
    + (SELECT count(*) FROM public.pharmacy_staff)
    + (SELECT count(*) FROM public.patients)
    + (SELECT count(*) FROM public.patient_medication_plans)
    + (SELECT count(*) FROM public.audit_logs)
  )::integer INTO v_cnt;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Inactive Staff A saw % rows.', v_cnt; END IF;

  UPDATE public.follow_up_tasks SET status = 'pending' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Inactive Staff A updated follow_up_tasks.'; END IF;

  UPDATE public.pharmacies SET phone = '07700000001' WHERE id = v_pharm_a;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Inactive Staff A must not edit pharmacy phone (affected=%)', v_cnt; END IF;

  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_a1, 'paused', 'Inactive staff pause', '2026-02-20');
    RAISE EXCEPTION 'Inactive Staff A called change_medication_plan_status.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  v_res := public.issue_patient_apk_invitation(v_patient_a1, 'initial_activation', NULL, 72, false);
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'UNAUTHORIZED_NOT_PHARMACIST'
  THEN
    RAISE EXCEPTION 'Expected UNAUTHORIZED_NOT_PHARMACIST for Inactive Staff A, got %', v_res;
  END IF;

  -- 5b. Unlinked Authenticated User
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_unlinked_user::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_unlinked_user::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_unlinked_user THEN
    RAISE EXCEPTION 'Auth context check failed for Unlinked User.';
  END IF;

  SELECT (
    (SELECT count(*) FROM public.pharmacies)
    + (SELECT count(*) FROM public.patients)
    + (SELECT count(*) FROM public.patient_medication_plans)
    + (SELECT count(*) FROM public.audit_logs)
  )::integer INTO v_cnt;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Unlinked user saw % rows.', v_cnt; END IF;

  UPDATE public.follow_up_tasks SET status = 'pending' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Unlinked user updated follow_up_tasks.'; END IF;

  BEGIN
    PERFORM public.send_consultation_reply(v_thread_a1, 'Unlinked reply', NULL);
    RAISE EXCEPTION 'Unlinked user called send_consultation_reply.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  v_res := public.confirm_scheduled_dose(v_sched_a1, 'taken', gen_random_uuid(), 'unlinked');
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'UNAUTHORIZED_NOT_ACTIVE_PATIENT'
  THEN
    RAISE EXCEPTION 'Expected UNAUTHORIZED_NOT_ACTIVE_PATIENT for Unlinked User, got %', v_res;
  END IF;

  -- 5c. Anonymous Role (`anon`)
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;

  IF current_user <> 'anon' OR auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Auth context check failed for anon role.';
  END IF;

  BEGIN
    PERFORM 1 FROM public.patients LIMIT 1;
    RAISE EXCEPTION 'anon role read public.patients.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    UPDATE public.follow_up_tasks SET status = 'completed' WHERE id = v_followup_a1;
    RAISE EXCEPTION 'anon role updated public.follow_up_tasks.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    INSERT INTO public.lab_results (
      pharmacy_id, patient_id, test_name, value, unit, reference_range, is_abnormal, test_date, recorded_by_staff_id, recorded_by_staff_name
    ) VALUES (
      v_pharm_a, v_patient_a1, 'Anon', '1', '%', '<5', false, '2026-02-20', v_inactive_staff_a, 'Anon'
    );
    RAISE EXCEPTION 'anon role inserted into lab_results.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_a1, '{"clinical_notes":"anon"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'anon role executed pharmacist RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  IF current_user IS DISTINCT FROM v_orig_user THEN
    RAISE EXCEPTION 'Failed to restore original SQL role after Section 5 block (expected %, got %).', v_orig_user, current_user;
  END IF;
  RAISE NOTICE 'PASS [5]: Inactive staff, unlinked user & anon denials verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 6. PATIENT A VS PATIENT B: SYMMETRIC SELF-ACCESS + CROSS-PATIENT ISOLATION
-- =============================================================================
DO $$
DECLARE
  v_orig_user      text := current_user;
  v_pharm_a        constant uuid := '2c10a000-0000-4000-8000-000000000001';
  v_pharm_b        constant uuid := '2c10b000-0000-4000-8000-000000000001';
  v_patient_a_auth constant uuid := '2c10a101-0000-4000-8000-000000000001';
  v_patient_b_auth constant uuid := '2c10b101-0000-4000-8000-000000000001';
  v_patient_a1     constant uuid := '2c10a201-0000-4000-8000-000000000001';
  v_patient_a2     constant uuid := '2c10a202-0000-4000-8000-000000000001';
  v_patient_b1     constant uuid := '2c10b201-0000-4000-8000-000000000001';
  v_sched_a1       constant uuid := '2c10a401-0000-4000-8000-000000000001';
  v_sched_b1       constant uuid := '2c10b401-0000-4000-8000-000000000001';
  v_followup_a1    constant uuid := '2c10a501-0000-4000-8000-000000000001';
  v_thread_a1      constant uuid := '2c10a601-0000-4000-8000-000000000001';
  v_thread_b1      constant uuid := '2c10b601-0000-4000-8000-000000000001';
  v_cnt            integer;
  v_res            jsonb;
  v_constraint_name text;
BEGIN
  -- 6a. Patient A1 session
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_patient_a_auth::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_patient_a_auth::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_patient_a_auth THEN
    RAISE EXCEPTION 'Auth context check failed for Patient A1.';
  END IF;

  -- Positive self-reads (only A1; NOT A2 and NOT B1)
  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE id = v_patient_a1;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Patient A1 could not read own patient row.'; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE id IN (v_patient_a2, v_patient_b1);
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Patient A1 saw other patients (cnt=%).', v_cnt; END IF;

  -- Positive unapproved patient message & positive scheduled dose confirmation
  INSERT INTO public.consultation_messages (
    pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
  ) VALUES (
    v_pharm_a, v_thread_a1, 'patient', NULL, 'مراجع اختبار أ١', 'سؤال من المراجع أ١', false
  );

  v_res := public.confirm_scheduled_dose(v_sched_a1, 'taken', gen_random_uuid(), 'Confirmed by A1');
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Patient A1 legitimate confirm_scheduled_dose failed: %', v_res;
  END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.unscheduled_dose_reports WHERE patient_id = v_patient_a1;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Patient A1 expected 1 own unscheduled_dose_reports row, got %.', v_cnt; END IF;

  INSERT INTO public.unscheduled_dose_reports (
    pharmacy_id, patient_id, medication_plan_id, report_type,
    reported_dose_amount, dose_unit, patient_reported_at, client_event_uuid, is_verified_schedule
  ) VALUES (
    v_pharm_a, v_patient_a1, '2c10a301-0000-4000-8000-000000000001', 'unscheduled_extra',
    1, 'tablet', '2026-02-20T14:00:00Z', gen_random_uuid(), false
  );

  -- Negative: Patient A1 cannot read Patient B1's records or pharmacy-only tables
  SELECT (
    (SELECT count(*) FROM public.patient_conditions WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.patient_allergies WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.patient_medication_plans WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.scheduled_doses WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.unscheduled_dose_reports WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.dispensing_events WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.lab_results WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.consultation_threads WHERE patient_id = v_patient_b1)
    + (SELECT count(*) FROM public.pharmacy_staff)
    + (SELECT count(*) FROM public.follow_up_tasks)
    + (SELECT count(*) FROM public.audit_logs)
  )::integer INTO v_cnt;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Patient A1 read % restricted/cross-patient rows.', v_cnt; END IF;

  -- Patient A1 cannot update pharmacist-only follow_up_tasks (RLS filters -> 0) or revoked patients columns (42501)
  UPDATE public.follow_up_tasks SET status = 'pending' WHERE id = v_followup_a1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Patient A1 updated follow_up_tasks.'; END IF;

  BEGIN
    UPDATE public.patients SET clinical_notes = 'Patient self edit attempt' WHERE id = v_patient_a1;
    RAISE EXCEPTION 'Patient A1 direct UPDATE on public.patients clinical_notes succeeded.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- Negative: Patient A1 cannot insert unscheduled_dose_reports for Patient B1
  BEGIN
    INSERT INTO public.unscheduled_dose_reports (
      pharmacy_id, patient_id, medication_plan_id, report_type,
      reported_dose_amount, dose_unit, patient_reported_at, client_event_uuid, is_verified_schedule
    ) VALUES (
      v_pharm_b, v_patient_b1, '2c10b301-0000-4000-8000-000000000001', 'unscheduled_extra',
      1, 'tablet', '2026-02-20T14:00:00Z', gen_random_uuid(), false
    );
    RAISE EXCEPTION 'Patient A1 inserted unscheduled_dose_reports for Patient B1.';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
    WHEN SQLSTATE '23514' THEN
      -- The BEFORE INSERT clinical-provenance trigger can reject an RLS-hidden
      -- cross-patient medication plan as missing before the INSERT RLS check.
      -- Accept only this precise denial, never an arbitrary CHECK failure.
      IF SQLERRM NOT LIKE 'Clinical provenance violation: unscheduled dose reports require an active medication plan for the same patient/pharmacy.%' THEN
        RAISE;
      END IF;
  END;

  -- Negative: Patient A1 cannot confirm Patient B1's scheduled dose or message Patient B1's thread
  v_res := public.confirm_scheduled_dose(v_sched_b1, 'taken', gen_random_uuid(), 'Cross-patient attack');
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED'
  THEN
    RAISE EXCEPTION 'Patient A1 expected SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED for B1, got %', v_res;
  END IF;

  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_b, v_thread_b1, 'patient', NULL, 'مراجع اختبار أ١', 'Cross-patient inject', false
    );
    RAISE EXCEPTION 'Patient A1 inserted message into Patient B1 thread.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_a, v_thread_a1, 'patient', NULL, 'مراجع اختبار أ١', 'Forged approval', true
    );
    RAISE EXCEPTION 'Patient A1 forged approved_by_pharmacist=true.';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
    WHEN SQLSTATE '23514' THEN
      -- Accept ONLY the exact patient-approval constraint; any other 23514 is a test failure.
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IS DISTINCT FROM 'chk_consultation_messages_patient_unapproved' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_patient_a1, '{"clinical_notes":"patient-escalate"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Patient A1 invoked pharmacist RPC.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- 6b. Patient B1 symmetric session
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_patient_b_auth::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_patient_b_auth::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_patient_b_auth THEN
    RAISE EXCEPTION 'Auth context check failed for Patient B1.';
  END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE id = v_patient_b1;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'Patient B1 could not read own patient row.'; END IF;

  SELECT count(*)::integer INTO v_cnt FROM public.patients WHERE id = v_patient_a1;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Patient B1 saw Patient A1.'; END IF;

  v_res := public.confirm_scheduled_dose(v_sched_b1, 'taken', gen_random_uuid(), 'Confirmed by B1');
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Patient B1 legitimate confirm_scheduled_dose failed: %', v_res;
  END IF;

  v_res := public.confirm_scheduled_dose(v_sched_a1, 'taken', gen_random_uuid(), 'Cross-patient B->A');
  IF COALESCE((v_res->>'ok')::boolean, false) IS TRUE
     OR COALESCE(v_res->>'errorCode', '') <> 'SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED'
  THEN
    RAISE EXCEPTION 'Patient B1 expected SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED for A1, got %', v_res;
  END IF;

  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_a, v_thread_a1, 'patient', NULL, 'مراجع اختبار ب١', 'Cross-patient B->A msg', false
    );
    RAISE EXCEPTION 'Patient B1 inserted message into Patient A1 thread.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  IF current_user IS DISTINCT FROM v_orig_user THEN
    RAISE EXCEPTION 'Failed to restore original SQL role after Section 6 block (expected %, got %).', v_orig_user, current_user;
  END IF;
  RAISE NOTICE 'PASS [6]: Patient A vs Patient B self-access & symmetric cross-patient isolation verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 7. FINAL SESSION CONTEXT HYGIENE CHECK PRIOR TO ROLLBACK
-- =============================================================================
DO $$
BEGIN
  IF COALESCE(pg_catalog.current_setting('request.jwt.claim.sub', true), '') <> ''
     OR COALESCE(pg_catalog.current_setting('request.jwt.claims', true), '') <> ''
  THEN
    RAISE EXCEPTION 'Session JWT settings were not cleanly reset prior to ROLLBACK.';
  END IF;
  RAISE NOTICE 'PASS [7]: Session role and JWT GUCs cleanly restored; rolling back all test fixtures.';
END $$;

ROLLBACK;
