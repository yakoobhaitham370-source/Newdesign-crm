-- ============================================================================
-- MASAR Care — Stage 2A Database Migration 0001 (Rev 3 — V1.5.4 Hardened)
-- Core Schema, Explicit Extension Schema Placement, Composite Tenant Ownership
-- FKs, Scheduled-Dose Provenance vs Unscheduled PRN Reports & Recovery Controls
-- STATUS: REVIEW ONLY — DO NOT EXECUTE WITHOUT EXPLICIT MIGRATION APPROVAL
-- Approved Architecture: Option B (Single Shared Supabase Project + Strict RLS)
-- Default Timezone Model: Asia/Baghdad (UTC+3)
-- ============================================================================

-- Pre-flight discovery in target PostgreSQL / Supabase before running:
--   SELECT e.extname, n.nspname AS installed_schema
--   FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
--   WHERE e.extname IN ('pgcrypto', 'pg_trgm', 'btree_gist');
-- Extensions are isolated inside the dedicated `extensions` schema (Supabase
-- convention) so SECURITY DEFINER functions never depend on unsafe search_path
-- resolution and can schema-qualify calls cleanly (`extensions.crypt`, etc.).
CREATE SCHEMA IF NOT EXISTS extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA extensions;

-- ----------------------------------------------------------------------------
-- 1. Pharmacies (Tenant Root)
-- ----------------------------------------------------------------------------
CREATE TABLE public.pharmacies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) >= 2),
  name_en text NOT NULL CHECK (char_length(btrim(name_en)) >= 2),
  city text NOT NULL,
  governorate text NOT NULL,
  license_number text NOT NULL UNIQUE,
  phone text NOT NULL CHECK (phone ~ '^07[3-9][0-9]{8}$'),
  timezone text NOT NULL DEFAULT 'Asia/Baghdad' CHECK (timezone = 'Asia/Baghdad'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pharmacies_governorate_city ON public.pharmacies (governorate, city);
CREATE INDEX idx_pharmacies_is_active ON public.pharmacies (is_active);

-- ----------------------------------------------------------------------------
-- 2. Pharmacy Staff & Roles (Authoritative RBAC Directory — Never user_metadata)
-- Note (Audit M5): Stage 2A enforces 1 active pharmacy_staff membership per
-- auth.users account; future multi-branch chains can migrate PK to a surrogate
-- membership_id with UNIQUE (user_id, pharmacy_id) without changing child FKs.
-- ----------------------------------------------------------------------------
CREATE TABLE public.pharmacy_staff (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  pharmacy_id uuid NOT NULL REFERENCES public.pharmacies(id) ON DELETE RESTRICT,
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) >= 3),
  role text NOT NULL CHECK (role IN ('pharmacy_owner', 'authorized_pharmacist')),
  syndicate_license text UNIQUE,
  phone text NOT NULL CHECK (phone ~ '^07[3-9][0-9]{8}$'),
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, pharmacy_id),
  UNIQUE (pharmacy_id, phone)
);

CREATE INDEX idx_pharmacy_staff_pharmacy_active ON public.pharmacy_staff (pharmacy_id, is_active);
CREATE INDEX idx_pharmacy_staff_role ON public.pharmacy_staff (pharmacy_id, role);

-- ----------------------------------------------------------------------------
-- 3. Patients (Pharmacist-Registered Only; Shared Family/Caregiver Phone Support)
-- Audit H5 Fix: Removed UNIQUE (pharmacy_id, phone) so family members/elderly
-- patients sharing a caregiver phone can be registered; added phone_owner_type
-- and caregiver_name while keeping idx_patients_pharmacy_phone for duplicate
-- warnings and lookup.
-- ----------------------------------------------------------------------------
CREATE TABLE public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL REFERENCES public.pharmacies(id) ON DELETE RESTRICT,
  patient_code text NOT NULL CHECK (char_length(btrim(patient_code)) >= 3),
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) >= 3),
  phone text NOT NULL CHECK (phone ~ '^07[3-9][0-9]{8}$'),
  phone_owner_type text NOT NULL DEFAULT 'self'
    CHECK (phone_owner_type IN ('self', 'caregiver', 'family_shared')),
  caregiver_name text,
  verified_account_phone text CHECK (verified_account_phone IS NULL OR verified_account_phone ~ '^07[3-9][0-9]{8}$'),
  date_of_birth date NOT NULL CHECK (date_of_birth <= CURRENT_DATE),
  sex text NOT NULL CHECK (sex IN ('male', 'female')),
  contact_preference text NOT NULL DEFAULT 'whatsapp'
    CHECK (contact_preference IN ('whatsapp', 'phone_call', 'apk_notification')),
  clinical_notes text NOT NULL DEFAULT '',
  registration_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at date,
  archived_reason text,
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  auth_linked_at timestamptz,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, pharmacy_id),
  UNIQUE (pharmacy_id, patient_code),
  FOREIGN KEY (created_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_patients_pharmacy_status ON public.patients (pharmacy_id, status);
CREATE INDEX idx_patients_pharmacy_phone ON public.patients (pharmacy_id, phone);
CREATE INDEX idx_patients_pharmacy_name_trgm ON public.patients USING gin (full_name extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- 4. Patient Medical Conditions (ON DELETE RESTRICT preserves clinical history)
-- ----------------------------------------------------------------------------
CREATE TABLE public.patient_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  condition_name text NOT NULL CHECK (char_length(btrim(condition_name)) >= 2),
  icd10_code text,
  diagnosed_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, condition_name),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_patient_conditions_pharmacy_condition
  ON public.patient_conditions (pharmacy_id, condition_name);

-- ----------------------------------------------------------------------------
-- 5. Patient Allergies (ON DELETE RESTRICT preserves clinical history)
-- ----------------------------------------------------------------------------
CREATE TABLE public.patient_allergies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  substance text NOT NULL CHECK (char_length(btrim(substance)) >= 2),
  severity text NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe')),
  reaction text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, substance),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_patient_allergies_patient_severity
  ON public.patient_allergies (patient_id, severity);

-- ----------------------------------------------------------------------------
-- 6. Medication Catalog (Reference Only — Never Stores Default Prescribed Dose)
-- ----------------------------------------------------------------------------
CREATE TABLE public.medication_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name text NOT NULL,
  generic_name text NOT NULL,
  available_strengths text[] NOT NULL DEFAULT '{}',
  default_dosage_form text NOT NULL
    CHECK (default_dosage_form IN ('tablet', 'capsule', 'syrup', 'injection', 'inhaler', 'drops', 'cream', 'sachet')),
  default_route text NOT NULL
    CHECK (default_route IN ('oral', 'subcutaneous', 'intramuscular', 'intravenous', 'inhalation', 'topical', 'ophthalmic', 'otic')),
  category text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_name, generic_name, default_dosage_form)
);

CREATE INDEX idx_medication_catalog_brand_generic
  ON public.medication_catalog (brand_name, generic_name);

-- ----------------------------------------------------------------------------
-- 7. Patient Medication Plans
-- Audit C4 Fix: Added UNIQUE (id, patient_id, pharmacy_id) so child tables
-- (scheduled_doses, dose_events, dispensing_events, refill_assessments,
-- follow_up_tasks) enforce that medication_plan_id belongs to that exact
-- patient_id AND pharmacy_id.
-- ----------------------------------------------------------------------------
CREATE TABLE public.patient_medication_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  catalog_id uuid REFERENCES public.medication_catalog(id) ON DELETE SET NULL,
  brand_name text NOT NULL CHECK (char_length(btrim(brand_name)) >= 1),
  generic_name text NOT NULL CHECK (char_length(btrim(generic_name)) >= 1),
  strength text NOT NULL CHECK (char_length(btrim(strength)) >= 1),
  dosage_form text NOT NULL
    CHECK (dosage_form IN ('tablet', 'capsule', 'syrup', 'injection', 'inhaler', 'drops', 'cream', 'sachet')),
  route text NOT NULL
    CHECK (route IN ('oral', 'subcutaneous', 'intramuscular', 'intravenous', 'inhalation', 'topical', 'ophthalmic', 'otic')),
  dose_amount numeric(10,3) NOT NULL CHECK (dose_amount > 0),
  dose_unit text NOT NULL CHECK (char_length(btrim(dose_unit)) >= 1),
  food_relation text NOT NULL
    CHECK (food_relation IN ('before_food', 'with_food', 'after_food', 'any_time')),
  verified_instructions text NOT NULL CHECK (char_length(btrim(verified_instructions)) >= 5),
  prescriber_name text,
  prescriber_specialty text,
  start_date date NOT NULL,
  end_date date,
  is_ongoing boolean NOT NULL DEFAULT true,
  duration_days integer CHECK (duration_days IS NULL OR duration_days >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'discontinued', 'archived')),
  status_changed_at date,
  status_change_reason text,
  current_version_number integer NOT NULL DEFAULT 1 CHECK (current_version_number >= 1),
  schedule jsonb NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_ongoing = true OR end_date IS NULL OR end_date >= start_date),
  UNIQUE (id, pharmacy_id),
  UNIQUE (id, patient_id, pharmacy_id),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_med_plans_pharmacy_patient_status
  ON public.patient_medication_plans (pharmacy_id, patient_id, status);
CREATE INDEX idx_med_plans_pharmacy_created_desc
  ON public.patient_medication_plans (pharmacy_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 8. Regimen Versions (Immutable Historical Regimen Ledger with Controlled Closure)
-- Audit C4 & Design Check Fix: Added UNIQUE (medication_plan_id, version_number, pharmacy_id),
-- CHECK (effective_to IS NULL OR effective_to >= effective_from), and partial
-- unique index ensuring at most one open version per plan.
-- ----------------------------------------------------------------------------
CREATE TABLE public.regimen_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  effective_from date NOT NULL,
  effective_to date,
  dose_amount numeric(10,3) NOT NULL CHECK (dose_amount > 0),
  dose_unit text NOT NULL,
  food_relation text NOT NULL
    CHECK (food_relation IN ('before_food', 'with_food', 'after_food', 'any_time')),
  verified_instructions text NOT NULL,
  schedule jsonb NOT NULL,
  changed_by_staff_id uuid NOT NULL,
  changed_by_staff_name text NOT NULL,
  change_reason text NOT NULL CHECK (char_length(btrim(change_reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (medication_plan_id, version_number),
  UNIQUE (medication_plan_id, version_number, pharmacy_id),
  FOREIGN KEY (medication_plan_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (changed_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_one_open_regimen_version_per_plan
  ON public.regimen_versions (medication_plan_id)
  WHERE (effective_to IS NULL);

CREATE INDEX idx_regimen_versions_plan_effective
  ON public.regimen_versions (medication_plan_id, effective_from, effective_to);

-- ----------------------------------------------------------------------------
-- 9. Medication Pause Periods (Non-Overlapping Pause/Resume Windows)
-- ----------------------------------------------------------------------------
CREATE TABLE public.medication_pause_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  paused_from date NOT NULL,
  resumed_at date,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 2),
  recorded_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resumed_at IS NULL OR resumed_at >= paused_from),
  CONSTRAINT ex_medication_pause_periods_no_overlap
    EXCLUDE USING gist (
      medication_plan_id extensions.gist_uuid_ops WITH =,
      daterange(paused_from, COALESCE(resumed_at, 'infinity'::date), '[)') WITH &&
    ),
  FOREIGN KEY (medication_plan_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_one_open_pause_per_plan
  ON public.medication_pause_periods (medication_plan_id)
  WHERE (resumed_at IS NULL);

CREATE INDEX idx_med_pause_periods_plan_dates
  ON public.medication_pause_periods (medication_plan_id, paused_from, resumed_at);

-- ----------------------------------------------------------------------------
-- 10. Scheduled Doses (Materialized Occurrences in Asia/Baghdad)
-- Audit C4 Fix: Composite FKs verify that (medication_plan_id, patient_id, pharmacy_id)
-- match the same patient_medication_plans row AND (medication_plan_id, regimen_version_number, pharmacy_id)
-- match a valid regimen_versions row.
-- ----------------------------------------------------------------------------
CREATE TABLE public.scheduled_doses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  regimen_version_number integer NOT NULL,
  scheduled_date date NOT NULL,
  scheduled_time24 text NOT NULL CHECK (scheduled_time24 ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  planned_dose_amount numeric(10,3) NOT NULL CHECK (planned_dose_amount > 0),
  dose_unit text NOT NULL,
  slot_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, medication_plan_id, patient_id, pharmacy_id),
  UNIQUE (medication_plan_id, regimen_version_number, scheduled_date, scheduled_time24),
  FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (medication_plan_id, regimen_version_number, pharmacy_id)
    REFERENCES public.regimen_versions(medication_plan_id, version_number, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_scheduled_doses_patient_date
  ON public.scheduled_doses (patient_id, scheduled_date);
CREATE INDEX idx_scheduled_doses_pharmacy_date
  ON public.scheduled_doses (pharmacy_id, scheduled_date);

-- ----------------------------------------------------------------------------
-- 11. Dose Events (Verified Scheduled-Dose Confirmations ONLY)
-- Audit C4, M6 & V1.5.4 H1 Fix:
-- - Every newly inserted dose_events row MUST reference an existing, authorized
--   scheduled_doses row (`scheduled_dose_id IS NOT NULL` enforced on INSERT by
--   `enforce_dose_event_provenance()`, while preserving nullable FK column so
--   future `ON DELETE SET NULL (scheduled_dose_id)` retains historical logs).
-- - UNIQUE (scheduled_dose_id) guarantees at most one confirmation record per
--   scheduled occurrence (blocking duplicate patient confirmations).
-- - Unscheduled / PRN patient intakes MUST go to `public.unscheduled_dose_reports`.
-- ----------------------------------------------------------------------------
CREATE TABLE public.dose_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  scheduled_dose_id uuid,
  regimen_version_number integer NOT NULL,
  scheduled_date date NOT NULL,
  scheduled_time24 text NOT NULL CHECK (scheduled_time24 ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  planned_dose_amount numeric(10,3) NOT NULL CHECK (planned_dose_amount > 0),
  dose_unit text NOT NULL,
  status text NOT NULL DEFAULT 'pending_unconfirmed'
    CHECK (status IN ('pending_unconfirmed', 'taken', 'skipped_by_patient', 'delayed')),
  confirmed_at timestamptz,
  client_event_uuid uuid UNIQUE,
  patient_note text,
  amendment_count integer NOT NULL DEFAULT 0 CHECK (amendment_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scheduled_dose_id),
  UNIQUE (medication_plan_id, scheduled_date, scheduled_time24),
  FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (scheduled_dose_id, medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.scheduled_doses(id, medication_plan_id, patient_id, pharmacy_id)
    ON DELETE SET NULL (scheduled_dose_id),
  FOREIGN KEY (medication_plan_id, regimen_version_number, pharmacy_id)
    REFERENCES public.regimen_versions(medication_plan_id, version_number, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_dose_events_patient_date_status
  ON public.dose_events (patient_id, scheduled_date, status);
CREATE INDEX idx_dose_events_pharmacy_date
  ON public.dose_events (pharmacy_id, scheduled_date);

-- ----------------------------------------------------------------------------
-- 11B. Unscheduled / PRN Dose Reports (Explicit Patient-Reported Provenance)
-- V1.5.4 H1 Fix: Separates unscheduled PRN or extra patient-reported intakes from
-- authoritative `scheduled_doses` / `dose_events`. `is_verified_schedule` is
-- permanently constrained to `false` so unscheduled reports never silently pose
-- as prescribed schedule occurrences or distort scheduled adherence metrics.
-- ----------------------------------------------------------------------------
CREATE TABLE public.unscheduled_dose_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('prn_intake', 'unscheduled_extra')),
  reported_dose_amount numeric(10,3) NOT NULL CHECK (reported_dose_amount > 0),
  dose_unit text NOT NULL CHECK (char_length(btrim(dose_unit)) >= 1),
  patient_reported_at timestamptz NOT NULL,
  server_recorded_at timestamptz NOT NULL DEFAULT now(),
  patient_note text,
  client_event_uuid uuid NOT NULL UNIQUE,
  is_verified_schedule boolean NOT NULL DEFAULT false CHECK (is_verified_schedule = false),
  reviewed_by_staff_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_unscheduled_reports_patient_time
  ON public.unscheduled_dose_reports (patient_id, server_recorded_at DESC);
CREATE INDEX idx_unscheduled_reports_pharmacy_plan
  ON public.unscheduled_dose_reports (pharmacy_id, medication_plan_id);

-- ----------------------------------------------------------------------------
-- 12. Dispensing Events (Immutable Append-Only Ledger)
-- Audit C4 Fix: Composite FKs enforce that medication_plan_id belongs to patient_id
-- and regimen_version_number belongs to medication_plan_id.
-- ----------------------------------------------------------------------------
CREATE TABLE public.dispensing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL,
  regimen_version_number integer NOT NULL,
  dispensed_quantity numeric(10,3) NOT NULL CHECK (dispensed_quantity > 0),
  quantity_unit text NOT NULL,
  package_count integer CHECK (package_count IS NULL OR package_count >= 1),
  package_size numeric(10,3) CHECK (package_size IS NULL OR package_size > 0),
  batch_number text,
  expiry_date date,
  dispensing_date date NOT NULL,
  dispensed_by_staff_id uuid NOT NULL,
  dispensed_by_staff_name text NOT NULL,
  notes text,
  estimated_daily_consumption numeric(10,4),
  estimated_supply_days integer,
  estimated_supply_end_date date,
  forecast_assumptions text NOT NULL,
  is_partial_fill boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, pharmacy_id),
  UNIQUE (id, medication_plan_id, patient_id, pharmacy_id),
  FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (medication_plan_id, regimen_version_number, pharmacy_id)
    REFERENCES public.regimen_versions(medication_plan_id, version_number, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (dispensed_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_dispensing_events_plan_date_asc
  ON public.dispensing_events (medication_plan_id, dispensing_date ASC, created_at ASC);
CREATE INDEX idx_dispensing_events_pharmacy_date
  ON public.dispensing_events (pharmacy_id, dispensing_date DESC);
CREATE INDEX idx_dispensing_events_patient_date
  ON public.dispensing_events (patient_id, dispensing_date DESC);

-- ----------------------------------------------------------------------------
-- 13. Refill Assessments (Persisted Refill Projections)
-- Audit C4 & H6 Fix: Composite FK (medication_plan_id, patient_id, pharmacy_id)
-- and column-specific ON DELETE SET NULL (last_dispensing_event_id) so non-nullable
-- tenant/patient columns are never nulled.
-- ----------------------------------------------------------------------------
CREATE TABLE public.refill_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  medication_plan_id uuid NOT NULL UNIQUE,
  last_dispensing_event_id uuid,
  last_dispensed_date date,
  last_dispensed_quantity numeric(10,3),
  total_dispensed_analyzed numeric(10,3),
  quantity_unit text NOT NULL,
  estimated_daily_consumption numeric(10,4),
  estimated_remaining_units numeric(10,3),
  estimated_days_remaining integer,
  estimated_supply_end_date date,
  refill_status text NOT NULL
    CHECK (refill_status IN ('overdue', 'due_soon', 'upcoming', 'on_track', 'unable_to_estimate', 'paused_or_prn')),
  uncertainty_note text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_dispensing_event_id, medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.dispensing_events(id, medication_plan_id, patient_id, pharmacy_id)
    ON DELETE SET NULL (last_dispensing_event_id)
);

CREATE INDEX idx_refill_assessments_pharmacy_status_enddate
  ON public.refill_assessments (pharmacy_id, refill_status, estimated_supply_end_date);

-- ----------------------------------------------------------------------------
-- 14. Laboratory Results
-- ----------------------------------------------------------------------------
CREATE TABLE public.lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  test_name text NOT NULL CHECK (char_length(btrim(test_name)) >= 2),
  value text NOT NULL,
  unit text NOT NULL,
  reference_range text NOT NULL,
  is_abnormal boolean NOT NULL DEFAULT false,
  test_date date NOT NULL,
  notes text,
  recorded_by_staff_id uuid NOT NULL,
  recorded_by_staff_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_lab_results_patient_testdate_desc
  ON public.lab_results (patient_id, test_date DESC);
CREATE INDEX idx_lab_results_pharmacy_abnormal
  ON public.lab_results (pharmacy_id, is_abnormal);

-- ----------------------------------------------------------------------------
-- 15. Follow-Up Tasks
-- Audit C4 & H6 Fix: Composite FK (related_medication_plan_id, patient_id, pharmacy_id)
-- with column-specific ON DELETE SET NULL (related_medication_plan_id) so
-- pharmacy_id and patient_id remain NOT NULL.
-- ----------------------------------------------------------------------------
CREATE TABLE public.follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  related_medication_plan_id uuid,
  type text NOT NULL CHECK (type IN ('refill', 'adherence', 'clinical', 'lab_review')),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'overdue')),
  notes text NOT NULL DEFAULT '',
  assigned_staff_id uuid,
  assigned_staff_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, pharmacy_id),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_medication_plan_id, patient_id, pharmacy_id)
    REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id)
    ON DELETE SET NULL (related_medication_plan_id),
  FOREIGN KEY (assigned_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id)
    ON DELETE SET NULL (assigned_staff_id)
);

CREATE INDEX idx_followup_tasks_pharmacy_status_duedate
  ON public.follow_up_tasks (pharmacy_id, status, due_date);
CREATE INDEX idx_followup_tasks_patient
  ON public.follow_up_tasks (patient_id, due_date DESC);

-- ----------------------------------------------------------------------------
-- 16. Follow-Up Contact Logs (Append-Only Manual Outreach History)
-- ----------------------------------------------------------------------------
CREATE TABLE public.follow_up_contact_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  follow_up_task_id uuid NOT NULL,
  contacted_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL CHECK (channel IN ('whatsapp_manual', 'phone_call', 'in_pharmacy')),
  outcome text NOT NULL
    CHECK (outcome IN ('answered', 'no_answer', 'refill_confirmed', 'appointment_scheduled', 'message_sent')),
  summary text NOT NULL CHECK (char_length(btrim(summary)) >= 2),
  staff_id uuid NOT NULL,
  staff_name text NOT NULL,
  FOREIGN KEY (follow_up_task_id, pharmacy_id)
    REFERENCES public.follow_up_tasks(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_followup_contact_logs_task_time
  ON public.follow_up_contact_logs (follow_up_task_id, contacted_at DESC);

-- ----------------------------------------------------------------------------
-- 17. Consultation Threads & 18. Consultation Messages
-- ----------------------------------------------------------------------------
CREATE TABLE public.consultation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  subject text NOT NULL CHECK (char_length(btrim(subject)) >= 3),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'follow_up', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, pharmacy_id),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_consultation_threads_pharmacy_status_updated
  ON public.consultation_threads (pharmacy_id, status, updated_at DESC);
CREATE INDEX idx_consultation_threads_patient
  ON public.consultation_threads (patient_id, updated_at DESC);

CREATE TABLE public.consultation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('patient', 'pharmacist')),
  sender_staff_id uuid,
  sender_name text NOT NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) >= 1),
  approved_by_pharmacist boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_type = 'patient' OR (approved_by_pharmacist = true AND sender_staff_id IS NOT NULL)),
  FOREIGN KEY (thread_id, pharmacy_id)
    REFERENCES public.consultation_threads(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_consultation_messages_thread_sent_asc
  ON public.consultation_messages (thread_id, sent_at ASC);

-- ----------------------------------------------------------------------------
-- 19. Patient APK Invitations & 20. Invitation Redemption Attempts
-- Audit C3, H4, H8 & V1.5.4 H4 Fix: Supports OTP issuance tracking, explicit
-- invitation_purpose ('initial_activation' vs 'device_replacement_recovery'),
-- mandatory pharmacy_owner approval + independent identity attestation
-- (`approved_by_owner_id`, `recovery_identity_verified`, `superseded_auth_user_id`),
-- and non-trivial `recovery_reason` (>= 10 chars) for activated account recovery.
-- ----------------------------------------------------------------------------
CREATE TABLE public.patient_apk_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  invitation_purpose text NOT NULL DEFAULT 'initial_activation'
    CHECK (invitation_purpose IN ('initial_activation', 'device_replacement_recovery')),
  recovery_reason text,
  approved_by_owner_id uuid,
  recovery_identity_verified boolean NOT NULL DEFAULT false,
  superseded_auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_phone text NOT NULL CHECK (target_phone ~ '^07[3-9][0-9]{8}$'),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  pharmacist_pin_hash text NOT NULL,
  sms_otp_hash text,
  sms_otp_expires_at timestamptz,
  otp_send_count integer NOT NULL DEFAULT 0 CHECK (otp_send_count BETWEEN 0 AND 5),
  otp_last_sent_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'activated', 'expired', 'revoked')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  issued_by_staff_id uuid NOT NULL,
  issued_by_staff_name text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 5),
  activated_device_label text,
  activated_auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (
    invitation_purpose = 'initial_activation'
    OR (
      recovery_reason IS NOT NULL
      AND char_length(btrim(recovery_reason)) >= 10
      AND approved_by_owner_id IS NOT NULL
      AND recovery_identity_verified = true
    )
  ),
  FOREIGN KEY (patient_id, pharmacy_id)
    REFERENCES public.patients(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (issued_by_staff_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_owner_id, pharmacy_id)
    REFERENCES public.pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_one_pending_invitation_per_patient
  ON public.patient_apk_invitations (patient_id)
  WHERE (status = 'pending');

CREATE INDEX idx_invitations_pharmacy_status
  ON public.patient_apk_invitations (pharmacy_id, status);
CREATE INDEX idx_invitations_patient_status
  ON public.patient_apk_invitations (patient_id, status);

CREATE TABLE public.invitation_redemption_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid REFERENCES public.patient_apk_invitations(id) ON DELETE SET NULL,
  pharmacy_id uuid REFERENCES public.pharmacies(id) ON DELETE CASCADE,
  patient_id uuid,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  network_ip_hmac text NOT NULL,
  device_fingerprint_hash text,
  phase text NOT NULL CHECK (phase IN ('otp_request', 'redemption')),
  outcome text NOT NULL CHECK (outcome IN ('OTP_ISSUED', 'ACTIVATED', 'FAILED')),
  failure_reason text
);

CREATE INDEX idx_redemption_attempts_invitation_time
  ON public.invitation_redemption_attempts (invitation_id, attempted_at DESC);
CREATE INDEX idx_redemption_attempts_ip_hmac_time
  ON public.invitation_redemption_attempts (network_ip_hmac, attempted_at DESC);
CREATE INDEX idx_redemption_attempts_device_time
  ON public.invitation_redemption_attempts (device_fingerprint_hash, attempted_at DESC);

-- ----------------------------------------------------------------------------
-- 21. Audit Logs (Strictly Immutable Append-Only Clinical & Security Trail)
-- ----------------------------------------------------------------------------
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL REFERENCES public.pharmacies(id) ON DELETE RESTRICT,
  timestamp timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL
    CHECK (actor_role IN ('platform_owner', 'pharmacy_owner', 'authorized_pharmacist', 'patient_apk_user', 'system')),
  action text NOT NULL,
  entity_type text NOT NULL
    CHECK (entity_type IN ('patient', 'medication_plan', 'dispensing', 'follow_up', 'consultation', 'invitation', 'lab_result', 'staff', 'dose_event', 'unscheduled_dose_report')),
  entity_id uuid NOT NULL,
  summary_ar text NOT NULL,
  summary_en text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_audit_logs_pharmacy_timestamp_desc
  ON public.audit_logs (pharmacy_id, timestamp DESC);
CREATE INDEX idx_audit_logs_entity
  ON public.audit_logs (pharmacy_id, entity_type, entity_id);

-- ----------------------------------------------------------------------------
-- Immutability & Integrity Triggers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Security policy violation: table % is an immutable append-only ledger (% forbidden).',
    TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER trg_dispensing_events_immutable
  BEFORE UPDATE OR DELETE ON public.dispensing_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER trg_followup_contact_logs_immutable
  BEFORE UPDATE OR DELETE ON public.follow_up_contact_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER trg_consultation_messages_immutable
  BEFORE UPDATE OR DELETE ON public.consultation_messages
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

CREATE TRIGGER trg_regimen_versions_no_delete
  BEFORE DELETE ON public.regimen_versions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_mutation();

-- Controlled closure on regimen_versions: only effective_to may transition from NULL to >= effective_from
CREATE OR REPLACE FUNCTION public.enforce_regimen_version_closure_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'Security policy violation: closed regimen_version # % cannot be modified.', OLD.version_number;
  END IF;
  IF NEW.effective_to IS NULL OR NEW.effective_to < OLD.effective_from THEN
    RAISE EXCEPTION 'Invalid regimen_version closure: effective_to must be >= effective_from.';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.pharmacy_id <> OLD.pharmacy_id
     OR NEW.medication_plan_id <> OLD.medication_plan_id
     OR NEW.version_number <> OLD.version_number
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.dose_amount <> OLD.dose_amount
     OR NEW.dose_unit <> OLD.dose_unit
     OR NEW.food_relation <> OLD.food_relation
     OR NEW.verified_instructions <> OLD.verified_instructions
     OR NEW.schedule <> OLD.schedule
     OR NEW.changed_by_staff_id <> OLD.changed_by_staff_id
     OR NEW.change_reason <> OLD.change_reason
  THEN
    RAISE EXCEPTION 'Security policy violation: historical regimen_version fields are immutable; only effective_to may be closed.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_regimen_versions_controlled_update
  BEFORE UPDATE ON public.regimen_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_regimen_version_closure_only();

-- Prevent overlapping pause periods on the same medication plan
CREATE OR REPLACE FUNCTION public.enforce_non_overlapping_pause_periods()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.medication_pause_periods mp
    WHERE mp.medication_plan_id = NEW.medication_plan_id
      AND mp.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND daterange(mp.paused_from, COALESCE(mp.resumed_at, 'infinity'::date), '[)')
          && daterange(NEW.paused_from, COALESCE(NEW.resumed_at, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION 'Overlapping medication_pause_periods are not permitted for the same medication_plan_id.'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pause_periods_no_overlap
  BEFORE INSERT OR UPDATE ON public.medication_pause_periods
  FOR EACH ROW EXECUTE FUNCTION public.enforce_non_overlapping_pause_periods();

-- Enforce authoritative scheduled-dose provenance & server-derived immutable fields (Audit M6 & V1.5.4 H1)
CREATE OR REPLACE FUNCTION public.enforce_dose_event_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_sd   public.scheduled_doses%ROWTYPE;
  v_plan public.patient_medication_plans%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scheduled_dose_id IS NULL THEN
      RAISE EXCEPTION 'Security/provenance policy violation: dose_events requires a non-null scheduled_dose_id. Submit PRN or extra intakes to unscheduled_dose_reports.'
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_sd
    FROM public.scheduled_doses sd
    WHERE sd.id = NEW.scheduled_dose_id
      AND sd.patient_id = NEW.patient_id
      AND sd.pharmacy_id = NEW.pharmacy_id
      AND sd.medication_plan_id = NEW.medication_plan_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Security/provenance policy violation: scheduled_dose_id % does not match patient/pharmacy/plan.', NEW.scheduled_dose_id
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_plan
    FROM public.patient_medication_plans mp
    WHERE mp.id = v_sd.medication_plan_id
      AND mp.patient_id = v_sd.patient_id
      AND mp.pharmacy_id = v_sd.pharmacy_id;

    IF NOT FOUND OR v_plan.status <> 'active' THEN
      RAISE EXCEPTION 'Clinical provenance violation: cannot record dose_events for inactive/cancelled/paused medication_plan_id %.', v_sd.medication_plan_id
        USING ERRCODE = '23514';
    END IF;

    -- Overwrite schedule & regimen fields from the authoritative scheduled_doses row so
    -- clients can never fabricate scheduled dates, times, versions, units, or dose amounts.
    NEW.regimen_version_number := v_sd.regimen_version_number;
    NEW.scheduled_date := v_sd.scheduled_date;
    NEW.scheduled_time24 := v_sd.scheduled_time24;
    NEW.planned_dose_amount := v_sd.planned_dose_amount;
    NEW.dose_unit := v_sd.dose_unit;

    IF NEW.status <> 'pending_unconfirmed' THEN
      NEW.confirmed_at := now();
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.pharmacy_id <> OLD.pharmacy_id
       OR NEW.patient_id <> OLD.patient_id
       OR NEW.medication_plan_id <> OLD.medication_plan_id
       OR NEW.regimen_version_number <> OLD.regimen_version_number
       OR NEW.scheduled_date <> OLD.scheduled_date
       OR NEW.scheduled_time24 <> OLD.scheduled_time24
       OR NEW.planned_dose_amount <> OLD.planned_dose_amount
       OR NEW.dose_unit <> OLD.dose_unit
    THEN
      RAISE EXCEPTION 'Security policy violation: dose_event identity, scheduled_dose_id, and scheduled quantities are immutable.';
    END IF;

    IF NEW.scheduled_dose_id IS DISTINCT FROM OLD.scheduled_dose_id THEN
      IF OLD.scheduled_dose_id IS NOT NULL
         AND NEW.scheduled_dose_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.scheduled_doses sd WHERE sd.id = OLD.scheduled_dose_id
         )
      THEN
        -- Permit PostgreSQL FK ON DELETE SET NULL (scheduled_dose_id) archival cleanup
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Security policy violation: scheduled_dose_id on dose_events cannot be modified or cleared.';
    END IF;

    IF NEW.status <> 'pending_unconfirmed' THEN
      NEW.confirmed_at := now();
    END IF;
    NEW.updated_at := now();
    NEW.amendment_count := OLD.amendment_count + 1;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dose_events_provenance
  BEFORE INSERT OR UPDATE ON public.dose_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dose_event_provenance();

-- Enforce explicit unscheduled provenance on unscheduled_dose_reports (V1.5.4 H1)
CREATE OR REPLACE FUNCTION public.enforce_unscheduled_dose_report_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_plan public.patient_medication_plans%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_plan
    FROM public.patient_medication_plans mp
    WHERE mp.id = NEW.medication_plan_id
      AND mp.patient_id = NEW.patient_id
      AND mp.pharmacy_id = NEW.pharmacy_id;

    IF NOT FOUND OR v_plan.status <> 'active' THEN
      RAISE EXCEPTION 'Clinical provenance violation: unscheduled dose reports require an active medication plan for the same patient/pharmacy.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.report_type = 'prn_intake' AND (v_plan.schedule->>'frequencyType') <> 'prn' THEN
      RAISE EXCEPTION 'Clinical provenance violation: prn_intake reports require a PRN medication plan.'
        USING ERRCODE = '23514';
    END IF;

    -- Option A (V1.5.4 QA): Explicitly reject caller-supplied true (or NULL) instead
    -- of silently normalizing it to false, while allowing omitted columns to use
    -- the table DEFAULT false and explicit false inserts to pass cleanly.
    IF NEW.is_verified_schedule IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Security/provenance policy violation: unscheduled_dose_reports requires is_verified_schedule = false (or omitted default).'
        USING ERRCODE = '23514';
    END IF;

    NEW.is_verified_schedule := false;
    NEW.server_recorded_at := now();
    NEW.created_at := now();
    NEW.reviewed_by_staff_id := NULL;
    NEW.reviewed_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.pharmacy_id <> OLD.pharmacy_id
       OR NEW.patient_id <> OLD.patient_id
       OR NEW.medication_plan_id <> OLD.medication_plan_id
       OR NEW.report_type <> OLD.report_type
       OR NEW.reported_dose_amount <> OLD.reported_dose_amount
       OR NEW.dose_unit <> OLD.dose_unit
       OR NEW.patient_reported_at <> OLD.patient_reported_at
       OR NEW.server_recorded_at <> OLD.server_recorded_at
       OR NEW.client_event_uuid <> OLD.client_event_uuid
       OR NEW.is_verified_schedule <> false
    THEN
      RAISE EXCEPTION 'Security policy violation: unscheduled_dose_reports patient intake fields are immutable; pharmacists may only record review.';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_unscheduled_dose_reports_provenance
  BEFORE INSERT OR UPDATE ON public.unscheduled_dose_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_unscheduled_dose_report_provenance();
