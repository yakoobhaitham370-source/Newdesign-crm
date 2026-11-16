-- ============================================================================
-- MASAR Care â€” Stage 2B.2A.3 Database Migration 0003 (Hardened Draft â€” Review Only)
-- Atomic Multi-Table Clinical RPCs, Closed Direct-Write Bypasses,
-- Consultation Approval Provenance Lock, Immutable Staff Provisioning Idempotency,
-- History-Preserving Clinical Tags, Server-Validated Refill Provenance,
-- Durable First-Owner & Staff Provisioning State Machines,
-- Secure Invitation Revocation & Non-Bypassable Clinical Audit Triggers
--
-- STATUS: REVIEW ONLY â€” DO NOT EXECUTE WITHOUT EXPLICIT STAGE 2B.2B APPROVAL
-- Approved Architecture: Option B (Single Shared Supabase Project + Strict RLS)
-- Target Baseline: 0001_stage2a_core_schema.sql + 0002_stage2a_rls_and_security.sql
-- Default Timezone: Asia/Baghdad (UTC+3)
-- Post-0003 Protected Public Table Count: 24 (22 Stage 2A tables + public.bootstrap_state + public.staff_provisioning_requests)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Durable First-Owner Bootstrap Sentinel & State Machine (service_role ONLY)
--    Replaces ephemeral cross-RPC advisory lock assumption with a durable claim
--    state machine (`pending`, `claimed`, `completed`, `failed_needs_reconciliation`),
--    idempotency key, claim TTL, and orphan Auth reconciliation tracking.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bootstrap_state (
  singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key = true),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'failed_needs_reconciliation')),
  idempotency_key text,
  claimed_by_request_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  pharmacy_id uuid REFERENCES public.pharmacies(id) ON DELETE RESTRICT,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  orphan_auth_user_id uuid,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bootstrap_state
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS claimed_by_request_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS orphan_auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

REVOKE ALL ON TABLE public.bootstrap_state FROM PUBLIC, anon, authenticated;
ALTER TABLE public.bootstrap_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bootstrap_state FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 1B. Additive Clinical History & Refill Provenance Schema Extensions (H1, H2)
-- ----------------------------------------------------------------------------
ALTER TABLE public.patient_conditions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by_staff_id uuid,
  ADD COLUMN IF NOT EXISTS removal_reason text;

ALTER TABLE public.patient_allergies
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by_staff_id uuid,
  ADD COLUMN IF NOT EXISTS removal_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_patient_conditions_removed_by_staff'
  ) THEN
    ALTER TABLE public.patient_conditions
      ADD CONSTRAINT fk_patient_conditions_removed_by_staff
      FOREIGN KEY (removed_by_staff_id, pharmacy_id)
      REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'fk_patient_allergies_removed_by_staff'
  ) THEN
    ALTER TABLE public.patient_allergies
      ADD CONSTRAINT fk_patient_allergies_removed_by_staff
      FOREIGN KEY (removed_by_staff_id, pharmacy_id)
      REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- Prevent direct client DELETE on clinical condition/allergy history (soft-deactivation only)
REVOKE DELETE ON TABLE public.patient_conditions FROM authenticated;
REVOKE DELETE ON TABLE public.patient_allergies FROM authenticated;

ALTER TABLE public.dispensing_events
  ADD COLUMN IF NOT EXISTS calculation_source text NOT NULL DEFAULT 'provisional_client_unverified'
    CHECK (calculation_source IN ('server_recomputed', 'provisional_client_unverified')),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'provisional_unverified'
    CHECK (verification_status IN ('server_verified', 'provisional_unverified')),
  ADD COLUMN IF NOT EXISTS algorithm_version text NOT NULL DEFAULT 'masar_refill_v1',
  ADD COLUMN IF NOT EXISTS calculation_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.refill_assessments
  ADD COLUMN IF NOT EXISTS calculation_source text NOT NULL DEFAULT 'provisional_client_unverified'
    CHECK (calculation_source IN ('server_recomputed', 'provisional_client_unverified')),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'provisional_unverified'
    CHECK (verification_status IN ('server_verified', 'provisional_unverified')),
  ADD COLUMN IF NOT EXISTS algorithm_version text NOT NULL DEFAULT 'masar_refill_v1',
  ADD COLUMN IF NOT EXISTS calculation_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 1C. Close Direct-Write Bypasses on RPC-Governed Tables (Stage 2B.2A.2 H1 Fix)
--     Preserves `0001`/`0002` historical files intact while additively revoking
--     direct `authenticated` INSERT/UPDATE/DELETE grants & write policies where
--     atomic 0003 RPCs are the authoritative mutation path.
--     Preserves legitimate `SELECT` reads, `patients` archive/restore status
--     updates, `dose_events` status updates & `confirm_scheduled_dose(...)`,
--     `unscheduled_dose_reports`, `lab_results`, `follow_up_*`,
--     `consultation_threads`, and patient-only `consultation_messages` inserts.
-- ----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON TABLE public.patient_conditions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.patient_allergies FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.patient_medication_plans FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.regimen_versions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.medication_pause_periods FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.dispensing_events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.refill_assessments FROM authenticated;

-- Narrow direct `public.patients` writes exclusively to archive/restore columns
-- (audited by `trg_audit_patients_status`); creation and profile edits MUST use
-- `create_patient_with_clinical_tags` / `update_patient_with_clinical_tags`.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.patients FROM authenticated;
GRANT UPDATE (status, archived_at, archived_reason, updated_at) ON public.patients TO authenticated;

-- Defense-in-depth: drop direct-write RLS policies on RPC-governed tables
DROP POLICY IF EXISTS conditions_pharmacist_write ON public.patient_conditions;
DROP POLICY IF EXISTS allergies_pharmacist_write ON public.patient_allergies;
DROP POLICY IF EXISTS med_plans_pharmacist_insert ON public.patient_medication_plans;
DROP POLICY IF EXISTS med_plans_pharmacist_update ON public.patient_medication_plans;
DROP POLICY IF EXISTS regimen_versions_pharmacist_insert ON public.regimen_versions;
DROP POLICY IF EXISTS regimen_versions_pharmacist_close ON public.regimen_versions;
DROP POLICY IF EXISTS pause_periods_pharmacist_write ON public.medication_pause_periods;
DROP POLICY IF EXISTS dispensing_events_pharmacist_insert ON public.dispensing_events;
DROP POLICY IF EXISTS refill_assessments_pharmacist_write ON public.refill_assessments;
DROP POLICY IF EXISTS patients_pharmacist_insert ON public.patients;

-- Pharmacist consultation replies must go through `send_consultation_reply` RPC;
-- direct client inserts on `consultation_messages` are restricted strictly to
-- unapproved patient-origin messages (`approved_by_pharmacist = false`, `sender_staff_id IS NULL`).
REVOKE UPDATE, DELETE ON TABLE public.consultation_messages FROM authenticated;

DROP POLICY IF EXISTS consultation_messages_patient_only_direct_insert ON public.consultation_messages;
CREATE POLICY consultation_messages_patient_only_direct_insert ON public.consultation_messages
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'patient'
    AND sender_staff_id IS NULL
    AND approved_by_pharmacist = false
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'chk_consultation_messages_patient_unapproved'
      AND conrelid = 'public.consultation_messages'::regclass
  ) THEN
    ALTER TABLE public.consultation_messages
      ADD CONSTRAINT chk_consultation_messages_patient_unapproved
      CHECK (
        (sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false)
        OR (sender_type = 'pharmacist' AND sender_staff_id IS NOT NULL AND approved_by_pharmacist = true)
      );
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1D. Durable Staff Provisioning State Machine (service_role ONLY â€” Stage 2B.2A.3)
--     Binds each (pharmacy_id, idempotency_key) to an immutable canonical
--     `request_fingerprint` so changed target attributes are never accepted.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_provisioning_requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  pharmacy_id uuid NOT NULL REFERENCES public.pharmacies(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES public.pharmacy_staff(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  target_email text NOT NULL,
  target_phone text NOT NULL,
  target_role text NOT NULL DEFAULT 'authorized_pharmacist'
    CHECK (target_role = 'authorized_pharmacist'),
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'completed', 'rolled_back', 'failed_needs_reconciliation')),
  claim_expires_at timestamptz,
  staff_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  orphan_auth_user_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (pharmacy_id, idempotency_key)
);

ALTER TABLE public.staff_provisioning_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

REVOKE ALL ON TABLE public.staff_provisioning_requests FROM PUBLIC, anon, authenticated;
ALTER TABLE public.staff_provisioning_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_provisioning_requests FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. Private Security & Clinical Validation Helpers (`app_security` schema)
--    All SECURITY DEFINER functions pin minimal `SET search_path = pg_catalog, pg_temp`
--    and schema-qualify all table and helper references.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.require_active_pharmacist_context()
RETURNS TABLE (
  staff_id uuid,
  pharmacy_id uuid,
  full_name text,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required: no active user session.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ps.id, ps.pharmacy_id, ps.full_name, ps.role
  FROM public.pharmacy_staff ps
  JOIN public.pharmacies ph ON ph.id = ps.pharmacy_id
  WHERE ps.id = v_uid
    AND ps.is_active = true
    AND ph.is_active = true
    AND ps.role IN ('pharmacy_owner', 'authorized_pharmacist')
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authorization denied: active pharmacist staff membership in an active pharmacy is required.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.require_active_pharmacist_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.require_active_pharmacist_context() TO service_role;

CREATE OR REPLACE FUNCTION app_security.normalize_clinical_unit_category(p_unit text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_u text;
BEGIN
  v_u := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_unit, '')));
  IF v_u IN ('tablet', 'tablets', 'Ù‚Ø±Øµ', 'Ø£Ù‚Ø±Ø§Øµ', 'Ø­Ø¨Ø©', 'Ø­Ø¨Ø§Øª') THEN
    RETURN 'tablet';
  ELSIF v_u IN ('capsule', 'capsules', 'ÙƒØ¨Ø³ÙˆÙ„Ø©', 'ÙƒØ¨Ø³ÙˆÙ„Ø§Øª') THEN
    RETURN 'capsule';
  ELSIF v_u IN ('ml', 'Ù…Ù„ÙŠ', 'Ù…Ù„') THEN
    RETURN 'ml';
  ELSIF v_u IN ('puff', 'puffs', 'Ø¨Ø®Ø©', 'Ø¨Ø®Ø§Øª') THEN
    RETURN 'puff';
  ELSIF v_u IN ('iu', 'unit', 'units', 'ÙˆØ­Ø¯Ø©', 'ÙˆØ­Ø¯Ø§Øª') THEN
    RETURN 'iu';
  ELSIF v_u IN ('drop', 'drops', 'Ù‚Ø·Ø±Ø©', 'Ù‚Ø·Ø±Ø§Øª') THEN
    RETURN 'drop';
  ELSIF v_u IN ('sachet', 'sachets', 'ÙƒÙŠØ³', 'Ø£ÙƒÙŠØ§Ø³', 'Ø¸Ø±Ù') THEN
    RETURN 'sachet';
  ELSIF v_u IN ('ampoule', 'vial', 'injection', 'Ø¥Ø¨Ø±Ø©', 'Ø£Ù…Ø¨ÙˆÙ„Ø©', 'ÙÙŠØ§Ù„') THEN
    RETURN 'injection_vial';
  END IF;
  RETURN v_u;
END;
$$;

REVOKE ALL ON FUNCTION app_security.normalize_clinical_unit_category(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.normalize_clinical_unit_category(text) TO service_role;

CREATE OR REPLACE FUNCTION app_security.compute_plan_daily_rate(
  p_schedule jsonb,
  p_dose_amount numeric,
  p_status text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_freq          text;
  v_slot_sum      numeric := 0;
  v_first_slot    numeric;
  v_interval_val  numeric;
  v_interval_unit text;
  v_weekdays_len  integer;
  v_on_days       numeric;
  v_off_days      numeric;
  v_rate          numeric;
BEGIN
  IF p_status IS DISTINCT FROM 'active' OR p_schedule IS NULL THEN
    RETURN NULL;
  END IF;

  v_freq := COALESCE(p_schedule->>'frequencyType', '');
  IF v_freq = 'prn' THEN
    RETURN NULL;
  END IF;

  IF pg_catalog.jsonb_typeof(p_schedule->'doseSlots') = 'array' THEN
    SELECT COALESCE(pg_catalog.sum((elem->>'doseAmount')::numeric), 0)
      INTO v_slot_sum
    FROM pg_catalog.jsonb_array_elements(p_schedule->'doseSlots') AS elem
    WHERE (elem->>'doseAmount') ~ '^[0-9]+(\.[0-9]+)?$'
      AND (elem->>'doseAmount')::numeric > 0;
  END IF;

  IF v_freq = 'daily' THEN
    v_rate := CASE
      WHEN v_slot_sum > 0 THEN v_slot_sum
      ELSE p_dose_amount * GREATEST(1, COALESCE((p_schedule->>'timesPerDay')::numeric, 1))
    END;
  ELSIF v_freq = 'interval' THEN
    v_interval_val := GREATEST(1, COALESCE((p_schedule->>'intervalValue')::numeric, 1));
    v_interval_unit := COALESCE(p_schedule->>'intervalUnit', 'days');
    IF v_interval_unit = 'hours' THEN
      SELECT (elem->>'doseAmount')::numeric
        INTO v_first_slot
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_schedule->'doseSlots', '[]'::jsonb)) AS elem
      WHERE (elem->>'doseAmount') ~ '^[0-9]+(\.[0-9]+)?$'
        AND (elem->>'doseAmount')::numeric > 0
      LIMIT 1;
      v_rate := (24.0 / v_interval_val) * COALESCE(v_first_slot, p_dose_amount);
    ELSIF v_interval_unit = 'weeks' THEN
      v_rate := COALESCE(NULLIF(v_slot_sum, 0), p_dose_amount) / (v_interval_val * 7.0);
    ELSE
      v_rate := COALESCE(NULLIF(v_slot_sum, 0), p_dose_amount) / v_interval_val;
    END IF;
  ELSIF v_freq = 'weekdays' THEN
    v_weekdays_len := CASE
      WHEN pg_catalog.jsonb_typeof(p_schedule->'selectedWeekdays') = 'array'
        THEN pg_catalog.jsonb_array_length(p_schedule->'selectedWeekdays')
      ELSE 0
    END;
    IF v_weekdays_len <= 0 THEN
      RETURN NULL;
    END IF;
    v_rate := (COALESCE(NULLIF(v_slot_sum, 0), p_dose_amount) * v_weekdays_len) / 7.0;
  ELSIF v_freq = 'cyclic' THEN
    v_on_days := GREATEST(1, COALESCE((p_schedule->>'cycleOnDays')::numeric, 21));
    v_off_days := GREATEST(0, COALESCE((p_schedule->>'cycleOffDays')::numeric, 7));
    v_rate := (COALESCE(NULLIF(v_slot_sum, 0), p_dose_amount) * v_on_days) / (v_on_days + v_off_days);
  ELSIF v_freq = 'variable' THEN
    IF v_slot_sum > 0 THEN
      v_rate := v_slot_sum;
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.round(v_rate, 4);
END;
$$;

REVOKE ALL ON FUNCTION app_security.compute_plan_daily_rate(jsonb, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.compute_plan_daily_rate(jsonb, numeric, text) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Durable Bootstrap State Machine & Reconciliation RPCs (service_role ONLY)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_first_owner_bootstrap(
  p_idempotency_key text,
  p_request_id uuid,
  p_claim_ttl_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean_key text;
  v_state     public.bootstrap_state%ROWTYPE;
BEGIN
  v_clean_key := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF pg_catalog.char_length(v_clean_key) < 16 OR pg_catalog.char_length(v_clean_key) > 128 THEN
    RAISE EXCEPTION 'Idempotency key must be between 16 and 128 characters.'
      USING ERRCODE = '23514';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'Bootstrap request_id is required.'
      USING ERRCODE = '23514';
  END IF;

  IF p_claim_ttl_seconds IS NULL OR p_claim_ttl_seconds < 15 OR p_claim_ttl_seconds > 600 THEN
    RAISE EXCEPTION 'Bootstrap claim TTL must be between 15 and 600 seconds.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_care_first_owner_bootstrap', 0)
  );

  IF EXISTS (SELECT 1 FROM public.pharmacy_staff)
     OR EXISTS (SELECT 1 FROM public.pharmacies)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
    );
  END IF;

  SELECT * INTO v_state
  FROM public.bootstrap_state bs
  WHERE bs.singleton_key = true
  FOR UPDATE;

  IF FOUND THEN
    IF v_state.status = 'completed' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
      );
    END IF;

    IF v_state.status = 'failed_needs_reconciliation' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'BOOTSTRAP_NEEDS_RECONCILIATION',
        'orphanAuthUserId', v_state.orphan_auth_user_id,
        'lastError', v_state.last_error
      );
    END IF;

    IF v_state.status = 'claimed'
       AND v_state.claim_expires_at IS NOT NULL
       AND v_state.claim_expires_at > pg_catalog.now()
    THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'BOOTSTRAP_IN_PROGRESS',
        'claimedByRequestId', v_state.claimed_by_request_id,
        'claimExpiresAt', v_state.claim_expires_at
      );
    END IF;
  END IF;

  INSERT INTO public.bootstrap_state (
    singleton_key, status, idempotency_key, claimed_by_request_id,
    claimed_at, claim_expires_at, started_at, orphan_auth_user_id, last_error, updated_at
  )
  VALUES (
    true,
    'claimed',
    v_clean_key,
    p_request_id,
    pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(secs => p_claim_ttl_seconds),
    pg_catalog.now(),
    NULL,
    NULL,
    pg_catalog.now()
  )
  ON CONFLICT (singleton_key) DO UPDATE
    SET status = 'claimed',
        idempotency_key = EXCLUDED.idempotency_key,
        claimed_by_request_id = EXCLUDED.claimed_by_request_id,
        claimed_at = EXCLUDED.claimed_at,
        claim_expires_at = EXCLUDED.claim_expires_at,
        orphan_auth_user_id = NULL,
        last_error = NULL,
        updated_at = pg_catalog.now();

  RETURN jsonb_build_object(
    'ok', true,
    'claimId', p_request_id,
    'status', 'claimed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_first_owner_bootstrap(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_first_owner_bootstrap(text, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.inspect_first_owner_bootstrap_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state          public.bootstrap_state%ROWTYPE;
  v_pharmacy_count integer;
  v_staff_count    integer;
BEGIN
  SELECT pg_catalog.count(*)::integer INTO v_pharmacy_count FROM public.pharmacies;
  SELECT pg_catalog.count(*)::integer INTO v_staff_count FROM public.pharmacy_staff;
  SELECT * INTO v_state FROM public.bootstrap_state bs WHERE bs.singleton_key = true;

  RETURN jsonb_build_object(
    'status', COALESCE(v_state.status, 'pending'),
    'idempotencyKey', v_state.idempotency_key,
    'claimedByRequestId', v_state.claimed_by_request_id,
    'claimExpiresAt', v_state.claim_expires_at,
    'pharmacyId', v_state.pharmacy_id,
    'ownerUserId', v_state.owner_user_id,
    'orphanAuthUserId', v_state.orphan_auth_user_id,
    'lastError', v_state.last_error,
    'pharmacyCount', v_pharmacy_count,
    'staffCount', v_staff_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_first_owner_bootstrap_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_first_owner_bootstrap_state() TO service_role;

CREATE OR REPLACE FUNCTION public.mark_first_owner_bootstrap_reconciliation(
  p_request_id uuid,
  p_new_status text,
  p_orphan_auth_user_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state public.bootstrap_state%ROWTYPE;
BEGIN
  IF p_new_status NOT IN ('pending', 'failed_needs_reconciliation') THEN
    RAISE EXCEPTION 'Invalid reconciliation target status: %.', p_new_status
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_care_first_owner_bootstrap', 0)
  );

  SELECT * INTO v_state
  FROM public.bootstrap_state bs
  WHERE bs.singleton_key = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'pending');
  END IF;

  IF v_state.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED',
      'pharmacyId', v_state.pharmacy_id,
      'ownerUserId', v_state.owner_user_id
    );
  END IF;

  IF p_request_id IS NOT NULL AND v_state.claimed_by_request_id IS DISTINCT FROM p_request_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_CLAIM_MISMATCH'
    );
  END IF;

  UPDATE public.bootstrap_state
     SET status = p_new_status,
         idempotency_key = CASE WHEN p_new_status = 'pending' THEN NULL ELSE idempotency_key END,
         claimed_by_request_id = CASE WHEN p_new_status = 'pending' THEN NULL ELSE claimed_by_request_id END,
         claimed_at = CASE WHEN p_new_status = 'pending' THEN NULL ELSE claimed_at END,
         claim_expires_at = NULL,
         orphan_auth_user_id = CASE WHEN p_new_status = 'pending' THEN NULL ELSE COALESCE(p_orphan_auth_user_id, orphan_auth_user_id) END,
         last_error = CASE WHEN p_new_status = 'pending' THEN NULL ELSE pg_catalog.left(COALESCE(p_error, ''), 500) END,
         updated_at = pg_catalog.now()
   WHERE singleton_key = true;

  RETURN jsonb_build_object('ok', true, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_first_owner_bootstrap_reconciliation(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_first_owner_bootstrap_reconciliation(uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_first_owner_bootstrap(
  p_request_id uuid,
  p_owner_user_id uuid,
  p_pharmacy_name_ar text,
  p_pharmacy_name_en text,
  p_city text,
  p_governorate text,
  p_license_number text,
  p_pharmacy_phone text,
  p_owner_full_name text,
  p_owner_phone text,
  p_syndicate_license text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state       public.bootstrap_state%ROWTYPE;
  v_pharmacy_id uuid;
BEGIN
  IF p_request_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Request id and owner auth user id are required for bootstrap finalization.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_care_first_owner_bootstrap', 0)
  );

  IF EXISTS (SELECT 1 FROM public.pharmacy_staff)
     OR EXISTS (SELECT 1 FROM public.pharmacies)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
    );
  END IF;

  SELECT * INTO v_state
  FROM public.bootstrap_state bs
  WHERE bs.singleton_key = true
  FOR UPDATE;

  IF FOUND AND v_state.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
    );
  END IF;

  IF FOUND AND v_state.status = 'failed_needs_reconciliation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_NEEDS_RECONCILIATION'
    );
  END IF;

  IF NOT FOUND
     OR v_state.status <> 'claimed'
     OR v_state.claimed_by_request_id IS DISTINCT FROM p_request_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_CLAIM_MISMATCH'
    );
  END IF;

  INSERT INTO public.pharmacies (
    name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
  )
  VALUES (
    pg_catalog.btrim(p_pharmacy_name_ar),
    pg_catalog.btrim(p_pharmacy_name_en),
    pg_catalog.btrim(p_city),
    pg_catalog.btrim(p_governorate),
    pg_catalog.btrim(p_license_number),
    pg_catalog.btrim(p_pharmacy_phone),
    'Asia/Baghdad',
    true
  )
  RETURNING id INTO v_pharmacy_id;

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  )
  VALUES (
    p_owner_user_id,
    v_pharmacy_id,
    pg_catalog.btrim(p_owner_full_name),
    'pharmacy_owner',
    NULLIF(pg_catalog.btrim(COALESCE(p_syndicate_license, '')), ''),
    pg_catalog.btrim(p_owner_phone),
    true,
    NULL
  );

  UPDATE public.bootstrap_state
     SET status = 'completed',
         completed_at = pg_catalog.now(),
         claim_expires_at = NULL,
         pharmacy_id = v_pharmacy_id,
         owner_user_id = p_owner_user_id,
         orphan_auth_user_id = NULL,
         last_error = NULL,
         updated_at = pg_catalog.now()
   WHERE singleton_key = true;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_pharmacy_id,
    NULL,
    'Platform Administrator Bootstrap',
    'platform_owner',
    'BOOTSTRAP_OWNER_PROVISIONED',
    'staff',
    p_owner_user_id,
    'ØªÙ…Øª ØªÙ‡ÙŠØ¦Ø© Ø§Ù„ØµÙŠØ¯Ù„ÙŠØ© Ø§Ù„Ø£ÙˆÙ„Ù‰ ÙˆØ­Ø³Ø§Ø¨ Ù…Ø§Ù„Ùƒ Ø§Ù„ØµÙŠØ¯Ù„ÙŠØ© Ù„Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø©',
    'Completed one-time initial pharmacy and pharmacy_owner bootstrap',
    pg_catalog.jsonb_build_object(
      'pharmacyId', v_pharmacy_id,
      'ownerUserId', p_owner_user_id,
      'requestId', p_request_id,
      'role', 'pharmacy_owner'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pharmacyId', v_pharmacy_id,
    'ownerUserId', p_owner_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_first_owner_bootstrap(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_first_owner_bootstrap(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) TO service_role;

-- ----------------------------------------------------------------------------
-- 3B. Immutable Staff Provisioning Fingerprint, Claim, Conservative Expired-Claim
--     Recovery & Mandatory-Claim Provisioning (service_role ONLY â€” Stage 2B.2A.3)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.compute_staff_provisioning_fingerprint(
  p_pharmacy_id uuid,
  p_owner_user_id uuid,
  p_target_email text,
  p_target_phone text,
  p_target_role text DEFAULT 'authorized_pharmacist'
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          p_pharmacy_id::text,
          p_owner_user_id::text,
          pg_catalog.lower(pg_catalog.btrim(COALESCE(p_target_email, ''))),
          pg_catalog.btrim(COALESCE(p_target_phone, '')),
          pg_catalog.btrim(COALESCE(p_target_role, ''))
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION app_security.compute_staff_provisioning_fingerprint(
  uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.compute_staff_provisioning_fingerprint(
  uuid, uuid, text, text, text
) TO service_role;

DROP FUNCTION IF EXISTS public.claim_staff_provisioning_request(uuid, text, uuid, text, text, integer);
CREATE OR REPLACE FUNCTION public.claim_staff_provisioning_request(
  p_owner_user_id uuid,
  p_idempotency_key text,
  p_request_id uuid,
  p_target_email text,
  p_target_phone text,
  p_target_role text DEFAULT 'authorized_pharmacist',
  p_claim_ttl_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean_key    text;
  v_clean_email  text;
  v_clean_phone  text;
  v_clean_role   text;
  v_fingerprint  text;
  v_owner        public.pharmacy_staff%ROWTYPE;
  v_pharmacy     public.pharmacies%ROWTYPE;
  v_existing     public.staff_provisioning_requests%ROWTYPE;
BEGIN
  v_clean_key := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  IF pg_catalog.char_length(v_clean_key) < 16 OR pg_catalog.char_length(v_clean_key) > 128 THEN
    RAISE EXCEPTION 'Staff provisioning Idempotency-Key must be between 16 and 128 characters.'
      USING ERRCODE = '23514';
  END IF;

  IF p_owner_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Owner id and request_id are required for staff provisioning claim.'
      USING ERRCODE = '23514';
  END IF;

  v_clean_role := pg_catalog.btrim(COALESCE(p_target_role, 'authorized_pharmacist'));
  IF v_clean_role <> 'authorized_pharmacist' THEN
    RAISE EXCEPTION 'Staff provisioning claim is restricted to authorized_pharmacist.'
      USING ERRCODE = '23514';
  END IF;

  v_clean_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_target_email, '')));
  v_clean_phone := pg_catalog.btrim(COALESCE(p_target_phone, ''));
  IF pg_catalog.char_length(v_clean_email) < 3 OR pg_catalog.char_length(v_clean_phone) < 10 THEN
    RAISE EXCEPTION 'Canonical target email and phone are required for staff provisioning claim.'
      USING ERRCODE = '23514';
  END IF;

  IF p_claim_ttl_seconds IS NULL OR p_claim_ttl_seconds < 15 OR p_claim_ttl_seconds > 600 THEN
    RAISE EXCEPTION 'Staff provisioning claim TTL must be between 15 and 600 seconds.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_owner
  FROM public.pharmacy_staff ps
  WHERE ps.id = p_owner_user_id
  FOR SHARE;

  IF NOT FOUND OR v_owner.is_active IS DISTINCT FROM true OR v_owner.role <> 'pharmacy_owner' THEN
    RAISE EXCEPTION 'Caller % is not an active pharmacy_owner.', p_owner_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pharmacy
  FROM public.pharmacies ph
  WHERE ph.id = v_owner.pharmacy_id
  FOR SHARE;

  IF NOT FOUND OR v_pharmacy.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pharmacy % is inactive or missing.', v_owner.pharmacy_id
      USING ERRCODE = '42501';
  END IF;

  v_fingerprint := app_security.compute_staff_provisioning_fingerprint(
    v_owner.pharmacy_id,
    v_owner.id,
    v_clean_email,
    v_clean_phone,
    v_clean_role
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_staff_prov:' || v_owner.pharmacy_id::text || ':' || v_clean_key, 0)
  );

  SELECT * INTO v_existing
  FROM public.staff_provisioning_requests spr
  WHERE spr.pharmacy_id = v_owner.pharmacy_id
    AND spr.idempotency_key = v_clean_key
  FOR UPDATE;

  IF FOUND THEN
    -- Stage 2B.2A.3 Issue B: An idempotency key is IMMUTABLY bound to its canonical
    -- request fingerprint. Never overwrite target email, phone, owner, or role,
    -- even after TTL expiration. Reject conflicting requests without modifying row.
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_existing.owner_user_id IS DISTINCT FROM v_owner.id
       OR v_existing.target_email IS DISTINCT FROM v_clean_email
       OR v_existing.target_phone IS DISTINCT FROM v_clean_phone
       OR v_existing.target_role IS DISTINCT FROM v_clean_role
    THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'STAFF_IDEMPOTENCY_KEY_CONFLICT',
        'existingStatus', v_existing.status,
        'requestId', v_existing.request_id,
        'staffId', v_existing.staff_user_id
      );
    END IF;

    IF v_existing.status = 'completed' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'STAFF_PROVISIONING_ALREADY_COMPLETED',
        'staffId', v_existing.staff_user_id,
        'pharmacyId', v_existing.pharmacy_id,
        'role', v_existing.target_role
      );
    END IF;

    IF v_existing.status = 'failed_needs_reconciliation' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'STAFF_PROVISIONING_NEEDS_RECONCILIATION',
        'requestId', v_existing.request_id,
        'orphanAuthUserId', v_existing.orphan_auth_user_id,
        'lastError', v_existing.last_error
      );
    END IF;

    IF v_existing.status = 'claimed' THEN
      IF v_existing.claim_expires_at IS NOT NULL AND v_existing.claim_expires_at > pg_catalog.now() THEN
        RETURN jsonb_build_object(
          'ok', false,
          'errorCode', 'STAFF_PROVISIONING_IN_PROGRESS',
          'claimedByRequestId', v_existing.request_id,
          'claimExpiresAt', v_existing.claim_expires_at
        );
      END IF;

      -- Conservative expired-claim handling: never overwrite an expired `claimed` row
      -- in place because an out-of-band Auth Admin `createUser` call may still be in
      -- flight. Escalate deterministically to `failed_needs_reconciliation` while
      -- preserving all canonical target fields and provenance.
      UPDATE public.staff_provisioning_requests
         SET status = 'failed_needs_reconciliation',
             claim_expires_at = NULL,
             last_error = COALESCE(
               last_error,
               'Staff provisioning claim TTL expired before completion or rollback; Auth/DB reconciliation required.'
             ),
             updated_at = pg_catalog.now()
       WHERE id = v_existing.id;

      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED',
        'expiredRequestId', v_existing.request_id,
        'status', 'failed_needs_reconciliation'
      );
    END IF;

    -- Only a cleanly verified `rolled_back` row with IDENTICAL canonical fingerprint
    -- may be safely re-claimed for an intentional operator retry.
    UPDATE public.staff_provisioning_requests
       SET request_id = p_request_id,
           status = 'claimed',
           claim_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_claim_ttl_seconds),
           staff_user_id = NULL,
           orphan_auth_user_id = NULL,
           last_error = NULL,
           updated_at = pg_catalog.now()
     WHERE id = v_existing.id;

    RETURN jsonb_build_object(
      'ok', true,
      'claimId', p_request_id,
      'pharmacyId', v_owner.pharmacy_id,
      'requestFingerprint', v_fingerprint,
      'status', 'claimed'
    );
  END IF;

  INSERT INTO public.staff_provisioning_requests (
    pharmacy_id, owner_user_id, idempotency_key, request_id,
    target_email, target_phone, target_role, request_fingerprint,
    status, claim_expires_at, staff_user_id, orphan_auth_user_id, last_error, updated_at
  )
  VALUES (
    v_owner.pharmacy_id,
    v_owner.id,
    v_clean_key,
    p_request_id,
    v_clean_email,
    v_clean_phone,
    'authorized_pharmacist',
    v_fingerprint,
    'claimed',
    pg_catalog.now() + pg_catalog.make_interval(secs => p_claim_ttl_seconds),
    NULL,
    NULL,
    NULL,
    pg_catalog.now()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'claimId', p_request_id,
    'pharmacyId', v_owner.pharmacy_id,
    'requestFingerprint', v_fingerprint,
    'status', 'claimed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_staff_provisioning_request(
  uuid, text, uuid, text, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_staff_provisioning_request(
  uuid, text, uuid, text, text, text, integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.inspect_staff_provisioning_state(
  p_owner_user_id uuid,
  p_request_id uuid DEFAULT NULL,
  p_staff_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_owner public.pharmacy_staff%ROWTYPE;
  v_req   public.staff_provisioning_requests%ROWTYPE;
  v_staff public.pharmacy_staff%ROWTYPE;
BEGIN
  SELECT * INTO v_owner FROM public.pharmacy_staff ps WHERE ps.id = p_owner_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner % not found.', p_owner_user_id USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_req
    FROM public.staff_provisioning_requests spr
    WHERE spr.request_id = p_request_id
      AND spr.pharmacy_id = v_owner.pharmacy_id;
  END IF;

  IF p_staff_user_id IS NOT NULL THEN
    SELECT * INTO v_staff
    FROM public.pharmacy_staff ps
    WHERE ps.id = p_staff_user_id
      AND ps.pharmacy_id = v_owner.pharmacy_id;
  END IF;

  RETURN jsonb_build_object(
    'status', COALESCE(v_req.status, CASE WHEN v_staff.id IS NOT NULL THEN 'completed' ELSE 'unknown' END),
    'requestId', v_req.request_id,
    'requestFingerprint', v_req.request_fingerprint,
    'pharmacyId', v_owner.pharmacy_id,
    'staffExistsInDb', (v_staff.id IS NOT NULL),
    'staffId', COALESCE(v_staff.id, v_req.staff_user_id),
    'staffRole', v_staff.role,
    'orphanAuthUserId', v_req.orphan_auth_user_id,
    'lastError', v_req.last_error
  );
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_staff_provisioning_state(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_staff_provisioning_state(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_staff_provisioning_reconciliation(
  p_request_id uuid,
  p_new_status text,
  p_orphan_auth_user_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_req public.staff_provisioning_requests%ROWTYPE;
BEGIN
  IF p_new_status NOT IN ('rolled_back', 'failed_needs_reconciliation') THEN
    RAISE EXCEPTION 'Invalid staff provisioning reconciliation status: %.', p_new_status
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.staff_provisioning_requests spr
  WHERE spr.request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'errorCode', 'STAFF_REQUEST_NOT_FOUND');
  END IF;

  IF v_req.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'STAFF_PROVISIONING_ALREADY_COMPLETED',
      'staffId', v_req.staff_user_id,
      'pharmacyId', v_req.pharmacy_id
    );
  END IF;

  UPDATE public.staff_provisioning_requests
     SET status = p_new_status,
         claim_expires_at = NULL,
         orphan_auth_user_id = CASE WHEN p_new_status = 'rolled_back' THEN NULL ELSE COALESCE(p_orphan_auth_user_id, orphan_auth_user_id) END,
         last_error = CASE WHEN p_new_status = 'rolled_back' THEN NULL ELSE pg_catalog.left(COALESCE(p_error, ''), 500) END,
         updated_at = pg_catalog.now()
   WHERE request_id = p_request_id;

  RETURN jsonb_build_object('ok', true, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_staff_provisioning_reconciliation(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_staff_provisioning_reconciliation(uuid, text, uuid, text) TO service_role;

-- Conservative Auth-verified reconciliation helper for expired/ambiguous staff claims:
-- Only transitions to `rolled_back` (allowing clean canonical retry) after verifying
-- zero matching `pharmacy_staff` rows exist AND caller attests Auth lookup found no user.
CREATE OR REPLACE FUNCTION public.reconcile_expired_staff_provisioning_claim(
  p_owner_user_id uuid,
  p_request_id uuid,
  p_auth_user_exists boolean,
  p_orphan_auth_user_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_owner public.pharmacy_staff%ROWTYPE;
  v_req   public.staff_provisioning_requests%ROWTYPE;
  v_staff public.pharmacy_staff%ROWTYPE;
BEGIN
  IF p_owner_user_id IS NULL OR p_request_id IS NULL OR p_auth_user_exists IS NULL THEN
    RAISE EXCEPTION 'Owner, request_id, and explicit auth_user_exists verification are required.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_owner
  FROM public.pharmacy_staff ps
  WHERE ps.id = p_owner_user_id
    AND ps.is_active = true
    AND ps.role = 'pharmacy_owner'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller % is not an active pharmacy_owner.', p_owner_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
  FROM public.staff_provisioning_requests spr
  WHERE spr.request_id = p_request_id
    AND spr.pharmacy_id = v_owner.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'errorCode', 'STAFF_REQUEST_NOT_FOUND');
  END IF;

  IF v_req.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'completed',
      'staffId', v_req.staff_user_id,
      'pharmacyId', v_req.pharmacy_id
    );
  END IF;

  SELECT * INTO v_staff
  FROM public.pharmacy_staff ps
  WHERE ps.pharmacy_id = v_req.pharmacy_id
    AND (
      (p_orphan_auth_user_id IS NOT NULL AND ps.id = p_orphan_auth_user_id)
      OR ps.phone = v_req.target_phone
    )
  LIMIT 1;

  IF FOUND THEN
    UPDATE public.staff_provisioning_requests
       SET status = 'completed',
           staff_user_id = v_staff.id,
           claim_expires_at = NULL,
           orphan_auth_user_id = NULL,
           last_error = NULL,
           completed_at = COALESCE(completed_at, pg_catalog.now()),
           updated_at = pg_catalog.now()
     WHERE id = v_req.id;

    RETURN jsonb_build_object(
      'ok', true,
      'status', 'completed',
      'staffId', v_staff.id,
      'pharmacyId', v_req.pharmacy_id
    );
  END IF;

  IF p_auth_user_exists THEN
    UPDATE public.staff_provisioning_requests
       SET status = 'failed_needs_reconciliation',
           claim_expires_at = NULL,
           orphan_auth_user_id = COALESCE(p_orphan_auth_user_id, orphan_auth_user_id),
           last_error = pg_catalog.left(
             COALESCE(
               p_note,
               'Orphan Auth user exists without pharmacy_staff row; resolve or delete Auth user before retry.'
             ),
             500
           ),
           updated_at = pg_catalog.now()
     WHERE id = v_req.id;

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'STAFF_PROVISIONING_NEEDS_RECONCILIATION',
      'status', 'failed_needs_reconciliation',
      'orphanAuthUserId', COALESCE(p_orphan_auth_user_id, v_req.orphan_auth_user_id)
    );
  END IF;

  UPDATE public.staff_provisioning_requests
     SET status = 'rolled_back',
         claim_expires_at = NULL,
         orphan_auth_user_id = NULL,
         last_error = NULL,
         updated_at = pg_catalog.now()
   WHERE id = v_req.id;

  RETURN jsonb_build_object('ok', true, 'status', 'rolled_back');
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_expired_staff_provisioning_claim(
  uuid, uuid, boolean, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_expired_staff_provisioning_claim(
  uuid, uuid, boolean, uuid, text
) TO service_role;

DROP FUNCTION IF EXISTS public.provision_pharmacy_staff_by_owner(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.provision_pharmacy_staff_by_owner(uuid, uuid, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.provision_pharmacy_staff_by_owner(
  p_owner_user_id uuid,
  p_new_user_id uuid,
  p_full_name text,
  p_role text,
  p_phone text,
  p_syndicate_license text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_owner       public.pharmacy_staff%ROWTYPE;
  v_pharmacy    public.pharmacies%ROWTYPE;
  v_req         public.staff_provisioning_requests%ROWTYPE;
  v_clean_name  text;
  v_clean_phone text;
  v_clean_syn   text;
BEGIN
  -- Stage 2B.2A.3: Reject claimless (p_request_id IS NULL) normal provisioning!
  IF p_owner_user_id IS NULL OR p_new_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Owner, new staff user id, and valid claim request_id are required; claimless provisioning is disabled.'
      USING ERRCODE = '23514';
  END IF;

  IF p_role IS DISTINCT FROM 'authorized_pharmacist' THEN
    RAISE EXCEPTION 'Owner staff provisioning is restricted to authorized_pharmacist; pharmacy_owner delegation is not enabled.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_owner
  FROM public.pharmacy_staff ps
  WHERE ps.id = p_owner_user_id
  FOR SHARE;

  IF NOT FOUND OR v_owner.is_active IS DISTINCT FROM true OR v_owner.role <> 'pharmacy_owner' THEN
    RAISE EXCEPTION 'Caller % is not an active pharmacy_owner.', p_owner_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pharmacy
  FROM public.pharmacies ph
  WHERE ph.id = v_owner.pharmacy_id
  FOR SHARE;

  IF NOT FOUND OR v_pharmacy.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pharmacy % is inactive or missing.', v_owner.pharmacy_id
      USING ERRCODE = '42501';
  END IF;

  v_clean_name := pg_catalog.btrim(COALESCE(p_full_name, ''));
  v_clean_phone := pg_catalog.btrim(COALESCE(p_phone, ''));
  v_clean_syn := NULLIF(pg_catalog.btrim(COALESCE(p_syndicate_license, '')), '');

  SELECT * INTO v_req
  FROM public.staff_provisioning_requests spr
  WHERE spr.request_id = p_request_id
    AND spr.pharmacy_id = v_owner.pharmacy_id
    AND spr.owner_user_id = v_owner.id
  FOR UPDATE;

  IF NOT FOUND OR v_req.status <> 'claimed' THEN
    RAISE EXCEPTION 'Staff provisioning claim % is missing or not in claimed state.', p_request_id
      USING ERRCODE = '23514';
  END IF;

  IF v_req.target_phone IS DISTINCT FROM v_clean_phone
     OR v_req.target_role IS DISTINCT FROM 'authorized_pharmacist'
  THEN
    RAISE EXCEPTION 'Staff provisioning claim % does not match canonical target phone or role.', p_request_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  )
  VALUES (
    p_new_user_id,
    v_owner.pharmacy_id,
    v_clean_name,
    'authorized_pharmacist',
    v_clean_syn,
    v_clean_phone,
    true,
    v_owner.id
  );

  UPDATE public.staff_provisioning_requests
     SET status = 'completed',
         staff_user_id = p_new_user_id,
         claim_expires_at = NULL,
         orphan_auth_user_id = NULL,
         last_error = NULL,
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = v_req.id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_owner.pharmacy_id,
    v_owner.id,
    v_owner.full_name,
    v_owner.role,
    'STAFF_PROVISIONED',
    'staff',
    p_new_user_id,
    'Ø¥Ø¶Ø§ÙØ© ØµÙŠØ¯Ù„ÙŠ Ù…Ø®ÙˆÙ‘Ù„ Ø¬Ø¯ÙŠØ¯: ' || v_clean_name || ' (authorized_pharmacist)',
    'Provisioned new authorized_pharmacist: ' || v_clean_name,
    pg_catalog.jsonb_build_object(
      'staffId', p_new_user_id,
      'role', 'authorized_pharmacist',
      'provisionedByOwnerId', v_owner.id,
      'requestId', p_request_id,
      'requestFingerprint', v_req.request_fingerprint
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'staffId', p_new_user_id,
    'pharmacyId', v_owner.pharmacy_id,
    'role', 'authorized_pharmacist'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_pharmacy_staff_by_owner(
  uuid, uuid, text, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_pharmacy_staff_by_owner(
  uuid, uuid, text, text, text, text, uuid
) TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Atomic Clinical RPC 1: Create Patient + Conditions + Allergies + Audit Log
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_patient_with_clinical_tags(
  p_patient_code text,
  p_full_name text,
  p_phone text,
  p_phone_owner_type text DEFAULT 'self',
  p_caregiver_name text DEFAULT NULL,
  p_date_of_birth date DEFAULT NULL,
  p_sex text DEFAULT NULL,
  p_contact_preference text DEFAULT 'whatsapp',
  p_clinical_notes text DEFAULT '',
  p_registration_date date DEFAULT (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date,
  p_chronic_conditions jsonb DEFAULT '[]'::jsonb,
  p_allergies jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff       record;
  v_patient_id  uuid;
  v_cond        text;
  v_allergy     jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_date_of_birth IS NULL THEN
    RAISE EXCEPTION 'Patient date_of_birth is required.'
      USING ERRCODE = '23514';
  END IF;

  IF p_chronic_conditions IS NOT NULL AND pg_catalog.jsonb_typeof(p_chronic_conditions) <> 'array' THEN
    RAISE EXCEPTION 'p_chronic_conditions must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_allergies IS NOT NULL AND pg_catalog.jsonb_typeof(p_allergies) <> 'array' THEN
    RAISE EXCEPTION 'p_allergies must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.patients (
    pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    caregiver_name, date_of_birth, sex, contact_preference,
    clinical_notes, registration_date, status, created_by_staff_id
  )
  VALUES (
    v_staff.pharmacy_id,
    pg_catalog.btrim(p_patient_code),
    pg_catalog.btrim(p_full_name),
    pg_catalog.btrim(p_phone),
    COALESCE(NULLIF(pg_catalog.btrim(p_phone_owner_type), ''), 'self'),
    NULLIF(pg_catalog.btrim(COALESCE(p_caregiver_name, '')), ''),
    p_date_of_birth,
    p_sex,
    COALESCE(NULLIF(pg_catalog.btrim(p_contact_preference), ''), 'whatsapp'),
    COALESCE(p_clinical_notes, ''),
    COALESCE(p_registration_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date),
    'active',
    v_staff.staff_id
  )
  RETURNING id INTO v_patient_id;

  FOR v_cond IN
    SELECT DISTINCT pg_catalog.btrim(val)
    FROM pg_catalog.jsonb_array_elements_text(COALESCE(p_chronic_conditions, '[]'::jsonb)) AS t(val)
    WHERE pg_catalog.char_length(pg_catalog.btrim(val)) >= 2
  LOOP
    INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name, status)
    VALUES (v_staff.pharmacy_id, v_patient_id, v_cond, 'active')
    ON CONFLICT (patient_id, condition_name) DO UPDATE
      SET status = 'active',
          removed_at = NULL,
          removed_by_staff_id = NULL,
          removal_reason = NULL;
  END LOOP;

  FOR v_allergy IN
    SELECT elem
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_allergies, '[]'::jsonb)) AS t(elem)
  LOOP
    IF pg_catalog.char_length(pg_catalog.btrim(COALESCE(v_allergy->>'substance', ''))) >= 2 THEN
      INSERT INTO public.patient_allergies (
        pharmacy_id, patient_id, substance, severity, reaction, status
      )
      VALUES (
        v_staff.pharmacy_id,
        v_patient_id,
        pg_catalog.btrim(v_allergy->>'substance'),
        COALESCE(NULLIF(pg_catalog.btrim(v_allergy->>'severity'), ''), 'moderate'),
        NULLIF(pg_catalog.btrim(COALESCE(v_allergy->>'reaction', '')), ''),
        'active'
      )
      ON CONFLICT (patient_id, substance) DO UPDATE
        SET severity = EXCLUDED.severity,
            reaction = EXCLUDED.reaction,
            status = 'active',
            removed_at = NULL,
            removed_by_staff_id = NULL,
            removal_reason = NULL;
    END IF;
  END LOOP;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'PATIENT_REGISTERED',
    'patient',
    v_patient_id,
    'ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ Ø§Ù„Ø¬Ø¯ÙŠØ¯ ' || pg_catalog.btrim(p_full_name) || ' (' || pg_catalog.btrim(p_patient_code) || ')',
    'Registered new patient ' || pg_catalog.btrim(p_full_name) || ' (' || pg_catalog.btrim(p_patient_code) || ')',
    pg_catalog.jsonb_build_object('patientCode', pg_catalog.btrim(p_patient_code))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'patientId', v_patient_id
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Atomic Clinical RPC 2: Update Patient + History-Preserving Conditions/Allergies
--    H2 Fix: Soft-deactivates omitted conditions/allergies (`status = 'inactive'`,
--    `removed_at`, `removed_by_staff_id`, `removal_reason`) instead of deleting
--    clinical history, and logs full before/after provenance in `audit_logs.metadata`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_patient_with_clinical_tags(
  p_patient_id uuid,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_chronic_conditions jsonb DEFAULT NULL,
  p_allergies jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff            record;
  v_patient          public.patients%ROWTYPE;
  v_cond             text;
  v_allergy          jsonb;
  v_kept_conds       text[] := '{}'::text[];
  v_kept_subs        text[] := '{}'::text[];
  v_prev_conditions  jsonb;
  v_curr_conditions  jsonb;
  v_prev_allergies   jsonb;
  v_curr_allergies   jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_patch IS NOT NULL AND pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  IF p_chronic_conditions IS NOT NULL AND pg_catalog.jsonb_typeof(p_chronic_conditions) <> 'array' THEN
    RAISE EXCEPTION 'p_chronic_conditions must be a JSON array.' USING ERRCODE = '22023';
  END IF;

  IF p_allergies IS NOT NULL AND pg_catalog.jsonb_typeof(p_allergies) <> 'array' THEN
    RAISE EXCEPTION 'p_allergies must be a JSON array.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pc.condition_name ORDER BY pc.condition_name), '[]'::jsonb)
    INTO v_prev_conditions
  FROM public.patient_conditions pc
  WHERE pc.patient_id = p_patient_id
    AND pc.pharmacy_id = v_staff.pharmacy_id
    AND pc.status = 'active';

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'substance', pa.substance,
        'severity', pa.severity,
        'reaction', pa.reaction
      )
      ORDER BY pa.substance
    ),
    '[]'::jsonb
  )
    INTO v_prev_allergies
  FROM public.patient_allergies pa
  WHERE pa.patient_id = p_patient_id
    AND pa.pharmacy_id = v_staff.pharmacy_id
    AND pa.status = 'active';

  UPDATE public.patients
     SET full_name = CASE WHEN p_patch ? 'full_name' THEN COALESCE(pg_catalog.btrim(p_patch->>'full_name'), '') ELSE full_name END,
         phone = CASE WHEN p_patch ? 'phone' THEN COALESCE(pg_catalog.btrim(p_patch->>'phone'), '') ELSE phone END,
         phone_owner_type = CASE WHEN p_patch ? 'phone_owner_type' THEN COALESCE(p_patch->>'phone_owner_type', '') ELSE phone_owner_type END,
         caregiver_name = CASE WHEN p_patch ? 'caregiver_name' THEN NULLIF(pg_catalog.btrim(COALESCE(p_patch->>'caregiver_name', '')), '') ELSE caregiver_name END,
         date_of_birth = CASE WHEN p_patch ? 'date_of_birth' THEN NULLIF(pg_catalog.btrim(COALESCE(p_patch->>'date_of_birth', '')), '')::date ELSE date_of_birth END,
         sex = CASE WHEN p_patch ? 'sex' THEN COALESCE(p_patch->>'sex', '') ELSE sex END,
         contact_preference = CASE WHEN p_patch ? 'contact_preference' THEN COALESCE(p_patch->>'contact_preference', '') ELSE contact_preference END,
         clinical_notes = CASE WHEN p_patch ? 'clinical_notes' THEN COALESCE(p_patch->>'clinical_notes', '') ELSE clinical_notes END,
         updated_at = pg_catalog.now()
   WHERE id = p_patient_id
     AND pharmacy_id = v_staff.pharmacy_id
   RETURNING * INTO v_patient;

  IF p_chronic_conditions IS NOT NULL THEN
    FOR v_cond IN
      SELECT DISTINCT pg_catalog.btrim(val)
      FROM pg_catalog.jsonb_array_elements_text(p_chronic_conditions) AS t(val)
      WHERE pg_catalog.char_length(pg_catalog.btrim(val)) >= 2
    LOOP
      v_kept_conds := pg_catalog.array_append(v_kept_conds, v_cond);
      INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name, status)
      VALUES (v_staff.pharmacy_id, p_patient_id, v_cond, 'active')
      ON CONFLICT (patient_id, condition_name) DO UPDATE
        SET status = 'active',
            removed_at = NULL,
            removed_by_staff_id = NULL,
            removal_reason = NULL;
    END LOOP;

    UPDATE public.patient_conditions pc
       SET status = 'inactive',
           removed_at = pg_catalog.now(),
           removed_by_staff_id = v_staff.staff_id,
           removal_reason = 'Deactivated during pharmacist patient profile update'
     WHERE pc.patient_id = p_patient_id
       AND pc.pharmacy_id = v_staff.pharmacy_id
       AND pc.status = 'active'
       AND NOT (pc.condition_name = ANY(v_kept_conds));
  END IF;

  IF p_allergies IS NOT NULL THEN
    FOR v_allergy IN
      SELECT elem FROM pg_catalog.jsonb_array_elements(p_allergies) AS t(elem)
    LOOP
      IF pg_catalog.char_length(pg_catalog.btrim(COALESCE(v_allergy->>'substance', ''))) >= 2 THEN
        v_kept_subs := pg_catalog.array_append(v_kept_subs, pg_catalog.btrim(v_allergy->>'substance'));
        INSERT INTO public.patient_allergies (
          pharmacy_id, patient_id, substance, severity, reaction, status
        )
        VALUES (
          v_staff.pharmacy_id,
          p_patient_id,
          pg_catalog.btrim(v_allergy->>'substance'),
          COALESCE(NULLIF(pg_catalog.btrim(v_allergy->>'severity'), ''), 'moderate'),
          NULLIF(pg_catalog.btrim(COALESCE(v_allergy->>'reaction', '')), ''),
          'active'
        )
        ON CONFLICT (patient_id, substance) DO UPDATE
          SET severity = EXCLUDED.severity,
              reaction = EXCLUDED.reaction,
              status = 'active',
              removed_at = NULL,
              removed_by_staff_id = NULL,
              removal_reason = NULL;
      END IF;
    END LOOP;

    UPDATE public.patient_allergies pa
       SET status = 'inactive',
           removed_at = pg_catalog.now(),
           removed_by_staff_id = v_staff.staff_id,
           removal_reason = 'Deactivated during pharmacist patient profile update'
     WHERE pa.patient_id = p_patient_id
       AND pa.pharmacy_id = v_staff.pharmacy_id
       AND pa.status = 'active'
       AND NOT (pa.substance = ANY(v_kept_subs));
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pc.condition_name ORDER BY pc.condition_name), '[]'::jsonb)
    INTO v_curr_conditions
  FROM public.patient_conditions pc
  WHERE pc.patient_id = p_patient_id
    AND pc.pharmacy_id = v_staff.pharmacy_id
    AND pc.status = 'active';

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'substance', pa.substance,
        'severity', pa.severity,
        'reaction', pa.reaction
      )
      ORDER BY pa.substance
    ),
    '[]'::jsonb
  )
    INTO v_curr_allergies
  FROM public.patient_allergies pa
  WHERE pa.patient_id = p_patient_id
    AND pa.pharmacy_id = v_staff.pharmacy_id
    AND pa.status = 'active';

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'PATIENT_UPDATED',
    'patient',
    p_patient_id,
    'ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || v_patient.full_name || ' Ù…Ø¹ Ø­ÙØ¸ Ø³Ø¬Ù„ Ø§Ù„Ø­Ø³Ø§Ø³ÙŠØ© ÙˆØ§Ù„Ø­Ø§Ù„Ø§Øª',
    'Updated patient profile for ' || v_patient.full_name || ' (clinical tag history preserved)',
    pg_catalog.jsonb_build_object(
      'patientId', p_patient_id,
      'conditionsUpdated', (p_chronic_conditions IS NOT NULL),
      'allergiesUpdated', (p_allergies IS NOT NULL),
      'previousConditions', v_prev_conditions,
      'currentConditions', v_curr_conditions,
      'previousAllergies', v_prev_allergies,
      'currentAllergies', v_curr_allergies
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'patientId', p_patient_id
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Atomic Clinical RPC 3: Create Medication Plan + Regimen Version v1 + Audit Log
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_medication_plan_with_version(
  p_patient_id uuid,
  p_catalog_id uuid,
  p_brand_name text,
  p_generic_name text,
  p_strength text,
  p_dosage_form text,
  p_route text,
  p_dose_amount numeric,
  p_dose_unit text,
  p_food_relation text,
  p_verified_instructions text,
  p_prescriber_name text,
  p_prescriber_specialty text,
  p_start_date date,
  p_end_date date,
  p_is_ongoing boolean,
  p_duration_days integer,
  p_schedule jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff   record;
  v_patient public.patients%ROWTYPE;
  v_plan_id uuid;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  IF p_schedule IS NULL OR pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     OR COALESCE(p_schedule->>'timezone', '') <> 'Asia/Baghdad'
     OR COALESCE(p_schedule->>'frequencyType', '') NOT IN ('daily', 'interval', 'weekdays', 'cyclic', 'variable', 'prn')
  THEN
    RAISE EXCEPTION 'Invalid schedule structure: Asia/Baghdad timezone and valid frequencyType required.'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.patient_medication_plans (
    pharmacy_id, patient_id, catalog_id, brand_name, generic_name, strength,
    dosage_form, route, dose_amount, dose_unit, food_relation,
    verified_instructions, prescriber_name, prescriber_specialty,
    start_date, end_date, is_ongoing, duration_days,
    status, current_version_number, schedule, created_by_staff_id
  )
  VALUES (
    v_staff.pharmacy_id, p_patient_id, p_catalog_id,
    pg_catalog.btrim(p_brand_name), pg_catalog.btrim(p_generic_name), pg_catalog.btrim(p_strength),
    p_dosage_form, p_route, p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation,
    pg_catalog.btrim(p_verified_instructions),
    NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_name, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_specialty, '')), ''),
    p_start_date,
    CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_end_date END,
    COALESCE(p_is_ongoing, true),
    CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_duration_days END,
    'active',
    1,
    p_schedule,
    v_staff.staff_id
  )
  RETURNING id INTO v_plan_id;

  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, effective_to,
    dose_amount, dose_unit, food_relation, verified_instructions, schedule,
    changed_by_staff_id, changed_by_staff_name, change_reason
  )
  VALUES (
    v_staff.pharmacy_id, v_plan_id, 1, p_start_date, NULL,
    p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation, pg_catalog.btrim(p_verified_instructions), p_schedule,
    v_staff.staff_id, v_staff.full_name,
    'Ø®Ø·Ø© Ø¹Ù„Ø§Ø¬ÙŠØ© Ø¬Ø¯ÙŠØ¯Ø© Ù…ÙˆØ«Ù‚Ø© Ù…Ù† Ø§Ù„ØµÙŠØ¯Ù„ÙŠ / Initial pharmacist-verified plan'
  );

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'MEDICATION_PLAN_ADDED',
    'medication_plan',
    v_plan_id,
    'Ø¥Ø¶Ø§ÙØ© Ø®Ø·Ø© Ø¹Ù„Ø§Ø¬ÙŠØ© (' || pg_catalog.btrim(p_brand_name) || ' ' || pg_catalog.btrim(p_strength) || ') Ù„Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || v_patient.full_name,
    'Added medication plan (' || pg_catalog.btrim(p_brand_name) || ' ' || pg_catalog.btrim(p_strength) || ') for ' || v_patient.full_name,
    pg_catalog.jsonb_build_object('patientId', p_patient_id, 'versionNumber', 1)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', v_plan_id,
    'versionNumber', 1
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Atomic Clinical RPC 4: Update Medication Plan + Close Prior Version + Insert v+1
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_medication_plan_version(
  p_plan_id uuid,
  p_brand_name text,
  p_generic_name text,
  p_strength text,
  p_dosage_form text,
  p_route text,
  p_dose_amount numeric,
  p_dose_unit text,
  p_food_relation text,
  p_verified_instructions text,
  p_prescriber_name text,
  p_prescriber_specialty text,
  p_start_date date,
  p_end_date date,
  p_is_ongoing boolean,
  p_duration_days integer,
  p_schedule jsonb,
  p_change_reason text,
  p_effective_date date DEFAULT (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_plan         public.patient_medication_plans%ROWTYPE;
  v_open_version public.regimen_versions%ROWTYPE;
  v_next_ver     integer;
  v_eff_date     date;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_reason := pg_catalog.btrim(COALESCE(p_change_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'A regimen change reason of at least 3 characters is required.'
      USING ERRCODE = '23514';
  END IF;

  IF p_schedule IS NULL OR pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     OR COALESCE(p_schedule->>'timezone', '') <> 'Asia/Baghdad'
     OR COALESCE(p_schedule->>'frequencyType', '') NOT IN ('daily', 'interval', 'weekdays', 'cyclic', 'variable', 'prn')
  THEN
    RAISE EXCEPTION 'Invalid schedule structure: Asia/Baghdad timezone and valid frequencyType required.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_plan_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found or belongs to another pharmacy.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  v_eff_date := COALESCE(p_effective_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date);

  SELECT * INTO v_open_version
  FROM public.regimen_versions rv
  WHERE rv.medication_plan_id = p_plan_id
    AND rv.pharmacy_id = v_staff.pharmacy_id
    AND rv.effective_to IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_eff_date < v_open_version.effective_from THEN
      RAISE EXCEPTION 'Effective date % cannot precede open regimen version effective_from %.',
        v_eff_date, v_open_version.effective_from
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.regimen_versions
       SET effective_to = v_eff_date
     WHERE id = v_open_version.id
       AND pharmacy_id = v_staff.pharmacy_id;
  END IF;

  v_next_ver := v_plan.current_version_number + 1;

  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, effective_to,
    dose_amount, dose_unit, food_relation, verified_instructions, schedule,
    changed_by_staff_id, changed_by_staff_name, change_reason
  )
  VALUES (
    v_staff.pharmacy_id, p_plan_id, v_next_ver, v_eff_date, NULL,
    p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation, pg_catalog.btrim(p_verified_instructions), p_schedule,
    v_staff.staff_id, v_staff.full_name, v_clean_reason
  );

  UPDATE public.patient_medication_plans
     SET brand_name = pg_catalog.btrim(p_brand_name),
         generic_name = pg_catalog.btrim(p_generic_name),
         strength = pg_catalog.btrim(p_strength),
         dosage_form = p_dosage_form,
         route = p_route,
         dose_amount = p_dose_amount,
         dose_unit = pg_catalog.btrim(p_dose_unit),
         food_relation = p_food_relation,
         verified_instructions = pg_catalog.btrim(p_verified_instructions),
         prescriber_name = NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_name, '')), ''),
         prescriber_specialty = NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_specialty, '')), ''),
         start_date = p_start_date,
         end_date = CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_end_date END,
         is_ongoing = COALESCE(p_is_ongoing, true),
         duration_days = CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_duration_days END,
         current_version_number = v_next_ver,
         schedule = p_schedule,
         updated_at = pg_catalog.now()
   WHERE id = p_plan_id
     AND pharmacy_id = v_staff.pharmacy_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'REGIMEN_VERSION_CREATED',
    'medication_plan',
    p_plan_id,
    'ØªØ¹Ø¯ÙŠÙ„ Ø®Ø·Ø© ' || pg_catalog.btrim(p_brand_name) || ' ÙˆØ­ÙØ¸ Ø§Ù„Ù†Ø³Ø®Ø© Ø±Ù‚Ù… ' || v_next_ver,
    'Updated ' || pg_catalog.btrim(p_brand_name) || ' plan (preserved version #' || v_next_ver || ')',
    pg_catalog.jsonb_build_object('versionNumber', v_next_ver, 'effectiveDate', v_eff_date, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', p_plan_id,
    'versionNumber', v_next_ver
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Atomic Clinical RPC 5: Medication Status Change & Non-Overlapping Pause Window
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_medication_plan_status(
  p_plan_id uuid,
  p_status text,
  p_reason text,
  p_effective_date date DEFAULT (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_plan         public.patient_medication_plans%ROWTYPE;
  v_open_pause   public.medication_pause_periods%ROWTYPE;
  v_eff_date     date;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_status IS NULL OR p_status NOT IN ('active', 'paused', 'discontinued', 'archived') THEN
    RAISE EXCEPTION 'Invalid medication plan status: %.', p_status USING ERRCODE = '23514';
  END IF;

  v_clean_reason := pg_catalog.btrim(COALESCE(p_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 2 THEN
    RAISE EXCEPTION 'Status change reason must be at least 2 characters.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_plan_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found or belongs to another pharmacy.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  v_eff_date := COALESCE(p_effective_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date);

  SELECT * INTO v_open_pause
  FROM public.medication_pause_periods mpp
  WHERE mpp.medication_plan_id = p_plan_id
    AND mpp.pharmacy_id = v_staff.pharmacy_id
    AND mpp.resumed_at IS NULL
  FOR UPDATE;

  IF p_status = 'paused' THEN
    IF NOT FOUND THEN
      INSERT INTO public.medication_pause_periods (
        pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, recorded_by_staff_id
      )
      VALUES (
        v_staff.pharmacy_id, p_plan_id, v_eff_date, NULL, v_clean_reason, v_staff.staff_id
      );
    END IF;
  ELSE
    IF FOUND THEN
      IF v_eff_date < v_open_pause.paused_from THEN
        RAISE EXCEPTION 'Resume/stop date % cannot precede pause start date %.',
          v_eff_date, v_open_pause.paused_from
          USING ERRCODE = '23514';
      END IF;

      UPDATE public.medication_pause_periods
         SET resumed_at = v_eff_date
       WHERE id = v_open_pause.id
         AND pharmacy_id = v_staff.pharmacy_id;
    END IF;
  END IF;

  UPDATE public.patient_medication_plans
     SET status = p_status,
         status_changed_at = CASE WHEN p_status = 'active' THEN NULL ELSE v_eff_date END,
         status_change_reason = v_clean_reason,
         updated_at = pg_catalog.now()
   WHERE id = p_plan_id
     AND pharmacy_id = v_staff.pharmacy_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'MEDICATION_STATUS_CHANGED',
    'medication_plan',
    p_plan_id,
    'ØªØºÙŠÙŠØ± Ø­Ø§Ù„Ø© ' || v_plan.brand_name || ' Ø¥Ù„Ù‰ (' || p_status || ')',
    'Changed status of ' || v_plan.brand_name || ' to ' || p_status,
    pg_catalog.jsonb_build_object('status', p_status, 'effectiveDate', v_eff_date, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', p_plan_id,
    'status', p_status
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Atomic Clinical RPC 6: Immutable Dispensing Ledger + Validated Refill Assessment
--    H1 Fix:
--      - Locks plan row (`FOR UPDATE`) to serialize concurrent fills on the same plan.
--      - Validates unit compatibility (`app_security.normalize_clinical_unit_category`),
--        numeric bounds, status consistency, and authoritative cumulative dispensed sum.
--      - Independently computes `v_server_daily_rate` from authoritative `v_plan.schedule`
--        and rejects tampered/stale client estimates (`ERRCODE = '23514'`).
--      - Never labels client-computed occurrence projections `'Server-verified'`;
--        explicitly records `calculation_source`, `verification_status`,
--        `algorithm_version`, and `calculation_inputs` provenance snapshot.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_dispensing_with_refill(
  p_patient_id uuid,
  p_medication_plan_id uuid,
  p_dispensed_quantity numeric,
  p_quantity_unit text,
  p_package_count integer,
  p_package_size numeric,
  p_batch_number text,
  p_expiry_date date,
  p_dispensing_date date,
  p_is_partial_fill boolean,
  p_notes text,
  p_estimated_daily_consumption numeric,
  p_estimated_supply_days integer,
  p_estimated_supply_end_date date,
  p_forecast_assumptions text,
  p_total_dispensed_analyzed numeric,
  p_estimated_remaining_units numeric,
  p_estimated_days_remaining integer,
  p_refill_status text,
  p_refill_supply_end_date date,
  p_uncertainty_note text,
  p_calculation_source text DEFAULT 'provisional_client_unverified',
  p_algorithm_version text DEFAULT 'masar_refill_v1',
  p_calculation_inputs jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff                      record;
  v_plan                       public.patient_medication_plans%ROWTYPE;
  v_patient                    public.patients%ROWTYPE;
  v_dispense_id                uuid;
  v_clean_unit                 text;
  v_dose_unit_cat              text;
  v_disp_unit_cat              text;
  v_units_compatible           boolean;
  v_server_daily_rate          numeric;
  v_auth_total_dispensed       numeric;
  v_freq                       text;
  v_calc_source                text := 'provisional_client_unverified';
  v_verif_status               text := 'provisional_unverified';
  v_eff_daily_consumption      numeric;
  v_eff_supply_days            integer;
  v_eff_supply_end_date        date;
  v_eff_remaining_units        numeric;
  v_eff_days_remaining         integer;
  v_eff_refill_supply_end_date date;
  v_eff_assumptions            text;
  v_eff_uncertainty            text;
  v_inputs_snapshot            jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_dispensed_quantity IS NULL OR p_dispensed_quantity <= 0 OR p_dispensed_quantity > 100000 THEN
    RAISE EXCEPTION 'Dispensed quantity must be between 0 and 100000.' USING ERRCODE = '23514';
  END IF;

  IF p_dispensing_date IS NULL THEN
    RAISE EXCEPTION 'Dispensing date is required.' USING ERRCODE = '23514';
  END IF;

  v_clean_unit := pg_catalog.btrim(COALESCE(p_quantity_unit, ''));
  IF pg_catalog.char_length(v_clean_unit) < 1 THEN
    RAISE EXCEPTION 'Dispensed quantity unit is required.' USING ERRCODE = '23514';
  END IF;

  IF p_refill_status NOT IN ('overdue', 'due_soon', 'upcoming', 'on_track', 'unable_to_estimate', 'paused_or_prn') THEN
    RAISE EXCEPTION 'Invalid refill_status: %.', p_refill_status USING ERRCODE = '23514';
  END IF;

  IF (p_estimated_daily_consumption IS NOT NULL AND p_estimated_daily_consumption < 0)
     OR (p_estimated_supply_days IS NOT NULL AND (p_estimated_supply_days < 0 OR p_estimated_supply_days > 3650))
     OR (p_estimated_remaining_units IS NOT NULL AND p_estimated_remaining_units < 0)
     OR (p_total_dispensed_analyzed IS NOT NULL AND p_total_dispensed_analyzed <= 0)
  THEN
    RAISE EXCEPTION 'Invalid negative or out-of-bounds refill forecast parameter.' USING ERRCODE = '23514';
  END IF;

  IF p_package_count IS NOT NULL AND p_package_count < 1 THEN
    RAISE EXCEPTION 'package_count must be >= 1 when provided.' USING ERRCODE = '23514';
  END IF;

  IF p_package_size IS NOT NULL AND p_package_size <= 0 THEN
    RAISE EXCEPTION 'package_size must be > 0 when provided.' USING ERRCODE = '23514';
  END IF;

  IF p_calculation_inputs IS NOT NULL AND pg_catalog.jsonb_typeof(p_calculation_inputs) <> 'object' THEN
    RAISE EXCEPTION 'p_calculation_inputs must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  -- Lock plan row FOR UPDATE so concurrent dispensing events for the same plan serialize cleanly
  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_medication_plan_id
    AND mp.patient_id = p_patient_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found for patient % in this pharmacy.', p_medication_plan_id, p_patient_id
      USING ERRCODE = '42501';
  END IF;

  v_freq := COALESCE(v_plan.schedule->>'frequencyType', '');
  v_dose_unit_cat := app_security.normalize_clinical_unit_category(v_plan.dose_unit);
  v_disp_unit_cat := app_security.normalize_clinical_unit_category(v_clean_unit);
  v_units_compatible := (v_dose_unit_cat = v_disp_unit_cat);

  v_server_daily_rate := app_security.compute_plan_daily_rate(
    v_plan.schedule,
    v_plan.dose_amount,
    v_plan.status
  );

  SELECT COALESCE(pg_catalog.sum(de.dispensed_quantity), 0) + p_dispensed_quantity
    INTO v_auth_total_dispensed
  FROM public.dispensing_events de
  WHERE de.medication_plan_id = p_medication_plan_id
    AND de.pharmacy_id = v_staff.pharmacy_id;

  IF NOT v_units_compatible THEN
    IF p_refill_status <> 'unable_to_estimate'
       OR p_estimated_supply_days IS NOT NULL
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Incompatible dispensed unit (%) vs prescribed dose unit (%) cannot produce an active refill forecast.',
        v_clean_unit, v_plan.dose_unit
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSIF v_plan.status <> 'active' OR v_freq = 'prn' THEN
    IF p_refill_status <> 'paused_or_prn'
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Paused, discontinued, archived, or PRN plans must record paused_or_prn refill_status without a depletion date.'
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSIF v_server_daily_rate IS NULL OR v_server_daily_rate <= 0 THEN
    IF p_refill_status <> 'unable_to_estimate'
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Plan without deterministic daily consumption rate must record unable_to_estimate without a depletion date.'
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSE
    IF p_estimated_daily_consumption IS NULL
       OR pg_catalog.abs(p_estimated_daily_consumption - v_server_daily_rate) > GREATEST(0.05, v_server_daily_rate * 0.05)
    THEN
      RAISE EXCEPTION 'Client estimated_daily_consumption (%) deviates from authoritative schedule daily rate (%).',
        p_estimated_daily_consumption, v_server_daily_rate
        USING ERRCODE = '23514';
    END IF;

    IF p_total_dispensed_analyzed IS NOT NULL
       AND pg_catalog.abs(p_total_dispensed_analyzed - v_auth_total_dispensed) > 0.01
    THEN
      RAISE EXCEPTION 'Client total_dispensed_analyzed (%) does not match authoritative cumulative ledger sum (%).',
        p_total_dispensed_analyzed, v_auth_total_dispensed
        USING ERRCODE = '23514';
    END IF;

    IF p_estimated_remaining_units IS NOT NULL
       AND p_estimated_remaining_units > (v_auth_total_dispensed + 0.01)
    THEN
      RAISE EXCEPTION 'Client estimated_remaining_units (%) exceeds authoritative total dispensed (%).',
        p_estimated_remaining_units, v_auth_total_dispensed
        USING ERRCODE = '23514';
    END IF;

    IF p_estimated_supply_days IS NOT NULL AND p_estimated_supply_end_date IS NOT NULL THEN
      IF pg_catalog.abs((p_estimated_supply_end_date - (p_dispensing_date + p_estimated_supply_days))) > 1 THEN
        RAISE EXCEPTION 'Client estimated_supply_end_date (%) is inconsistent with dispensing_date + estimated_supply_days (%).',
          p_estimated_supply_end_date, (p_dispensing_date + p_estimated_supply_days)
          USING ERRCODE = '23514';
      END IF;
    END IF;

    v_eff_daily_consumption := v_server_daily_rate;
    v_eff_supply_days := p_estimated_supply_days;
    v_eff_supply_end_date := p_estimated_supply_end_date;
    v_eff_remaining_units := p_estimated_remaining_units;
    v_eff_days_remaining := p_estimated_days_remaining;
    v_eff_refill_supply_end_date := p_refill_supply_end_date;
  END IF;

  -- Server always enforces honest provisional provenance when occurrence simulation runs client-side;
  -- client input cannot elevate itself to `server_verified`.
  v_calc_source := 'provisional_client_unverified';
  v_verif_status := 'provisional_unverified';

  v_eff_assumptions := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_forecast_assumptions, '')), ''),
    'Provisional client schedule projection (unit compatibility & daily rate bounds server-validated)'
  );
  v_eff_uncertainty := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_uncertainty_note, '')), ''),
    'Provisional client refill estimate (server validated units, daily rate bounds, and cumulative ledger sum)'
  );

  v_inputs_snapshot := COALESCE(p_calculation_inputs, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'serverValidatedAt', pg_catalog.now(),
    'serverDailyRate', v_server_daily_rate,
    'authoritativeTotalDispensed', v_auth_total_dispensed,
    'planStatus', v_plan.status,
    'regimenVersionNumber', v_plan.current_version_number,
    'prescribedDoseUnit', v_plan.dose_unit,
    'dispensedUnit', v_clean_unit,
    'unitsCompatible', v_units_compatible,
    'requestedCalculationSource', COALESCE(p_calculation_source, 'provisional_client_unverified')
  );

  INSERT INTO public.dispensing_events (
    pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    dispensed_quantity, quantity_unit, package_count, package_size,
    batch_number, expiry_date, dispensing_date,
    dispensed_by_staff_id, dispensed_by_staff_name, notes,
    estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date,
    forecast_assumptions, is_partial_fill,
    calculation_source, verification_status, algorithm_version, calculation_inputs
  )
  VALUES (
    v_staff.pharmacy_id,
    p_patient_id,
    p_medication_plan_id,
    v_plan.current_version_number,
    p_dispensed_quantity,
    v_clean_unit,
    p_package_count,
    p_package_size,
    NULLIF(pg_catalog.btrim(COALESCE(p_batch_number, '')), ''),
    p_expiry_date,
    p_dispensing_date,
    v_staff.staff_id,
    v_staff.full_name,
    NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), ''),
    v_eff_daily_consumption,
    v_eff_supply_days,
    v_eff_supply_end_date,
    v_eff_assumptions,
    COALESCE(p_is_partial_fill, false),
    v_calc_source,
    v_verif_status,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_algorithm_version, '')), ''), 'masar_refill_v1'),
    v_inputs_snapshot
  )
  RETURNING id INTO v_dispense_id;

  INSERT INTO public.refill_assessments (
    pharmacy_id, patient_id, medication_plan_id, last_dispensing_event_id,
    last_dispensed_date, last_dispensed_quantity, total_dispensed_analyzed,
    quantity_unit, estimated_daily_consumption, estimated_remaining_units,
    estimated_days_remaining, estimated_supply_end_date,
    refill_status, uncertainty_note, calculated_at,
    calculation_source, verification_status, algorithm_version, calculation_inputs
  )
  VALUES (
    v_staff.pharmacy_id,
    p_patient_id,
    p_medication_plan_id,
    v_dispense_id,
    p_dispensing_date,
    p_dispensed_quantity,
    v_auth_total_dispensed,
    v_clean_unit,
    v_eff_daily_consumption,
    v_eff_remaining_units,
    v_eff_days_remaining,
    v_eff_refill_supply_end_date,
    p_refill_status,
    v_eff_uncertainty,
    pg_catalog.now(),
    v_calc_source,
    v_verif_status,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_algorithm_version, '')), ''), 'masar_refill_v1'),
    v_inputs_snapshot
  )
  ON CONFLICT (medication_plan_id) DO UPDATE
    SET last_dispensing_event_id = EXCLUDED.last_dispensing_event_id,
        last_dispensed_date = EXCLUDED.last_dispensed_date,
        last_dispensed_quantity = EXCLUDED.last_dispensed_quantity,
        total_dispensed_analyzed = EXCLUDED.total_dispensed_analyzed,
        quantity_unit = EXCLUDED.quantity_unit,
        estimated_daily_consumption = EXCLUDED.estimated_daily_consumption,
        estimated_remaining_units = EXCLUDED.estimated_remaining_units,
        estimated_days_remaining = EXCLUDED.estimated_days_remaining,
        estimated_supply_end_date = EXCLUDED.estimated_supply_end_date,
        refill_status = EXCLUDED.refill_status,
        uncertainty_note = EXCLUDED.uncertainty_note,
        calculated_at = pg_catalog.now(),
        calculation_source = EXCLUDED.calculation_source,
        verification_status = EXCLUDED.verification_status,
        algorithm_version = EXCLUDED.algorithm_version,
        calculation_inputs = EXCLUDED.calculation_inputs;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'DISPENSE_RECORDED',
    'dispensing',
    v_dispense_id,
    'ØµØ±Ù ' || p_dispensed_quantity || ' ' || v_clean_unit || ' Ù…Ù† ' || v_plan.brand_name || ' Ù„Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || v_patient.full_name,
    'Dispensed ' || p_dispensed_quantity || ' ' || v_clean_unit || ' of ' || v_plan.brand_name || ' to ' || v_patient.full_name,
    pg_catalog.jsonb_build_object(
      'patientId', p_patient_id,
      'medicationPlanId', p_medication_plan_id,
      'regimenVersionNumber', v_plan.current_version_number,
      'refillStatus', p_refill_status,
      'calculationSource', v_calc_source,
      'verificationStatus', v_verif_status,
      'authoritativeTotalDispensed', v_auth_total_dispensed
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispensingEventId', v_dispense_id,
    'verificationStatus', v_verif_status,
    'calculationSource', v_calc_source,
    'authoritativeTotalDispensed', v_auth_total_dispensed
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Atomic Clinical RPC 7: Transactional Pharmacist Consultation Reply
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_consultation_reply(
  p_thread_id uuid,
  p_body text,
  p_new_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff       record;
  v_thread      public.consultation_threads%ROWTYPE;
  v_clean_body  text;
  v_msg_id      uuid;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_body := pg_catalog.btrim(COALESCE(p_body, ''));
  IF pg_catalog.char_length(v_clean_body) < 1 THEN
    RAISE EXCEPTION 'Consultation reply body cannot be empty.' USING ERRCODE = '23514';
  END IF;

  IF p_new_status IS NOT NULL AND p_new_status NOT IN ('open', 'follow_up', 'resolved') THEN
    RAISE EXCEPTION 'Invalid consultation status: %.', p_new_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_thread
  FROM public.consultation_threads ct
  WHERE ct.id = p_thread_id
    AND ct.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consultation thread % not found or belongs to another pharmacy.', p_thread_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.consultation_messages (
    pharmacy_id, thread_id, sender_type, sender_staff_id,
    sender_name, body, approved_by_pharmacist
  )
  VALUES (
    v_staff.pharmacy_id,
    p_thread_id,
    'pharmacist',
    v_staff.staff_id,
    v_staff.full_name,
    v_clean_body,
    true
  )
  RETURNING id INTO v_msg_id;

  UPDATE public.consultation_threads
     SET status = COALESCE(p_new_status, status),
         updated_at = pg_catalog.now()
   WHERE id = p_thread_id
     AND pharmacy_id = v_staff.pharmacy_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'CONSULTATION_REPLIED',
    'consultation',
    p_thread_id,
    'Ø¥Ø±Ø³Ø§Ù„ Ø±Ø¯ ØµÙŠØ¯Ù„Ø§Ù†ÙŠ Ù…Ø¹ØªÙ…Ø¯ Ø¹Ù„Ù‰ Ø§Ø³ØªØ´Ø§Ø±Ø© Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹',
    'Pharmacist-approved consultation reply sent',
    pg_catalog.jsonb_build_object('messageId', v_msg_id, 'newStatus', COALESCE(p_new_status, v_thread.status))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'threadId', p_thread_id,
    'messageId', v_msg_id
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. Atomic Security RPC 8: Revoke Pending Patient APK Invitation
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_patient_apk_invitation(
  p_patient_id uuid,
  p_reason text DEFAULT 'Pharmacist revoked pending invitation'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_patient      public.patients%ROWTYPE;
  v_inv          public.patient_apk_invitations%ROWTYPE;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_reason := pg_catalog.btrim(COALESCE(p_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Revocation reason must be at least 3 characters.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.patient_apk_invitations pai
  WHERE pai.patient_id = p_patient_id
    AND pai.pharmacy_id = v_staff.pharmacy_id
    AND pai.status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_NOT_PENDING'
    );
  END IF;

  UPDATE public.patient_apk_invitations
     SET status = 'revoked',
         revoked_at = pg_catalog.now()
   WHERE id = v_inv.id
     AND pharmacy_id = v_staff.pharmacy_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'INVITATION_REVOKED',
    'invitation',
    v_inv.id,
    'Ø¥Ù„ØºØ§Ø¡ Ø¯Ø¹ÙˆØ© ØªØ·Ø¨ÙŠÙ‚ Ø§Ù„Ù…Ø±ÙŠØ¶ Ù„Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || v_patient.full_name,
    'Revoked APK invitation for ' || v_patient.full_name,
    pg_catalog.jsonb_build_object('patientId', p_patient_id, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'invitationId', v_inv.id,
    'patientId', p_patient_id
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. Server-Side Clinical Audit Triggers for Single-Table Client Operations
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.write_clinical_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_actor_name  text := 'System';
  v_actor_role  text := 'system';
  v_pharmacy_id uuid;
  v_entity_id   uuid;
  v_entity_type text;
  v_action      text;
  v_summary_ar  text;
  v_summary_en  text;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT ps.full_name, ps.role
      INTO v_actor_name, v_actor_role
    FROM public.pharmacy_staff ps
    WHERE ps.id = v_uid AND ps.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.patients pt WHERE pt.auth_user_id = v_uid) THEN
        v_actor_name := 'Patient APK User';
        v_actor_role := 'patient_apk_user';
      ELSE
        v_actor_name := 'System';
        v_actor_role := 'system';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'patients' THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      v_pharmacy_id := NEW.pharmacy_id;
      v_entity_id := NEW.id;
      v_entity_type := 'patient';
      IF NEW.status = 'archived' THEN
        v_action := 'PATIENT_ARCHIVED';
        v_summary_ar := 'Ø£Ø±Ø´ÙØ© Ù…Ù„Ù Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || NEW.full_name || ' Ù…Ø¹ Ø­ÙØ¸ Ø§Ù„Ø³Ø¬Ù„';
        v_summary_en := 'Archived patient ' || NEW.full_name || ' (clinical history preserved)';
      ELSE
        v_action := 'PATIENT_RESTORED';
        v_summary_ar := 'Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ Ù…Ù„Ù Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ ' || NEW.full_name;
        v_summary_en := 'Restored patient profile for ' || NEW.full_name;
      END IF;
    ELSE
      RETURN NULL;
    END IF;

  ELSIF TG_TABLE_NAME = 'lab_results' AND TG_OP = 'INSERT' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'lab_result';
    v_action := 'LAB_RESULT_RECORDED';
    v_summary_ar := 'ØªØ³Ø¬ÙŠÙ„ Ù†ØªÙŠØ¬Ø© ØªØ­Ù„ÙŠÙ„ ' || NEW.test_name || ': ' || NEW.value || ' ' || NEW.unit;
    v_summary_en := 'Recorded lab result ' || NEW.test_name || ': ' || NEW.value || ' ' || NEW.unit;

  ELSIF TG_TABLE_NAME = 'follow_up_tasks' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'follow_up';
    IF TG_OP = 'INSERT' THEN
      v_action := 'FOLLOWUP_CREATED';
      v_summary_ar := 'Ø¥Ù†Ø´Ø§Ø¡ Ù…Ù‡Ù…Ø© Ù…ØªØ§Ø¨Ø¹Ø© Ø¨ØªØ§Ø±ÙŠØ® ' || NEW.due_date::text;
      v_summary_en := 'Created follow-up task due ' || NEW.due_date::text;
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      v_action := 'FOLLOWUP_STATUS_UPDATED';
      v_summary_ar := 'ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø§Ù„Ù…ØªØ§Ø¨Ø¹Ø© Ø¥Ù„Ù‰ (' || NEW.status || ')';
      v_summary_en := 'Updated follow-up task status to ' || NEW.status;
    ELSE
      RETURN NULL;
    END IF;

  ELSIF TG_TABLE_NAME = 'follow_up_contact_logs' AND TG_OP = 'INSERT' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.follow_up_task_id;
    v_entity_type := 'follow_up';
    v_action := 'FOLLOWUP_CONTACT_LOGGED';
    v_summary_ar := 'ØªÙˆØ«ÙŠÙ‚ ØªÙˆØ§ØµÙ„ Ù…ØªØ§Ø¨Ø¹Ø© Ø¹Ø¨Ø± (' || NEW.channel || ')';
    v_summary_en := 'Recorded follow-up contact via ' || NEW.channel;

  ELSIF TG_TABLE_NAME = 'dose_events' AND TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'dose_event';
    v_action := 'DOSE_EVENT_UPDATED';
    v_summary_ar := 'ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø§Ù„Ø¬Ø±Ø¹Ø© Ø¥Ù„Ù‰ (' || NEW.status || ')';
    v_summary_en := 'Updated scheduled dose status to ' || NEW.status;

  ELSIF TG_TABLE_NAME = 'consultation_threads' AND TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'consultation';
    v_action := 'CONSULTATION_STATUS_UPDATED';
    v_summary_ar := 'ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø§Ù„Ø§Ø³ØªØ´Ø§Ø±Ø© Ø¥Ù„Ù‰ (' || NEW.status || ')';
    v_summary_en := 'Updated consultation status to ' || NEW.status;

  ELSE
    RETURN NULL;
  END IF;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en
  )
  VALUES (
    v_pharmacy_id,
    v_uid,
    v_actor_name,
    v_actor_role,
    v_action,
    v_entity_type,
    v_entity_id,
    v_summary_ar,
    v_summary_en
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_security.write_clinical_audit_log() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_patients_status ON public.patients;
CREATE TRIGGER trg_audit_patients_status
  AFTER UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

DROP TRIGGER IF EXISTS trg_audit_lab_results_insert ON public.lab_results;
CREATE TRIGGER trg_audit_lab_results_insert
  AFTER INSERT ON public.lab_results
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

DROP TRIGGER IF EXISTS trg_audit_followup_tasks_write ON public.follow_up_tasks;
CREATE TRIGGER trg_audit_followup_tasks_write
  AFTER INSERT OR UPDATE ON public.follow_up_tasks
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

DROP TRIGGER IF EXISTS trg_audit_followup_contact_logs_insert ON public.follow_up_contact_logs;
CREATE TRIGGER trg_audit_followup_contact_logs_insert
  AFTER INSERT ON public.follow_up_contact_logs
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

DROP TRIGGER IF EXISTS trg_audit_dose_events_status ON public.dose_events;
CREATE TRIGGER trg_audit_dose_events_status
  AFTER UPDATE ON public.dose_events
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

DROP TRIGGER IF EXISTS trg_audit_consultation_threads_status ON public.consultation_threads;
CREATE TRIGGER trg_audit_consultation_threads_status
  AFTER UPDATE ON public.consultation_threads
  FOR EACH ROW EXECUTE FUNCTION app_security.write_clinical_audit_log();

-- ----------------------------------------------------------------------------
-- 13. Minimal Execution Grants for Stage 2B Pharmacist RPCs
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_patient_with_clinical_tags(
  text, text, text, text, text, date, text, text, text, date, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_patient_with_clinical_tags(
  text, text, text, text, text, date, text, text, text, date, jsonb, jsonb
) TO authenticated;

REVOKE ALL ON FUNCTION public.update_patient_with_clinical_tags(
  uuid, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_patient_with_clinical_tags(
  uuid, jsonb, jsonb, jsonb
) TO authenticated;

REVOKE ALL ON FUNCTION public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
) TO authenticated;

REVOKE ALL ON FUNCTION public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
) TO authenticated;

REVOKE ALL ON FUNCTION public.change_medication_plan_status(
  uuid, text, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_medication_plan_status(
  uuid, text, text, date
) TO authenticated;

REVOKE ALL ON FUNCTION public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
) TO authenticated;

REVOKE ALL ON FUNCTION public.send_consultation_reply(
  uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_consultation_reply(
  uuid, text, text
) TO authenticated;

REVOKE ALL ON FUNCTION public.revoke_patient_apk_invitation(
  uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_patient_apk_invitation(
  uuid, text
) TO authenticated;

COMMIT;