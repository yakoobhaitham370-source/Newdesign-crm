-- ============================================================================
-- MASAR Care — Stage 2A Database Migration 0002 (Rev 3 — V1.5.4 Hardened)
-- Private app_security Schema, Scoped MASAR Table REVOKE/GRANTs, Schema-Qualified
-- pgcrypto Calls, Least-Privilege Dose Confirmation RPC, Unscheduled PRN Reports
-- & Owner-Authorized Account Recovery Controls
-- STATUS: REVIEW ONLY — DO NOT EXECUTE WITHOUT EXPLICIT MIGRATION APPROVAL
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Private Security Schema & Authoritative Role Helpers (Audit M7 & H3 Fix)
-- Moved out of exposed `public` schema into `app_security`; never trusts
-- client-editable `raw_user_meta_data`; keeps pinned search_path without
-- user-writable schemas (`pg_catalog, public, pg_temp`).
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app_security;
REVOKE ALL ON SCHEMA app_security FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA app_security TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app_security.current_pharmacy_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ps.pharmacy_id
  FROM public.pharmacy_staff ps
  JOIN public.pharmacies ph ON ph.id = ps.pharmacy_id
  WHERE ps.id = auth.uid()
    AND ps.is_active = true
    AND ph.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app_security.current_staff_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ps.role
  FROM public.pharmacy_staff ps
  JOIN public.pharmacies ph ON ph.id = ps.pharmacy_id
  WHERE ps.id = auth.uid()
    AND ps.is_active = true
    AND ph.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app_security.is_active_pharmacist()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pharmacy_staff ps
    JOIN public.pharmacies ph ON ph.id = ps.pharmacy_id
    WHERE ps.id = auth.uid()
      AND ps.is_active = true
      AND ph.is_active = true
      AND ps.role IN ('pharmacy_owner', 'authorized_pharmacist')
  );
$$;

CREATE OR REPLACE FUNCTION app_security.current_patient_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id
  FROM public.patients p
  WHERE p.auth_user_id = auth.uid()
    AND p.status = 'active'
  LIMIT 1;
$$;

-- Audit H3, F9 & V1.5.4 H3 Fix: Unbiased CSPRNG 6-digit code generator using
-- schema-qualified `extensions.gen_random_bytes(4)` with rejection sampling
-- (discard raw 31-bit values >= 2147400000 = 2386 * 900000).
CREATE OR REPLACE FUNCTION app_security.generate_csprng_6digit_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_raw   bigint;
  v_limit constant bigint := 2147400000; -- largest multiple of 900000 <= 2^31 (2147483648)
BEGIN
  LOOP
    v_raw := (('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint & x'7fffffff'::bigint);
    EXIT WHEN v_raw < v_limit;
  END LOOP;

  RETURN lpad(((v_raw % 900000) + 100000)::text, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION app_security.current_pharmacy_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.current_pharmacy_id() TO authenticated, service_role;

REVOKE ALL ON FUNCTION app_security.current_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.current_staff_role() TO authenticated, service_role;

REVOKE ALL ON FUNCTION app_security.is_active_pharmacist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.is_active_pharmacist() TO authenticated, service_role;

REVOKE ALL ON FUNCTION app_security.current_patient_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.current_patient_id() TO authenticated, service_role;

REVOKE ALL ON FUNCTION app_security.generate_csprng_6digit_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.generate_csprng_6digit_code() TO service_role;

-- ----------------------------------------------------------------------------
-- 2. Enable & Force Row-Level Security on All 22 MASAR Tables
-- ----------------------------------------------------------------------------
ALTER TABLE public.pharmacies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pharmacies FORCE ROW LEVEL SECURITY;

ALTER TABLE public.pharmacy_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pharmacy_staff FORCE ROW LEVEL SECURITY;

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;

ALTER TABLE public.patient_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_conditions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.patient_allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_allergies FORCE ROW LEVEL SECURITY;

ALTER TABLE public.medication_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_catalog FORCE ROW LEVEL SECURITY;

ALTER TABLE public.patient_medication_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_medication_plans FORCE ROW LEVEL SECURITY;

ALTER TABLE public.regimen_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regimen_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.medication_pause_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_pause_periods FORCE ROW LEVEL SECURITY;

ALTER TABLE public.scheduled_doses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_doses FORCE ROW LEVEL SECURITY;

ALTER TABLE public.dose_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dose_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.unscheduled_dose_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unscheduled_dose_reports FORCE ROW LEVEL SECURITY;

ALTER TABLE public.dispensing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispensing_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.refill_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refill_assessments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lab_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lab_results FORCE ROW LEVEL SECURITY;

ALTER TABLE public.follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_tasks FORCE ROW LEVEL SECURITY;

ALTER TABLE public.follow_up_contact_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_contact_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.consultation_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_threads FORCE ROW LEVEL SECURITY;

ALTER TABLE public.consultation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_messages FORCE ROW LEVEL SECURITY;

ALTER TABLE public.patient_apk_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_apk_invitations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.invitation_redemption_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_redemption_attempts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Scoped Least-Privilege SQL Grants (V1.5.4 H2 Fix)
-- Revoke privileges ONLY on explicitly enumerated MASAR tables (never schema-wide
-- `ON ALL TABLES/SEQUENCES IN SCHEMA public`, so unrelated tables in a shared
-- Postgres/Supabase project retain their existing privileges untouched).
-- MASAR tables use UUID primary keys (`gen_random_uuid()`) and create zero sequences.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.pharmacies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pharmacy_staff FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.patients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.patient_conditions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.patient_allergies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medication_catalog FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.patient_medication_plans FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.regimen_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medication_pause_periods FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.scheduled_doses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dose_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.unscheduled_dose_reports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispensing_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.refill_assessments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.lab_results FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.follow_up_tasks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.follow_up_contact_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.consultation_threads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.consultation_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.patient_apk_invitations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitation_redemption_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.pharmacies TO authenticated;
GRANT UPDATE (name_ar, name_en, phone) ON public.pharmacies TO authenticated;

GRANT SELECT ON public.pharmacy_staff TO authenticated;
GRANT UPDATE (full_name, phone, is_active) ON public.pharmacy_staff TO authenticated;

GRANT SELECT, INSERT, UPDATE (
  full_name, phone, phone_owner_type, caregiver_name, date_of_birth, sex,
  contact_preference, clinical_notes, status, archived_at, archived_reason, updated_at
) ON public.patients TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_conditions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_allergies TO authenticated;
GRANT SELECT ON public.medication_catalog TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.patient_medication_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE (effective_to) ON public.regimen_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE (resumed_at) ON public.medication_pause_periods TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scheduled_doses TO authenticated;
-- Direct dose_events INSERT/UPDATE is restricted to pharmacy staff via RLS; patients
-- confirm scheduled doses exclusively via `public.confirm_scheduled_dose(...)` RPC.
GRANT SELECT, INSERT, UPDATE (status, patient_note) ON public.dose_events TO authenticated;
GRANT SELECT, INSERT, UPDATE (reviewed_by_staff_id, reviewed_at) ON public.unscheduled_dose_reports TO authenticated;
GRANT SELECT, INSERT ON public.dispensing_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.refill_assessments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.lab_results TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.follow_up_tasks TO authenticated;
GRANT SELECT, INSERT ON public.follow_up_contact_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE (status, updated_at) ON public.consultation_threads TO authenticated;
GRANT SELECT, INSERT ON public.consultation_messages TO authenticated;

-- Never grant SELECT on token_hash, pharmacist_pin_hash, or sms_otp_hash to authenticated clients
GRANT SELECT (
  id, pharmacy_id, patient_id, invitation_purpose, recovery_reason,
  approved_by_owner_id, recovery_identity_verified, target_phone,
  status, issued_at, expires_at, activated_at, revoked_at, issued_by_staff_id,
  issued_by_staff_name, failed_attempts, max_attempts, otp_send_count, activated_device_label
) ON public.patient_apk_invitations TO authenticated;

GRANT SELECT ON public.invitation_redemption_attempts TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Row-Level Security Policies (Using app_security.* Authoritative Functions)
-- ----------------------------------------------------------------------------

-- 4.1 pharmacies
CREATE POLICY pharmacies_staff_select ON public.pharmacies
  FOR SELECT TO authenticated
  USING (id = app_security.current_pharmacy_id());

CREATE POLICY pharmacies_owner_update ON public.pharmacies
  FOR UPDATE TO authenticated
  USING (id = app_security.current_pharmacy_id() AND app_security.current_staff_role() = 'pharmacy_owner')
  WITH CHECK (id = app_security.current_pharmacy_id() AND app_security.current_staff_role() = 'pharmacy_owner');

-- 4.2 pharmacy_staff
CREATE POLICY staff_same_pharmacy_select ON public.pharmacy_staff
  FOR SELECT TO authenticated
  USING (pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY staff_owner_update ON public.pharmacy_staff
  FOR UPDATE TO authenticated
  USING (
    pharmacy_id = app_security.current_pharmacy_id()
    AND app_security.current_staff_role() = 'pharmacy_owner'
  )
  WITH CHECK (
    pharmacy_id = app_security.current_pharmacy_id()
    AND app_security.current_staff_role() = 'pharmacy_owner'
  );

-- 4.3 patients (Pharmacist-Only Registration; Strict Pharmacy & Patient Isolation)
CREATE POLICY patients_pharmacist_select ON public.patients
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (id = app_security.current_patient_id() AND auth_user_id = auth.uid())
  );

CREATE POLICY patients_pharmacist_insert ON public.patients
  FOR INSERT TO authenticated
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
    AND created_by_staff_id = auth.uid()
    AND auth_user_id IS NULL
  );

CREATE POLICY patients_pharmacist_update ON public.patients
  FOR UPDATE TO authenticated
  USING (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  )
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  );

-- 4.4 patient_conditions & patient_allergies
CREATE POLICY conditions_select ON public.patient_conditions
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY conditions_pharmacist_write ON public.patient_conditions
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY allergies_select ON public.patient_allergies
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY allergies_pharmacist_write ON public.patient_allergies
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

-- 4.5 medication_catalog
CREATE POLICY catalog_authenticated_select ON public.medication_catalog
  FOR SELECT TO authenticated
  USING (is_active = true);

-- 4.6 patient_medication_plans, regimen_versions, medication_pause_periods
CREATE POLICY med_plans_select ON public.patient_medication_plans
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id() AND status IN ('active', 'paused'))
  );

CREATE POLICY med_plans_pharmacist_insert ON public.patient_medication_plans
  FOR INSERT TO authenticated
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
    AND created_by_staff_id = auth.uid()
  );

CREATE POLICY med_plans_pharmacist_update ON public.patient_medication_plans
  FOR UPDATE TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY regimen_versions_select ON public.regimen_versions
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR EXISTS (
      SELECT 1 FROM public.patient_medication_plans mp
      WHERE mp.id = regimen_versions.medication_plan_id
        AND mp.patient_id = app_security.current_patient_id()
    )
  );

CREATE POLICY regimen_versions_pharmacist_insert ON public.regimen_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
    AND changed_by_staff_id = auth.uid()
  );

CREATE POLICY regimen_versions_pharmacist_close ON public.regimen_versions
  FOR UPDATE TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY pause_periods_select ON public.medication_pause_periods
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR EXISTS (
      SELECT 1 FROM public.patient_medication_plans mp
      WHERE mp.id = medication_pause_periods.medication_plan_id
        AND mp.patient_id = app_security.current_patient_id()
    )
  );

CREATE POLICY pause_periods_pharmacist_write ON public.medication_pause_periods
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

-- 4.7 scheduled_doses, dose_events & unscheduled_dose_reports (V1.5.4 H1 Fix)
CREATE POLICY scheduled_doses_select ON public.scheduled_doses
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY scheduled_doses_pharmacist_write ON public.scheduled_doses
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY dose_events_select ON public.dose_events
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

-- Direct client INSERT/UPDATE on dose_events is limited to active pharmacy staff;
-- authenticated patients CANNOT bypass provenance validation via direct table writes
-- and must use `public.confirm_scheduled_dose(...)`.
CREATE POLICY dose_events_pharmacist_insert ON public.dose_events
  FOR INSERT TO authenticated
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  );

CREATE POLICY dose_events_pharmacist_update ON public.dose_events
  FOR UPDATE TO authenticated
  USING (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  )
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  );

CREATE POLICY unscheduled_dose_reports_select ON public.unscheduled_dose_reports
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY unscheduled_dose_reports_patient_insert ON public.unscheduled_dose_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    patient_id = app_security.current_patient_id()
    AND is_verified_schedule = false
    AND reviewed_by_staff_id IS NULL
    AND reviewed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.patients pt
      WHERE pt.id = unscheduled_dose_reports.patient_id
        AND pt.pharmacy_id = unscheduled_dose_reports.pharmacy_id
        AND pt.status = 'active'
    )
  );

CREATE POLICY unscheduled_dose_reports_pharmacist_review ON public.unscheduled_dose_reports
  FOR UPDATE TO authenticated
  USING (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
  )
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
    AND reviewed_by_staff_id = auth.uid()
  );

-- 4.8 dispensing_events & refill_assessments
CREATE POLICY dispensing_events_select ON public.dispensing_events
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY dispensing_events_pharmacist_insert ON public.dispensing_events
  FOR INSERT TO authenticated
  WITH CHECK (
    app_security.is_active_pharmacist()
    AND pharmacy_id = app_security.current_pharmacy_id()
    AND dispensed_by_staff_id = auth.uid()
  );

CREATE POLICY refill_assessments_select ON public.refill_assessments
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY refill_assessments_pharmacist_write ON public.refill_assessments
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

-- 4.9 lab_results, follow_up_tasks, follow_up_contact_logs
CREATE POLICY lab_results_select ON public.lab_results
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY lab_results_pharmacist_write ON public.lab_results
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY followup_tasks_pharmacist_only ON public.follow_up_tasks
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY followup_logs_pharmacist_only ON public.follow_up_contact_logs
  FOR ALL TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
  WITH CHECK (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

-- 4.10 consultation_threads & consultation_messages
CREATE POLICY consultations_select ON public.consultation_threads
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY consultations_write ON public.consultation_threads
  FOR ALL TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  )
  WITH CHECK (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR (patient_id = app_security.current_patient_id())
  );

CREATE POLICY consultation_messages_select ON public.consultation_messages
  FOR SELECT TO authenticated
  USING (
    (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id())
    OR EXISTS (
      SELECT 1 FROM public.consultation_threads ct
      WHERE ct.id = consultation_messages.thread_id
        AND ct.patient_id = app_security.current_patient_id()
    )
  );

CREATE POLICY consultation_messages_insert ON public.consultation_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      app_security.is_active_pharmacist()
      AND pharmacy_id = app_security.current_pharmacy_id()
      AND sender_type = 'pharmacist'
      AND sender_staff_id = auth.uid()
      AND approved_by_pharmacist = true
    )
    OR (
      sender_type = 'patient'
      AND sender_staff_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.consultation_threads ct
        WHERE ct.id = consultation_messages.thread_id
          AND ct.patient_id = app_security.current_patient_id()
          AND ct.pharmacy_id = consultation_messages.pharmacy_id
      )
    )
  );

-- 4.11 patient_apk_invitations, invitation_redemption_attempts, audit_logs
CREATE POLICY invitations_pharmacist_select ON public.patient_apk_invitations
  FOR SELECT TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

CREATE POLICY redemption_attempts_owner_select ON public.invitation_redemption_attempts
  FOR SELECT TO authenticated
  USING (
    pharmacy_id = app_security.current_pharmacy_id()
    AND app_security.current_staff_role() = 'pharmacy_owner'
  );

CREATE POLICY audit_logs_pharmacist_select ON public.audit_logs
  FOR SELECT TO authenticated
  USING (app_security.is_active_pharmacist() AND pharmacy_id = app_security.current_pharmacy_id());

-- ----------------------------------------------------------------------------
-- 5. Least-Privilege Scheduled Dose Confirmation RPC (V1.5.4 H1 Fix)
-- Authenticated patients confirm an EXISTING authorized `scheduled_doses` row.
-- All schedule/regimen fields (`scheduled_date`, `scheduled_time24`,
-- `planned_dose_amount`, `dose_unit`, `regimen_version_number`) are derived
-- exclusively server-side from `scheduled_doses`. Supports offline idempotency
-- via `p_client_event_uuid` while blocking duplicate confirmations per dose.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_scheduled_dose(
  p_scheduled_dose_id uuid,
  p_status text,
  p_client_event_uuid uuid,
  p_patient_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_patient_id     uuid;
  v_sd             public.scheduled_doses%ROWTYPE;
  v_plan           public.patient_medication_plans%ROWTYPE;
  v_existing_uuid  public.dose_events%ROWTYPE;
  v_existing_dose  public.dose_events%ROWTYPE;
  v_dose_event_id  uuid;
  v_clean_note     text;
BEGIN
  v_patient_id := app_security.current_patient_id();
  IF v_patient_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'UNAUTHORIZED_NOT_ACTIVE_PATIENT'
    );
  END IF;

  IF p_scheduled_dose_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'SCHEDULED_DOSE_ID_REQUIRED'
    );
  END IF;

  IF p_client_event_uuid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'CLIENT_EVENT_UUID_REQUIRED'
    );
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('taken', 'skipped_by_patient', 'delayed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVALID_DOSE_CONFIRMATION_STATUS'
    );
  END IF;

  v_clean_note := CASE
    WHEN p_patient_note IS NULL OR char_length(btrim(p_patient_note)) = 0 THEN NULL
    ELSE left(btrim(p_patient_note), 500)
  END;

  -- V1.5.4 QA: Serialize concurrent retries targeting the same scheduled_dose_id
  -- or reusing the same client_event_uuid in fixed namespace order (sd -> ev) so
  -- parallel Read Committed sessions settle deterministically without deadlock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_confirm_sd:' || p_scheduled_dose_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_confirm_ev:' || p_client_event_uuid::text, 0)
  );

  -- Idempotent replay check on offline client_event_uuid
  SELECT * INTO v_existing_uuid
  FROM public.dose_events de
  WHERE de.client_event_uuid = p_client_event_uuid;

  IF FOUND THEN
    IF v_existing_uuid.patient_id = v_patient_id
       AND v_existing_uuid.scheduled_dose_id = p_scheduled_dose_id
    THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotentReplay', true,
        'doseEventId', v_existing_uuid.id,
        'scheduledDoseId', v_existing_uuid.scheduled_dose_id,
        'status', v_existing_uuid.status
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'CLIENT_EVENT_UUID_CONFLICT'
    );
  END IF;

  -- Verify authoritative scheduled occurrence & patient ownership
  SELECT * INTO v_sd
  FROM public.scheduled_doses sd
  WHERE sd.id = p_scheduled_dose_id
    AND sd.patient_id = v_patient_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'SCHEDULED_DOSE_NOT_FOUND_OR_UNAUTHORIZED'
    );
  END IF;

  -- Verify active parent medication plan
  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = v_sd.medication_plan_id
    AND mp.patient_id = v_patient_id
    AND mp.pharmacy_id = v_sd.pharmacy_id
  FOR SHARE;

  IF NOT FOUND OR v_plan.status <> 'active' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'MEDICATION_PLAN_NOT_ACTIVE',
      'planStatus', COALESCE(v_plan.status, 'missing')
    );
  END IF;

  -- Block confirmations on dates falling inside an authoritative pause window
  IF EXISTS (
    SELECT 1
    FROM public.medication_pause_periods mpp
    WHERE mpp.medication_plan_id = v_plan.id
      AND v_sd.scheduled_date >= mpp.paused_from
      AND (mpp.resumed_at IS NULL OR v_sd.scheduled_date < mpp.resumed_at)
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'MEDICATION_PLAN_PAUSED_ON_DATE'
    );
  END IF;

  -- Prevent duplicate confirmations for the same scheduled_dose_id
  SELECT * INTO v_existing_dose
  FROM public.dose_events de
  WHERE de.scheduled_dose_id = p_scheduled_dose_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_dose.status = 'pending_unconfirmed' THEN
      BEGIN
        UPDATE public.dose_events
           SET status = p_status,
               patient_note = COALESCE(v_clean_note, patient_note),
               client_event_uuid = p_client_event_uuid
         WHERE id = v_existing_dose.id
        RETURNING id INTO v_dose_event_id;

        RETURN jsonb_build_object(
          'ok', true,
          'idempotentReplay', false,
          'amendedFromPending', true,
          'doseEventId', v_dose_event_id,
          'scheduledDoseId', v_sd.id,
          'status', p_status,
          'scheduledDate', v_sd.scheduled_date,
          'scheduledTime24', v_sd.scheduled_time24,
          'plannedDoseAmount', v_sd.planned_dose_amount,
          'doseUnit', v_sd.dose_unit,
          'regimenVersionNumber', v_sd.regimen_version_number
        );
      EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object(
          'ok', false,
          'errorCode', 'CLIENT_EVENT_UUID_CONFLICT'
        );
      END;
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'DUPLICATE_DOSE_CONFIRMATION_BLOCKED',
      'existingDoseEventId', v_existing_dose.id,
      'existingStatus', v_existing_dose.status
    );
  END IF;

  -- Defense-in-depth subtransaction catch preserves UNIQUE constraints while returning
  -- deterministic idempotentReplay / conflict JSONB under concurrent races (e.g., if
  -- a pharmacist insert or cross-slot collision raced with confirm_scheduled_dose).
  BEGIN
    INSERT INTO public.dose_events (
      pharmacy_id, patient_id, medication_plan_id, scheduled_dose_id,
      regimen_version_number, scheduled_date, scheduled_time24,
      planned_dose_amount, dose_unit, status, client_event_uuid, patient_note
    )
    VALUES (
      v_sd.pharmacy_id, v_sd.patient_id, v_sd.medication_plan_id, v_sd.id,
      v_sd.regimen_version_number, v_sd.scheduled_date, v_sd.scheduled_time24,
      v_sd.planned_dose_amount, v_sd.dose_unit, p_status, p_client_event_uuid, v_clean_note
    )
    RETURNING id INTO v_dose_event_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing_uuid
    FROM public.dose_events de
    WHERE de.client_event_uuid = p_client_event_uuid;

    IF FOUND THEN
      IF v_existing_uuid.patient_id = v_patient_id
         AND v_existing_uuid.scheduled_dose_id = p_scheduled_dose_id
      THEN
        RETURN jsonb_build_object(
          'ok', true,
          'idempotentReplay', true,
          'doseEventId', v_existing_uuid.id,
          'scheduledDoseId', v_existing_uuid.scheduled_dose_id,
          'status', v_existing_uuid.status
        );
      END IF;

      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'CLIENT_EVENT_UUID_CONFLICT'
      );
    END IF;

    SELECT * INTO v_existing_dose
    FROM public.dose_events de
    WHERE de.scheduled_dose_id = p_scheduled_dose_id
       OR (
         de.medication_plan_id = v_sd.medication_plan_id
         AND de.scheduled_date = v_sd.scheduled_date
         AND de.scheduled_time24 = v_sd.scheduled_time24
       )
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'DUPLICATE_DOSE_CONFIRMATION_BLOCKED',
        'existingDoseEventId', v_existing_dose.id,
        'existingStatus', v_existing_dose.status
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'CONCURRENT_CONFIRMATION_CONFLICT'
    );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotentReplay', false,
    'doseEventId', v_dose_event_id,
    'scheduledDoseId', v_sd.id,
    'status', p_status,
    'scheduledDate', v_sd.scheduled_date,
    'scheduledTime24', v_sd.scheduled_time24,
    'plannedDoseAmount', v_sd.planned_dose_amount,
    'doseUnit', v_sd.dose_unit,
    'regimenVersionNumber', v_sd.regimen_version_number
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Hardened Invitation & Identity-Binding RPCs (Fixes C1, C2, C3, H3, H4, H8, M7)
-- ----------------------------------------------------------------------------

-- 6.1 Issue a single-use invitation (Pharmacist-Only; Owner-Approved Recovery)
-- Audit H3 Fix: Uses CSPRNG `app_security.generate_csprng_6digit_code()` and
-- schema-qualified `extensions.*` pgcrypto calls.
-- Audit H8 & V1.5.4 H4 Fix: Activated patients require `device_replacement_recovery`
-- issued exclusively by an active `pharmacy_owner` with independent identity
-- verification attestation (`p_recovery_identity_verified = true`), verified
-- phone on file, and documented reason (>= 10 chars).
-- NOTE: Actual SMS OTP dispatch, Supabase Admin Auth provisioning, and prior
-- session revocation Edge Functions remain NOT IMPLEMENTED in Stage 1/V1.5.4.
CREATE OR REPLACE FUNCTION public.issue_patient_apk_invitation(
  p_patient_id uuid,
  p_invitation_purpose text DEFAULT 'initial_activation',
  p_recovery_reason text DEFAULT NULL,
  p_ttl_hours integer DEFAULT 72,
  p_recovery_identity_verified boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_pharmacy_id uuid;
  v_staff_name text;
  v_staff_role text;
  v_patient public.patients%ROWTYPE;
  v_raw_token text;
  v_token_hash text;
  v_handover_pin text;
  v_pin_hash text;
  v_inv_id uuid;
  v_recent_recovery_count integer;
BEGIN
  IF NOT app_security.is_active_pharmacist() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'UNAUTHORIZED_NOT_PHARMACIST'
    );
  END IF;

  SELECT ps.pharmacy_id, ps.full_name, ps.role
    INTO v_pharmacy_id, v_staff_name, v_staff_role
  FROM public.pharmacy_staff ps
  WHERE ps.id = auth.uid() AND ps.is_active = true;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_pharmacy_id
    AND pt.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'PATIENT_NOT_FOUND_OR_CROSS_TENANT'
    );
  END IF;

  -- Audit H8 Fix: Prevent silent account replacement if patient is already linked to auth_user_id
  IF v_patient.auth_user_id IS NOT NULL AND p_invitation_purpose <> 'device_replacement_recovery' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'ALREADY_ACTIVATED_REQUIRES_RECOVERY_CEREMONY'
    );
  END IF;

  IF p_invitation_purpose = 'device_replacement_recovery' THEN
    IF v_patient.auth_user_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'PATIENT_NOT_ACTIVATED_USE_INITIAL_INVITATION'
      );
    END IF;

    -- V1.5.4 H4 Fix: Separation of privilege — recovery requires pharmacy_owner approval
    IF v_staff_role <> 'pharmacy_owner' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REQUIRES_PHARMACY_OWNER_APPROVAL'
      );
    END IF;

    -- Require independent verification attestation (in-person or verified phone challenge)
    IF p_recovery_identity_verified IS DISTINCT FROM true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_IDENTITY_VERIFICATION_REQUIRED'
      );
    END IF;

    IF v_patient.verified_account_phone IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'NO_VERIFIED_PHONE_ON_FILE_FOR_RECOVERY'
      );
    END IF;

    IF p_recovery_reason IS NULL OR char_length(btrim(p_recovery_reason)) < 10 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REASON_MIN_10_CHARS_REQUIRED'
      );
    END IF;

    -- Rate-limit recovery issuances per patient (max 2 within 24 hours)
    SELECT count(*) INTO v_recent_recovery_count
    FROM public.patient_apk_invitations pai
    WHERE pai.patient_id = p_patient_id
      AND pai.invitation_purpose = 'device_replacement_recovery'
      AND pai.issued_at > now() - interval '24 hours';

    IF v_recent_recovery_count >= 2 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_RATE_LIMIT_EXCEEDED'
      );
    END IF;
  END IF;

  -- Revoke any existing pending invitation for this patient before issuing a new one
  UPDATE public.patient_apk_invitations
     SET status = 'revoked',
         revoked_at = now()
   WHERE patient_id = p_patient_id
     AND pharmacy_id = v_pharmacy_id
     AND status = 'pending';

  -- Audit H3 & V1.5.4 H3 Fix: Schema-qualified CSPRNG 256-bit single-use token + 6-digit PIN
  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_handover_pin := app_security.generate_csprng_6digit_code();
  v_pin_hash := extensions.crypt(v_handover_pin, extensions.gen_salt('bf', 10));

  INSERT INTO public.patient_apk_invitations (
    pharmacy_id, patient_id, invitation_purpose, recovery_reason,
    approved_by_owner_id, recovery_identity_verified, superseded_auth_user_id,
    target_phone, token_hash, pharmacist_pin_hash, status, expires_at,
    issued_by_staff_id, issued_by_staff_name
  )
  VALUES (
    v_pharmacy_id, p_patient_id, p_invitation_purpose, p_recovery_reason,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN auth.uid() ELSE NULL END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN true ELSE false END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN v_patient.auth_user_id ELSE NULL END,
    COALESCE(v_patient.verified_account_phone, v_patient.phone),
    v_token_hash, v_pin_hash, 'pending',
    now() + make_interval(hours => LEAST(GREATEST(p_ttl_hours, 1), 168)),
    auth.uid(), v_staff_name
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_pharmacy_id, auth.uid(), v_staff_name, v_staff_role,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'INVITATION_RECOVERY_ISSUED'
         ELSE 'INVITATION_ISSUED'
    END,
    'invitation', v_inv_id,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'إصدار دعوة استعادة جهاز بموافقة مالك الصيدلية والتحقق المستقل'
         ELSE 'إصدار دعوة تفعيل آمنة أحادية الاستخدام لتطبيق المريض'
    END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'Issued owner-approved device replacement recovery invitation with verified identity check'
         ELSE 'Issued single-use patient APK invitation with CSPRNG handover PIN'
    END,
    jsonb_build_object(
      'purpose', p_invitation_purpose,
      'recoveryReason', p_recovery_reason,
      'approvedByOwnerId', CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN auth.uid() ELSE NULL END,
      'supersededAuthUserId', v_patient.auth_user_id,
      'recoveryIdentityVerified', (p_invitation_purpose = 'device_replacement_recovery')
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'invitationId', v_inv_id,
    'invitationPurpose', p_invitation_purpose,
    'singleUseToken', v_raw_token,
    'pharmacistHandoverPin', v_handover_pin
  );
END;
$$;

-- 6.2 Request SMS OTP Challenge (Audit C1, C2, C3, H3 Fix — service_role Edge Function ONLY)
CREATE OR REPLACE FUNCTION public.request_invitation_sms_otp(
  p_raw_token text,
  p_pharmacist_pin text,
  p_network_ip_hmac text,
  p_device_fingerprint_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_token_hash text;
  v_inv public.patient_apk_invitations%ROWTYPE;
  v_ip_failures integer;
  v_device_failures integer;
  v_sms_otp text;
  v_new_failures integer;
  v_locked boolean := false;
BEGIN
  -- Backend-enforced multi-key rate limit (IP HMAC + Device Fingerprint)
  SELECT count(*) INTO v_ip_failures
  FROM public.invitation_redemption_attempts
  WHERE network_ip_hmac = p_network_ip_hmac
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  SELECT count(*) INTO v_device_failures
  FROM public.invitation_redemption_attempts
  WHERE device_fingerprint_hash IS NOT NULL
    AND device_fingerprint_hash = p_device_fingerprint_hash
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  IF v_ip_failures >= 10 OR v_device_failures >= 5 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'RATE_LIMIT_EXCEEDED'
    );
  END IF;

  v_token_hash := encode(extensions.digest(coalesce(p_raw_token, ''), 'sha256'), 'hex');

  SELECT * INTO v_inv
  FROM public.patient_apk_invitations
  WHERE token_hash = v_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.invitation_redemption_attempts (
      network_ip_hmac, device_fingerprint_hash, phase, outcome, failure_reason
    ) VALUES (
      p_network_ip_hmac, p_device_fingerprint_hash, 'otp_request', 'FAILED', 'TOKEN_NOT_FOUND'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVALID_INVITATION'
    );
  END IF;

  IF v_inv.status <> 'pending' THEN
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'otp_request', 'FAILED', 'STATUS_' || upper(v_inv.status)
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_NOT_PENDING',
      'status', v_inv.status
    );
  END IF;

  IF now() > v_inv.expires_at THEN
    UPDATE public.patient_apk_invitations SET status = 'expired' WHERE id = v_inv.id;
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'otp_request', 'FAILED', 'EXPIRED'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_EXPIRED'
    );
  END IF;

  -- Verify Pharmacist Handover PIN before dispatching SMS OTP (commits failure counter on mismatch!)
  IF v_inv.pharmacist_pin_hash <> extensions.crypt(coalesce(p_pharmacist_pin, ''), v_inv.pharmacist_pin_hash) THEN
    v_new_failures := v_inv.failed_attempts + 1;
    v_locked := (v_new_failures >= v_inv.max_attempts);

    UPDATE public.patient_apk_invitations
       SET failed_attempts = v_new_failures,
           status = CASE WHEN v_locked THEN 'revoked' ELSE status END,
           revoked_at = CASE WHEN v_locked THEN now() ELSE revoked_at END
     WHERE id = v_inv.id;

    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'otp_request', 'FAILED', 'INVALID_PHARMACIST_PIN'
    );

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', CASE WHEN v_locked THEN 'RATE_LIMIT_LOCKOUT_REVOKED' ELSE 'INVALID_PHARMACIST_PIN' END,
      'failedAttempts', v_new_failures,
      'lockedOut', v_locked
    );
  END IF;

  -- Enforce OTP send cap (max 5 sends per invitation) and 60-second resend cooldown
  IF v_inv.otp_send_count >= 5 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'OTP_SEND_LIMIT_REACHED'
    );
  END IF;

  IF v_inv.otp_last_sent_at IS NOT NULL AND now() < v_inv.otp_last_sent_at + interval '60 seconds' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'OTP_COOLDOWN_ACTIVE'
    );
  END IF;

  v_sms_otp := app_security.generate_csprng_6digit_code();

  UPDATE public.patient_apk_invitations
     SET sms_otp_hash = extensions.crypt(v_sms_otp, extensions.gen_salt('bf', 10)),
         sms_otp_expires_at = now() + interval '5 minutes',
         otp_send_count = otp_send_count + 1,
         otp_last_sent_at = now()
   WHERE id = v_inv.id;

  INSERT INTO public.invitation_redemption_attempts (
    invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
    phase, outcome
  ) VALUES (
    v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
    'otp_request', 'OTP_ISSUED'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'invitationId', v_inv.id,
    'targetPhone', v_inv.target_phone,
    'smsOtpForGatewayDispatch', v_sms_otp,
    'expiresInSeconds', 300
  );
END;
$$;

-- 6.3 Redeem Single-Use Invitation & Bind Bootstrap Auth Account (Audit C1, C2, C3, H4, H8 Fix)
CREATE OR REPLACE FUNCTION public.redeem_patient_apk_invitation(
  p_raw_token text,
  p_pharmacist_pin text,
  p_sms_otp text,
  p_bootstrap_auth_user_id uuid,
  p_device_label text,
  p_network_ip_hmac text,
  p_device_fingerprint_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_token_hash text;
  v_inv public.patient_apk_invitations%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_ip_failures integer;
  v_device_failures integer;
  v_new_failures integer;
  v_locked boolean := false;
  v_prior_auth_uid uuid;
BEGIN
  IF p_bootstrap_auth_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'MISSING_BOOTSTRAP_AUTH_USER'
    );
  END IF;

  SELECT count(*) INTO v_ip_failures
  FROM public.invitation_redemption_attempts
  WHERE network_ip_hmac = p_network_ip_hmac
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  SELECT count(*) INTO v_device_failures
  FROM public.invitation_redemption_attempts
  WHERE device_fingerprint_hash IS NOT NULL
    AND device_fingerprint_hash = p_device_fingerprint_hash
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  IF v_ip_failures >= 10 OR v_device_failures >= 5 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'RATE_LIMIT_EXCEEDED'
    );
  END IF;

  v_token_hash := encode(extensions.digest(coalesce(p_raw_token, ''), 'sha256'), 'hex');

  SELECT * INTO v_inv
  FROM public.patient_apk_invitations
  WHERE token_hash = v_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.invitation_redemption_attempts (
      network_ip_hmac, device_fingerprint_hash, phase, outcome, failure_reason
    ) VALUES (
      p_network_ip_hmac, p_device_fingerprint_hash, 'redemption', 'FAILED', 'TOKEN_NOT_FOUND'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVALID_INVITATION'
    );
  END IF;

  IF v_inv.status <> 'pending' THEN
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'STATUS_' || upper(v_inv.status)
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_NOT_PENDING',
      'status', v_inv.status
    );
  END IF;

  IF now() > v_inv.expires_at THEN
    UPDATE public.patient_apk_invitations SET status = 'expired' WHERE id = v_inv.id;
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'EXPIRED'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_EXPIRED'
    );
  END IF;

  -- Verify BOTH Pharmacist Handover PIN AND non-expired SMS OTP
  IF v_inv.pharmacist_pin_hash <> extensions.crypt(coalesce(p_pharmacist_pin, ''), v_inv.pharmacist_pin_hash)
     OR v_inv.sms_otp_hash IS NULL
     OR v_inv.sms_otp_expires_at IS NULL
     OR now() > v_inv.sms_otp_expires_at
     OR v_inv.sms_otp_hash <> extensions.crypt(coalesce(p_sms_otp, ''), v_inv.sms_otp_hash)
  THEN
    v_new_failures := v_inv.failed_attempts + 1;
    v_locked := (v_new_failures >= v_inv.max_attempts);

    UPDATE public.patient_apk_invitations
       SET failed_attempts = v_new_failures,
           status = CASE WHEN v_locked THEN 'revoked' ELSE status END,
           revoked_at = CASE WHEN v_locked THEN now() ELSE revoked_at END
     WHERE id = v_inv.id;

    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'INVALID_PIN_OR_OTP'
    );

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', CASE WHEN v_locked THEN 'RATE_LIMIT_LOCKOUT_REVOKED' ELSE 'IDENTITY_VERIFICATION_FAILED' END,
      'failedAttempts', v_new_failures,
      'lockedOut', v_locked
    );
  END IF;

  SELECT * INTO v_patient
  FROM public.patients
  WHERE id = v_inv.patient_id AND pharmacy_id = v_inv.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND OR v_patient.status <> 'active' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'PATIENT_NOT_ACTIVE'
    );
  END IF;

  -- Audit H8 Fix: Block overwriting an existing linked auth_user_id unless invitation_purpose = 'device_replacement_recovery'
  IF v_patient.auth_user_id IS NOT NULL
     AND v_patient.auth_user_id <> p_bootstrap_auth_user_id
     AND v_inv.invitation_purpose <> 'device_replacement_recovery'
  THEN
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'ACCOUNT_ALREADY_LINKED_NO_RECOVERY'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'ACCOUNT_ALREADY_LINKED_REQUIRES_RECOVERY'
    );
  END IF;

  -- V1.5.4 H4 Fix: Recovery ceremony requires owner approval, identity verification,
  -- matching prior auth_user_id snapshot, and a fresh auth_user_id for the new device.
  v_prior_auth_uid := v_patient.auth_user_id;
  IF v_inv.invitation_purpose = 'device_replacement_recovery' THEN
    IF v_inv.approved_by_owner_id IS NULL OR v_inv.recovery_identity_verified IS DISTINCT FROM true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_APPROVAL_MISSING'
      );
    END IF;

    IF v_patient.auth_user_id IS DISTINCT FROM v_inv.superseded_auth_user_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_SUPERSEDED_USER_MISMATCH'
      );
    END IF;

    IF p_bootstrap_auth_user_id = v_inv.superseded_auth_user_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REQUIRES_FRESH_AUTH_USER_ID'
      );
    END IF;
  END IF;

  -- Consume single-use invitation and atomically unlink prior auth_user_id before binding new one
  UPDATE public.patient_apk_invitations
     SET status = 'activated',
         activated_at = now(),
         activated_device_label = left(coalesce(p_device_label, 'Android APK'), 120),
         activated_auth_user_id = p_bootstrap_auth_user_id,
         sms_otp_hash = NULL
   WHERE id = v_inv.id;

  IF v_inv.invitation_purpose = 'device_replacement_recovery' THEN
    UPDATE public.patients
       SET auth_user_id = NULL,
           updated_at = now()
     WHERE id = v_inv.patient_id
       AND pharmacy_id = v_inv.pharmacy_id;
  END IF;

  UPDATE public.patients
     SET auth_user_id = p_bootstrap_auth_user_id,
         verified_account_phone = v_inv.target_phone,
         auth_linked_at = now(),
         updated_at = now()
   WHERE id = v_inv.patient_id
     AND pharmacy_id = v_inv.pharmacy_id;

  INSERT INTO public.invitation_redemption_attempts (
    invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
    phase, outcome
  ) VALUES (
    v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
    'redemption', 'ACTIVATED'
  );

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  ) VALUES (
    v_inv.pharmacy_id, p_bootstrap_auth_user_id, 'Patient APK User', 'patient_apk_user',
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'INVITATION_RECOVERY_REDEEMED'
         ELSE 'INVITATION_REDEEMED'
    END,
    'invitation', v_inv.id,
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'تمت استعادة حساب المريض وربط الجهاز الجديد مع إلغاء تفويض الجلسة السابقة'
         ELSE 'تفعيل حساب المريض بنجاح عبر رمز الدعوة والتحقق الثنائي (OTP + PIN)'
    END,
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'Patient device recovery completed with owner approval; prior auth user marked for session revocation'
         ELSE 'Patient APK invitation redeemed after SMS OTP and Pharmacist Handover PIN verification'
    END,
    jsonb_build_object(
      'purpose', v_inv.invitation_purpose,
      'deviceLabel', p_device_label,
      'supersededAuthUserId', v_prior_auth_uid,
      'newAuthUserId', p_bootstrap_auth_user_id,
      'requiresPriorSessionRevocation', (v_inv.invitation_purpose = 'device_replacement_recovery')
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'activated',
    'patientId', v_inv.patient_id,
    'pharmacyId', v_inv.pharmacy_id,
    'revokedPriorAuthUserId', CASE
      WHEN v_inv.invitation_purpose = 'device_replacement_recovery' THEN v_prior_auth_uid
      ELSE NULL
    END
  );
END;
$$;

-- Audit C2, M7 & V1.5.4 H1/H4 Fix:
-- - `confirm_scheduled_dose`: `authenticated` patients + `service_role` ONLY
-- - `issue_patient_apk_invitation`: `authenticated` pharmacy staff + `service_role` ONLY
-- - OTP challenge & redemption RPCs: `service_role` (Edge Function) ONLY
REVOKE ALL ON FUNCTION public.confirm_scheduled_dose(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_scheduled_dose(uuid, text, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.request_invitation_sms_otp(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_invitation_sms_otp(text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) TO service_role;
