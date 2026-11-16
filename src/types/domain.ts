export type Language = 'ar' | 'en';

export type StaffRole =
  | 'platform_owner'
  | 'pharmacy_owner'
  | 'authorized_pharmacist'
  | 'patient_apk_user';

export interface Pharmacy {
  id: string;
  nameAr: string;
  nameEn: string;
  city: string;
  governorate: string;
  licenseNumber: string;
  phone: string;
  timezone: 'Asia/Baghdad';
}

export interface PharmacyStaff {
  id: string;
  pharmacyId: string;
  fullName: string;
  role: Exclude<StaffRole, 'patient_apk_user'>;
  syndicateLicense?: string;
  phone: string;
  isActive: boolean;
}

export type PatientSex = 'male' | 'female';
export type ContactPreference = 'whatsapp' | 'phone_call' | 'apk_notification';
export type PatientStatus = 'active' | 'archived';
export type PhoneOwnerType = 'self' | 'caregiver' | 'family_shared';

export interface PatientAllergy {
  id: string;
  substance: string;
  severity: 'mild' | 'moderate' | 'severe';
  reaction?: string;
}

export type AllergyOverrideAuthSource =
  | 'prescriber_written_order'
  | 'prescriber_verbal_verified'
  | 'pharmacist_clinical_escalation';

export interface AllergyOverrideAuthorization {
  acknowledged: boolean;
  level?:
    | 'critical_conflict'
    | 'allergy_conflict'
    | 'caution_cross_reactivity'
    | 'insufficient_ingredient_data';
  prescriberName?: string;
  authorizationSource?: AllergyOverrideAuthSource;
  authorizationReference?: string;
  clinicalJustification?: string;
  authorizedByStaffName?: string;
  authorizedAt?: string;
}

export type BackendSafetyStage =
  | 'demo'
  | 'migration_0004_legacy'
  | 'stage2c2b_v2'
  | 'stage2c2c_v2';

export type BackendCapabilityProbeStatus =
  | 'demo'
  | 'verified_v2'
  | 'legacy_missing_rpc'
  | 'malformed_response';

export interface BackendSafetyCapabilities {
  stage: BackendSafetyStage;
  supportsV2MedicationPlans: boolean;
  supportsV2DispensingIdempotency: boolean;
  enforcesServerCriticalAllergyOverride: boolean;
  enforcesServerAllergyUncertainty?: boolean;
  legacy0004RpcsRetired?: boolean;
  probeStatus?: BackendCapabilityProbeStatus;
  checkedAt?: string;
}

export interface Patient {
  id: string;
  patientCode: string; // e.g., MC-1001
  pharmacyId: string;
  fullName: string;
  phone: string;
  phoneOwnerType?: PhoneOwnerType;
  caregiverName?: string;
  dateOfBirth: string; // YYYY-MM-DD
  sex: PatientSex;
  chronicConditions: string[];
  allergies: PatientAllergy[];
  contactPreference: ContactPreference;
  clinicalNotes: string;
  registrationDate: string; // YYYY-MM-DD
  status: PatientStatus;
  archivedAt?: string;
  archivedReason?: string;
}

export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'injection'
  | 'inhaler'
  | 'drops'
  | 'cream'
  | 'sachet';

export type AdministrationRoute =
  | 'oral'
  | 'subcutaneous'
  | 'intramuscular'
  | 'intravenous'
  | 'inhalation'
  | 'topical'
  | 'ophthalmic'
  | 'otic';

export type FoodRelation = 'before_food' | 'with_food' | 'after_food' | 'any_time';

export type MedicationCatalogLoadStatus = 'demo' | 'loaded' | 'error' | 'unavailable';

export interface MedicationCatalogItem {
  id: string;
  brandName: string;
  genericName: string;
  activeIngredients?: string[];
  availableStrengths: string[];
  defaultDosageForm: DosageForm;
  defaultRoute: AdministrationRoute;
  category: string;
  ingredientVerificationStatus?: 'verified' | 'partial' | 'unverified';
  ingredientSource?: string;
  ingredientReviewedAt?: string;
  ingredientReviewedBy?: string;
  // Clinical safety: catalog never prescribes a default doseAmount; pharmacist must verify & enter dose.
}

export type ScheduleFrequencyType =
  | 'daily'
  | 'interval'
  | 'weekdays'
  | 'cyclic'
  | 'variable'
  | 'prn';

export type IntervalUnit = 'hours' | 'days' | 'weeks';

// 0 = Sunday ... 6 = Saturday (JS Date.getDay compatible)
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DoseTimeSlot {
  id: string;
  time24: string; // "HH:mm" in Asia/Baghdad
  doseAmount: number; // e.g. 1 or 0.5 or 2
  label?: string; // e.g. "صباحاً" / "Morning"
}

export interface DoseSchedule {
  frequencyType: ScheduleFrequencyType;
  timesPerDay: number; // ignored when frequencyType === 'prn' or 'interval' in hours
  intervalValue?: number; // for 'interval': every N hours/days/weeks
  intervalUnit?: IntervalUnit;
  selectedWeekdays?: WeekdayIndex[]; // for 'weekdays'
  cycleOnDays?: number; // for 'cyclic', e.g., 21 days on
  cycleOffDays?: number; // for 'cyclic', e.g., 7 days off
  variablePatternNote?: string; // for 'variable', e.g., tapering or alternate-day dosing details
  prnMaxPerDay?: number; // for 'prn' (as needed)
  prnIndication?: string; // for 'prn'
  doseSlots: DoseTimeSlot[];
  timezone: 'Asia/Baghdad';
}

export type MedicationPlanStatus = 'active' | 'paused' | 'discontinued' | 'archived';

export interface MedicationPausePeriod {
  pausedFrom: string; // YYYY-MM-DD (inclusive start of pause)
  resumedAt?: string; // YYYY-MM-DD (inclusive date treatment resumed; undefined if still paused)
  reason?: string;
}

export interface RegimenVersion {
  versionNumber: number;
  effectiveFrom: string; // ISO date YYYY-MM-DD
  effectiveTo?: string;
  doseAmount: number;
  doseUnit: string;
  foodRelation: FoodRelation;
  verifiedInstructions: string;
  schedule: DoseSchedule;
  changedByStaffName: string;
  changeReason: string;
  createdAt: string; // ISO timestamp
}

export interface PatientMedicationPlan {
  id: string;
  patientId: string;
  pharmacyId: string;
  catalogId?: string;
  brandName: string;
  genericName: string;
  strength: string;
  dosageForm: DosageForm;
  route: AdministrationRoute;
  doseAmount: number; // primary prescribed dose amount
  doseUnit: string; // e.g. "قرص" / "tablet", "مل" / "mL", "بخة" / "puff", "وحدة" / "IU"
  foodRelation: FoodRelation;
  verifiedInstructions: string;
  prescriberName?: string;
  prescriberSpecialty?: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD when finite
  isOngoing: boolean;
  durationDays?: number;
  status: MedicationPlanStatus;
  statusChangedAt?: string;
  statusChangeReason?: string;
  pausePeriods?: MedicationPausePeriod[];
  currentVersionNumber: number;
  schedule: DoseSchedule;
  regimenHistory: RegimenVersion[];
  createdAt: string; // ISO timestamp - used to sort newest added at top
  updatedAt: string;
}

export type DispensingHashVerificationStatus =
  | 'v2_matched'
  | 'v2_mismatch'
  | 'v2_client_hash_missing'
  | 'v2_server_hash_missing'
  | 'legacy_0004'
  | 'missing_hash';

export interface DispensingEvent {
  id: string;
  pharmacyId: string;
  patientId: string;
  medicationPlanId: string;
  regimenVersionNumber: number;
  dispensedQuantity: number;
  quantityUnit: string;
  packageCount?: number;
  packageSize?: number;
  batchNumber?: string;
  expiryDate?: string;
  dispensingDate: string; // YYYY-MM-DD
  dispensedByStaffId: string;
  dispensedByStaffName: string;
  notes?: string;
  // Forecast snapshot at time of dispensing
  estimatedDailyConsumption: number | null; // null if PRN or non-deterministic variable
  estimatedSupplyDays: number | null;
  estimatedSupplyEndDate: string | null; // YYYY-MM-DD
  forecastAssumptions: string;
  isPartialFill: boolean;
  calculationSource?: 'server_recomputed' | 'provisional_client_unverified';
  verificationStatus?: 'server_verified' | 'provisional_unverified';
  algorithmVersion?: string;
  clientEventUuid?: string;
  clientPayloadHash?: string;
  serverPayloadHash?: string;
  clientHashProvided?: boolean;
  clientServerHashMatched?: boolean;
  hashVerificationStatus?: DispensingHashVerificationStatus;
  rpcVersion?: 'v2' | 'legacy_0004';
  allergyOverrideSummary?: string;
  createdAt: string;
}

export type RefillStatus =
  | 'overdue'
  | 'due_soon'
  | 'upcoming'
  | 'on_track'
  | 'unable_to_estimate'
  | 'paused_or_prn';

export interface ScheduledOccurrence {
  date: string; // YYYY-MM-DD in Asia/Baghdad
  time24: string; // HH:mm in Asia/Baghdad
  isoBaghdad: string; // YYYY-MM-DDTHH:mm:00+03:00
  doseAmount: number;
  doseUnit: string;
  slotLabel?: string;
  medicationPlanId: string;
  regimenVersionNumber: number;
}

export interface RefillProjection {
  medicationPlanId: string;
  patientId: string;
  patientName: string;
  patientCode: string;
  medicationLabel: string;
  medicationStatus: MedicationPlanStatus;
  lastDispensedDate?: string;
  lastDispensedQuantity?: number;
  totalDispensedAnalyzed?: number;
  quantityUnit: string;
  estimatedDailyConsumption: number | null;
  estimatedRemainingUnits: number | null;
  estimatedDaysRemaining: number | null;
  estimatedSupplyEndDate: string | null;
  refillStatus: RefillStatus;
  uncertaintyNote: string;
}

// IMPORTANT: Patient-confirmed dose events are strictly separate from DispensingEvents.
// An unconfirmed dose is NEVER automatically marked 'skipped'.
export type DoseConfirmationStatus = 'pending_unconfirmed' | 'taken' | 'skipped_by_patient' | 'delayed';

export interface DoseEvent {
  id: string;
  patientId: string;
  medicationPlanId: string;
  regimenVersionNumber: number;
  scheduledDate: string; // YYYY-MM-DD
  scheduledTime24: string; // HH:mm
  plannedDoseAmount: number;
  doseUnit: string;
  status: DoseConfirmationStatus;
  confirmedAt?: string;
  patientNote?: string;
}

export interface LabResult {
  id: string;
  patientId: string;
  pharmacyId: string;
  testName: string;
  value: string;
  unit: string;
  referenceRange: string;
  isAbnormal: boolean;
  testDate: string; // YYYY-MM-DD
  notes?: string;
  recordedByStaffName: string;
}

export type FollowUpType = 'refill' | 'adherence' | 'clinical' | 'lab_review';
export type FollowUpStatus = 'pending' | 'completed' | 'overdue';
export type ContactOutcome = 'answered' | 'no_answer' | 'refill_confirmed' | 'appointment_scheduled' | 'message_sent';

export interface FollowUpContactLog {
  id: string;
  contactedAt: string;
  channel: 'whatsapp_manual' | 'phone_call' | 'in_pharmacy';
  outcome: ContactOutcome;
  summary: string;
  staffName: string;
}

export interface FollowUpTask {
  id: string;
  pharmacyId: string;
  patientId: string;
  relatedMedicationPlanId?: string;
  type: FollowUpType;
  dueDate: string; // YYYY-MM-DD
  status: FollowUpStatus;
  notes: string;
  assignedStaffName: string;
  contactHistory: FollowUpContactLog[];
  createdAt: string;
}

export type ConsultationStatus = 'open' | 'follow_up' | 'resolved';

export interface ConsultationMessage {
  id: string;
  senderType: 'patient' | 'pharmacist';
  senderStaffId?: string;
  senderName: string;
  body: string;
  sentAt: string; // ISO timestamp
  approvedByPharmacist?: boolean;
}

export interface ConsultationThread {
  id: string;
  pharmacyId: string;
  patientId: string;
  subject: string;
  status: ConsultationStatus;
  messages: ConsultationMessage[];
  updatedAt: string;
}

export type InvitationStatus = 'not_invited' | 'pending' | 'activated' | 'expired' | 'revoked';

export interface PatientApkInvitation {
  id: string;
  pharmacyId: string;
  patientId: string;
  status: InvitationStatus;
  // Stage 1 Mock fields ONLY — Stage 2 generates cryptographically signed single-use tokens server-side
  mockInviteCode: string;
  mockActivationUrl: string;
  issuedAt?: string;
  expiresAt?: string;
  activatedAt?: string;
  revokedAt?: string;
  issuedByStaffName?: string;
  identityVerificationMethod?: 'national_id_last4' | 'dob_and_phone_otp';
  deviceLabel?: string;
  // Stage 2B Connected fields (optional, populated only in Supabase mode)
  invitationPurpose?: 'initial_activation' | 'device_replacement_recovery';
  targetPhone?: string;
  singleUseTokenOnce?: string;
  pharmacistHandoverPinOnce?: string;
}

export interface AuditLogEntry {
  id: string;
  pharmacyId: string;
  timestamp: string;
  actorName: string;
  actorRole: StaffRole;
  action: string;
  entityType:
    | 'patient'
    | 'medication_plan'
    | 'dispensing'
    | 'follow_up'
    | 'consultation'
    | 'invitation'
    | 'lab_result';
  entityId: string;
  summaryAr: string;
  summaryEn: string;
}

export interface DashboardKpis {
  totalPatients: number;
  activeChronicPatients: number;
  activeMedicationPlans: number;
  refillsDueSoonCount: number;
  patientsRequiringFollowUp: number;
  todaysDispensingCount: number;
}

// ============================================================================
// FUTURE ANDROID APK & SUPABASE API CONTRACT TYPES (STAGE 2 SPECIFICATION)
// ============================================================================

export interface AndroidPatientSyncPayload {
  apiVersion: '1.0-draft';
  patientId: string;
  pharmacyId: string;
  timezone: 'Asia/Baghdad';
  syncedAt: string;
  activePlans: Array<{
    planId: string;
    versionNumber: number;
    brandName: string;
    genericName: string;
    strength: string;
    dosageForm: DosageForm;
    doseAmount: number;
    doseUnit: string;
    foodRelation: FoodRelation;
    verifiedInstructions: string;
    schedule: DoseSchedule;
    startDate: string;
    endDate?: string;
    isOngoing: boolean;
  }>;
}

export interface AndroidDoseConfirmationRequest {
  patientId: string;
  medicationPlanId: string;
  regimenVersionNumber: number;
  scheduledDate: string;
  scheduledTime24: string;
  status: Extract<DoseConfirmationStatus, 'taken' | 'skipped_by_patient' | 'delayed'>;
  confirmedAt: string;
  clientEventUuid: string; // idempotency key for offline sync deduplication
  patientNote?: string;
}
