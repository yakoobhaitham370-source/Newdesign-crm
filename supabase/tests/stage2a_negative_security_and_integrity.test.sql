-- =============================================================================
-- MASAR Care — Stage 2A Negative Security, RLS & Integrity SQL Test Suite
-- Target Database: PostgreSQL 15+ (Supabase Local / Staging Verification)
-- Status: REVIEW-ONLY — NOT EXECUTED AGAINST POSTGRESQL YET
--
-- UNVERIFIED POSTGRESQL / SUPABASE RUNTIME ASSUMPTIONS (PENDING REAL DB RUN):
--   1. `SET LOCAL ROLE anon` and `SET LOCAL ROLE authenticated` assume Supabase's
--      standard `anon` and `authenticated` roles exist and the script runner role
--      (`postgres` / `supabase_admin`) is a member permitted to assume them.
--   2. Setting `request.jwt.claim.sub` and `request.jwt.claims` GUCs assumes
--      Supabase's `auth.uid()` resolves claims identically under `SET LOCAL ROLE`.
--   3. RLS `insufficient_privilege` (SQLSTATE 42501) catches, `auth.users` column
--      shapes, and `extensions.*` resolution remain UNVERIFIED until executed on
--      an explicitly authorized disposable development PostgreSQL/Supabase instance.
-- =============================================================================
-- Schema-verified against:
--   - supabase/migrations/0001_stage2a_core_schema.sql
--   - supabase/migrations/0002_stage2a_rls_and_security.sql
--
-- Covers Independent Audit & V1.5.4 Audit Findings:
--   F1: Exact alignment with 0001/0002 DDL (columns, FKs, auth.users & staff harness)
--   F2: Overlap pause rejection catches true SQLSTATE 23P01 (exclusion_violation)
--   F8: Real role-switched RLS tests (anon, Pharmacy A owner/staff, inactive staff,
--       Pharmacy B cross-tenant, Patient A1 self-read & cross-patient/staff denial)
--   F9: CSPRNG unbiased 6-digit format & range checks
--   C1: Failed PIN/OTP attempts and lockouts persist without transaction rollback
--   C2: Direct authenticated/anon execution of OTP/redemption RPCs is denied
--   C3: End-to-end OTP issuance (request_invitation_sms_otp) + redemption flow
--   C4: Cross-patient composite FK rejection (Patient A1 + Patient A2's plan/dose)
--   H1 (V1.5.4): Scheduled-dose provenance (reject NULL scheduled_dose_id, cross-patient,
--       discontinued plan, duplicate confirmations; support client_event_uuid replay;
--       separate unscheduled_dose_reports with is_verified_schedule = false)
--   H3 (V1.5.4): Schema-qualified extensions.crypt / gen_salt / digest
--   H4 (V1.5.4): Owner-approved device replacement recovery & identity verification
--   H5: Shared caregiver/family phone numbers allowed within the same pharmacy
--   H6: Column-specific ON DELETE SET NULL preserves non-nullable tenant keys
--   H8: Activated patient account replacement blocked without recovery ceremony
--   M6: Non-overlapping medication pause periods & dose_events provenance trigger
--   M7: Private app_security schema & column-level invitation secret protection
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FICTIONAL AUTH, STAFF, TENANT, PATIENT & MEDICATION FIXTURE HARNESS
-- =============================================================================
DO $$
DECLARE
  v_pharm_a       UUID := '11111111-1111-4111-8111-111111111111';
  v_pharm_b       UUID := '22222222-2222-4222-8222-222222222222';

  -- Fictional Supabase auth.users identities (all rolled back at end of suite)
  v_owner_a_uid   UUID := 'aaaa0001-1111-4111-8111-111111111111';
  v_staff_a_uid   UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_inact_a_uid   UUID := 'aaaa0003-1111-4111-8111-111111111111';
  v_owner_b_uid   UUID := 'bbbb0001-2222-4222-8222-222222222222';
  v_pat_a1_uid    UUID := 'cccc0001-1111-4111-8111-111111111111';
  v_pat_a2_uid    UUID := 'cccc0002-1111-4111-8111-111111111111';

  v_pat_a1        UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_pat_a2        UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-222222222222';
  v_pat_b1        UUID := 'bbbbbbbb-bbbb-4bbb-8bbb-111111111111';

  v_plan_a1       UUID := 'dddddddd-aaaa-4aaa-8aaa-111111111111';
  v_plan_a2       UUID := 'dddddddd-aaaa-4aaa-8aaa-222222222222';
  v_plan_b1       UUID := 'dddddddd-bbbb-4bbb-8bbb-111111111111';

  v_sched_a1      jsonb := '{"frequencyType":"daily","timesPerDay":2,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1},{"id":"s2","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_sched_a2      jsonb := '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"09:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
BEGIN
  -- Fictional Supabase auth.users entries
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_owner_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'owner.a@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_staff_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'staff.a@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_inact_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'inactive.a@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_owner_b_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'owner.b@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_pat_a1_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'patient.a1@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_pat_a2_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'patient.a2@masarcare.test.iq', extensions.crypt('TestPass!123', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

  -- Pharmacies (exact 0001 columns: license_number required, timezone = Asia/Baghdad)
  INSERT INTO public.pharmacies (
    id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
  ) VALUES
    (v_pharm_a, 'صيدلية النور التجريبية', 'Al-Noor Test Pharmacy', 'Baghdad', 'Baghdad', 'IQ-BGW-TEST-001', '07701234567', 'Asia/Baghdad', true),
    (v_pharm_b, 'صيدلية الشفاء التجريبية', 'Al-Shifa Test Pharmacy', 'Basra', 'Basra', 'IQ-BSR-TEST-002', '07801234567', 'Asia/Baghdad', true);

  -- Pharmacy staff (Authoritative RBAC directory; id = auth.users.id)
  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  ) VALUES
    (v_owner_a_uid, v_pharm_a, 'Dr. Zaid Al-Noor', 'pharmacy_owner', 'SYN-A-001', '07701000001', true, v_owner_a_uid),
    (v_staff_a_uid, v_pharm_a, 'Ph. Noor Al-Mansour', 'authorized_pharmacist', 'SYN-A-002', '07701000002', true, v_owner_a_uid),
    (v_inact_a_uid, v_pharm_a, 'Ph. Inactive User', 'authorized_pharmacist', 'SYN-A-003', '07701000003', false, v_owner_a_uid),
    (v_owner_b_uid, v_pharm_b, 'Dr. Sara Al-Basri', 'pharmacy_owner', 'SYN-B-001', '07801000001', true, v_owner_b_uid);

  -- H5 TEST: Two patients in Pharmacy A sharing the same caregiver phone number
  INSERT INTO public.patients (
    id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    caregiver_name, date_of_birth, sex, contact_preference, created_by_staff_id
  ) VALUES
    (v_pat_a1, v_pharm_a, 'TEST-A-001', 'الحاج محمود العاني', '07709998877', 'caregiver',
     'علي محمود (الابن)', '1954-03-10', 'male', 'whatsapp', v_staff_a_uid),
    (v_pat_a2, v_pharm_a, 'TEST-A-002', 'الحاجة سعاد العاني', '07709998877', 'family_shared',
     'علي محمود (الابن)', '1958-07-22', 'female', 'whatsapp', v_staff_a_uid),
    (v_pat_b1, v_pharm_b, 'TEST-B-001', 'فاطمة البصري', '07805554433', 'self',
     NULL, '1965-11-05', 'female', 'phone_call', v_owner_b_uid);

  -- Medication plans (exact 0001 columns)
  INSERT INTO public.patient_medication_plans (
    id, pharmacy_id, patient_id, brand_name, generic_name, strength, dosage_form,
    route, dose_amount, dose_unit, food_relation, verified_instructions,
    start_date, is_ongoing, status, current_version_number, schedule, created_by_staff_id
  ) VALUES
    (v_plan_a1, v_pharm_a, v_pat_a1, 'Glucophage', 'Metformin', '1000 mg', 'tablet',
     'oral', 1, 'tablet', 'after_food', 'قرص واحد مرتين يومياً بعد الأكل',
     '2026-11-01', true, 'active', 1, v_sched_a1, v_staff_a_uid),
    (v_plan_a2, v_pharm_a, v_pat_a2, 'Concor', 'Bisoprolol', '5 mg', 'tablet',
     'oral', 1, 'tablet', 'after_food', 'قرص واحد صباحاً بعد الفطور',
     '2026-11-01', true, 'active', 1, v_sched_a2, v_staff_a_uid),
    (v_plan_b1, v_pharm_b, v_pat_b1, 'Lipitor', 'Atorvastatin', '20 mg', 'tablet',
     'oral', 1, 'tablet', 'any_time', 'قرص واحد مساءً يومياً',
     '2026-11-01', true, 'active', 1, v_sched_a2, v_owner_b_uid);

  -- Regimen versions (exact 0001 columns)
  INSERT INTO public.regimen_versions (
    medication_plan_id, pharmacy_id, version_number, effective_from,
    dose_amount, dose_unit, food_relation, verified_instructions,
    schedule, changed_by_staff_id, changed_by_staff_name, change_reason
  ) VALUES
    (v_plan_a1, v_pharm_a, 1, '2026-11-01', 1, 'tablet', 'after_food', 'قرص واحد مرتين يومياً بعد الأكل',
     v_sched_a1, v_staff_a_uid, 'Ph. Noor Al-Mansour', 'Initial verified regimen'),
    (v_plan_a2, v_pharm_a, 1, '2026-11-01', 1, 'tablet', 'after_food', 'قرص واحد صباحاً بعد الفطور',
     v_sched_a2, v_staff_a_uid, 'Ph. Noor Al-Mansour', 'Initial verified regimen'),
    (v_plan_b1, v_pharm_b, 1, '2026-11-01', 1, 'tablet', 'any_time', 'قرص واحد مساءً يومياً',
     v_sched_a2, v_owner_b_uid, 'Dr. Sara Al-Basri', 'Initial verified regimen');

  -- Follow-up task for Patient A1 (must remain invisible to Patient A1 under RLS)
  INSERT INTO public.follow_up_tasks (
    pharmacy_id, patient_id, related_medication_plan_id, type, due_date, status,
    notes, assigned_staff_id, assigned_staff_name
  ) VALUES (
    v_pharm_a, v_pat_a1, v_plan_a1, 'refill', '2026-11-15', 'pending',
    'Pharmacist outreach note: check blood glucose adherence', v_staff_a_uid, 'Ph. Noor Al-Mansour'
  );
END $$;

-- =============================================================================
-- 2. NEGATIVE TEST C4: CROSS-PATIENT PLAN / DOSE / DISPENSING MISMATCH MUST FAIL
-- =============================================================================
DO $$
DECLARE
  v_pharm_a     UUID := '11111111-1111-4111-8111-111111111111';
  v_staff_a_uid UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_pat_a1      UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_plan_a2     UUID := 'dddddddd-aaaa-4aaa-8aaa-222222222222';
  v_caught      BOOLEAN := FALSE;
BEGIN
  -- Attempt to insert a dispensing_event for Patient A1 referencing Patient A2's medication_plan_id
  BEGIN
    INSERT INTO public.dispensing_events (
      pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
      dispensed_quantity, quantity_unit, dispensing_date,
      dispensed_by_staff_id, dispensed_by_staff_name,
      estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date,
      forecast_assumptions, is_partial_fill
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a2, 1,
      30, 'tablet', '2026-11-12',
      v_staff_a_uid, 'Ph. Noor Al-Mansour',
      1.0, 30, '2026-12-12',
      'Test forecast assumption', false
    );
  EXCEPTION WHEN foreign_key_violation THEN
    v_caught := TRUE;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST FAILURE [C4]: Cross-patient medication_plan_id on dispensing_events was not blocked by composite FK';
  END IF;
END $$;

DO $$
DECLARE
  v_pharm_a UUID := '11111111-1111-4111-8111-111111111111';
  v_pat_a1  UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_plan_a2 UUID := 'dddddddd-aaaa-4aaa-8aaa-222222222222';
  v_caught  BOOLEAN := FALSE;
BEGIN
  -- Attempt to insert a scheduled_dose for Patient A1 referencing Patient A2's medication_plan_id
  BEGIN
    INSERT INTO public.scheduled_doses (
      pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
      scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a2, 1,
      '2026-11-12', '09:00', 1, 'tablet'
    );
  EXCEPTION WHEN foreign_key_violation THEN
    v_caught := TRUE;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST FAILURE [C4]: Cross-patient medication_plan_id on scheduled_doses was not blocked by composite FK';
  END IF;
END $$;

-- =============================================================================
-- 3. NEGATIVE TEST H6: COLUMN-SPECIFIC ON DELETE SET NULL PRESERVES TENANT KEYS
-- =============================================================================
DO $$
DECLARE
  v_pharm_a UUID := '11111111-1111-4111-8111-111111111111';
  v_pat_a1  UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_plan_a1 UUID := 'dddddddd-aaaa-4aaa-8aaa-111111111111';
  v_dose_id UUID := 'eeeeeeee-aaaa-4aaa-8aaa-111111111111';
  v_evt_id  UUID := 'eeeeeeee-aaaa-4aaa-8aaa-222222222222';
  v_rem_pat UUID;
  v_rem_ph  UUID;
BEGIN
  INSERT INTO public.scheduled_doses (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
  ) VALUES (
    v_dose_id, v_pharm_a, v_pat_a1, v_plan_a1, 1,
    '2026-11-12', '08:00', 1, 'tablet'
  );

  INSERT INTO public.dose_events (
    id, pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
    regimen_version_number, scheduled_date, scheduled_time24,
    planned_dose_amount, dose_unit, status
  ) VALUES (
    v_evt_id, v_pharm_a, v_pat_a1, v_plan_a1, v_dose_id,
    1, '2026-11-12', '08:00',
    1, 'tablet', 'taken'
  );

  -- Delete the scheduled_dose; ONLY scheduled_dose_id becomes NULL while pharmacy_id & patient_id stay intact
  DELETE FROM public.scheduled_doses WHERE id = v_dose_id;

  SELECT patient_id, pharmacy_id INTO v_rem_pat, v_rem_ph
  FROM public.dose_events
  WHERE id = v_evt_id AND scheduled_dose_id IS NULL;

  IF v_rem_pat IS DISTINCT FROM v_pat_a1 OR v_rem_ph IS DISTINCT FROM v_pharm_a THEN
    RAISE EXCEPTION 'TEST FAILURE [H6]: Column-specific ON DELETE SET NULL (scheduled_dose_id) failed to preserve non-nullable tenant/patient keys';
  END IF;
END $$;

-- =============================================================================
-- 4. NEGATIVE TEST M6 & F2: OVERLAPPING PAUSE PERIODS RAISE exclusion_violation (23P01)
--    AND DOSE EVENT IDENTITY IS IMMUTABLE
-- =============================================================================
DO $$
DECLARE
  v_pharm_a     UUID := '11111111-1111-4111-8111-111111111111';
  v_staff_a_uid UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_plan_a1     UUID := 'dddddddd-aaaa-4aaa-8aaa-111111111111';
  v_evt_id      UUID := 'eeeeeeee-aaaa-4aaa-8aaa-222222222222';
  v_caught      BOOLEAN := FALSE;
  v_immut       BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.medication_pause_periods (
    pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, recorded_by_staff_id
  ) VALUES (
    v_pharm_a, v_plan_a1, '2026-11-05', '2026-11-10', 'Temporary hospitalization', v_staff_a_uid
  );

  BEGIN
    INSERT INTO public.medication_pause_periods (
      pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, recorded_by_staff_id
    ) VALUES (
      v_pharm_a, v_plan_a1, '2026-11-08', '2026-11-12', 'Overlapping pause attempt', v_staff_a_uid
    );
  EXCEPTION WHEN exclusion_violation THEN
    v_caught := TRUE;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'TEST FAILURE [M6/F2]: Overlapping medication_pause_periods did not raise exclusion_violation (23P01)';
  END IF;

  -- Verify trg_dose_events_provenance blocks tampering with planned_dose_amount
  BEGIN
    UPDATE public.dose_events
       SET planned_dose_amount = 99
     WHERE id = v_evt_id;
  EXCEPTION WHEN OTHERS THEN
    v_immut := TRUE;
  END;

  IF NOT v_immut THEN
    RAISE EXCEPTION 'TEST FAILURE [M6]: dose_events provenance trigger allowed mutation of planned_dose_amount';
  END IF;
END $$;

-- =============================================================================
-- 5. NEGATIVE & POSITIVE TEST C1, C3, H3, H4, H8, F9:
--    UNBIASED CSPRNG PIN/OTP, NON-ROLLBACK LOCKOUT, BOOTSTRAP BINDING & RECOVERY
-- =============================================================================
DO $$
DECLARE
  v_pharm_a     UUID := '11111111-1111-4111-8111-111111111111';
  v_owner_a_uid UUID := 'aaaa0001-1111-4111-8111-111111111111';
  v_staff_a_uid UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_pat_a1      UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_pat_a1_uid  UUID := 'cccc0001-1111-4111-8111-111111111111';
  v_pat_a2_uid  UUID := 'cccc0002-1111-4111-8111-111111111111';
  v_inv_id      UUID := 'ffffffff-aaaa-4aaa-8aaa-111111111111';
  v_inv_id_2    UUID := 'ffffffff-aaaa-4aaa-8aaa-222222222222';
  v_raw_tok     TEXT := 'inv_tok_test_secret_value_000001';
  v_raw_tok_2   TEXT := 'inv_tok_test_secret_value_000002';
  v_raw_pin     TEXT := '482910';
  v_csprng_code TEXT;
  v_otp_res     JSONB;
  v_raw_otp     TEXT;
  v_redeem_res  JSONB;
  v_issue_res   JSONB;
  v_fail_cnt    INTEGER;
  v_status      TEXT;
  v_linked_uid  UUID;
BEGIN
  -- F9: CSPRNG code is strictly 6 digits between 100000 and 999999
  v_csprng_code := app_security.generate_csprng_6digit_code();
  IF v_csprng_code !~ '^[1-9][0-9]{5}$' THEN
    RAISE EXCEPTION 'TEST FAILURE [F9/H3]: generate_csprng_6digit_code returned invalid format: %', v_csprng_code;
  END IF;

  -- Seed pending invitation with hashed token and pharmacist handover PIN
  INSERT INTO public.patient_apk_invitations (
    id, pharmacy_id, patient_id, invitation_purpose, target_phone, token_hash,
    pharmacist_pin_hash, status, max_attempts, expires_at, issued_by_staff_id, issued_by_staff_name
  ) VALUES (
    v_inv_id, v_pharm_a, v_pat_a1, 'initial_activation', '07709998877',
    encode(extensions.digest(v_raw_tok, 'sha256'), 'hex'),
    extensions.crypt(v_raw_pin, extensions.gen_salt('bf', 8)),
    'pending', 3, NOW() + INTERVAL '24 hours', v_staff_a_uid, 'Ph. Noor Al-Mansour'
  );

  -- C1 TEST: Submit wrong PIN -> returns ok=false AND persists failed_attempts = 1
  v_otp_res := public.request_invitation_sms_otp(v_raw_tok, '000000', 'edge_ip_hmac_1', 'dev_fp_1');
  IF (v_otp_res->>'ok')::boolean IS DISTINCT FROM FALSE OR (v_otp_res->>'errorCode') <> 'INVALID_PHARMACIST_PIN' THEN
    RAISE EXCEPTION 'TEST FAILURE [C1]: Wrong PIN did not return structured INVALID_PHARMACIST_PIN payload';
  END IF;

  SELECT failed_attempts, status INTO v_fail_cnt, v_status
  FROM public.patient_apk_invitations WHERE id = v_inv_id;

  IF v_fail_cnt <> 1 OR v_status <> 'pending' THEN
    RAISE EXCEPTION 'TEST FAILURE [C1]: Failed PIN attempt did not persist in patient_apk_invitations (got %)', v_fail_cnt;
  END IF;

  -- C3 TEST: Request SMS OTP with valid PIN -> issues 6-digit CSPRNG OTP
  v_otp_res := public.request_invitation_sms_otp(v_raw_tok, v_raw_pin, 'edge_ip_hmac_1', 'dev_fp_1');
  IF (v_otp_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'TEST FAILURE [C3]: Valid PIN failed to issue SMS OTP: %', v_otp_res;
  END IF;
  v_raw_otp := v_otp_res->>'smsOtpForGatewayDispatch';
  IF v_raw_otp !~ '^[1-9][0-9]{5}$' THEN
    RAISE EXCEPTION 'TEST FAILURE [H3/F9]: Issued SMS OTP invalid format: %', v_raw_otp;
  END IF;

  -- C1 LOCKOUT TEST: 2 more wrong OTP attempts reach max_attempts (3) and persist status = 'revoked'
  v_redeem_res := public.redeem_patient_apk_invitation(
    v_raw_tok, v_raw_pin, '999999', v_pat_a1_uid, 'Pixel 8 Test', 'edge_ip_hmac_1', 'dev_fp_1'
  );
  v_redeem_res := public.redeem_patient_apk_invitation(
    v_raw_tok, v_raw_pin, '888888', v_pat_a1_uid, 'Pixel 8 Test', 'edge_ip_hmac_1', 'dev_fp_1'
  );

  SELECT failed_attempts, status INTO v_fail_cnt, v_status
  FROM public.patient_apk_invitations WHERE id = v_inv_id;

  IF v_fail_cnt <> 3 OR v_status <> 'revoked' THEN
    RAISE EXCEPTION 'TEST FAILURE [C1]: Lockout after max_attempts did not persist status=revoked (attempts=%, status=%)', v_fail_cnt, v_status;
  END IF;

  -- C3 & H4 TEST: Valid fresh invitation -> OTP -> Redeem -> binds patients.auth_user_id = v_pat_a1_uid
  INSERT INTO public.patient_apk_invitations (
    id, pharmacy_id, patient_id, invitation_purpose, target_phone, token_hash,
    pharmacist_pin_hash, status, max_attempts, expires_at, issued_by_staff_id, issued_by_staff_name
  ) VALUES (
    v_inv_id_2, v_pharm_a, v_pat_a1, 'initial_activation', '07709998877',
    encode(extensions.digest(v_raw_tok_2, 'sha256'), 'hex'),
    extensions.crypt(v_raw_pin, extensions.gen_salt('bf', 8)),
    'pending', 5, NOW() + INTERVAL '24 hours', v_staff_a_uid, 'Ph. Noor Al-Mansour'
  );

  v_otp_res := public.request_invitation_sms_otp(v_raw_tok_2, v_raw_pin, 'edge_ip_hmac_2', 'dev_fp_2');
  v_raw_otp := v_otp_res->>'smsOtpForGatewayDispatch';

  v_redeem_res := public.redeem_patient_apk_invitation(
    v_raw_tok_2, v_raw_pin, v_raw_otp, v_pat_a1_uid, 'Samsung A55 Test', 'edge_ip_hmac_2', 'dev_fp_2'
  );
  IF (v_redeem_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'TEST FAILURE [C3/H4]: Valid invitation redemption failed: %', v_redeem_res;
  END IF;

  SELECT auth_user_id INTO v_linked_uid FROM public.patients WHERE id = v_pat_a1;
  IF v_linked_uid IS DISTINCT FROM v_pat_a1_uid THEN
    RAISE EXCEPTION 'TEST FAILURE [H4]: patients.auth_user_id was not bound to bootstrap auth user';
  END IF;

  -- H8 TEST: Activated patient cannot be issued an 'initial_activation' invitation without recovery ceremony
  -- NOTE: Switching to authenticated role assumes Supabase `authenticated` role membership & `auth.uid()` GUC behavior (UNVERIFIED until live PG run).
  PERFORM set_config('request.jwt.claim.sub', v_staff_a_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_a_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_issue_res := public.issue_patient_apk_invitation(v_pat_a1, 'initial_activation', NULL, 72, false);
  IF (v_issue_res->>'errorCode') <> 'ALREADY_ACTIVATED_REQUIRES_RECOVERY_CEREMONY' THEN
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILURE [H8]: Already activated patient allowed initial_activation instead of requiring recovery ceremony: %', v_issue_res;
  END IF;

  -- V1.5.4 H4 NEGATIVE TEST 1: Non-owner authorized_pharmacist CANNOT issue device_replacement_recovery
  v_issue_res := public.issue_patient_apk_invitation(v_pat_a1, 'device_replacement_recovery', 'Patient lost old phone', 72, true);
  IF (v_issue_res->>'errorCode') <> 'RECOVERY_REQUIRES_PHARMACY_OWNER_APPROVAL' THEN
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILURE [H4-RECOVERY]: Non-owner pharmacist was allowed to issue device_replacement_recovery: %', v_issue_res;
  END IF;

  -- V1.5.4 H4 NEGATIVE TEST 2: Pharmacy owner WITHOUT recovery_identity_verified=true is rejected
  PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a_uid, 'role', 'authenticated')::text, true);
  v_issue_res := public.issue_patient_apk_invitation(v_pat_a1, 'device_replacement_recovery', 'Patient lost old phone in Baghdad', 72, false);
  IF (v_issue_res->>'errorCode') <> 'RECOVERY_IDENTITY_VERIFICATION_REQUIRED' THEN
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILURE [H4-RECOVERY]: Recovery succeeded without independent identity verification attestation: %', v_issue_res;
  END IF;

  -- V1.5.4 H4 POSITIVE TEST: Pharmacy owner WITH identity verification + detailed reason succeeds
  v_issue_res := public.issue_patient_apk_invitation(v_pat_a1, 'device_replacement_recovery', 'Verified in-person ID and replacement handset', 72, true);
  IF (v_issue_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILURE [H4-RECOVERY]: Owner-approved device_replacement_recovery failed: %', v_issue_res;
  END IF;

  -- Clear role & JWT claims
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- =============================================================================
-- 6. NEGATIVE & POSITIVE TEST F8 / C2 / M7: ROLE-SWITCHED RLS & PRIVILEGE TESTS
-- =============================================================================

-- 6A. ANON ROLE MUST BE DENIED ALL CLINICAL TABLES & PRIVATE SECURITY FUNCTIONS
DO $$
DECLARE
  v_denied BOOLEAN := FALSE;
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM count(*) FROM public.patients;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := TRUE;
  END;
  RESET ROLE;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: anon role was allowed to query public.patients';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE;
END $$;

-- 6B. PHARMACY A AUTHORIZED PHARMACIST: POSITIVE SAME-TENANT + CROSS-TENANT DENIAL
DO $$
DECLARE
  v_pharm_a      UUID := '11111111-1111-4111-8111-111111111111';
  v_pharm_b      UUID := '22222222-2222-4222-8222-222222222222';
  v_staff_a_uid  UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_pat_b1       UUID := 'bbbbbbbb-bbbb-4bbb-8bbb-111111111111';
  v_visible_cnt  INTEGER;
  v_cross_cnt    INTEGER;
  v_att_cnt      INTEGER;
  v_upd_rows     INTEGER;
  v_new_pat_id   UUID;
  v_caught_ins   BOOLEAN := FALSE;
  v_caught_del   BOOLEAN := FALSE;
  v_caught_col   BOOLEAN := FALSE;
  v_caught_rpc   BOOLEAN := FALSE;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_staff_a_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff_a_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Positive SELECT: sees only Pharmacy A patients (2) and 0 from Pharmacy B
  SELECT count(*) INTO v_visible_cnt FROM public.patients;
  SELECT count(*) INTO v_cross_cnt FROM public.patients WHERE id = v_pat_b1;
  IF v_visible_cnt <> 2 OR v_cross_cnt <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Pharmacist A saw wrong patient counts (visible=%, crossTenant=%)', v_visible_cnt, v_cross_cnt;
  END IF;

  -- Positive INSERT into Pharmacy A succeeds
  INSERT INTO public.patients (
    pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    date_of_birth, sex, created_by_staff_id
  ) VALUES (
    v_pharm_a, 'TEST-A-NEW', 'مريض اختبار الصلاحية', '07708887766', 'self',
    '1972-02-15', 'male', v_staff_a_uid
  )
  RETURNING id INTO v_new_pat_id;

  -- Positive UPDATE on own Pharmacy A patient succeeds
  UPDATE public.patients
     SET clinical_notes = 'Updated safely by Pharmacy A staff'
   WHERE id = v_new_pat_id;

  -- Negative cross-tenant INSERT into Pharmacy B must fail RLS WITH CHECK (42501)
  BEGIN
    INSERT INTO public.patients (
      pharmacy_id, patient_code, full_name, phone, phone_owner_type,
      date_of_birth, sex, created_by_staff_id
    ) VALUES (
      v_pharm_b, 'TEST-X-TENANT', 'Cross Tenant Intrusion', '07809991111', 'self',
      '1980-01-01', 'male', v_staff_a_uid
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_ins := TRUE;
  END;
  IF NOT v_caught_ins THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Pharmacist A was able to INSERT a patient into Pharmacy B';
  END IF;

  -- Negative cross-tenant UPDATE on Pharmacy B affects 0 rows
  UPDATE public.patients SET clinical_notes = 'Cross-tenant overwrite' WHERE id = v_pat_b1;
  GET DIAGNOSTICS v_upd_rows = ROW_COUNT;
  IF v_upd_rows <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Pharmacist A updated % rows in Pharmacy B', v_upd_rows;
  END IF;

  -- Negative DELETE on patients (no DELETE privilege granted)
  BEGIN
    DELETE FROM public.patients WHERE id = v_new_pat_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_del := TRUE;
  END;
  IF NOT v_caught_del THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: authenticated pharmacist was granted DELETE on public.patients';
  END IF;

  -- Role separation: authorized_pharmacist sees 0 rows in owner-only invitation_redemption_attempts
  SELECT count(*) INTO v_att_cnt FROM public.invitation_redemption_attempts;
  IF v_att_cnt <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: non-owner pharmacist saw % rows in invitation_redemption_attempts', v_att_cnt;
  END IF;

  -- Column-level secret protection: selecting token_hash/pharmacist_pin_hash/sms_otp_hash fails
  BEGIN
    EXECUTE 'SELECT token_hash FROM public.patient_apk_invitations LIMIT 1';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_col := TRUE;
  END;
  IF NOT v_caught_col THEN
    RAISE EXCEPTION 'TEST FAILURE [M7]: authenticated role could SELECT secret token_hash from patient_apk_invitations';
  END IF;

  -- C2 runtime RPC privilege check: calling service_role-only OTP/redemption RPC fails as authenticated
  BEGIN
    PERFORM public.request_invitation_sms_otp('tok', '123456', 'ip', 'fp');
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_rpc := TRUE;
  END;
  IF NOT v_caught_rpc THEN
    RAISE EXCEPTION 'TEST FAILURE [C2]: authenticated role executed request_invitation_sms_otp';
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- 6C. PHARMACY A OWNER CAN READ PHARMACY A REDEMPTION ATTEMPTS (POSITIVE)
DO $$
DECLARE
  v_owner_a_uid UUID := 'aaaa0001-1111-4111-8111-111111111111';
  v_att_cnt     INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_a_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_att_cnt FROM public.invitation_redemption_attempts;
  IF v_att_cnt < 1 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Pharmacy A owner could not read Pharmacy A invitation_redemption_attempts';
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- 6D. INACTIVE PHARMACY STAFF MUST HAVE ZERO ACCESS
DO $$
DECLARE
  v_inact_a_uid UUID := 'aaaa0003-1111-4111-8111-111111111111';
  v_cnt         INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_inact_a_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_inact_a_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_cnt FROM public.patients;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Inactive staff account saw % patient rows', v_cnt;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- 6E. PATIENT A1 APK USER: SELF-READ, DIRECT DOSE INSERT BLOCKED, & STAFF-TABLE DENIAL
DO $$
DECLARE
  v_pharm_a        UUID := '11111111-1111-4111-8111-111111111111';
  v_pat_a1         UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_pat_a2         UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-222222222222';
  v_plan_a1        UUID := 'dddddddd-aaaa-4aaa-8aaa-111111111111';
  v_plan_a2        UUID := 'dddddddd-aaaa-4aaa-8aaa-222222222222';
  v_sd_own_guard   UUID := '51111111-aaaa-4aaa-8aaa-111111111111';
  v_sd_other_guard UUID := '51111111-aaaa-4aaa-8aaa-222222222222';
  v_pat_a1_uid     UUID := 'cccc0001-1111-4111-8111-111111111111';
  v_self_cnt       INTEGER;
  v_other_cnt      INTEGER;
  v_fu_cnt         INTEGER;
  v_audit_cnt      INTEGER;
  v_inv_cnt        INTEGER;
  v_caught_bad_provenance BOOLEAN := FALSE;
  v_caught_direct         BOOLEAN := FALSE;
  v_caught_cross          BOOLEAN := FALSE;
BEGIN
  -- Create two genuine, distinct scheduled doses as the administrative test role.
  -- These use 2026-11-14, separate from section 7's 2026-11-13 fixtures.
  -- All fixtures are within this file's outer BEGIN ... ROLLBACK.
  INSERT INTO public.scheduled_doses (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
  ) VALUES
    (v_sd_own_guard, v_pharm_a, v_pat_a1, v_plan_a1, 1,
     '2026-11-14', '08:00', 1, 'tablet'),
    (v_sd_other_guard, v_pharm_a, v_pat_a2, v_plan_a2, 1,
     '2026-11-14', '09:00', 1, 'tablet');

  PERFORM set_config('request.jwt.claim.sub', v_pat_a1_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pat_a1_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Positive: Patient A1 sees own patient record (1) and own plans (1)
  SELECT count(*) INTO v_self_cnt FROM public.patients WHERE id = v_pat_a1;
  SELECT count(*) INTO v_other_cnt FROM public.patients WHERE id <> v_pat_a1;
  IF v_self_cnt <> 1 OR v_other_cnt <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Patient A1 isolation failed (self=%, others=%)', v_self_cnt, v_other_cnt;
  END IF;

  -- Negative H1-A: Forged dose without scheduled_dose_id MUST raise 23514.
  -- The BEFORE INSERT provenance trigger runs before the RLS WITH CHECK.
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
      scheduled_date, scheduled_time24, planned_dose_amount, dose_unit, status
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a1, 1,
      '2026-11-13', '08:00', 99, 'tablet', 'taken'
    );
  EXCEPTION WHEN check_violation THEN
    v_caught_bad_provenance := TRUE;
  END;
  IF NOT v_caught_bad_provenance THEN
    RAISE EXCEPTION 'TEST FAILURE [H1-A]: NULL scheduled_dose_id was not rejected with 23514';
  END IF;

  -- Negative H1-B: Even a valid, visible, own scheduled dose MUST NOT be
  -- directly writable by a patient. Only the authorized RPC may write it.
  -- This deliberately checks for 42501, not the provenance 23514 error.
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
      regimen_version_number, scheduled_date, scheduled_time24,
      planned_dose_amount, dose_unit, status
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a1, v_sd_own_guard,
      1, '2026-11-14', '08:00', 1, 'tablet', 'taken'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_direct := TRUE;
  END;
  IF NOT v_caught_direct THEN
    RAISE EXCEPTION 'TEST FAILURE [H1-B]: Patient could directly INSERT a valid scheduled dose event (RLS bypass)';
  END IF;

  -- Negative: Patient A1 cannot read follow_up_tasks, audit_logs, or invitations
  SELECT count(*) INTO v_fu_cnt FROM public.follow_up_tasks;
  SELECT count(*) INTO v_audit_cnt FROM public.audit_logs;
  SELECT count(*) INTO v_inv_cnt FROM public.patient_apk_invitations;
  IF v_fu_cnt <> 0 OR v_audit_cnt <> 0 OR v_inv_cnt <> 0 THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Patient A1 read restricted staff tables (followups=%, audits=%, invitations=%)',
      v_fu_cnt, v_audit_cnt, v_inv_cnt;
  END IF;

  -- Negative F8: Patient A1 cannot insert Patient A2's dose event, even
  -- when identifying a real scheduled_dose_id belonging to Patient A2.
  -- Expected: either 23514 (invisible/mismatched schedule provenance)
  -- or 42501 (explicit RLS denial). Both safely reject the write.
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
      regimen_version_number, scheduled_date, scheduled_time24,
      planned_dose_amount, dose_unit, status
    ) VALUES (
      v_pharm_a, v_pat_a2, v_plan_a2, v_sd_other_guard,
      1, '2026-11-14', '09:00', 1, 'tablet', 'taken'
    );
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      v_caught_cross := TRUE;
  END;

  IF NOT v_caught_cross THEN
    RAISE EXCEPTION 'TEST FAILURE [F8]: Patient A1 inserted a dose_event for Patient A2';
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

-- 6F. STATIC PRIVILEGE MATRIX ASSERTIONS (C2, M7, H1)
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.request_invitation_sms_otp(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [C2]: authenticated role must NOT have EXECUTE privilege on request_invitation_sms_otp';
  END IF;

  IF has_function_privilege('authenticated', 'public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [C2]: authenticated role must NOT have EXECUTE privilege on redeem_patient_apk_invitation';
  END IF;

  IF has_function_privilege('anon', 'app_security.generate_csprng_6digit_code()', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [M7]: anon role must NOT have EXECUTE privilege on app_security.generate_csprng_6digit_code';
  END IF;

  IF has_function_privilege('authenticated', 'app_security.generate_csprng_6digit_code()', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [M7]: authenticated role must NOT have EXECUTE privilege on app_security.generate_csprng_6digit_code';
  END IF;

  IF has_function_privilege('anon', 'public.confirm_scheduled_dose(uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: anon role must NOT have EXECUTE privilege on confirm_scheduled_dose';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.confirm_scheduled_dose(uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: authenticated role must have EXECUTE privilege on confirm_scheduled_dose';
  END IF;
END $$;

-- =============================================================================
-- 7. V1.5.4 H1: SCHEDULED-DOSE PROVENANCE, IDEMPOTENCY, DUPLICATE BLOCKING
--    & UNSCHEDULED PRN DOSE SEPARATION TESTS
-- =============================================================================
DO $$
DECLARE
  v_pharm_a        UUID := '11111111-1111-4111-8111-111111111111';
  v_staff_a_uid    UUID := 'aaaa0002-1111-4111-8111-111111111111';
  v_pat_a1         UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
  v_pat_a2         UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-222222222222';
  v_pat_a1_uid     UUID := 'cccc0001-1111-4111-8111-111111111111';
  v_plan_a1        UUID := 'dddddddd-aaaa-4aaa-8aaa-111111111111';
  v_plan_a2        UUID := 'dddddddd-aaaa-4aaa-8aaa-222222222222';
  v_plan_disc      UUID := 'dddddddd-aaaa-4aaa-8aaa-333333333333';
  v_sd_a1          UUID := '11111111-aaaa-4aaa-8aaa-111111111111';
  v_sd_a2          UUID := '11111111-aaaa-4aaa-8aaa-222222222222';
  v_sd_disc        UUID := '11111111-aaaa-4aaa-8aaa-333333333333';
  v_ev_uuid_1      UUID := '99990001-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_2      UUID := '99990002-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_3      UUID := '99990003-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_4         UUID := '99990004-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_unsched_bad UUID := '99990005-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_unsched_ok1 UUID := '99990006-aaaa-4aaa-8aaa-111111111111';
  v_ev_uuid_unsched_ok2 UUID := '99990007-aaaa-4aaa-8aaa-111111111111';
  v_caught_null       BOOLEAN := FALSE;
  v_caught_bad_sd     BOOLEAN := FALSE;
  v_caught_verified   BOOLEAN := FALSE;
  v_res               JSONB;
  v_is_verified       BOOLEAN;
  v_is_verified_2     BOOLEAN;
BEGIN
  -- Seed authorized scheduled doses for Patient A1 (active), Patient A2 (active), and Patient A1 (discontinued plan)
  INSERT INTO public.scheduled_doses (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
  ) VALUES
    (v_sd_a1, v_pharm_a, v_pat_a1, v_plan_a1, 1, '2026-11-13', '08:00', 1, 'tablet'),
    (v_sd_a2, v_pharm_a, v_pat_a2, v_plan_a2, 1, '2026-11-13', '09:00', 1, 'tablet');

  INSERT INTO public.patient_medication_plans (
    id, pharmacy_id, patient_id, brand_name, generic_name, strength, dosage_form,
    route, dose_amount, dose_unit, food_relation, verified_instructions,
    start_date, is_ongoing, status, current_version_number, schedule, created_by_staff_id
  ) VALUES (
    v_plan_disc, v_pharm_a, v_pat_a1, 'Lipanthyl', 'Fenofibrate', '160 mg', 'tablet',
    'oral', 1, 'tablet', 'with_food', 'Discontinued plan for negative test',
    '2026-10-01', true, 'discontinued', 1,
    '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb,
    v_staff_a_uid
  );

  INSERT INTO public.regimen_versions (
    medication_plan_id, pharmacy_id, version_number, effective_from,
    dose_amount, dose_unit, food_relation, verified_instructions,
    schedule, changed_by_staff_id, changed_by_staff_name, change_reason
  ) VALUES (
    v_plan_disc, v_pharm_a, 1, '2026-10-01', 1, 'tablet', 'with_food', 'Discontinued plan for negative test',
    '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb,
    v_staff_a_uid, 'Ph. Noor Al-Mansour', 'Initial version'
  );

  INSERT INTO public.scheduled_doses (
    id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
  ) VALUES (
    v_sd_disc, v_pharm_a, v_pat_a1, v_plan_disc, 1, '2026-11-13', '20:00', 1, 'tablet'
  );

  -- Trigger provenance test (superuser): NULL scheduled_dose_id on INSERT must fail
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
      regimen_version_number, scheduled_date, scheduled_time24,
      planned_dose_amount, dose_unit, status
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a1, NULL,
      1, '2026-11-25', '08:00', 50, 'tablet', 'taken'
    );
  EXCEPTION WHEN check_violation THEN
    v_caught_null := TRUE;
  END;
  IF NOT v_caught_null THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: enforce_dose_event_provenance allowed NULL scheduled_dose_id on INSERT';
  END IF;

  -- Trigger provenance test: non-existent scheduled_dose_id must fail FK/provenance check
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
      regimen_version_number, scheduled_date, scheduled_time24,
      planned_dose_amount, dose_unit, status
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a1, '00000000-0000-4000-8000-000000000999',
      1, '2026-11-25', '08:00', 1, 'tablet', 'taken'
    );
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    v_caught_bad_sd := TRUE;
  END;
  IF NOT v_caught_bad_sd THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: dose_events allowed non-existent scheduled_dose_id';
  END IF;

  -- Switch to Patient A1 authenticated session
  PERFORM set_config('request.jwt.claim.sub', v_pat_a1_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pat_a1_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Positive: Patient A1 confirms own authorized scheduled_dose via RPC
  v_res := public.confirm_scheduled_dose(v_sd_a1, 'taken', v_ev_uuid_1, 'Taken after breakfast');
  IF (v_res->>'ok')::boolean IS DISTINCT FROM TRUE
     OR (v_res->>'scheduledDate') <> '2026-11-13'
     OR (v_res->>'plannedDoseAmount')::numeric <> 1
  THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Valid confirm_scheduled_dose RPC failed or failed to derive server schedule fields: %', v_res;
  END IF;

  -- Idempotency: Repeating the exact offline client_event_uuid returns ok=true, idempotentReplay=true
  v_res := public.confirm_scheduled_dose(v_sd_a1, 'taken', v_ev_uuid_1, 'Retry after offline reconnect');
  IF (v_res->>'ok')::boolean IS DISTINCT FROM TRUE
     OR (v_res->>'idempotentReplay')::boolean IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Idempotent client_event_uuid replay failed: %', v_res;
  END IF;

  -- Duplicate confirmation block: Different client_event_uuid for same scheduled_dose_id is rejected
  v_res := public.confirm_scheduled_dose(v_sd_a1, 'taken', v_ev_uuid_2, NULL);
  IF (v_res->>'errorCode') <> 'DUPLICATE_DOSE_CONFIRMATION_BLOCKED' THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Duplicate confirmation for same scheduled_dose_id was not blocked: %', v_res;
  END IF;

  -- Cross-patient scheduled_dose_id: Patient A1 trying to confirm Patient A2's scheduled_dose_id is rejected
  v_res := public.confirm_scheduled_dose(v_sd_a2, 'taken', v_ev_uuid_3, NULL);
  IF (v_res->>'errorCode') <> 'SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED' THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Cross-patient scheduled_dose_id was not rejected: %', v_res;
  END IF;

  -- Discontinued plan scheduled_dose_id: Rejected
  v_res := public.confirm_scheduled_dose(v_sd_disc, 'taken', v_ev_uuid_4, NULL);
  IF (v_res->>'errorCode') <> 'MEDICATION_PLAN_NOT_ACTIVE' THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Discontinued medication plan scheduled_dose_id was not rejected: %', v_res;
  END IF;

  -- Unscheduled patient report: Trigger Option A rejects supplied true with SQLSTATE 23514 (check_violation),
  -- while omitted default and explicit false succeed with distinct client_event_uuid values.
  BEGIN
    INSERT INTO public.unscheduled_dose_reports (
      pharmacy_id, patient_id, medication_plan_id, report_type,
      reported_dose_amount, dose_unit, patient_reported_at, client_event_uuid, is_verified_schedule
    ) VALUES (
      v_pharm_a, v_pat_a1, v_plan_a1, 'unscheduled_extra',
      1, 'tablet', now(), v_ev_uuid_unsched_bad, true
    );
  EXCEPTION WHEN check_violation THEN
    v_caught_verified := TRUE;
  END;
  IF NOT v_caught_verified THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: Trigger/CHECK allowed unscheduled_dose_reports INSERT with is_verified_schedule=true';
  END IF;

  -- Intended-success insert 1: omit is_verified_schedule so table DEFAULT false applies cleanly
  INSERT INTO public.unscheduled_dose_reports (
    pharmacy_id, patient_id, medication_plan_id, report_type,
    reported_dose_amount, dose_unit, patient_reported_at, patient_note, client_event_uuid
  ) VALUES (
    v_pharm_a, v_pat_a1, v_plan_a1, 'unscheduled_extra',
    1, 'tablet', now(), 'Patient took extra dose before dinner', v_ev_uuid_unsched_ok1
  )
  RETURNING is_verified_schedule INTO v_is_verified;

  IF v_is_verified IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: unscheduled_dose_reports omitted default did not store is_verified_schedule = false';
  END IF;

  -- Intended-success insert 2: explicit is_verified_schedule = false with a distinct client_event_uuid
  INSERT INTO public.unscheduled_dose_reports (
    pharmacy_id, patient_id, medication_plan_id, report_type,
    reported_dose_amount, dose_unit, patient_reported_at, patient_note, client_event_uuid, is_verified_schedule
  ) VALUES (
    v_pharm_a, v_pat_a1, v_plan_a1, 'unscheduled_extra',
    1, 'tablet', now(), 'Second extra dose report with explicit false', v_ev_uuid_unsched_ok2, false
  )
  RETURNING is_verified_schedule INTO v_is_verified_2;

  IF v_is_verified_2 IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'TEST FAILURE [H1]: unscheduled_dose_reports explicit false did not store is_verified_schedule = false';
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END $$;

ROLLBACK;
