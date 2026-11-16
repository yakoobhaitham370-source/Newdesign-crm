-- =============================================================================
-- MASAR Care Stage 2A — Concurrent Retry & Idempotency SQL Fixtures & Verifier
-- =============================================================================
-- STATUS: REVIEW-ONLY SQL HARNESS (NOT EXECUTED AGAINST POSTGRESQL).
-- Companion Runner: supabase/tests/run_stage2a_concurrency_and_retry.sh
--
-- IMPORTANT ISOLATION & EXECUTION RULES:
--   1. Never run this file standalone (`psql -f stage2a_concurrency_and_retry.test.sql`).
--      Single-session `psql` execution CANNOT test multi-session Read Committed
--      concurrency; this file explicitly fails unless invoked via the two-session
--      runner (`run_stage2a_concurrency_and_retry.sh`) with `-v run_seed=1` or
--      `-v run_verify=1`.
--   2. Target ONLY an explicitly approved, fresh/reset disposable development
--      PostgreSQL 15+ / Supabase instance containing fictional data only.
--   3. Do NOT attempt `DELETE FROM public.regimen_versions` or `audit_logs`:
--      `0001_stage2a_core_schema.sql` installs `trg_regimen_versions_no_delete`
--      (`prevent_ledger_mutation()`). Post-test cleanup must be performed by
--      destroying or resetting the disposable development database.
--   4. `SET LOCAL ROLE authenticated` + `request.jwt.claim.sub` simulation
--      assumes Supabase PostgreSQL `auth` roles/functions and remains UNVERIFIED
--      until executed against a real PostgreSQL instance.
-- =============================================================================

\if :{?run_seed}
\else
  \if :{?run_verify}
  \else
    DO $$
    BEGIN
      RAISE EXCEPTION 'HARNESS USAGE ERROR: Run supabase/tests/run_stage2a_concurrency_and_retry.sh against an authorized disposable dev DB (single-session psql execution cannot simulate parallel workers and refuses to false-pass).';
    END $$;
  \endif
\endif

-- -----------------------------------------------------------------------------
-- PHASE 1: Pre-Flight Clean-Slate Check & Schema-Aligned Fictional Seed Fixture
-- Invoked with: psql ... -v run_seed=1 -f stage2a_concurrency_and_retry.test.sql
-- Matches exact DDL of `supabase/migrations/0001_stage2a_core_schema.sql`.
-- -----------------------------------------------------------------------------
\if :{?run_seed}
BEGIN;

DO $$
DECLARE
  v_existing_pharm_cnt integer;
  v_non_test_pharm_cnt integer;
  v_existing_ev_cnt    integer;
BEGIN
  IF to_regprocedure('public.confirm_scheduled_dose(uuid,text,uuid,text)') IS NULL
     OR to_regclass('public.dose_events') IS NULL
     OR to_regclass('public.scheduled_doses') IS NULL
  THEN
    RAISE EXCEPTION 'SEED PRECONDITION FAILED: Stage 2A migrations 0001 and 0002 must be applied before running concurrency tests.';
  END IF;

  SELECT count(*) INTO v_non_test_pharm_cnt
  FROM public.pharmacies
  WHERE id <> 'c1111111-1111-4111-8111-111111111111';

  IF v_non_test_pharm_cnt > 0 THEN
    RAISE EXCEPTION 'DISPOSABLE DB GUARD TRIGGERED: Found % non-test pharmacy rows. Refusing to seed a non-isolated or potentially live database.', v_non_test_pharm_cnt;
  END IF;

  SELECT count(*) INTO v_existing_pharm_cnt
  FROM public.pharmacies
  WHERE id = 'c1111111-1111-4111-8111-111111111111';

  SELECT count(*) INTO v_existing_ev_cnt
  FROM public.dose_events
  WHERE scheduled_dose_id IN (
    'c4444444-1111-4111-8111-00000000000a',
    'c4444444-1111-4111-8111-00000000000b',
    'c4444444-1111-4111-8111-00000000000c',
    'c4444444-1111-4111-8111-00000000000d'
  );

  IF v_existing_pharm_cnt > 0 OR v_existing_ev_cnt > 0 THEN
    RAISE EXCEPTION 'DIRTY DISPOSABLE DB STATE: Seed fixture or prior dose_events already exist (pharm=%, events=%). Reset/destroy and recreate the disposable development database cleanly before re-running (do not DELETE immutable regimen_versions).',
      v_existing_pharm_cnt, v_existing_ev_cnt;
  END IF;
END $$;

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  (
    'c0c00001-1111-4111-8111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'conc-staff@masarcare.test.iq',
    extensions.crypt('TestPass!123', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'c0c00002-1111-4111-8111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'conc-patient@masarcare.test.iq',
    extensions.crypt('TestPass!123', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

-- 0001 pharmacies columns: id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
INSERT INTO public.pharmacies (
  id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
)
VALUES (
  'c1111111-1111-4111-8111-111111111111',
  'صيدلية اختبار التزامن',
  'Concurrency QA Pharmacy',
  'Baghdad',
  'Baghdad',
  'IQ-BGW-CONC-001',
  '07700009999',
  'Asia/Baghdad',
  true
);

-- 0001 pharmacy_staff columns: id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
INSERT INTO public.pharmacy_staff (
  id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
)
VALUES (
  'c0c00001-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'د. اختبار التزامن',
  'pharmacy_owner',
  'SYN-CONC-001',
  '07700009991',
  true,
  'c0c00001-1111-4111-8111-111111111111'
);

-- 0001 patients columns: id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
-- verified_account_phone, date_of_birth, sex, contact_preference, registration_date, status,
-- auth_user_id, auth_linked_at, created_by_staff_id
INSERT INTO public.patients (
  id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
  verified_account_phone, date_of_birth, sex, contact_preference,
  registration_date, status, auth_user_id, auth_linked_at, created_by_staff_id
)
VALUES (
  'c2222222-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'MC-CONC-1',
  'مريض اختبار التزامن',
  '07701119999',
  'self',
  '07701119999',
  '1985-01-01',
  'male',
  'apk_notification',
  '2026-11-01',
  'active',
  'c0c00002-1111-4111-8111-111111111111',
  now(),
  'c0c00001-1111-4111-8111-111111111111'
);

INSERT INTO public.patient_medication_plans (
  id, pharmacy_id, patient_id, brand_name, generic_name, strength, dosage_form,
  route, dose_amount, dose_unit, food_relation, verified_instructions,
  start_date, is_ongoing, status, current_version_number, schedule, created_by_staff_id
)
VALUES (
  'c3333333-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'c2222222-1111-4111-8111-111111111111',
  'Concor',
  'Bisoprolol',
  '5 mg',
  'tablet',
  'oral',
  1,
  'tablet',
  'before_food',
  'قرص واحد صباحاً',
  '2026-11-01',
  true,
  'active',
  1,
  '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb,
  'c0c00001-1111-4111-8111-111111111111'
);

INSERT INTO public.regimen_versions (
  medication_plan_id, pharmacy_id, version_number, effective_from,
  dose_amount, dose_unit, food_relation, verified_instructions,
  schedule, changed_by_staff_id, changed_by_staff_name, change_reason
)
VALUES (
  'c3333333-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  1,
  '2026-11-01',
  1,
  'tablet',
  'before_food',
  'قرص واحد صباحاً',
  '{"frequencyType":"daily","timesPerDay":1,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb,
  'c0c00001-1111-4111-8111-111111111111',
  'د. اختبار التزامن',
  'Concurrency seed'
);

-- Four distinct scheduled_doses rows:
--   ...000a -> Case A (same dose + same client_event_uuid)
--   ...000b -> Case B (same dose + different client_event_uuids)
--   ...000c, ...000d -> Case C (different doses + same client_event_uuid)
INSERT INTO public.scheduled_doses (
  id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
  scheduled_date, scheduled_time24, planned_dose_amount, dose_unit
)
VALUES
  ('c4444444-1111-4111-8111-00000000000a', 'c1111111-1111-4111-8111-111111111111', 'c2222222-1111-4111-8111-111111111111', 'c3333333-1111-4111-8111-111111111111', 1, '2026-11-14', '08:00', 1, 'tablet'),
  ('c4444444-1111-4111-8111-00000000000b', 'c1111111-1111-4111-8111-111111111111', 'c2222222-1111-4111-8111-111111111111', 'c3333333-1111-4111-8111-111111111111', 1, '2026-11-15', '08:00', 1, 'tablet'),
  ('c4444444-1111-4111-8111-00000000000c', 'c1111111-1111-4111-8111-111111111111', 'c2222222-1111-4111-8111-111111111111', 'c3333333-1111-4111-8111-111111111111', 1, '2026-11-16', '08:00', 1, 'tablet'),
  ('c4444444-1111-4111-8111-00000000000d', 'c1111111-1111-4111-8111-111111111111', 'c2222222-1111-4111-8111-111111111111', 'c3333333-1111-4111-8111-111111111111', 1, '2026-11-17', '08:00', 1, 'tablet');

COMMIT;
\endif

-- -----------------------------------------------------------------------------
-- PHASE 2: Strict Post-Race Database Invariant Assertions
-- Invoked with: psql ... -v run_verify=1 -f stage2a_concurrency_and_retry.test.sql
-- Fails loudly unless Case A, Case B, and Case C EACH produced exactly 1
-- committed dose_events row with expected authoritative values.
-- -----------------------------------------------------------------------------
\if :{?run_verify}
DO $$
DECLARE
  v_ev_a        public.dose_events%ROWTYPE;
  v_cnt_a       integer;
  v_ev_b        public.dose_events%ROWTYPE;
  v_cnt_b       integer;
  v_ev_c        public.dose_events%ROWTYPE;
  v_cnt_c_total integer;
BEGIN
  -- Case A: Exactly 1 row for dose ...000a with client_event_uuid = c9990001-...
  SELECT count(*) INTO v_cnt_a
  FROM public.dose_events
  WHERE scheduled_dose_id = 'c4444444-1111-4111-8111-00000000000a';

  IF v_cnt_a <> 1 THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case A]: Expected exactly 1 committed dose_events row, found %', v_cnt_a;
  END IF;

  SELECT * INTO v_ev_a
  FROM public.dose_events
  WHERE scheduled_dose_id = 'c4444444-1111-4111-8111-00000000000a';

  IF v_ev_a.client_event_uuid <> 'c9990001-1111-4111-8111-111111111111'::uuid
     OR v_ev_a.status <> 'taken'
     OR v_ev_a.planned_dose_amount <> 1
     OR v_ev_a.regimen_version_number <> 1
  THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case A]: Unexpected committed row fields (uuid=%, status=%, dose=%, ver=%)',
      v_ev_a.client_event_uuid, v_ev_a.status, v_ev_a.planned_dose_amount, v_ev_a.regimen_version_number;
  END IF;

  -- Case B: Exactly 1 row for dose ...000b using one of the two distinct client UUIDs
  SELECT count(*) INTO v_cnt_b
  FROM public.dose_events
  WHERE scheduled_dose_id = 'c4444444-1111-4111-8111-00000000000b';

  IF v_cnt_b <> 1 THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case B]: Expected exactly 1 committed dose_events row, found %', v_cnt_b;
  END IF;

  SELECT * INTO v_ev_b
  FROM public.dose_events
  WHERE scheduled_dose_id = 'c4444444-1111-4111-8111-00000000000b';

  IF v_ev_b.client_event_uuid NOT IN (
       'c9990002-1111-4111-8111-111111111111'::uuid,
       'c9990003-1111-4111-8111-111111111111'::uuid
     )
     OR v_ev_b.status NOT IN ('taken', 'delayed')
  THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case B]: Unexpected committed row fields (uuid=%, status=%)',
      v_ev_b.client_event_uuid, v_ev_b.status;
  END IF;

  -- Case C: Exactly 1 row total across doses ...000c and ...000d sharing client_event_uuid = c9990004-...
  SELECT count(*) INTO v_cnt_c_total
  FROM public.dose_events
  WHERE scheduled_dose_id IN (
    'c4444444-1111-4111-8111-00000000000c',
    'c4444444-1111-4111-8111-00000000000d'
  );

  IF v_cnt_c_total <> 1 THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case C]: Expected exactly 1 committed dose_events row across doses c & d, found %', v_cnt_c_total;
  END IF;

  SELECT * INTO v_ev_c
  FROM public.dose_events
  WHERE scheduled_dose_id IN (
    'c4444444-1111-4111-8111-00000000000c',
    'c4444444-1111-4111-8111-00000000000d'
  );

  IF v_ev_c.client_event_uuid <> 'c9990004-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'CONCURRENCY ASSERTION FAILED [Case C]: Expected client_event_uuid c9990004-..., got %', v_ev_c.client_event_uuid;
  END IF;

  RAISE NOTICE 'PASS [Stage 2A Concurrency DB Invariants]: Case A=1 row, Case B=1 row, Case C=1 row across c/d.';
END $$;
\endif

-- Cleanup Strategy Note:
-- Do NOT DELETE from public.regimen_versions or public.audit_logs (`prevent_ledger_mutation()`).
-- Destroy or reset the dedicated disposable development database after inspection.
