-- =============================================================================
-- MASAR Care — Stage 2B Migration 0003 Post-Bootstrap Security, Bypass & Clinical Tests
-- Target Database: PostgreSQL 17+ (Supabase Disposable Development Instance ONLY)
-- Status: DRAFT — NOT EXECUTED AGAINST POSTGRESQL
--
-- EXECUTION SAFETY & ORDER (Stage 2B.2A.2 H2, H3):
--   - Safe to execute AFTER initial owner bootstrap (or on any 0003 dev DB),
--     because it creates isolated fictional test pharmacies directly inside
--     `BEGIN; ... ROLLBACK;` without altering `public.bootstrap_state`.
--   - Run `stage2b_0003_bootstrap_clean_state.test.sql` BEFORE live bootstrap.
--   - Uses PostgreSQL 17 `RESET ROLE;` + `pg_catalog.set_config(...)` (never
--     nonexistent `reset_config`) and asserts full role/claims restoration.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. POST-0003 24-TABLE PRIVILEGE CLOSURE, POLICY & SECURITY DEFINER VERIFICATION
-- =============================================================================
DO $$
DECLARE
  v_table_count                integer;
  v_rls_forced_count           integer;
  v_anon_priv_count            integer;
  v_admin_table_client_privs   integer;
  v_bypass_write_privs         integer;
  v_patients_direct_ins_del    boolean;
  v_patients_fullname_update   boolean;
  v_patients_status_update     boolean;
  v_open_bypass_policies       integer;
  v_fn_leak_count              integer;
  v_secdef_bad_search_path     integer;
BEGIN
  SELECT count(*)::integer INTO v_table_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN (
      'pharmacies', 'pharmacy_staff', 'patients', 'patient_conditions', 'patient_allergies',
      'medication_catalog', 'patient_medication_plans', 'regimen_versions', 'medication_pause_periods',
      'scheduled_doses', 'dose_events', 'unscheduled_dose_reports', 'dispensing_events',
      'refill_assessments', 'lab_results', 'follow_up_tasks', 'follow_up_contact_logs',
      'consultation_threads', 'consultation_messages', 'patient_apk_invitations',
      'invitation_redemption_attempts', 'audit_logs', 'bootstrap_state', 'staff_provisioning_requests'
    );

  IF v_table_count <> 24 THEN
    RAISE EXCEPTION 'Expected 24 MASAR tables in public after Migration 0003, found %.', v_table_count;
  END IF;

  SELECT count(*)::integer INTO v_rls_forced_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity = true
    AND c.relforcerowsecurity = true
    AND c.relname IN (
      'pharmacies', 'pharmacy_staff', 'patients', 'patient_conditions', 'patient_allergies',
      'medication_catalog', 'patient_medication_plans', 'regimen_versions', 'medication_pause_periods',
      'scheduled_doses', 'dose_events', 'unscheduled_dose_reports', 'dispensing_events',
      'refill_assessments', 'lab_results', 'follow_up_tasks', 'follow_up_contact_logs',
      'consultation_threads', 'consultation_messages', 'patient_apk_invitations',
      'invitation_redemption_attempts', 'audit_logs', 'bootstrap_state', 'staff_provisioning_requests'
    );

  IF v_rls_forced_count <> 24 THEN
    RAISE EXCEPTION 'Expected RLS enabled AND forced on all 24 tables, found %.', v_rls_forced_count;
  END IF;

  SELECT count(*)::integer INTO v_anon_priv_count
  FROM information_schema.table_privileges
  WHERE table_schema = 'public'
    AND grantee = 'anon'
    AND table_name IN (
      'pharmacies', 'pharmacy_staff', 'patients', 'patient_conditions', 'patient_allergies',
      'medication_catalog', 'patient_medication_plans', 'regimen_versions', 'medication_pause_periods',
      'scheduled_doses', 'dose_events', 'unscheduled_dose_reports', 'dispensing_events',
      'refill_assessments', 'lab_results', 'follow_up_tasks', 'follow_up_contact_logs',
      'consultation_threads', 'consultation_messages', 'patient_apk_invitations',
      'invitation_redemption_attempts', 'audit_logs', 'bootstrap_state', 'staff_provisioning_requests'
    );

  IF v_anon_priv_count <> 0 THEN
    RAISE EXCEPTION 'Expected 0 table privileges for anon across 24 MASAR tables, found %.', v_anon_priv_count;
  END IF;

  SELECT count(*)::integer INTO v_admin_table_client_privs
  FROM information_schema.table_privileges
  WHERE table_schema = 'public'
    AND table_name IN ('bootstrap_state', 'staff_provisioning_requests')
    AND grantee IN ('anon', 'authenticated', 'PUBLIC');

  IF v_admin_table_client_privs <> 0 THEN
    RAISE EXCEPTION 'bootstrap_state and staff_provisioning_requests must expose 0 privileges to PUBLIC/anon/authenticated.';
  END IF;

  -- Audit H1: Verify authenticated has ZERO direct INSERT/UPDATE/DELETE on all 7 RPC-governed tables
  SELECT count(*)::integer INTO v_bypass_write_privs
  FROM information_schema.table_privileges
  WHERE table_schema = 'public'
    AND grantee = 'authenticated'
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
    AND table_name IN (
      'patient_conditions',
      'patient_allergies',
      'patient_medication_plans',
      'regimen_versions',
      'medication_pause_periods',
      'dispensing_events',
      'refill_assessments'
    );

  IF v_bypass_write_privs <> 0 THEN
    RAISE EXCEPTION 'Expected 0 direct authenticated INSERT/UPDATE/DELETE privileges on 7 RPC-governed tables, found %.', v_bypass_write_privs;
  END IF;

  -- Narrowed patients ACL: no direct INSERT/DELETE, no full_name direct UPDATE; archive status UPDATE allowed
  v_patients_direct_ins_del :=
    has_table_privilege('authenticated', 'public.patients', 'INSERT')
    OR has_table_privilege('authenticated', 'public.patients', 'DELETE');
  v_patients_fullname_update := has_column_privilege('authenticated', 'public.patients', 'full_name', 'UPDATE');
  v_patients_status_update := has_column_privilege('authenticated', 'public.patients', 'status', 'UPDATE');
  IF v_patients_direct_ins_del OR v_patients_fullname_update OR NOT v_patients_status_update THEN
    RAISE EXCEPTION 'Invalid public.patients ACL narrowing: ins_del=%, fullname_upd=%, status_upd=%.',
      v_patients_direct_ins_del, v_patients_fullname_update, v_patients_status_update;
  END IF;

  -- Defense-in-depth: confirm dropped bypass policies are absent from pg_policies
  SELECT count(*)::integer INTO v_open_bypass_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname IN (
      'conditions_pharmacist_write',
      'allergies_pharmacist_write',
      'med_plans_pharmacist_insert',
      'med_plans_pharmacist_update',
      'regimen_versions_pharmacist_insert',
      'regimen_versions_pharmacist_close',
      'pause_periods_pharmacist_write',
      'dispensing_events_pharmacist_insert',
      'refill_assessments_pharmacist_write',
      'patients_pharmacist_insert'
    );

  IF v_open_bypass_policies <> 0 THEN
    RAISE EXCEPTION 'Expected 0 legacy direct-write policies remaining on RPC-governed tables, found %.', v_open_bypass_policies;
  END IF;

  -- Verify all 9 service_role-only 0003 functions cannot be executed by anon or authenticated
  SELECT count(*)::integer INTO v_fn_leak_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE ((n.nspname = 'public' AND p.proname IN (
      'claim_first_owner_bootstrap',
      'inspect_first_owner_bootstrap_state',
      'mark_first_owner_bootstrap_reconciliation',
      'finalize_first_owner_bootstrap',
      'claim_staff_provisioning_request',
      'inspect_staff_provisioning_state',
      'mark_staff_provisioning_reconciliation',
      'reconcile_expired_staff_provisioning_claim',
      'provision_pharmacy_staff_by_owner'
    ))
    OR (n.nspname = 'app_security' AND p.proname = 'compute_staff_provisioning_fingerprint'))
    AND (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
    );

  IF v_fn_leak_count <> 0 THEN
    RAISE EXCEPTION 'Found % service_role-only 0003 provisioning functions executable by anon/authenticated.', v_fn_leak_count;
  END IF;

  -- Verify all 19 SECURITY DEFINER functions introduced/updated in 0003 pin search_path = pg_catalog, pg_temp
  SELECT count(*)::integer INTO v_secdef_bad_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE ((n.nspname = 'public' AND p.proname IN (
      'claim_first_owner_bootstrap', 'inspect_first_owner_bootstrap_state',
      'mark_first_owner_bootstrap_reconciliation', 'finalize_first_owner_bootstrap',
      'claim_staff_provisioning_request', 'inspect_staff_provisioning_state',
      'mark_staff_provisioning_reconciliation', 'reconcile_expired_staff_provisioning_claim',
      'provision_pharmacy_staff_by_owner',
      'create_patient_with_clinical_tags', 'update_patient_with_clinical_tags',
      'create_medication_plan_with_version', 'update_medication_plan_version',
      'change_medication_plan_status', 'record_dispensing_with_refill',
      'send_consultation_reply', 'revoke_patient_apk_invitation'
    ))
    OR (n.nspname = 'app_security' AND p.proname IN (
      'require_active_pharmacist_context', 'write_clinical_audit_log'
    )))
    AND (
      NOT p.prosecdef
      OR COALESCE(array_to_string(p.proconfig, ','), '') NOT LIKE '%search_path=pg_catalog, pg_temp%'
    );

  IF v_secdef_bad_search_path <> 0 THEN
    RAISE EXCEPTION 'Found % 0003 SECURITY DEFINER functions missing pinned search_path=pg_catalog, pg_temp.', v_secdef_bad_search_path;
  END IF;

  -- Stage 2B.2A.3: Verify consultation_messages DB invariant constraint exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'chk_consultation_messages_patient_unapproved'
      AND conrelid = 'public.consultation_messages'::regclass
  ) THEN
    RAISE EXCEPTION 'Missing chk_consultation_messages_patient_unapproved constraint on consultation_messages.';
  END IF;

  RAISE NOTICE 'PASS [1]: 24-table RLS, direct-write bypass closure, consultation invariant & 19 SECURITY DEFINER ACLs verified.';
END;
$$;

-- =============================================================================
-- 2. DIRECT-WRITE BYPASS NEGATIVE TESTS, H1/H2, AUDIT INTEGRITY & CROSS-TENANT RLS
-- =============================================================================
DO $$
DECLARE
  v_orig_user     text := current_user;
  v_pharm_a       uuid := '11119001-1111-4111-8111-111111111111';
  v_pharm_b       uuid := '22229002-2222-4222-8222-222222222222';
  v_owner_a_uid   uuid := 'aaaa9001-1111-4111-8111-111111111111';
  v_inact_a_uid   uuid := 'aaaa9003-1111-4111-8111-111111111111';
  v_pat_a_uid     uuid := 'aaaa9004-1111-4111-8111-111111111111';
  v_owner_b_uid   uuid := 'bbbb9001-2222-4222-8222-222222222222';
  v_pat_a         uuid;
  v_pat_b         uuid;
  v_plan_a        uuid;
  v_thread_a      uuid;
  v_sched_daily   jsonb := '{"frequencyType":"daily","timesPerDay":2,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1},{"id":"s2","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb;
  v_res           jsonb;
  v_inactive_cnt  integer;
  v_active_cnt    integer;
  v_audit_meta    jsonb;
  v_verif_status  text;
  v_audit_cnt     integer;
  v_pat_msg_cnt   integer;
BEGIN
  -- Seed isolated fictional test Auth users & two fictional pharmacies directly inside ROLLBACK transaction
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_owner_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'post.owner.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_inact_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'post.inact.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_pat_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'post.patient.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_owner_b_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'post.owner.b@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO public.pharmacies (
    id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
  ) VALUES
    (v_pharm_a, 'صيدلية اختبار أ', 'Test Pharmacy A', 'بغداد', 'بغداد', 'IQ-POST-A1', '07709990001', 'Asia/Baghdad', true),
    (v_pharm_b, 'صيدلية اختبار ب', 'Test Pharmacy B', 'البصرة', 'البصرة', 'IQ-POST-B1', '07809990001', 'Asia/Baghdad', true);

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  ) VALUES
    (v_owner_a_uid, v_pharm_a, 'د. أمل بغداد', 'pharmacy_owner', 'SYN-POST-A1', '07709990002', true, v_owner_a_uid),
    (v_inact_a_uid, v_pharm_a, 'د. موقوف', 'authorized_pharmacist', 'SYN-POST-A2', '07709990003', false, v_owner_a_uid),
    (v_owner_b_uid, v_pharm_b, 'د. سارة البصرة', 'pharmacy_owner', 'SYN-POST-B1', '07809990002', true, v_owner_b_uid);

  -- Non-destructive replay check: claim_first_owner_bootstrap refuses because pharmacies exist
  v_res := public.claim_first_owner_bootstrap('idem-post-replay-check-0001', '99993001-0000-4000-8000-000000000001'::uuid, 120);
  IF COALESCE(v_res->>'errorCode', '') <> 'BOOTSTRAP_ALREADY_COMPLETED' THEN
    RAISE EXCEPTION 'Expected claim_first_owner_bootstrap to report BOOTSTRAP_ALREADY_COMPLETED, got %', v_res;
  END IF;

  -- Switch cleanly into authenticated Pharmacy A owner session
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_owner_a_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Create patient & medication plan via authoritative RPCs
  v_res := public.create_patient_with_clinical_tags(
    'PAT-POST-A1', 'حيدر كاظم', '07705551122', 'self', NULL, '1970-05-15', 'male', 'whatsapp',
    'Notes', '2026-11-14',
    '["Type 2 Diabetes","Hypertension"]'::jsonb,
    '[{"substance":"Penicillin","severity":"severe","reaction":"Anaphylaxis"},{"substance":"Sulfa","severity":"moderate","reaction":"Rash"}]'::jsonb
  );
  v_pat_a := (v_res->>'patientId')::uuid;

  v_res := public.create_medication_plan_with_version(
    v_pat_a, NULL, 'Glucophage', 'Metformin', '500 mg', 'tablet', 'oral',
    1, 'قرص', 'after_food', 'قرص صباحاً وقرص مساءً بعد الأكل', NULL, NULL,
    '2026-11-14', NULL, true, NULL, v_sched_daily
  );
  v_plan_a := (v_res->>'planId')::uuid;

  -- Record valid dispensing via authoritative RPC -> must store provisional_unverified
  v_res := public.record_dispensing_with_refill(
    v_pat_a, v_plan_a, 60, 'قرص', NULL, NULL, NULL, NULL, '2026-11-14', false, NULL,
    2, 30, '2026-12-14', 'Daily 2x/day', 60, 60, 30, 'on_track', '2026-12-14', NULL
  );

  SELECT verification_status INTO v_verif_status FROM public.refill_assessments WHERE medication_plan_id = v_plan_a;
  IF v_verif_status <> 'provisional_unverified' THEN
    RAISE EXCEPTION 'H1 failed: expected provisional_unverified provenance, got %', v_verif_status;
  END IF;

  -- =========================================================================
  -- Audit H1 Negative Bypass Tests: ALL direct writes on RPC-governed tables MUST FAIL (42501)
  -- =========================================================================
  BEGIN
    UPDATE public.patient_allergies SET status = 'inactive' WHERE patient_id = v_pat_a;
    RAISE EXCEPTION 'BYPASS FAILURE: Direct UPDATE on patient_allergies succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name)
    VALUES (v_pharm_a, v_pat_a, 'Bypass Condition');
    RAISE EXCEPTION 'BYPASS FAILURE: Direct INSERT on patient_conditions succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.patient_medication_plans (
      pharmacy_id, patient_id, brand_name, generic_name, strength, dosage_form, route,
      dose_amount, dose_unit, food_relation, verified_instructions, start_date, schedule, created_by_staff_id
    ) VALUES (
      v_pharm_a, v_pat_a, 'Bypass', 'Bypass', '10mg', 'tablet', 'oral',
      1, 'قرص', 'anytime', 'Direct bypass', '2026-11-14', v_sched_daily, v_owner_a_uid
    );
    RAISE EXCEPTION 'BYPASS FAILURE: Direct INSERT on patient_medication_plans succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.regimen_versions SET effective_to = '2026-11-15' WHERE medication_plan_id = v_plan_a;
    RAISE EXCEPTION 'BYPASS FAILURE: Direct UPDATE on regimen_versions succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.medication_pause_periods (pharmacy_id, medication_plan_id, paused_from, reason, recorded_by_staff_id)
    VALUES (v_pharm_a, v_plan_a, '2026-11-14', 'Bypass pause', v_owner_a_uid);
    RAISE EXCEPTION 'BYPASS FAILURE: Direct INSERT on medication_pause_periods succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.dispensing_events (
      pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
      dispensed_quantity, quantity_unit, dispensing_date, dispensed_by_staff_id,
      dispensed_by_staff_name, forecast_assumptions, calculation_source, verification_status
    ) VALUES (
      v_pharm_a, v_pat_a, v_plan_a, 1, 999, 'قرص', '2026-11-14', v_owner_a_uid,
      'د. أمل بغداد', 'Forged', 'server_recomputed', 'server_verified'
    );
    RAISE EXCEPTION 'BYPASS FAILURE: Direct INSERT forging server_verified dispensing_events succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.refill_assessments
       SET calculation_source = 'server_recomputed',
           verification_status = 'server_verified'
     WHERE medication_plan_id = v_plan_a;
    RAISE EXCEPTION 'BYPASS FAILURE: Direct UPDATE forging server_verified on refill_assessments succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.patients SET full_name = 'Direct Bypass Rename' WHERE id = v_pat_a;
    RAISE EXCEPTION 'BYPASS FAILURE: Direct demographic UPDATE on patients succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- Permitted single-table archive/restore on patients succeeds & triggers audit log
  UPDATE public.patients
     SET status = 'archived', archived_at = '2026-11-14', archived_reason = 'Test archive', updated_at = now()
   WHERE id = v_pat_a;
  UPDATE public.patients
     SET status = 'active', archived_at = NULL, archived_reason = NULL, updated_at = now()
   WHERE id = v_pat_a;

  -- H2: Soft-deactivation via RPC + audit metadata preservation + invalid p_patch rollback
  PERFORM public.update_patient_with_clinical_tags(
    v_pat_a,
    '{"clinical_notes":"Updated note"}'::jsonb,
    '["Type 2 Diabetes"]'::jsonb,
    '[{"substance":"Penicillin","severity":"severe","reaction":"Anaphylaxis"}]'::jsonb
  );
  SELECT count(*)::integer INTO v_active_cnt FROM public.patient_allergies WHERE patient_id = v_pat_a AND status = 'active';
  SELECT count(*)::integer INTO v_inactive_cnt FROM public.patient_allergies WHERE patient_id = v_pat_a AND status = 'inactive' AND removed_at IS NOT NULL;
  IF v_active_cnt <> 1 OR v_inactive_cnt <> 1 THEN
    RAISE EXCEPTION 'H2 failed: expected 1 active & 1 soft-deactivated allergy, got active=% inactive=%', v_active_cnt, v_inactive_cnt;
  END IF;

  SELECT metadata INTO v_audit_meta
  FROM public.audit_logs
  WHERE entity_id = v_pat_a AND action = 'PATIENT_UPDATED'
  ORDER BY timestamp DESC LIMIT 1;
  IF jsonb_array_length(v_audit_meta->'previousAllergies') <> 2 OR jsonb_array_length(v_audit_meta->'currentAllergies') <> 1 THEN
    RAISE EXCEPTION 'H2 failed: audit_logs metadata missing before/after allergy history: %', v_audit_meta;
  END IF;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_pat_a, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    RAISE EXCEPTION 'Expected invalid p_patch array to fail.';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  -- H1 Tampered rate, unit mismatch, and stale cumulative sum rejected with 23514
  BEGIN
    PERFORM public.record_dispensing_with_refill(
      v_pat_a, v_plan_a, 60, 'قرص', NULL, NULL, NULL, NULL, '2026-11-14', false, NULL,
      10, 6, '2026-11-20', 'Tampered rate', 120, 60, 6, 'due_soon', '2026-11-20', NULL
    );
    RAISE EXCEPTION 'H1 failed: tampered daily rate (10 vs 2) should raise 23514.';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    PERFORM public.record_dispensing_with_refill(
      v_pat_a, v_plan_a, 30, 'قرص', NULL, NULL, NULL, NULL, '2026-11-14', true, NULL,
      2, 15, '2026-11-29', 'Stale cumulative', 30, 30, 15, 'on_track', '2026-11-29', NULL
    );
    RAISE EXCEPTION 'H1 failed: stale total_dispensed_analyzed (30 vs 90) should raise 23514.';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Audit M1 Integrity: Direct consultation_messages pharmacist bypass blocked;
  -- setting masar.skip_thread_audit_trigger = '1' CANNOT suppress CONSULTATION_STATUS_UPDATED!
  INSERT INTO public.consultation_threads (pharmacy_id, patient_id, subject, status)
  VALUES (v_pharm_a, v_pat_a, 'Medication timing question', 'open')
  RETURNING id INTO v_thread_a;

  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_a, v_thread_a, 'pharmacist', v_owner_a_uid, 'د. أمل بغداد', 'Direct bypass msg', true
    );
    RAISE EXCEPTION 'BYPASS FAILURE: Direct pharmacist INSERT into consultation_messages succeeded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM pg_catalog.set_config('masar.skip_thread_audit_trigger', '1', true);
  UPDATE public.consultation_threads SET status = 'follow_up', updated_at = now() WHERE id = v_thread_a;

  SELECT count(*)::integer INTO v_audit_cnt
  FROM public.audit_logs
  WHERE entity_id = v_thread_a AND action = 'CONSULTATION_STATUS_UPDATED';
  IF v_audit_cnt <> 1 THEN
    RAISE EXCEPTION 'Audit M1 failed: session GUC suppressed CONSULTATION_STATUS_UPDATED audit entry (count=%).', v_audit_cnt;
  END IF;

  PERFORM public.send_consultation_reply(v_thread_a, 'خذ الجرعة بعد العشاء بساعتين.', 'resolved');
  SELECT count(*)::integer INTO v_audit_cnt
  FROM public.audit_logs
  WHERE entity_id = v_thread_a AND action IN ('CONSULTATION_REPLIED', 'CONSULTATION_STATUS_UPDATED');
  IF v_audit_cnt < 3 THEN
    RAISE EXCEPTION 'Expected non-bypassable consultation reply + status audit entries (>=3), got %.', v_audit_cnt;
  END IF;

  -- Stage 2B.2A.3 Issue A: Simulated patient session consultation_messages tests (DRAFT — NOT EXECUTED IN POSTGRESQL)
  -- Temporarily bind simulated patient auth_user_id inside ROLLBACK transaction to test patient RLS + CHECK
  RESET ROLE;
  UPDATE public.patients SET auth_user_id = v_pat_a_uid WHERE id = v_pat_a;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_pat_a_uid::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_pat_a_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- Negative test 1: Patient CANNOT insert patient message claiming approved_by_pharmacist = true
  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_a, v_thread_a, 'patient', NULL, 'حيدر كاظم', 'Forged approval message', true
    );
    RAISE EXCEPTION 'BYPASS FAILURE: Patient direct INSERT with approved_by_pharmacist=true succeeded.';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN check_violation THEN NULL;
  END;

  -- Negative test 2: Patient CANNOT insert spoofed pharmacist-authored message
  BEGIN
    INSERT INTO public.consultation_messages (
      pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
    ) VALUES (
      v_pharm_a, v_thread_a, 'pharmacist', v_owner_a_uid, 'د. أمل بغداد', 'Spoofed pharmacist message', true
    );
    RAISE EXCEPTION 'BYPASS FAILURE: Patient direct INSERT posing as pharmacist succeeded.';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN check_violation THEN NULL;
  END;

  -- Positive test: Legitimate patient-origin message with approved_by_pharmacist = false succeeds
  INSERT INTO public.consultation_messages (
    pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist
  ) VALUES (
    v_pharm_a, v_thread_a, 'patient', NULL, 'حيدر كاظم', 'هل أستمر على نفس الجرعة غداً؟', false
  );

  SELECT count(*)::integer INTO v_pat_msg_cnt
  FROM public.consultation_messages
  WHERE thread_id = v_thread_a AND sender_type = 'patient' AND approved_by_pharmacist = false;
  IF v_pat_msg_cnt <> 1 THEN
    RAISE EXCEPTION 'Expected 1 legitimate unapproved patient consultation message, found %.', v_pat_msg_cnt;
  END IF;

  -- Restore active pharmacist session and confirm pharmacist RPC reply remains functional
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_owner_a_uid::text, 'role', 'authenticated')::text, true);
  PERFORM public.send_consultation_reply(v_thread_a, 'نعم استمر على نفس الجرعة حسب الجدول.', 'follow_up');

  -- Inactive staff & Cross-pharmacy 42501 checks
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_inact_a_uid::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_inact_a_uid::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.change_medication_plan_status(v_plan_a, 'paused', 'Unauthorized pause');
    RAISE EXCEPTION 'Expected inactive staff to be denied with 42501.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner_b_uid::text, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', json_build_object('sub', v_owner_b_uid::text, 'role', 'authenticated')::text, true);
  v_res := public.create_patient_with_clinical_tags(
    'PAT-POST-B1', 'زهرة البصري', '07803334455', 'self', NULL, '1978-01-01', 'female', 'whatsapp',
    'Notes', '2026-11-14', '[]'::jsonb, '[]'::jsonb
  );
  v_pat_b := (v_res->>'patientId')::uuid;

  BEGIN
    PERFORM public.update_patient_with_clinical_tags(v_pat_a, '{"full_name":"Tampered"}'::jsonb, NULL, NULL);
    RAISE EXCEPTION 'Cross-pharmacy patient update should raise 42501.';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- PostgreSQL 17-supported role and claims restoration + explicit verification
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);

  IF current_user IS DISTINCT FROM v_orig_user
     OR COALESCE(pg_catalog.current_setting('request.jwt.claims', true), '') <> ''
     OR COALESCE(pg_catalog.current_setting('request.jwt.claim.sub', true), '') <> ''
  THEN
    RAISE EXCEPTION 'Role/claims restoration verification failed (current_user=%, expected=%).', current_user, v_orig_user;
  END IF;

  RAISE NOTICE 'PASS [2]: Direct-write bypasses blocked, H1/H2, audit trigger integrity, 42501 isolation & PG17 role reset verified.';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
  RAISE;
END;
$$;

ROLLBACK;
