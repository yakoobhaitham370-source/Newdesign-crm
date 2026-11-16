-- =============================================================================
-- MASAR Care — Stage 2B Migration 0003 Clean-State Bootstrap & Staff Claim Test
-- Target Database: PostgreSQL 17+ (Supabase Disposable Development Instance ONLY)
-- Status: DRAFT — NOT EXECUTED AGAINST POSTGRESQL
--
-- EXECUTION ORDER REQUIREMENT (Stage 2B.2A.2 H3):
--   - MUST execute ONLY on a CLEAN database BEFORE creating the first live
--     pharmacy / pharmacy_owner via `bootstrap-first-owner`.
--   - Fails immediately if `public.pharmacies`, `public.pharmacy_staff`, or
--     `public.bootstrap_state` already contain rows.
--   - Wrapped in `BEGIN; ... ROLLBACK;` so zero fictional fixtures persist and
--     the database remains completely clean for real dev owner bootstrap.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_pharm_cnt     integer;
  v_staff_cnt     integer;
  v_boot_cnt      integer;
  v_owner_a_uid   uuid := 'aaaa2001-1111-4111-8111-111111111111';
  v_staff_a_uid   uuid := 'aaaa2002-1111-4111-8111-111111111111';
  v_other_uid     uuid := 'aaaa2003-1111-4111-8111-111111111111';
  v_req1          uuid := '99991001-0000-4000-8000-000000000001';
  v_req2          uuid := '99991002-0000-4000-8000-000000000002';
  v_sreq1         uuid := '99992001-0000-4000-8000-000000000001';
  v_sreq2         uuid := '99992002-0000-4000-8000-000000000002';
  v_res           jsonb;
  v_pharm_id      uuid;
BEGIN
  SELECT count(*)::integer INTO v_pharm_cnt FROM public.pharmacies;
  SELECT count(*)::integer INTO v_staff_cnt FROM public.pharmacy_staff;
  SELECT count(*)::integer INTO v_boot_cnt FROM public.bootstrap_state;

  IF v_pharm_cnt > 0 OR v_staff_cnt > 0 OR v_boot_cnt > 0 THEN
    RAISE EXCEPTION
      'CLEAN-STATE PRECONDITION FAILED: stage2b_0003_bootstrap_clean_state.test.sql must run BEFORE initial owner bootstrap (pharmacies=%, staff=%, bootstrap_state=%).',
      v_pharm_cnt, v_staff_cnt, v_boot_cnt;
  END IF;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    (v_owner_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'clean.owner.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_staff_a_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'clean.staff.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
    (v_other_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'clean.other.a@masar.test.iq', extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

  -- 1. H3 Durable Bootstrap Claim, Competing Claim Lock & Claim Mismatch Guard
  v_res := public.claim_first_owner_bootstrap('idem-clean-boot-0001', v_req1, 120);
  IF COALESCE((v_res->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected initial bootstrap claim to succeed, got %', v_res;
  END IF;

  v_res := public.claim_first_owner_bootstrap('idem-clean-boot-0002', v_req2, 120);
  IF COALESCE(v_res->>'errorCode', '') <> 'BOOTSTRAP_IN_PROGRESS' THEN
    RAISE EXCEPTION 'Expected competing bootstrap claim to return BOOTSTRAP_IN_PROGRESS, got %', v_res;
  END IF;

  v_res := public.finalize_first_owner_bootstrap(
    v_req2, v_owner_a_uid, 'صيدلية الأمل', 'Al-Amal Pharmacy', 'بغداد', 'بغداد',
    'IQ-CLEAN-001', '07701110001', 'د. علي الحسن', '07701110002', 'SYN-CLEAN-1'
  );
  IF COALESCE(v_res->>'errorCode', '') <> 'BOOTSTRAP_CLAIM_MISMATCH' THEN
    RAISE EXCEPTION 'Expected mismatched claim finalize to return BOOTSTRAP_CLAIM_MISMATCH, got %', v_res;
  END IF;

  -- 2. Valid Bootstrap Finalize + Inspect + Replay Lockout
  v_res := public.finalize_first_owner_bootstrap(
    v_req1, v_owner_a_uid, 'صيدلية الأمل', 'Al-Amal Pharmacy', 'بغداد', 'بغداد',
    'IQ-CLEAN-001', '07701110001', 'د. علي الحسن', '07701110002', 'SYN-CLEAN-1'
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected valid bootstrap finalize to succeed, got %', v_res;
  END IF;
  v_pharm_id := (v_res->>'pharmacyId')::uuid;

  v_res := public.inspect_first_owner_bootstrap_state();
  IF COALESCE(v_res->>'status', '') <> 'completed'
     OR (v_res->>'pharmacyCount')::integer <> 1
     OR (v_res->>'staffCount')::integer <> 1 THEN
    RAISE EXCEPTION 'Expected inspect_first_owner_bootstrap_state completed/1/1, got %', v_res;
  END IF;

  v_res := public.claim_first_owner_bootstrap('idem-clean-boot-replay-0003', v_req2, 120);
  IF COALESCE(v_res->>'errorCode', '') <> 'BOOTSTRAP_ALREADY_COMPLETED' THEN
    RAISE EXCEPTION 'Expected post-completion bootstrap claim to return BOOTSTRAP_ALREADY_COMPLETED, got %', v_res;
  END IF;

  -- 3. H5 Owner-Only Pharmacist Role + Stage 2B.2A.3 Immutable Staff Claim, Expiration & Claim-Required Guard
  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq1,
    'clean.staff.a@masar.test.iq', '07702220001', 'authorized_pharmacist', 120
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected staff provisioning claim to succeed, got %', v_res;
  END IF;

  -- Stage 2B.2A.3 Issue B: Reusing same Idempotency-Key with DIFFERENT email or phone MUST return STAFF_IDEMPOTENCY_KEY_CONFLICT without mutating claim
  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq2,
    'different.staff@masar.test.iq', '07702229999', 'authorized_pharmacist', 120
  );
  IF COALESCE(v_res->>'errorCode', '') <> 'STAFF_IDEMPOTENCY_KEY_CONFLICT' THEN
    RAISE EXCEPTION 'Expected differing target payload on reused key to return STAFF_IDEMPOTENCY_KEY_CONFLICT, got %', v_res;
  END IF;

  -- Competing concurrent retry with same canonical target returns STAFF_PROVISIONING_IN_PROGRESS
  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq2,
    'clean.staff.a@masar.test.iq', '07702220001', 'authorized_pharmacist', 120
  );
  IF COALESCE(v_res->>'errorCode', '') <> 'STAFF_PROVISIONING_IN_PROGRESS' THEN
    RAISE EXCEPTION 'Expected competing staff claim to return STAFF_PROVISIONING_IN_PROGRESS, got %', v_res;
  END IF;

  -- Simulate TTL expiration on an in-flight claim without completion:
  -- Reused key after TTL must escalate conservatively to failed_needs_reconciliation (NEVER overwrite!)
  UPDATE public.staff_provisioning_requests
     SET claim_expires_at = pg_catalog.now() - interval '10 seconds'
   WHERE request_id = v_sreq1;

  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq2,
    'clean.staff.a@masar.test.iq', '07702220001', 'authorized_pharmacist', 120
  );
  IF COALESCE(v_res->>'errorCode', '') <> 'STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'Expected expired claimed row to return STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED, got %', v_res;
  END IF;

  -- After verifying Auth has NO user (p_auth_user_exists = false) and DB has no staff row,
  -- conservative reconciliation releases the canonical key cleanly for retry:
  v_res := public.reconcile_expired_staff_provisioning_claim(
    v_owner_a_uid, v_sreq1, false, NULL, 'Verified no Auth user was created before TTL expiry'
  );
  IF COALESCE(v_res->>'status', '') <> 'rolled_back' THEN
    RAISE EXCEPTION 'Expected conservative reconciliation to transition expired claim to rolled_back, got %', v_res;
  END IF;

  -- Canonical retry now claims cleanly with v_sreq1
  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq1,
    'clean.staff.a@masar.test.iq', '07702220001', 'authorized_pharmacist', 120
  );
  IF COALESCE((v_res->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Expected canonical retry after Auth-verified reconciliation to succeed, got %', v_res;
  END IF;

  -- Claimless provisioning (p_request_id IS NULL) MUST raise 23514
  BEGIN
    PERFORM public.provision_pharmacy_staff_by_owner(
      v_owner_a_uid, v_staff_a_uid, 'د. فرح محمد', 'authorized_pharmacist', '07702220001', 'SYN-CLEAN-2', NULL
    );
    RAISE EXCEPTION 'Expected claimless provision_pharmacy_staff_by_owner (NULL p_request_id) to raise 23514.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- H5: Attempting pharmacy_owner delegation raises 23514
  BEGIN
    PERFORM public.provision_pharmacy_staff_by_owner(
      v_owner_a_uid, v_staff_a_uid, 'د. فرح محمد', 'pharmacy_owner', '07702220001', 'SYN-CLEAN-2', v_sreq1
    );
    RAISE EXCEPTION 'Expected pharmacy_owner delegation attempt to raise 23514.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  v_res := public.provision_pharmacy_staff_by_owner(
    v_owner_a_uid, v_staff_a_uid, 'د. فرح محمد', 'authorized_pharmacist', '07702220001', 'SYN-CLEAN-2', v_sreq1
  );
  IF COALESCE(v_res->>'role', '') <> 'authorized_pharmacist' OR (v_res->>'pharmacyId')::uuid <> v_pharm_id THEN
    RAISE EXCEPTION 'Expected authorized_pharmacist provisioning success, got %', v_res;
  END IF;

  -- Stage 2B.2A.2 H4: Inspect confirms committed staff row even if caller lost RPC response
  v_res := public.inspect_staff_provisioning_state(v_owner_a_uid, v_sreq1, v_staff_a_uid);
  IF COALESCE((v_res->>'staffExistsInDb')::boolean, false) IS DISTINCT FROM true
     OR COALESCE(v_res->>'status', '') <> 'completed' THEN
    RAISE EXCEPTION 'Expected inspect_staff_provisioning_state to report staffExistsInDb=true and completed, got %', v_res;
  END IF;

  -- Replay of completed Idempotency-Key returns STAFF_PROVISIONING_ALREADY_COMPLETED
  v_res := public.claim_staff_provisioning_request(
    v_owner_a_uid, 'idem-clean-staff-0001', v_sreq2,
    'clean.staff.a@masar.test.iq', '07702220001', 'authorized_pharmacist', 120
  );
  IF COALESCE(v_res->>'errorCode', '') <> 'STAFF_PROVISIONING_ALREADY_COMPLETED' THEN
    RAISE EXCEPTION 'Expected completed staff idempotency replay to return STAFF_PROVISIONING_ALREADY_COMPLETED, got %', v_res;
  END IF;

  -- Non-owner staff cannot claim or provision staff (42501)
  BEGIN
    PERFORM public.claim_staff_provisioning_request(
      v_staff_a_uid, 'idem-clean-staff-nonowner', v_sreq2,
      'clean.other.a@masar.test.iq', '07702220009', 'authorized_pharmacist', 120
    );
    RAISE EXCEPTION 'Expected non-owner staff claim attempt to raise 42501.';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  RAISE NOTICE 'PASS [CLEAN-STATE]: 0003 first-owner bootstrap, immutable staff idempotency, expiration recovery & claim guard verified cleanly.';
END;
$$;

ROLLBACK;
