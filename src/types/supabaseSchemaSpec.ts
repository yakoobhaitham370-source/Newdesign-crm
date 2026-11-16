/**
 * MASAR Care — Stage 2A Supabase PostgreSQL Schema, Entity Mapping & Security Architecture Spec
 * NOTE: Pure TypeScript specification & verification model only.
 * No live Supabase connection or database execution is performed in Stage 1 / V1.5.1.
 */

export interface SupabaseTableSpec {
  tableName: string;
  domainArea: string;
  uiModules: string[];
  primaryKey: string;
  foreignKeys: string[];
  uniqueConstraints: string[];
  indexes: string[];
  auditRequirement: 'immutable_ledger' | 'trigger_audited' | 'system_managed';
  rlsPolicySummary: string;
}

export interface UiModuleDatabaseMapping {
  domainEntity: string;
  uiModule: string;
  requiredPersistentData: string;
  databaseTables: string[];
  relationships: string[];
  accessPermissions: {
    platform_owner: string;
    pharmacy_owner: string;
    authorized_pharmacist: string;
    patient_apk_user: string;
  };
}

export const SUPABASE_STAGE2_SCHEMA_SPEC: SupabaseTableSpec[] = [
  {
    tableName: 'pharmacies',
    domainArea: 'Pharmacies',
    uiModules: ['AppShell', 'DashboardView', 'GovernanceView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [],
    uniqueConstraints: ['license_number'],
    indexes: ['idx_pharmacies_governorate_city', 'idx_pharmacies_is_active'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'platform_owner reads/provisions pharmacies; pharmacy_owner & authorized_pharmacist SELECT own pharmacy row only (id = app_current_pharmacy_id()); patient_apk_user reads linked pharmacy display metadata only.',
  },
  {
    tableName: 'pharmacy_staff',
    domainArea: 'Staff and roles',
    uiModules: ['AppShell', 'GovernanceView'],
    primaryKey: 'id (uuid -> auth.users.id)',
    foreignKeys: ['pharmacy_id -> pharmacies.id ON DELETE RESTRICT'],
    uniqueConstraints: ['(pharmacy_id, phone)', 'syndicate_license'],
    indexes: ['idx_pharmacy_staff_pharmacy_active', 'idx_pharmacy_staff_role'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Server-side provisioned via Edge Function; pharmacy_owner reads/updates active status of own pharmacy staff; authorized_pharmacist reads staff within own pharmacy_id; role column cannot be self-elevated.',
  },
  {
    tableName: 'patients',
    domainArea: 'Patients',
    uiModules: ['PatientsView', 'PatientDetailView', 'PatientFormModal', 'DashboardView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      'pharmacy_id -> pharmacies.id ON DELETE RESTRICT',
      'auth_user_id -> auth.users.id ON DELETE SET NULL',
      'created_by_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: [
      '(id, pharmacy_id)',
      '(pharmacy_id, patient_code)',
      'auth_user_id (WHERE auth_user_id IS NOT NULL)',
    ],
    indexes: [
      'idx_patients_pharmacy_status',
      'idx_patients_pharmacy_phone',
      'idx_patients_pharmacy_name_trgm',
    ],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacist-only INSERT/UPDATE within app_security.current_pharmacy_id(); shared family/caregiver phone numbers supported via phone_owner_type (self/caregiver/family_shared); patient_apk_user SELECTs own row ONLY where auth_user_id = auth.uid() AND status = active.',
  },
  {
    tableName: 'patient_conditions',
    domainArea: 'Medical conditions',
    uiModules: ['PatientsView', 'PatientDetailView', 'PatientFormModal', 'AnalyticsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
    ],
    uniqueConstraints: ['(patient_id, condition_name)'],
    indexes: ['idx_patient_conditions_pharmacy_condition'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff CRUD within app_security.current_pharmacy_id(); patient_apk_user SELECTs own conditions via linked patient_id.',
  },
  {
    tableName: 'patient_allergies',
    domainArea: 'Allergies',
    uiModules: ['PatientDetailView', 'PatientFormModal', 'DispenseModal'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
    ],
    uniqueConstraints: ['(patient_id, substance)'],
    indexes: ['idx_patient_allergies_patient_severity'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff CRUD within app_security.current_pharmacy_id(); patient_apk_user SELECTs own allergies.',
  },
  {
    tableName: 'medication_catalog',
    domainArea: 'Medication catalog',
    uiModules: ['MedicationWizardModal'],
    primaryKey: 'id (uuid)',
    foreignKeys: [],
    uniqueConstraints: ['(brand_name, generic_name, default_dosage_form)'],
    indexes: ['idx_medication_catalog_brand_generic'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Authenticated staff & patients SELECT reference catalog; platform_owner manages catalog entries; never stores default prescribed doses.',
  },
  {
    tableName: 'patient_medication_plans',
    domainArea: 'Medication plans',
    uiModules: ['PatientDetailView', 'MedicationWizardModal', 'DispensingView', 'RefillsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
      'catalog_id -> medication_catalog.id ON DELETE SET NULL',
    ],
    uniqueConstraints: ['(id, pharmacy_id)', '(id, patient_id, pharmacy_id)'],
    indexes: [
      'idx_med_plans_pharmacy_patient_status',
      'idx_med_plans_pharmacy_created_desc',
    ],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff CRUD within app_security.current_pharmacy_id(); patient_apk_user SELECTs own active/paused plans.',
  },
  {
    tableName: 'regimen_versions',
    domainArea: 'Regimen versions',
    uiModules: ['PatientDetailView', 'MedicationWizardModal'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, pharmacy_id) -> patient_medication_plans(id, pharmacy_id) ON DELETE RESTRICT',
      'changed_by_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: ['(medication_plan_id, version_number)', '(medication_plan_id, version_number, pharmacy_id)'],
    indexes: ['idx_regimen_versions_plan_effective'],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Append-only clinical version ledger (SELECT/INSERT by pharmacy staff within pharmacy_id; UPDATE restricted by trigger solely to closing effective_to; DELETE forbidden).',
  },
  {
    tableName: 'medication_pause_periods',
    domainArea: 'Medication plans (pause/resume windows)',
    uiModules: ['PatientDetailView', 'RefillsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      'recorded_by_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: ['trg_pause_periods_no_overlap (non-overlapping daterange per medication_plan_id)'],
    indexes: ['idx_med_pause_periods_plan_dates'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff SELECT/INSERT/UPDATE (resumed_at) within app_security.current_pharmacy_id(); patient_apk_user SELECTs own plan pause periods.',
  },
  {
    tableName: 'scheduled_doses',
    domainArea: 'Scheduled doses',
    uiModules: ['PatientDetailView', 'MedicationWizardModal'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      '(medication_plan_id, regimen_version_number, pharmacy_id) -> regimen_versions(medication_plan_id, version_number, pharmacy_id) ON DELETE RESTRICT',
    ],
    uniqueConstraints: [
      '(id, medication_plan_id, patient_id, pharmacy_id)',
      '(medication_plan_id, regimen_version_number, scheduled_date, scheduled_time24)',
    ],
    indexes: ['idx_scheduled_doses_patient_date', 'idx_scheduled_doses_pharmacy_date'],
    auditRequirement: 'system_managed',
    rlsPolicySummary:
      'Pharmacy staff CRUD within app_security.current_pharmacy_id(); patient_apk_user SELECTs own scheduled dose occurrences.',
  },
  {
    tableName: 'dose_events',
    domainArea: 'Dose events',
    uiModules: ['PatientDetailView', 'DashboardView', 'AnalyticsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      '(scheduled_dose_id, medication_plan_id, patient_id, pharmacy_id) -> scheduled_doses(id, medication_plan_id, patient_id, pharmacy_id) ON DELETE SET NULL (scheduled_dose_id)',
    ],
    uniqueConstraints: [
      'scheduled_dose_id',
      'client_event_uuid',
      '(medication_plan_id, scheduled_date, scheduled_time24)',
    ],
    indexes: ['idx_dose_events_patient_date_status', 'idx_dose_events_pharmacy_date'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Direct patient INSERT/UPDATE revoked; patient_apk_user confirms existing active scheduled_doses ONLY via idempotent `public.confirm_scheduled_dose(...)` RPC (trigger requires non-null scheduled_dose_id on INSERT & server-derives schedule/regimen fields); pharmacy staff SELECT/INSERT/UPDATE within app_security.current_pharmacy_id().',
  },
  {
    tableName: 'unscheduled_dose_reports',
    domainArea: 'Dose events',
    uiModules: ['PatientDetailView', 'DashboardView', 'AnalyticsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      '(reviewed_by_staff_id, pharmacy_id) -> pharmacy_staff(id, pharmacy_id) ON DELETE RESTRICT',
    ],
    uniqueConstraints: ['client_event_uuid'],
    indexes: ['idx_unscheduled_reports_patient_time', 'idx_unscheduled_reports_pharmacy_plan'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Explicitly separates patient-reported PRN or extra intakes (`is_verified_schedule = false` constrained permanently) from scheduled occurrences; patient_apk_user INSERTs own reports for active plans; pharmacy staff SELECT/review within app_security.current_pharmacy_id().',
  },
  {
    tableName: 'dispensing_events',
    domainArea: 'Dispensing records',
    uiModules: ['DispensingView', 'DispenseModal', 'PatientDetailView', 'DashboardView', 'AnalyticsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      '(medication_plan_id, regimen_version_number, pharmacy_id) -> regimen_versions(medication_plan_id, version_number, pharmacy_id) ON DELETE RESTRICT',
      'dispensed_by_staff_id -> pharmacy_staff.id ON DELETE RESTRICT',
    ],
    uniqueConstraints: ['(id, pharmacy_id)', '(id, medication_plan_id, patient_id, pharmacy_id)'],
    indexes: [
      'idx_dispensing_events_plan_date_asc',
      'idx_dispensing_events_pharmacy_date',
      'idx_dispensing_events_patient_date',
    ],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Append-only dispensing ledger: pharmacy staff SELECT/INSERT within app_security.current_pharmacy_id(); UPDATE/DELETE blocked by trigger; patient_apk_user SELECTs own dispensing history.',
  },
  {
    tableName: 'refill_assessments',
    domainArea: 'Refills',
    uiModules: ['RefillsView', 'DashboardView', 'PatientDetailView', 'FollowUpsView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE RESTRICT',
      '(last_dispensing_event_id, medication_plan_id, patient_id, pharmacy_id) -> dispensing_events(id, medication_plan_id, patient_id, pharmacy_id) ON DELETE SET NULL (last_dispensing_event_id)',
    ],
    uniqueConstraints: ['(medication_plan_id)'],
    indexes: ['idx_refill_assessments_pharmacy_status_enddate'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff SELECT/INSERT/UPDATE within app_security.current_pharmacy_id(); patient_apk_user SELECTs own projected refill dates.',
  },
  {
    tableName: 'lab_results',
    domainArea: 'Laboratory results',
    uiModules: ['PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
      'recorded_by_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: [],
    indexes: ['idx_lab_results_patient_testdate_desc', 'idx_lab_results_pharmacy_abnormal'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff SELECT/INSERT/UPDATE within app_security.current_pharmacy_id(); patient_apk_user SELECTs own lab results.',
  },
  {
    tableName: 'follow_up_tasks',
    domainArea: 'Follow-up tasks',
    uiModules: ['FollowUpsView', 'DashboardView', 'PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
      '(related_medication_plan_id, patient_id, pharmacy_id) -> patient_medication_plans(id, patient_id, pharmacy_id) ON DELETE SET NULL (related_medication_plan_id)',
      'assigned_staff_id -> pharmacy_staff.id ON DELETE SET NULL (assigned_staff_id)',
    ],
    uniqueConstraints: ['(id, pharmacy_id)'],
    indexes: ['idx_followup_tasks_pharmacy_status_duedate', 'idx_followup_tasks_patient'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff CRUD within app_security.current_pharmacy_id(); internal clinical workflow — not exposed to patient_apk_user.',
  },
  {
    tableName: 'follow_up_contact_logs',
    domainArea: 'Follow-up tasks (contact logs)',
    uiModules: ['FollowUpsView', 'PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(follow_up_task_id, pharmacy_id) -> follow_up_tasks(id, pharmacy_id) ON DELETE CASCADE',
      'staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: [],
    indexes: ['idx_followup_contact_logs_task_time'],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Append-only contact log for pharmacy staff within app_current_pharmacy_id(); not exposed to patient_apk_user.',
  },
  {
    tableName: 'consultation_threads',
    domainArea: 'Consultations and messages',
    uiModules: ['ConsultationsView', 'PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE RESTRICT',
    ],
    uniqueConstraints: ['(id, pharmacy_id)'],
    indexes: ['idx_consultation_threads_pharmacy_status_updated', 'idx_consultation_threads_patient'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff SELECT/INSERT/UPDATE within app_current_pharmacy_id(); patient_apk_user SELECT/INSERT own threads.',
  },
  {
    tableName: 'consultation_messages',
    domainArea: 'Consultations and messages',
    uiModules: ['ConsultationsView', 'PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(thread_id, pharmacy_id) -> consultation_threads(id, pharmacy_id) ON DELETE CASCADE',
      'sender_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: [],
    indexes: ['idx_consultation_messages_thread_sent_asc'],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Append-only messages: pharmacy staff SELECT/INSERT within app_current_pharmacy_id() (with approved_by_pharmacist = true); patient_apk_user SELECT/INSERT messages in own thread.',
  },
  {
    tableName: 'patient_apk_invitations',
    domainArea: 'Patient invitations',
    uiModules: ['InvitationsView', 'InvitationModal', 'PatientDetailView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      '(patient_id, pharmacy_id) -> patients(id, pharmacy_id) ON DELETE CASCADE',
      'issued_by_staff_id -> pharmacy_staff.id',
    ],
    uniqueConstraints: ['token_hash (sha256)', 'one_pending_per_patient PARTIAL UNIQUE (patient_id) WHERE status = pending'],
    indexes: ['idx_invitations_pharmacy_status', 'idx_invitations_patient_status'],
    auditRequirement: 'trigger_audited',
    rlsPolicySummary:
      'Pharmacy staff SELECT/INSERT/UPDATE (revoke) within app_current_pharmacy_id(); raw token never stored; redemption & OTP verification exclusively via rate-limited SECURITY DEFINER RPC.',
  },
  {
    tableName: 'invitation_redemption_attempts',
    domainArea: 'Patient invitations (Abuse & Rate-Limit Ledger)',
    uiModules: ['InvitationsView', 'GovernanceView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      'invitation_id -> patient_apk_invitations.id ON DELETE SET NULL',
      'pharmacy_id -> pharmacies.id ON DELETE CASCADE',
    ],
    uniqueConstraints: [],
    indexes: ['idx_redemption_attempts_invitation_time', 'idx_redemption_attempts_ip_hash_time'],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Append-only security telemetry written by SECURITY DEFINER redemption RPC; pharmacy_owner & platform_owner SELECT for abuse auditing.',
  },
  {
    tableName: 'audit_logs',
    domainArea: 'Audit records',
    uiModules: ['GovernanceView', 'DashboardView'],
    primaryKey: 'id (uuid)',
    foreignKeys: [
      'pharmacy_id -> pharmacies.id ON DELETE RESTRICT',
    ],
    uniqueConstraints: [],
    indexes: ['idx_audit_logs_pharmacy_timestamp_desc', 'idx_audit_logs_entity'],
    auditRequirement: 'immutable_ledger',
    rlsPolicySummary:
      'Strictly append-only via database triggers & SECURITY DEFINER functions; UPDATE/DELETE blocked by trigger; pharmacy_owner & authorized_pharmacist SELECT within app_current_pharmacy_id().',
  },
];

export const UI_MODULE_DATABASE_MAPPING: UiModuleDatabaseMapping[] = [
  {
    domainEntity: 'Pharmacies',
    uiModule: 'AppShell, DashboardView, GovernanceView',
    requiredPersistentData: 'Pharmacy name (AR/EN), Iraqi license number, city, governorate, phone, Asia/Baghdad timezone',
    databaseTables: ['pharmacies'],
    relationships: ['1:N with pharmacy_staff, patients, patient_medication_plans, dispensing_events, audit_logs'],
    accessPermissions: {
      platform_owner: 'SELECT, INSERT, UPDATE (provision & suspend tenants)',
      pharmacy_owner: 'SELECT, UPDATE own pharmacy profile',
      authorized_pharmacist: 'SELECT own pharmacy profile',
      patient_apk_user: 'SELECT linked pharmacy display info only',
    },
  },
  {
    domainEntity: 'Staff and roles',
    uiModule: 'AppShell (Staff Switcher / Auth Profile), GovernanceView',
    requiredPersistentData: 'Staff full name, role (pharmacy_owner / authorized_pharmacist), Iraqi Syndicate license, phone, active status',
    databaseTables: ['pharmacy_staff'],
    relationships: ['N:1 with pharmacies; 1:1 with auth.users(id)'],
    accessPermissions: {
      platform_owner: 'Provision initial pharmacy_owner via Edge Function',
      pharmacy_owner: 'SELECT all own-pharmacy staff; provision/deactivate authorized_pharmacist via Edge Function',
      authorized_pharmacist: 'SELECT own-pharmacy staff directory; cannot modify roles',
      patient_apk_user: 'No access',
    },
  },
  {
    domainEntity: 'Patients',
    uiModule: 'PatientsView, PatientDetailView, PatientFormModal, DashboardView',
    requiredPersistentData: 'Patient code (MC-XXXX), full name, normalized Iraqi phone (07XXXXXXXXX), DOB, sex, contact preference, clinical notes, archive state',
    databaseTables: ['patients'],
    relationships: ['N:1 with pharmacies; 1:N with patient_conditions, patient_allergies, patient_medication_plans, dispensing_events'],
    accessPermissions: {
      platform_owner: 'No clinical PII access by default',
      pharmacy_owner: 'SELECT, INSERT, UPDATE (archive/restore) within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE (archive/restore) within own pharmacy_id',
      patient_apk_user: 'SELECT own row ONLY (auth_user_id = auth.uid()); no self-registration',
    },
  },
  {
    domainEntity: 'Medical conditions',
    uiModule: 'PatientsView, PatientDetailView, PatientFormModal, AnalyticsView',
    requiredPersistentData: 'Chronic condition name, onset date, clinical status, notes',
    databaseTables: ['patient_conditions'],
    relationships: ['N:1 with patients (composite FK patient_id, pharmacy_id)'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      patient_apk_user: 'SELECT own conditions',
    },
  },
  {
    domainEntity: 'Allergies',
    uiModule: 'PatientDetailView, PatientFormModal, DispenseModal (Safety Banner)',
    requiredPersistentData: 'Allergen substance, severity (mild/moderate/severe), reaction description',
    databaseTables: ['patient_allergies'],
    relationships: ['N:1 with patients (composite FK patient_id, pharmacy_id)'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      patient_apk_user: 'SELECT own allergies',
    },
  },
  {
    domainEntity: 'Medication catalog',
    uiModule: 'MedicationWizardModal (Step 1 Reference Lookup)',
    requiredPersistentData: 'Brand name, generic name, available strengths, default dosage form, default route, therapeutic category',
    databaseTables: ['medication_catalog'],
    relationships: ['1:N optional reference from patient_medication_plans'],
    accessPermissions: {
      platform_owner: 'SELECT, INSERT, UPDATE reference catalog',
      pharmacy_owner: 'SELECT reference catalog',
      authorized_pharmacist: 'SELECT reference catalog',
      patient_apk_user: 'SELECT reference catalog',
    },
  },
  {
    domainEntity: 'Medication plans',
    uiModule: 'PatientDetailView, MedicationWizardModal, DispensingView, RefillsView',
    requiredPersistentData: 'Drug identity, separate strength/form/route/doseAmount/doseUnit, verified instructions, start/end dates, status, pause periods, current schedule JSONB',
    databaseTables: ['patient_medication_plans', 'medication_pause_periods'],
    relationships: ['N:1 with patients; 1:N with regimen_versions, medication_pause_periods, dispensing_events, scheduled_doses'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'SELECT own active/paused medication plans',
    },
  },
  {
    domainEntity: 'Regimen versions',
    uiModule: 'PatientDetailView (Version History Drawer), MedicationWizardModal',
    requiredPersistentData: 'Version number, effective_from, effective_to, dose amount/unit, food relation, schedule snapshot, changed_by_staff_id, change_reason',
    databaseTables: ['regimen_versions'],
    relationships: ['N:1 with patient_medication_plans (composite FK medication_plan_id, pharmacy_id)'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT (append-only; DELETE forbidden)',
      authorized_pharmacist: 'SELECT, INSERT (append-only; DELETE forbidden)',
      patient_apk_user: 'SELECT own regimen versions',
    },
  },
  {
    domainEntity: 'Scheduled doses',
    uiModule: 'PatientDetailView (Daily Schedule & Occurrence Preview), Android Sync API',
    requiredPersistentData: 'Generated Baghdad date, 24h time, planned dose amount, dose unit, slot label, version number',
    databaseTables: ['scheduled_doses'],
    relationships: ['N:1 with patient_medication_plans & patients; 1:1 optional with dose_events'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE, DELETE within own pharmacy_id',
      patient_apk_user: 'SELECT own scheduled doses',
    },
  },
  {
    domainEntity: 'Dose events',
    uiModule: 'PatientDetailView (Adherence Log), DashboardView, AnalyticsView',
    requiredPersistentData: 'Scheduled occurrence confirmation via confirm_scheduled_dose RPC (taken, skipped_by_patient, delayed), confirmed_at, client_event_uuid; plus separate unscheduled_dose_reports for PRN/extra intakes (is_verified_schedule = false)',
    databaseTables: ['dose_events', 'unscheduled_dose_reports'],
    relationships: ['N:1 with patients, patient_medication_plans & scheduled_doses'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'Confirm existing scheduled doses via `confirm_scheduled_dose` RPC ONLY; INSERT own `unscheduled_dose_reports` (is_verified_schedule = false)',
    },
  },
  {
    domainEntity: 'Dispensing records',
    uiModule: 'DispensingView, DispenseModal, PatientDetailView, DashboardView, AnalyticsView',
    requiredPersistentData: 'Dispensed quantity, unit, package count/size, batch, expiry, dispensing date, staff ID, partial fill flag, forecast snapshot & assumptions',
    databaseTables: ['dispensing_events'],
    relationships: ['N:1 with patients, patient_medication_plans, pharmacy_staff'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT (append-only ledger; UPDATE/DELETE blocked)',
      authorized_pharmacist: 'SELECT, INSERT (append-only ledger; UPDATE/DELETE blocked)',
      patient_apk_user: 'SELECT own dispensing records',
    },
  },
  {
    domainEntity: 'Refills',
    uiModule: 'RefillsView, DashboardView, PatientDetailView, FollowUpsView',
    requiredPersistentData: 'Cumulative dispensed analyzed, estimated remaining units, estimated supply end date, refill status (including unable_to_estimate), assumptions text',
    databaseTables: ['refill_assessments'],
    relationships: ['1:1 with patient_medication_plans; N:1 with patients & latest dispensing_events'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'SELECT own refill projections',
    },
  },
  {
    domainEntity: 'Laboratory results',
    uiModule: 'PatientDetailView (Labs Tab)',
    requiredPersistentData: 'Test name (HbA1c, eGFR, INR, etc.), value, unit, reference range, abnormal flag, test date, notes',
    databaseTables: ['lab_results'],
    relationships: ['N:1 with patients & pharmacy_staff'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'SELECT own lab results',
    },
  },
  {
    domainEntity: 'Follow-up tasks',
    uiModule: 'FollowUpsView, DashboardView, PatientDetailView',
    requiredPersistentData: 'Follow-up type (refill/adherence/clinical/lab_review), due date, status, assigned staff, manual WhatsApp/phone contact logs',
    databaseTables: ['follow_up_tasks', 'follow_up_contact_logs'],
    relationships: ['N:1 with patients & patient_medication_plans; 1:N with follow_up_contact_logs'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'No access (internal pharmacy workflow)',
    },
  },
  {
    domainEntity: 'Consultations and messages',
    uiModule: 'ConsultationsView, PatientDetailView',
    requiredPersistentData: 'Thread subject, status (open/follow_up/resolved), chronological messages, sender type, pharmacist approval flag',
    databaseTables: ['consultation_threads', 'consultation_messages'],
    relationships: ['N:1 with patients; 1:N between consultation_threads and consultation_messages'],
    accessPermissions: {
      platform_owner: 'No access',
      pharmacy_owner: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE within own pharmacy_id',
      patient_apk_user: 'SELECT, INSERT on own consultation threads',
    },
  },
  {
    domainEntity: 'Patient invitations',
    uiModule: 'InvitationsView, InvitationModal, PatientDetailView',
    requiredPersistentData: 'SHA-256 token hash, status (pending/activated/expired/revoked), expiry timestamp, verification method, OTP hash, attempt counters, device binding',
    databaseTables: ['patient_apk_invitations', 'invitation_redemption_attempts'],
    relationships: ['N:1 with patients & pharmacy_staff; 1:N with invitation_redemption_attempts'],
    accessPermissions: {
      platform_owner: 'SELECT aggregated abuse/redemption metrics',
      pharmacy_owner: 'SELECT, INSERT, UPDATE (revoke) within own pharmacy_id',
      authorized_pharmacist: 'SELECT, INSERT, UPDATE (revoke) within own pharmacy_id',
      patient_apk_user: 'Redeem ONLY via rate-limited SECURITY DEFINER RPC with token + SMS OTP + Pharmacist PIN',
    },
  },
  {
    domainEntity: 'Audit records',
    uiModule: 'GovernanceView, DashboardView',
    requiredPersistentData: 'Actor user ID, actor role, pharmacy ID, action code, entity type, entity ID, bilingual summary, timestamp',
    databaseTables: ['audit_logs'],
    relationships: ['N:1 with pharmacies'],
    accessPermissions: {
      platform_owner: 'SELECT tenant-level operational audit logs',
      pharmacy_owner: 'SELECT own pharmacy audit logs (INSERT via trigger only; UPDATE/DELETE forbidden)',
      authorized_pharmacist: 'SELECT own pharmacy audit logs (INSERT via trigger only; UPDATE/DELETE forbidden)',
      patient_apk_user: 'No access',
    },
  },
];

// ============================================================================
// TASK 4 — STAGE 2A REFERENCE AUTHORIZATION & RLS POLICY SIMULATOR
// Used by automated negative security tests to prove strict isolation between
// pharmacies, unauthorized staff, and patients before live Supabase connection.
// ============================================================================

export interface SimulatedAuthContext {
  authUid: string | null;
  /**
   * Simulates user_metadata (editable by client via supabase.auth.updateUser).
   * SECURITY RULE: Authorization MUST NEVER trust userMetadata!
   */
  untrustedUserMetadata?: {
    role?: string;
    pharmacyId?: string;
  };
}

export interface AuthoritativeStaffRow {
  userId: string;
  pharmacyId: string;
  role: 'pharmacy_owner' | 'authorized_pharmacist';
  isActive: boolean;
}

export interface AuthoritativePatientAccountLink {
  patientId: string;
  pharmacyId: string;
  authUserId: string;
  status: 'active' | 'archived';
}

export interface InvitationRedemptionRecord {
  id: string;
  patientId: string;
  pharmacyId: string;
  tokenHash: string;
  pharmacistPinHash: string;
  smsOtpHash: string;
  status: 'pending' | 'activated' | 'expired' | 'revoked';
  expiresAtMs: number;
  failedAttempts: number;
  maxAttempts: number;
}

/**
 * Evaluates RLS & RPC access rules identically to our Stage 2A PostgreSQL policies.
 * Never reads `ctx.untrustedUserMetadata` for authorization decisions.
 */
export class Stage2SecurityPolicyEvaluator {
  constructor(
    private readonly staffDirectory: AuthoritativeStaffRow[],
    private readonly patientLinks: AuthoritativePatientAccountLink[],
    private readonly invitations: InvitationRedemptionRecord[]
  ) {}

  private getActiveStaff(authUid: string | null): AuthoritativeStaffRow | undefined {
    if (!authUid) return undefined;
    return this.staffDirectory.find((s) => s.userId === authUid && s.isActive);
  }

  private getActivePatientLink(authUid: string | null): AuthoritativePatientAccountLink | undefined {
    if (!authUid) return undefined;
    return this.patientLinks.find((p) => p.authUserId === authUid && p.status === 'active');
  }

  public canRegisterPatient(ctx: SimulatedAuthContext, targetPharmacyId: string): boolean {
    const staff = this.getActiveStaff(ctx.authUid);
    if (!staff) return false;
    return (
      staff.pharmacyId === targetPharmacyId &&
      (staff.role === 'pharmacy_owner' || staff.role === 'authorized_pharmacist')
    );
  }

  public canProvisionPharmacistStaff(ctx: SimulatedAuthContext, targetPharmacyId: string): boolean {
    const staff = this.getActiveStaff(ctx.authUid);
    if (!staff) return false;
    return staff.pharmacyId === targetPharmacyId && staff.role === 'pharmacy_owner';
  }

  public canSelectPatientRecord(
    ctx: SimulatedAuthContext,
    record: { patientId: string; pharmacyId: string }
  ): boolean {
    const staff = this.getActiveStaff(ctx.authUid);
    if (staff) {
      return staff.pharmacyId === record.pharmacyId;
    }
    const patient = this.getActivePatientLink(ctx.authUid);
    if (patient) {
      return patient.patientId === record.patientId && patient.pharmacyId === record.pharmacyId;
    }
    return false;
  }

  public canMutateClinicalRecord(
    ctx: SimulatedAuthContext,
    record: { pharmacyId: string }
  ): boolean {
    const staff = this.getActiveStaff(ctx.authUid);
    if (!staff) return false;
    return staff.pharmacyId === record.pharmacyId;
  }

  public canSelectInternalFollowUp(
    ctx: SimulatedAuthContext,
    record: { pharmacyId: string }
  ): boolean {
    const staff = this.getActiveStaff(ctx.authUid);
    if (!staff) return false;
    return staff.pharmacyId === record.pharmacyId;
  }

  /**
   * Simulates the server-side SECURITY DEFINER invitation redemption RPC.
   * Requires:
   * 1. Valid pending invitation not expired & under maxAttempts
   * 2. Matching cryptographic single-use tokenHash
   * 3. Multi-factor verification: SMS OTP sent to registered phone + Pharmacist handover PIN
   *    (DOB or National ID alone is NEVER sufficient!)
   */
  public redeemInvitationRpc(params: {
    invitationId: string;
    providedTokenHash: string;
    providedPharmacistPinHash?: string;
    providedSmsOtpHash?: string;
    onlyDobOrNationalIdProvided?: boolean;
    nowMs: number;
  }): { allowed: boolean; reason: string } {
    const inv = this.invitations.find((i) => i.id === params.invitationId);
    if (!inv) return { allowed: false, reason: 'INVITATION_NOT_FOUND' };

    if (inv.status !== 'pending') {
      return { allowed: false, reason: `INVITATION_NOT_PENDING:${inv.status}` };
    }

    if (inv.failedAttempts >= inv.maxAttempts) {
      inv.status = 'revoked';
      return { allowed: false, reason: 'RATE_LIMIT_LOCKOUT_REVOKED' };
    }

    if (params.nowMs > inv.expiresAtMs) {
      inv.status = 'expired';
      return { allowed: false, reason: 'INVITATION_EXPIRED' };
    }

    if (params.onlyDobOrNationalIdProvided) {
      inv.failedAttempts += 1;
      return {
        allowed: false,
        reason: 'INSUFFICIENT_IDENTITY_PROOF:DOB_OR_NATIONAL_ID_ALONE_REJECTED',
      };
    }

    const tokenMatches = inv.tokenHash === params.providedTokenHash;
    const pinMatches =
      Boolean(params.providedPharmacistPinHash) &&
      inv.pharmacistPinHash === params.providedPharmacistPinHash;
    const otpMatches =
      Boolean(params.providedSmsOtpHash) && inv.smsOtpHash === params.providedSmsOtpHash;

    if (!tokenMatches || !pinMatches || !otpMatches) {
      inv.failedAttempts += 1;
      if (inv.failedAttempts >= inv.maxAttempts) {
        inv.status = 'revoked';
        return { allowed: false, reason: 'RATE_LIMIT_LOCKOUT_REVOKED' };
      }
      return { allowed: false, reason: 'INVALID_CREDENTIALS_OR_OTP' };
    }

    // Consume single-use token atomically
    inv.status = 'activated';
    return { allowed: true, reason: 'ACTIVATED' };
  }
}
