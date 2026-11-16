import {
  DEMO_PHARMACY,
  DEMO_STAFF,
  INITIAL_AUDIT_LOGS,
  INITIAL_CONSULTATIONS,
  INITIAL_DISPENSING_EVENTS,
  INITIAL_DOSE_EVENTS,
  INITIAL_FOLLOWUPS,
  INITIAL_INVITATIONS,
  INITIAL_LAB_RESULTS,
  INITIAL_MEDICATION_PLANS,
  INITIAL_PATIENTS,
  MEDICATION_CATALOG,
} from '../data/seedData';
import { normalizeIraqiPhone } from '../i18n/translations';
import { getActiveBaghdadDateStr, getActiveClock } from './clockService';
import {
  AllergyOverrideAuthorization,
  AuditLogEntry,
  BackendSafetyCapabilities,
  ConsultationStatus,
  ConsultationThread,
  DashboardKpis,
  DispensingEvent,
  DoseConfirmationStatus,
  DoseEvent,
  FollowUpContactLog,
  FollowUpStatus,
  FollowUpTask,
  LabResult,
  Language,
  MedicationCatalogItem,
  MedicationCatalogLoadStatus,
  MedicationPlanStatus,
  Patient,
  PatientApkInvitation,
  PatientMedicationPlan,
  Pharmacy,
  PharmacyStaff,
  RefillProjection,
  RegimenVersion,
} from '../types/domain';
import {
  addDaysToDate,
  calculateDispensingForecast,
  computeRefillProjection,
} from './scheduleEngine';
import {
  assessMedicationAllergyRisk,
  computeDispensingPayloadHash,
  DispensingRefillSnapshotInput,
  toAllergyOverrideLevel,
  validateAllergyOverrideAuthorization,
  validateDispensingInput,
  validateMedicationEditAllowed,
  validateMedicationPlanInput,
  validateMedicationStatusTransition,
} from './clinicalSafety';

export interface CrmState {
  pharmacy: Pharmacy;
  staff: PharmacyStaff[];
  activeStaffId: string;
  patients: Patient[];
  medicationCatalog: MedicationCatalogItem[];
  catalogLoadStatus?: MedicationCatalogLoadStatus;
  catalogLoadError?: string;
  medicationPlans: PatientMedicationPlan[];
  dispensingEvents: DispensingEvent[];
  doseEvents: DoseEvent[];
  labResults: LabResult[];
  followUps: FollowUpTask[];
  consultations: ConsultationThread[];
  invitations: PatientApkInvitation[];
  auditLogs: AuditLogEntry[];
}

export type NewPatientInput = Omit<
  Patient,
  'id' | 'pharmacyId' | 'status' | 'archivedAt' | 'archivedReason'
>;
export type NewMedicationPlanInput = Omit<
  PatientMedicationPlan,
  'id' | 'pharmacyId' | 'currentVersionNumber' | 'regimenHistory' | 'createdAt' | 'updatedAt' | 'status'
>;
export type RecordDispensingInput = {
  patientId: string;
  medicationPlanId: string;
  dispensedQuantity: number;
  quantityUnit: string;
  packageCount?: number;
  packageSize?: number;
  batchNumber?: string;
  expiryDate?: string;
  dispensingDate: string;
  isPartialFill: boolean;
  notes?: string;
  expectedRegimenVersionNumber?: number;
  clientEventUuid?: string;
  clientPayloadHash?: string;
  allergyOverrideAuthorization?: AllergyOverrideAuthorization;
  refillSnapshot?: DispensingRefillSnapshotInput;
};
export type FollowUpInput = Omit<FollowUpTask, 'id' | 'pharmacyId' | 'createdAt' | 'contactHistory'>;
export type ContactLogInput = Omit<FollowUpContactLog, 'id' | 'contactedAt' | 'staffName'>;
export type LabResultInput = Omit<LabResult, 'id' | 'pharmacyId' | 'recordedByStaffName'>;
export type DoseUpdatePayload = { doseId: string; status: DoseConfirmationStatus; note?: string };
export type ConsultationReplyPayload = {
  threadId: string;
  body: string;
  newStatus?: ConsultationStatus;
};
export type FollowUpStatusPayload = { followUpId: string; status: FollowUpStatus };

/**
 * Stage 2 Integration Contract: Swappable repository interface so Supabase PostgreSQL + Auth + RLS
 * can replace InMemoryCrmAdapter in Stage 2 without modifying UI views or modals.
 */
export interface ICrmDataAdapter {
  readonly mode: 'in_memory_stage1' | 'supabase_stage2';
  getState(): CrmState;
  reset(): CrmState;
  setActiveStaff(staffId: string): CrmState;
  addPatient(data: NewPatientInput): { state: CrmState; patient: Patient };
  updatePatient(patientId: string, updates: Partial<Patient>): CrmState;
  archivePatient(patientId: string, reason: string, archivedDate?: string): CrmState;
  restorePatient(patientId: string): CrmState;
  addMedicationPlan(
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ): { state: CrmState; plan: PatientMedicationPlan };
  updateMedicationPlan(
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    effectiveDate?: string,
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ): CrmState;
  changeMedicationStatus(
    planId: string,
    status: MedicationPlanStatus,
    reason: string,
    effectiveDate?: string
  ): CrmState;
  recordDispensing(
    params: RecordDispensingInput,
    lang: Language
  ): { state: CrmState; event: DispensingEvent | null };
  updateDoseEventStatus(doseId: string, status: DoseConfirmationStatus, note?: string): CrmState;
  addLabResult(data: LabResultInput): CrmState;
  addFollowUp(data: FollowUpInput): CrmState;
  updateFollowUpStatus(followUpId: string, status: FollowUpStatus): CrmState;
  addFollowUpContactLog(followUpId: string, log: ContactLogInput): CrmState;
  sendConsultationReply(threadId: string, body: string, newStatus?: ConsultationStatus): CrmState;
  updateConsultationStatus(threadId: string, status: ConsultationStatus): CrmState;
  issueInvitation(
    patientId: string,
    method: 'national_id_last4' | 'dob_and_phone_otp',
    refDateStr?: string
  ): { state: CrmState; invitation: PatientApkInvitation | null };
  revokeInvitation(patientId: string): CrmState;
  simulateInvitationActivation(patientId: string): CrmState;
  simulateInvitationExpiry(patientId: string): CrmState;
}

export function createInitialCrmState(): CrmState {
  return {
    pharmacy: structuredClone(DEMO_PHARMACY),
    staff: structuredClone(DEMO_STAFF),
    activeStaffId: DEMO_STAFF[0].id,
    patients: structuredClone(INITIAL_PATIENTS),
    medicationCatalog: structuredClone(MEDICATION_CATALOG),
    catalogLoadStatus: 'demo',
    medicationPlans: structuredClone(INITIAL_MEDICATION_PLANS),
    dispensingEvents: structuredClone(INITIAL_DISPENSING_EVENTS),
    doseEvents: structuredClone(INITIAL_DOSE_EVENTS),
    labResults: structuredClone(INITIAL_LAB_RESULTS),
    followUps: structuredClone(INITIAL_FOLLOWUPS),
    consultations: structuredClone(INITIAL_CONSULTATIONS),
    invitations: structuredClone(INITIAL_INVITATIONS),
    auditLogs: structuredClone(INITIAL_AUDIT_LOGS),
  };
}

export interface DuplicatePatientMatch {
  codeConflict?: Patient;
  phoneConflict?: Patient;
  nameDobConflict?: Patient;
}

export function findDuplicatePatientMatch(
  patients: Patient[],
  candidate: { patientCode: string; phone: string; fullName: string; dateOfBirth: string },
  excludePatientId?: string
): DuplicatePatientMatch {
  const normCode = candidate.patientCode.trim().toLowerCase();
  const normPhone = normalizeIraqiPhone(candidate.phone);
  const normName = candidate.fullName.trim().toLowerCase().replace(/\s+/g, ' ');

  const match: DuplicatePatientMatch = {};
  for (const p of patients) {
    if (excludePatientId && p.id === excludePatientId) continue;
    if (!match.codeConflict && normCode && p.patientCode.trim().toLowerCase() === normCode) {
      match.codeConflict = p;
    }
    if (!match.phoneConflict && normPhone && normalizeIraqiPhone(p.phone) === normPhone) {
      match.phoneConflict = p;
    }
    if (
      !match.nameDobConflict &&
      normName &&
      candidate.dateOfBirth &&
      p.fullName.trim().toLowerCase().replace(/\s+/g, ' ') === normName &&
      p.dateOfBirth === candidate.dateOfBirth
    ) {
      match.nameDobConflict = p;
    }
  }
  return match;
}

export function findDuplicateActiveMedication(
  plans: PatientMedicationPlan[],
  patientId: string,
  genericName: string,
  strength: string,
  excludePlanId?: string
): PatientMedicationPlan | undefined {
  const normGeneric = genericName.trim().toLowerCase().replace(/\s+/g, ' ');
  const normStrength = strength.trim().toLowerCase().replace(/\s+/g, '');
  if (!normGeneric) return undefined;

  return plans.find(
    (m) =>
      m.patientId === patientId &&
      m.status === 'active' &&
      m.id !== excludePlanId &&
      m.genericName.trim().toLowerCase().replace(/\s+/g, ' ') === normGeneric &&
      m.strength.trim().toLowerCase().replace(/\s+/g, '') === normStrength
  );
}

export function findRecentDuplicateDispensing(
  events: DispensingEvent[],
  patientId: string,
  medicationPlanId: string,
  dispensingDate: string,
  dispensedQuantity: number
): DispensingEvent | undefined {
  return events.find(
    (d) =>
      d.patientId === patientId &&
      d.medicationPlanId === medicationPlanId &&
      d.dispensingDate === dispensingDate &&
      d.dispensedQuantity === dispensedQuantity
  );
}

export function computeAllRefillProjections(
  state: CrmState,
  lang: Language,
  refDateStr: string = getActiveBaghdadDateStr()
): RefillProjection[] {
  const activePatientsMap = new Map(
    state.patients.filter((p) => p.status === 'active').map((p) => [p.id, p])
  );
  const projections: RefillProjection[] = [];

  for (const plan of state.medicationPlans) {
    const patient = activePatientsMap.get(plan.patientId);
    if (!patient) continue;
    if (plan.status === 'discontinued' || plan.status === 'archived') continue;
    projections.push(
      computeRefillProjection(plan, patient, state.dispensingEvents, lang, refDateStr)
    );
  }

  return projections.sort((a, b) => {
    const rank = (s: RefillProjection['refillStatus']) =>
      s === 'overdue'
        ? 0
        : s === 'due_soon'
          ? 1
          : s === 'upcoming'
            ? 2
            : s === 'on_track'
              ? 3
              : s === 'unable_to_estimate'
                ? 4
                : 5;
    const diff = rank(a.refillStatus) - rank(b.refillStatus);
    if (diff !== 0) return diff;
    return (a.estimatedDaysRemaining ?? 9999) - (b.estimatedDaysRemaining ?? 9999);
  });
}

export function computeDashboardKpis(
  state: CrmState,
  lang: Language,
  refDateStr: string = getActiveBaghdadDateStr()
): DashboardKpis {
  const activePatients = state.patients.filter((p) => p.status === 'active');
  const activeChronicPatients = activePatients.filter((p) => p.chronicConditions.length > 0).length;
  const activePatientIds = new Set(activePatients.map((p) => p.id));

  const activeMedicationPlans = state.medicationPlans.filter(
    (m) => m.status === 'active' && activePatientIds.has(m.patientId)
  ).length;

  const refillProjections = computeAllRefillProjections(state, lang, refDateStr);
  const refillsDueSoonCount = refillProjections.filter(
    (r) => r.refillStatus === 'overdue' || r.refillStatus === 'due_soon'
  ).length;

  const followUpPatientIds = new Set(
    state.followUps
      .filter(
        (f) => (f.status === 'pending' || f.status === 'overdue') && activePatientIds.has(f.patientId)
      )
      .map((f) => f.patientId)
  );

  const todaysDispensingCount = state.dispensingEvents.filter(
    (d) => d.dispensingDate === refDateStr && activePatientIds.has(d.patientId)
  ).length;

  return {
    totalPatients: activePatients.length,
    activeChronicPatients,
    activeMedicationPlans,
    refillsDueSoonCount,
    patientsRequiringFollowUp: followUpPatientIds.size,
    todaysDispensingCount,
  };
}

/**
 * Generates an RFC 4122 v4 UUID compatible with PostgreSQL UUID primary keys (Audit Finding H2).
 */
export function generateEntityUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Stage 2 Asynchronous Repository Contract (Audit Finding H2):
 * Mirrors ICrmDataAdapter with Promise-based operations so network latency,
 * loading states, and remote database errors are handled without rewriting UI views.
 */
export const DEFAULT_DEMO_SAFETY_CAPABILITIES: BackendSafetyCapabilities = {
  stage: 'demo',
  supportsV2MedicationPlans: true,
  supportsV2DispensingIdempotency: true,
  enforcesServerCriticalAllergyOverride: true,
  enforcesServerAllergyUncertainty: true,
  legacy0004RpcsRetired: false,
  probeStatus: 'demo',
};

export interface IAsyncCrmRepository {
  readonly mode: 'in_memory_stage1' | 'supabase_stage2';
  getBackendCapabilitiesAsync?(forceRefresh?: boolean): Promise<BackendSafetyCapabilities>;
  refreshBackendCapabilitiesAsync?(): Promise<BackendSafetyCapabilities>;
  getStateAsync(): Promise<CrmState>;
  resetAsync(): Promise<CrmState>;
  setActiveStaffAsync(staffId: string): Promise<CrmState>;
  addPatientAsync(data: NewPatientInput): Promise<{ state: CrmState; patient: Patient }>;
  updatePatientAsync(patientId: string, updates: Partial<Patient>): Promise<CrmState>;
  archivePatientAsync(patientId: string, reason: string): Promise<CrmState>;
  restorePatientAsync(patientId: string): Promise<CrmState>;
  addMedicationPlanAsync(
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<{ state: CrmState; plan: PatientMedicationPlan }>;
  updateMedicationPlanAsync(
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    effectiveDate?: string,
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<CrmState>;
  changeMedicationStatusAsync(
    planId: string,
    status: MedicationPlanStatus,
    reason: string,
    effectiveDate?: string
  ): Promise<CrmState>;
  recordDispensingAsync(
    params: RecordDispensingInput,
    lang: Language
  ): Promise<{ state: CrmState; event: DispensingEvent | null }>;
  updateDoseEventStatusAsync(
    doseId: string,
    status: DoseConfirmationStatus,
    note?: string
  ): Promise<CrmState>;
  addLabResultAsync(data: LabResultInput): Promise<CrmState>;
  addFollowUpAsync(data: FollowUpInput): Promise<CrmState>;
  updateFollowUpStatusAsync(followUpId: string, status: FollowUpStatus): Promise<CrmState>;
  addFollowUpContactLogAsync(followUpId: string, log: ContactLogInput): Promise<CrmState>;
  sendConsultationReplyAsync(
    threadId: string,
    body: string,
    newStatus?: ConsultationStatus
  ): Promise<CrmState>;
  updateConsultationStatusAsync(threadId: string, status: ConsultationStatus): Promise<CrmState>;
  issueInvitationAsync(
    patientId: string,
    method: 'national_id_last4' | 'dob_and_phone_otp',
    refDateStr?: string
  ): Promise<{ state: CrmState; invitation: PatientApkInvitation | null }>;
  revokeInvitationAsync(patientId: string, reason?: string): Promise<CrmState>;
}

export function createAuditEntry(
  state: CrmState,
  partial: Omit<AuditLogEntry, 'id' | 'pharmacyId' | 'timestamp' | 'actorName' | 'actorRole'>
): AuditLogEntry {
  const actor = state.staff.find((s) => s.id === state.activeStaffId) ?? state.staff[0];
  return {
    id: generateEntityUuid(),
    pharmacyId: state.pharmacy.id,
    timestamp: new Date().toISOString(),
    actorName: actor.fullName,
    actorRole: actor.role,
    ...partial,
  };
}

export function buildNewMedicationPlanWithVersion(
  input: NewMedicationPlanInput,
  staffName: string
): PatientMedicationPlan {
  const nowIso = new Date().toISOString();
  const initialVersion: RegimenVersion = {
    versionNumber: 1,
    effectiveFrom: input.startDate,
    doseAmount: input.doseAmount,
    doseUnit: input.doseUnit,
    foodRelation: input.foodRelation,
    verifiedInstructions: input.verifiedInstructions,
    schedule: structuredClone(input.schedule),
    changedByStaffName: staffName,
    changeReason: 'خطة علاجية جديدة موثقة من الصيدلي / Initial pharmacist-verified plan',
    createdAt: nowIso,
  };

  return {
    ...input,
    id: generateEntityUuid(),
    pharmacyId: DEMO_PHARMACY.id,
    status: 'active',
    currentVersionNumber: 1,
    regimenHistory: [initialVersion],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function buildUpdatedMedicationPlanVersion(
  existing: PatientMedicationPlan,
  updates: NewMedicationPlanInput,
  staffName: string,
  changeReason: string,
  effectiveDate: string = getActiveBaghdadDateStr()
): PatientMedicationPlan {
  const nowIso = new Date().toISOString();
  const nextVer = existing.currentVersionNumber + 1;

    const closedHistory = existing.regimenHistory.map((v, idx) =>
    idx === existing.regimenHistory.length - 1 && !v.effectiveTo
      ? { ...structuredClone(v), effectiveTo: effectiveDate }
      : structuredClone(v)
  );

  const newVersion: RegimenVersion = {
    versionNumber: nextVer,
    effectiveFrom: effectiveDate,
    doseAmount: updates.doseAmount,
    doseUnit: updates.doseUnit,
    foodRelation: updates.foodRelation,
    verifiedInstructions: updates.verifiedInstructions,
    schedule: structuredClone(updates.schedule),
    changedByStaffName: staffName,
    changeReason: changeReason || 'تحديث الجرعة أو الجدول الزمني / Regimen adjustment',
    createdAt: nowIso,
  };

  return {
    ...existing,
    ...updates,
    currentVersionNumber: nextVer,
    regimenHistory: [...closedHistory, newVersion],
    updatedAt: nowIso,
  };
}

export function buildDispensingEventRecord(
  state: CrmState,
  params: Omit<RecordDispensingInput, 'medicationPlanId'> & { medicationPlan: PatientMedicationPlan },
  lang: Language
): DispensingEvent {
  if (!Number.isFinite(params.dispensedQuantity) || params.dispensedQuantity <= 0) {
    throw new Error('Dispensed quantity must be a finite number greater than zero.');
  }
  const staff = state.staff.find((s) => s.id === state.activeStaffId) ?? state.staff[0];
  const forecast = calculateDispensingForecast(
    params.medicationPlan,
    params.dispensedQuantity,
    params.dispensingDate,
    lang,
    params.quantityUnit
  );
  const payloadHash =
    params.clientPayloadHash ??
    computeDispensingPayloadHash({
      patientId: params.patientId,
      medicationPlanId: params.medicationPlan.id,
      dispensedQuantity: params.dispensedQuantity,
      quantityUnit: params.quantityUnit,
      packageCount: params.packageCount,
      packageSize: params.packageSize,
      batchNumber: params.batchNumber,
      expiryDate: params.expiryDate,
      dispensingDate: params.dispensingDate,
      isPartialFill: params.isPartialFill,
      notes: params.notes,
      expectedRegimenVersionNumber:
        params.expectedRegimenVersionNumber ?? params.medicationPlan.currentVersionNumber,
      allergyOverrideAuthorization: params.allergyOverrideAuthorization,
      refillSnapshot: params.refillSnapshot,
    });
  const overrideSummary =
    params.allergyOverrideAuthorization?.prescriberName?.trim()
      ? `${params.allergyOverrideAuthorization.authorizationSource ?? 'override'}: ${params.allergyOverrideAuthorization.prescriberName.trim()} — ${params.allergyOverrideAuthorization.clinicalJustification?.trim() ?? ''}`
      : params.allergyOverrideAuthorization?.clinicalJustification?.trim()
        ? `clinical_review: ${params.allergyOverrideAuthorization.clinicalJustification.trim()}`
        : undefined;

  return {
    id: generateEntityUuid(),
    pharmacyId: state.pharmacy.id,
    patientId: params.patientId,
    medicationPlanId: params.medicationPlan.id,
    regimenVersionNumber: params.medicationPlan.currentVersionNumber,
    dispensedQuantity: params.dispensedQuantity,
    quantityUnit: params.quantityUnit,
    packageCount: params.packageCount,
    packageSize: params.packageSize,
    batchNumber: params.batchNumber,
    expiryDate: params.expiryDate,
    dispensingDate: params.dispensingDate,
    dispensedByStaffId: staff.id,
    dispensedByStaffName: staff.fullName,
    notes: params.notes,
    estimatedDailyConsumption: forecast.estimatedDailyConsumption,
    estimatedSupplyDays: forecast.estimatedSupplyDays,
    estimatedSupplyEndDate: forecast.estimatedSupplyEndDate,
    forecastAssumptions: forecast.assumptionsText,
    isPartialFill: params.isPartialFill,
    clientEventUuid: params.clientEventUuid,
    clientPayloadHash: payloadHash,
    allergyOverrideSummary: overrideSummary,
    createdAt: new Date().toISOString(),
  };
}

export function buildMockInvitation(
  state: CrmState,
  patient: Patient,
  method: 'national_id_last4' | 'dob_and_phone_otp',
  refDateStr?: string
): PatientApkInvitation {
  const staff = state.staff.find((s) => s.id === state.activeStaffId) ?? state.staff[0];
  const suffix = Math.floor(1000 + Math.random() * 9000);
  const code = `DEMO-${patient.patientCode.replace(/[^A-Z0-9]/gi, '')}-${suffix}`;
  const clock = getActiveClock();
  const baseDate = refDateStr ?? clock.todayDateStr();
  const timePart = clock.currentTimeStr();
  const issuedIso = `${baseDate}T${timePart}:00+03:00`;
  const expiresDate = addDaysToDate(baseDate, 7);

  return {
    id: generateEntityUuid(),
    pharmacyId: state.pharmacy.id,
    patientId: patient.id,
    status: 'pending',
    mockInviteCode: code,
    mockActivationUrl: `https://masarcare.example.iq/activate?demoCode=${code}`,
    issuedAt: issuedIso,
    expiresAt: `${expiresDate}T12:00:00+03:00`,
    issuedByStaffName: staff.fullName,
    identityVerificationMethod: method,
  };
}

/**
 * Stage 1 in-memory repository implementing ICrmDataAdapter.
 * Never persists clinical data to browser localStorage.
 */
export class InMemoryCrmAdapter implements ICrmDataAdapter {
  public readonly mode = 'in_memory_stage1' as const;
  private state: CrmState;

  constructor(initialState?: CrmState) {
    this.state = initialState ?? createInitialCrmState();
  }

  public getState(): CrmState {
    return this.state;
  }

  public setState(nextState: CrmState): CrmState {
    this.state = nextState;
    return this.state;
  }

  public reset(): CrmState {
    this.state = createInitialCrmState();
    return this.state;
  }

  private getActiveStaff(): PharmacyStaff {
    return this.state.staff.find((s) => s.id === this.state.activeStaffId) ?? this.state.staff[0];
  }

  public setActiveStaff(staffId: string): CrmState {
    if (!this.state.staff.some((s) => s.id === staffId)) return this.state;
    this.state = { ...this.state, activeStaffId: staffId };
    return this.state;
  }

  public addPatient(data: NewPatientInput): { state: CrmState; patient: Patient } {
    const normalizedPhone = normalizeIraqiPhone(data.phone);
    const newPatient: Patient = {
      ...data,
      phone: normalizedPhone,
      phoneOwnerType: data.phoneOwnerType ?? 'self',
      id: generateEntityUuid(),
      pharmacyId: this.state.pharmacy.id,
      status: 'active',
    };
    const audit = createAuditEntry(this.state, {
      action: 'PATIENT_REGISTERED',
      entityType: 'patient',
      entityId: newPatient.id,
      summaryAr: `تسجيل المراجع الجديد ${newPatient.fullName} (${newPatient.patientCode})`,
      summaryEn: `Registered new patient ${newPatient.fullName} (${newPatient.patientCode})`,
    });
    this.state = {
      ...this.state,
      patients: [newPatient, ...this.state.patients],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return { state: this.state, patient: newPatient };
  }

  public updatePatient(patientId: string, updates: Partial<Patient>): CrmState {
    const target = this.state.patients.find((p) => p.id === patientId);
    if (!target) return this.state;
    const sanitizedUpdates = updates.phone
      ? { ...updates, phone: normalizeIraqiPhone(updates.phone) }
      : updates;
    const updated = this.state.patients.map((p) =>
      p.id === patientId ? { ...p, ...sanitizedUpdates } : p
    );
    const audit = createAuditEntry(this.state, {
      action: 'PATIENT_UPDATED',
      entityType: 'patient',
      entityId: patientId,
      summaryAr: `تحديث بيانات المراجع ${updates.fullName ?? target.fullName}`,
      summaryEn: `Updated patient profile for ${updates.fullName ?? target.fullName}`,
    });
    this.state = { ...this.state, patients: updated, auditLogs: [audit, ...this.state.auditLogs] };
    return this.state;
  }

  public archivePatient(
    patientId: string,
    reason: string,
    archivedDate: string = getActiveBaghdadDateStr()
  ): CrmState {
    const target = this.state.patients.find((p) => p.id === patientId);
    if (!target) return this.state;
    const updated = this.state.patients.map((p) =>
      p.id === patientId
        ? {
            ...p,
            status: 'archived' as const,
            archivedAt: archivedDate,
            archivedReason: reason,
          }
        : p
    );
    const audit = createAuditEntry(this.state, {
      action: 'PATIENT_ARCHIVED',
      entityType: 'patient',
      entityId: patientId,
      summaryAr: `أرشفة ملف المراجع ${target.fullName} مع حفظ السجل`,
      summaryEn: `Archived patient ${target.fullName} (clinical history preserved)`,
    });
    this.state = { ...this.state, patients: updated, auditLogs: [audit, ...this.state.auditLogs] };
    return this.state;
  }

  public restorePatient(patientId: string): CrmState {
    const target = this.state.patients.find((p) => p.id === patientId);
    if (!target) return this.state;
    const updated = this.state.patients.map((p) =>
      p.id === patientId
        ? { ...p, status: 'active' as const, archivedAt: undefined, archivedReason: undefined }
        : p
    );
    const audit = createAuditEntry(this.state, {
      action: 'PATIENT_RESTORED',
      entityType: 'patient',
      entityId: patientId,
      summaryAr: `إعادة تفعيل ملف المراجع ${target.fullName}`,
      summaryEn: `Restored patient profile for ${target.fullName}`,
    });
    this.state = { ...this.state, patients: updated, auditLogs: [audit, ...this.state.auditLogs] };
    return this.state;
  }

  public addMedicationPlan(
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ): { state: CrmState; plan: PatientMedicationPlan } {
    const patient = this.state.patients.find((p) => p.id === data.patientId);
    if (!patient) {
      throw new Error('Cannot add medication plan: patient was not found.');
    }
    if (patient.status !== 'active') {
      throw new Error('Cannot add medication plan for an archived patient.');
    }
    const validation = validateMedicationPlanInput(data, 'en');
    if (!validation.valid) {
      throw new Error(validation.errors[0]);
    }
    const catalogRecord = data.catalogId
      ? this.state.medicationCatalog.find((c) => c.id === data.catalogId)
      : undefined;
    const allergyAssessment = assessMedicationAllergyRisk(
      patient,
      {
        catalogId: data.catalogId,
        catalogRecord,
        brandName: data.brandName,
        genericName: data.genericName,
        strength: data.strength,
      },
      'en'
    );
    if (allergyAssessment.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        allergyOverride,
        'en'
      );
      if (!overrideCheck.valid) {
        throw new Error(overrideCheck.errors[0]);
      }
    }

    const staff = this.getActiveStaff();
    const newPlan = buildNewMedicationPlanWithVersion(data, staff.fullName);
    const overrideSuffixAr =
      allergyAssessment.requiresDocumentedOverride && allergyOverride?.prescriberName
        ? ` [تجاوز حساسية حرج موثق بتفويض: ${allergyOverride.prescriberName.trim()}]`
        : '';
    const overrideSuffixEn =
      allergyAssessment.requiresDocumentedOverride && allergyOverride?.prescriberName
        ? ` [Critical allergy override authorized by: ${allergyOverride.prescriberName.trim()} (${allergyOverride.authorizationSource ?? 'verified'})]`
        : '';

    const audit = createAuditEntry(this.state, {
      action: 'MEDICATION_PLAN_ADDED',
      entityType: 'medication_plan',
      entityId: newPlan.id,
      summaryAr: `إضافة خطة علاجية (${newPlan.brandName} ${newPlan.strength}) للمراجع ${patient?.fullName ?? ''}${overrideSuffixAr}`,
      summaryEn: `Added medication plan (${newPlan.brandName} ${newPlan.strength}) for ${patient?.fullName ?? ''}${overrideSuffixEn}`,
    });
    this.state = {
      ...this.state,
      medicationPlans: [newPlan, ...this.state.medicationPlans],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return { state: this.state, plan: newPlan };
  }

  public updateMedicationPlan(
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    effectiveDate: string = getActiveBaghdadDateStr(),
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ): CrmState {
    const existing = this.state.medicationPlans.find((m) => m.id === planId);
    if (!existing) return this.state;
    const editCheck = validateMedicationEditAllowed(existing, 'en', expectedVersionNumber);
    if (!editCheck.allowed) {
      throw new Error(editCheck.error);
    }
    const validation = validateMedicationPlanInput(updates, 'en');
    if (!validation.valid) {
      throw new Error(validation.errors[0]);
    }
    const patient = this.state.patients.find((p) => p.id === existing.patientId);
    const catalogRecord = updates.catalogId
      ? this.state.medicationCatalog.find((c) => c.id === updates.catalogId)
      : undefined;
    const allergyAssessment = patient
      ? assessMedicationAllergyRisk(
          patient,
          {
            catalogId: updates.catalogId,
            catalogRecord,
            brandName: updates.brandName,
            genericName: updates.genericName,
            strength: updates.strength,
          },
          'en'
        )
      : null;
    if (allergyAssessment?.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        allergyOverride,
        'en'
      );
      if (!overrideCheck.valid) {
        throw new Error(overrideCheck.errors[0]);
      }
    }

    const staff = this.getActiveStaff();
    const nextPlan = buildUpdatedMedicationPlanVersion(
      existing,
      updates,
      staff.fullName,
      changeReason,
      effectiveDate
    );
    const overrideSuffixAr =
      allergyAssessment?.requiresDocumentedOverride && allergyOverride?.prescriberName
        ? ` [تجاوز حساسية حرج موثق بتفويض: ${allergyOverride.prescriberName.trim()}]`
        : '';
    const overrideSuffixEn =
      allergyAssessment?.requiresDocumentedOverride && allergyOverride?.prescriberName
        ? ` [Critical allergy override authorized by: ${allergyOverride.prescriberName.trim()}]`
        : '';

    const audit = createAuditEntry(this.state, {
      action: 'REGIMEN_VERSION_CREATED',
      entityType: 'medication_plan',
      entityId: planId,
      summaryAr: `تعديل خطة ${nextPlan.brandName} وحفظ النسخة رقم ${nextPlan.currentVersionNumber}${overrideSuffixAr}`,
      summaryEn: `Updated ${nextPlan.brandName} plan (preserved version #${nextPlan.currentVersionNumber})${overrideSuffixEn}`,
    });
    this.state = {
      ...this.state,
      medicationPlans: this.state.medicationPlans.map((m) => (m.id === planId ? nextPlan : m)),
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public changeMedicationStatus(
    planId: string,
    status: MedicationPlanStatus,
    reason: string,
    effectiveDate: string = getActiveBaghdadDateStr()
  ): CrmState {
    const existing = this.state.medicationPlans.find((m) => m.id === planId);
    if (!existing) return this.state;
    const transitionCheck = validateMedicationStatusTransition(
      existing.status,
      status,
      reason,
      'en'
    );
    if (!transitionCheck.allowed) {
      throw new Error(transitionCheck.error);
    }

    const updated = this.state.medicationPlans.map((m) => {
      if (m.id !== planId) return m;
      const priorPeriods = [...(m.pausePeriods ?? [])];
      let nextPausePeriods = priorPeriods;

      if (status === 'paused') {
        const hasOpenPause = priorPeriods.some((p) => !p.resumedAt);
        if (!hasOpenPause) {
          nextPausePeriods = [...priorPeriods, { pausedFrom: effectiveDate, reason }];
        }
      } else if (status === 'active') {
        nextPausePeriods = priorPeriods
          .map((p) => (!p.resumedAt ? { ...p, resumedAt: effectiveDate } : p))
          .filter((p) => !p.resumedAt || p.pausedFrom < p.resumedAt);
      }

      return {
        ...m,
        status,
        statusChangedAt: status === 'active' ? undefined : effectiveDate,
        statusChangeReason: reason,
        pausePeriods: nextPausePeriods,
        updatedAt: new Date().toISOString(),
      };
    });
    const audit = createAuditEntry(this.state, {
      action: 'MEDICATION_STATUS_CHANGED',
      entityType: 'medication_plan',
      entityId: planId,
      summaryAr: `تغيير حالة ${existing.brandName} إلى (${status})`,
      summaryEn: `Changed status of ${existing.brandName} to ${status}`,
    });
    this.state = {
      ...this.state,
      medicationPlans: updated,
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public recordDispensing(
    params: RecordDispensingInput,
    lang: Language
  ): { state: CrmState; event: DispensingEvent | null } {
    const patient = this.state.patients.find((p) => p.id === params.patientId);
    const plan = this.state.medicationPlans.find(
      (m) => m.id === params.medicationPlanId && m.patientId === params.patientId
    );
    const resolvedExpectedVersion =
      params.expectedRegimenVersionNumber ?? plan?.currentVersionNumber;
    const incomingPayloadHash =
      params.clientPayloadHash ??
      computeDispensingPayloadHash({
        ...params,
        expectedRegimenVersionNumber: resolvedExpectedVersion,
      });
    if (params.clientEventUuid) {
      const existingDuplicate = this.state.dispensingEvents.find(
        (d) => d.clientEventUuid === params.clientEventUuid
      );
      if (existingDuplicate) {
        const existingHash =
          existingDuplicate.clientPayloadHash ??
          computeDispensingPayloadHash({
            patientId: existingDuplicate.patientId,
            medicationPlanId: existingDuplicate.medicationPlanId,
            dispensedQuantity: existingDuplicate.dispensedQuantity,
            quantityUnit: existingDuplicate.quantityUnit,
            packageCount: existingDuplicate.packageCount,
            packageSize: existingDuplicate.packageSize,
            batchNumber: existingDuplicate.batchNumber,
            expiryDate: existingDuplicate.expiryDate,
            dispensingDate: existingDuplicate.dispensingDate,
            isPartialFill: existingDuplicate.isPartialFill,
            notes: existingDuplicate.notes,
            expectedRegimenVersionNumber: existingDuplicate.regimenVersionNumber,
          });
        if (existingHash !== incomingPayloadHash) {
          throw new Error(
            lang === 'ar'
              ? 'تعارض عدم التكرار: تم إعادة استخدام معرف العملية (clientEventUuid) مع تفاصيل صرف مختلفة.'
              : 'Idempotency conflict: clientEventUuid was reused with modified dispensing details.'
          );
        }
        return { state: this.state, event: existingDuplicate };
      }
    }
    if (!plan || !patient) return { state: this.state, event: null };
    if (!Number.isFinite(params.dispensedQuantity) || params.dispensedQuantity <= 0) {
      return { state: this.state, event: null };
    }
    const validation = validateDispensingInput(params, lang, {
      patient,
      plan,
      allowIncompatibleUnit: false,
    });
    if (!validation.valid) {
      throw new Error(validation.errors[0]);
    }
    const catalogRecord = plan.catalogId
      ? this.state.medicationCatalog.find((c) => c.id === plan.catalogId)
      : undefined;
    const allergyAssessment = assessMedicationAllergyRisk(
      patient,
      {
        catalogId: plan.catalogId,
        catalogRecord,
        brandName: plan.brandName,
        genericName: plan.genericName,
        strength: plan.strength,
      },
      lang
    );
    if (allergyAssessment.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        params.allergyOverrideAuthorization,
        lang
      );
      if (!overrideCheck.valid) {
        throw new Error(overrideCheck.errors[0]);
      }
    }

    const normalizedOverride =
      allergyAssessment.requiresPharmacistAcknowledgment && params.allergyOverrideAuthorization
        ? {
            ...params.allergyOverrideAuthorization,
            level: toAllergyOverrideLevel(allergyAssessment.level),
          }
        : params.allergyOverrideAuthorization;

    const event = buildDispensingEventRecord(
      this.state,
      {
        ...params,
        expectedRegimenVersionNumber: resolvedExpectedVersion,
        allergyOverrideAuthorization: normalizedOverride,
        clientPayloadHash: incomingPayloadHash,
        medicationPlan: plan,
      },
      lang
    );
    const overrideSuffixAr =
      allergyAssessment.requiresDocumentedOverride &&
      params.allergyOverrideAuthorization?.prescriberName
        ? ` [تجاوز حساسية حرج موثق: ${params.allergyOverrideAuthorization.prescriberName.trim()}]`
        : allergyAssessment.requiresDocumentedReview &&
            params.allergyOverrideAuthorization?.clinicalJustification
          ? ' [مراجعة سريرية موثقة لعدم اليقين الدوائي]'
          : '';
    const overrideSuffixEn =
      allergyAssessment.requiresDocumentedOverride &&
      params.allergyOverrideAuthorization?.prescriberName
        ? ` [Critical allergy override: ${params.allergyOverrideAuthorization.prescriberName.trim()}]`
        : allergyAssessment.requiresDocumentedReview &&
            params.allergyOverrideAuthorization?.clinicalJustification
          ? ' [Documented allergy uncertainty review]'
          : '';

    const audit = createAuditEntry(this.state, {
      action: 'DISPENSE_RECORDED',
      entityType: 'dispensing',
      entityId: event.id,
      summaryAr: `صرف ${event.dispensedQuantity} ${event.quantityUnit} من ${plan.brandName} للمراجع ${patient?.fullName ?? ''}${overrideSuffixAr}`,
      summaryEn: `Dispensed ${event.dispensedQuantity} ${event.quantityUnit} of ${plan.brandName} to ${patient?.fullName ?? ''}${overrideSuffixEn}`,
    });
    this.state = {
      ...this.state,
      dispensingEvents: [event, ...this.state.dispensingEvents],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return { state: this.state, event };
  }

  public updateDoseEventStatus(
    doseId: string,
    status: DoseConfirmationStatus,
    note?: string
  ): CrmState {
    this.state = {
      ...this.state,
      doseEvents: this.state.doseEvents.map((d) =>
        d.id === doseId
          ? {
              ...d,
              status,
              confirmedAt:
                status === 'pending_unconfirmed' ? undefined : new Date().toISOString(),
              patientNote: note ?? d.patientNote,
            }
          : d
      ),
    };
    return this.state;
  }

  public addLabResult(data: LabResultInput): CrmState {
    const staff = this.getActiveStaff();
    const newLab: LabResult = {
      ...data,
      id: generateEntityUuid(),
      pharmacyId: this.state.pharmacy.id,
      recordedByStaffName: staff.fullName,
    };
    const audit = createAuditEntry(this.state, {
      action: 'LAB_RESULT_RECORDED',
      entityType: 'lab_result',
      entityId: newLab.id,
      summaryAr: `تسجيل نتيجة تحليل ${newLab.testName}: ${newLab.value} ${newLab.unit}`,
      summaryEn: `Recorded lab result ${newLab.testName}: ${newLab.value} ${newLab.unit}`,
    });
    this.state = {
      ...this.state,
      labResults: [newLab, ...this.state.labResults],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public addFollowUp(data: FollowUpInput): CrmState {
    const newTask: FollowUpTask = {
      ...data,
      id: generateEntityUuid(),
      pharmacyId: this.state.pharmacy.id,
      contactHistory: [],
      createdAt: new Date().toISOString(),
    };
    const patient = this.state.patients.find((p) => p.id === data.patientId);
    const audit = createAuditEntry(this.state, {
      action: 'FOLLOWUP_CREATED',
      entityType: 'follow_up',
      entityId: newTask.id,
      summaryAr: `إنشاء مهمة متابعة للمراجع ${patient?.fullName ?? ''} بتاريخ ${newTask.dueDate}`,
      summaryEn: `Created follow-up task for ${patient?.fullName ?? ''} due ${newTask.dueDate}`,
    });
    this.state = {
      ...this.state,
      followUps: [newTask, ...this.state.followUps],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public updateFollowUpStatus(followUpId: string, status: FollowUpStatus): CrmState {
    this.state = {
      ...this.state,
      followUps: this.state.followUps.map((f) => (f.id === followUpId ? { ...f, status } : f)),
    };
    return this.state;
  }

  public addFollowUpContactLog(followUpId: string, log: ContactLogInput): CrmState {
    const staff = this.getActiveStaff();
    const entry: FollowUpContactLog = {
      ...log,
      id: generateEntityUuid(),
      contactedAt: new Date().toISOString(),
      staffName: staff.fullName,
    };
    this.state = {
      ...this.state,
      followUps: this.state.followUps.map((f) =>
        f.id === followUpId ? { ...f, contactHistory: [entry, ...f.contactHistory] } : f
      ),
    };
    return this.state;
  }

  public sendConsultationReply(
    threadId: string,
    body: string,
    newStatus?: ConsultationStatus
  ): CrmState {
    const trimmed = body.trim();
    if (!trimmed) return this.state;
    const staff = this.getActiveStaff();
    const nowIso = new Date().toISOString();
    const updated = this.state.consultations.map((c) => {
      if (c.id !== threadId) return c;
      return {
        ...c,
        status: newStatus ?? c.status,
        updatedAt: nowIso,
        messages: [
          ...c.messages,
          {
            id: generateEntityUuid(),
            senderType: 'pharmacist' as const,
            senderStaffId: staff.id,
            senderName: staff.fullName,
            body: trimmed,
            sentAt: nowIso,
            approvedByPharmacist: true,
          },
        ],
      };
    });
    const audit = createAuditEntry(this.state, {
      action: 'CONSULTATION_REPLIED',
      entityType: 'consultation',
      entityId: threadId,
      summaryAr: 'إرسال رد صيدلاني معتمد على استشارة المراجع',
      summaryEn: 'Pharmacist-approved consultation reply sent',
    });
    this.state = {
      ...this.state,
      consultations: updated,
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public updateConsultationStatus(threadId: string, status: ConsultationStatus): CrmState {
    this.state = {
      ...this.state,
      consultations: this.state.consultations.map((c) => (c.id === threadId ? { ...c, status } : c)),
    };
    return this.state;
  }

  public issueInvitation(
    patientId: string,
    method: 'national_id_last4' | 'dob_and_phone_otp',
    refDateStr: string = getActiveBaghdadDateStr()
  ): { state: CrmState; invitation: PatientApkInvitation | null } {
    const patient = this.state.patients.find((p) => p.id === patientId && p.status === 'active');
    if (!patient) return { state: this.state, invitation: null };

    const prior = this.state.invitations.find((i) => i.patientId === patientId);
    const inv = buildMockInvitation(this.state, patient, method, refDateStr);
    const others = this.state.invitations.filter((i) => i.patientId !== patientId);

    const action =
      prior?.status === 'activated'
        ? 'INVITATION_REPLACED_ACTIVATED'
        : prior?.status === 'pending'
          ? 'INVITATION_REISSUED_SUPERSEDED'
          : 'INVITATION_ISSUED';

    const summaryAr =
      prior?.status === 'activated'
        ? `استبدال جهاز مُفعّل وإصدار دعوة تفعيل تجريبية جديدة للمراجع ${patient.fullName}`
        : prior?.status === 'pending'
          ? `إلغاء الدعوة المعلقة السابقة وإصدار دعوة تجريبية جديدة للمراجع ${patient.fullName}`
          : `إصدار دعوة تفعيل تجريبية للمراجع ${patient.fullName}`;

    const summaryEn =
      prior?.status === 'activated'
        ? `Replaced activated device and issued new mock APK invitation for ${patient.fullName}`
        : prior?.status === 'pending'
          ? `Superseded pending invitation and re-issued mock APK invitation for ${patient.fullName}`
          : `Issued mock APK invitation for ${patient.fullName}`;

    const audit = createAuditEntry(this.state, {
      action,
      entityType: 'invitation',
      entityId: inv.id,
      summaryAr,
      summaryEn,
    });

    this.state = {
      ...this.state,
      invitations: [inv, ...others],
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return { state: this.state, invitation: inv };
  }

  public revokeInvitation(patientId: string): CrmState {
    const patient = this.state.patients.find((p) => p.id === patientId);
    const target = this.state.invitations.find((i) => i.patientId === patientId);
    if (!target || target.status !== 'pending') return this.state;

    const updated = this.state.invitations.map((i) =>
      i.patientId === patientId
        ? { ...i, status: 'revoked' as const, revokedAt: new Date().toISOString() }
        : i
    );
    const audit = createAuditEntry(this.state, {
      action: 'INVITATION_REVOKED',
      entityType: 'invitation',
      entityId: target.id,
      summaryAr: `إلغاء دعوة تطبيق المريض للمراجع ${patient?.fullName ?? ''}`,
      summaryEn: `Revoked APK invitation for ${patient?.fullName ?? ''}`,
    });
    this.state = {
      ...this.state,
      invitations: updated,
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public simulateInvitationActivation(patientId: string): CrmState {
    const target = this.state.invitations.find((i) => i.patientId === patientId);
    // Only pending invitations can be redeemed/activated
    if (!target || target.status !== 'pending') return this.state;

    const patient = this.state.patients.find((p) => p.id === patientId);
    const updated = this.state.invitations.map((i) =>
      i.patientId === patientId
        ? {
            ...i,
            status: 'activated' as const,
            activatedAt: new Date().toISOString(),
            deviceLabel: 'Android Device (Stage 1 Simulation)',
          }
        : i
    );
    const audit = createAuditEntry(this.state, {
      action: 'INVITATION_ACTIVATED_SIMULATION',
      entityType: 'invitation',
      entityId: target.id,
      summaryAr: `محاكاة تفعيل دعوة المراجع ${patient?.fullName ?? ''}`,
      summaryEn: `Simulated APK invitation activation for ${patient?.fullName ?? ''}`,
    });
    this.state = {
      ...this.state,
      invitations: updated,
      auditLogs: [audit, ...this.state.auditLogs],
    };
    return this.state;
  }

  public simulateInvitationExpiry(patientId: string): CrmState {
    const target = this.state.invitations.find((i) => i.patientId === patientId);
    if (!target || target.status !== 'pending') return this.state;
    this.state = {
      ...this.state,
      invitations: this.state.invitations.map((i) =>
        i.patientId === patientId ? { ...i, status: 'expired' as const } : i
      ),
    };
    return this.state;
  }
}

/**
 * Asynchronous repository adapter (Audit Finding H2).
 * Wraps any ICrmDataAdapter in Promise-returning methods with configurable simulated latency
 * and error injection for testing async loading/failure boundaries before live Supabase connection.
 */
export class AsyncInMemoryCrmRepository implements IAsyncCrmRepository {
  public readonly mode = 'in_memory_stage1' as const;
  private readonly syncAdapter: InMemoryCrmAdapter;
  private readonly latencyMs: number;
  private nextError: Error | null = null;

  constructor(syncAdapter?: InMemoryCrmAdapter, latencyMs = 0) {
    this.syncAdapter = syncAdapter ?? new InMemoryCrmAdapter();
    this.latencyMs = latencyMs;
  }

  public injectNextError(error: Error): void {
    this.nextError = error;
  }

  private async runAsync<T>(fn: () => T): Promise<T> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    return fn();
  }

  public getBackendCapabilitiesAsync(
    _forceRefresh = false
  ): Promise<BackendSafetyCapabilities> {
    return this.runAsync(() => ({
      ...DEFAULT_DEMO_SAFETY_CAPABILITIES,
      checkedAt: new Date().toISOString(),
    }));
  }

  public refreshBackendCapabilitiesAsync(): Promise<BackendSafetyCapabilities> {
    return this.getBackendCapabilitiesAsync(true);
  }

  public getStateAsync(): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.getState());
  }

  public resetAsync(): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.reset());
  }

  public setActiveStaffAsync(staffId: string): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.setActiveStaff(staffId));
  }

  public addPatientAsync(data: NewPatientInput): Promise<{ state: CrmState; patient: Patient }> {
    return this.runAsync(() => this.syncAdapter.addPatient(data));
  }

  public updatePatientAsync(patientId: string, updates: Partial<Patient>): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.updatePatient(patientId, updates));
  }

  public archivePatientAsync(patientId: string, reason: string): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.archivePatient(patientId, reason));
  }

  public restorePatientAsync(patientId: string): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.restorePatient(patientId));
  }

  public addMedicationPlanAsync(
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<{ state: CrmState; plan: PatientMedicationPlan }> {
    return this.runAsync(() => this.syncAdapter.addMedicationPlan(data, allergyOverride));
  }

  public updateMedicationPlanAsync(
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    effectiveDate?: string,
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<CrmState> {
    return this.runAsync(() =>
      this.syncAdapter.updateMedicationPlan(
        planId,
        updates,
        changeReason,
        effectiveDate,
        expectedVersionNumber,
        allergyOverride
      )
    );
  }

  public changeMedicationStatusAsync(
    planId: string,
    status: MedicationPlanStatus,
    reason: string,
    effectiveDate?: string
  ): Promise<CrmState> {
    return this.runAsync(() =>
      this.syncAdapter.changeMedicationStatus(planId, status, reason, effectiveDate)
    );
  }

  public recordDispensingAsync(
    params: RecordDispensingInput,
    lang: Language
  ): Promise<{ state: CrmState; event: DispensingEvent | null }> {
    return this.runAsync(() => this.syncAdapter.recordDispensing(params, lang));
  }

  public updateDoseEventStatusAsync(
    doseId: string,
    status: DoseConfirmationStatus,
    note?: string
  ): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.updateDoseEventStatus(doseId, status, note));
  }

  public addLabResultAsync(data: LabResultInput): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.addLabResult(data));
  }

  public addFollowUpAsync(data: FollowUpInput): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.addFollowUp(data));
  }

  public updateFollowUpStatusAsync(followUpId: string, status: FollowUpStatus): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.updateFollowUpStatus(followUpId, status));
  }

  public addFollowUpContactLogAsync(followUpId: string, log: ContactLogInput): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.addFollowUpContactLog(followUpId, log));
  }

  public sendConsultationReplyAsync(
    threadId: string,
    body: string,
    newStatus?: ConsultationStatus
  ): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.sendConsultationReply(threadId, body, newStatus));
  }

  public updateConsultationStatusAsync(
    threadId: string,
    status: ConsultationStatus
  ): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.updateConsultationStatus(threadId, status));
  }

  public issueInvitationAsync(
    patientId: string,
    method: 'national_id_last4' | 'dob_and_phone_otp',
    refDateStr?: string
  ): Promise<{ state: CrmState; invitation: PatientApkInvitation | null }> {
    return this.runAsync(() => this.syncAdapter.issueInvitation(patientId, method, refDateStr));
  }

  public revokeInvitationAsync(patientId: string, _reason?: string): Promise<CrmState> {
    return this.runAsync(() => this.syncAdapter.revokeInvitation(patientId));
  }
}
