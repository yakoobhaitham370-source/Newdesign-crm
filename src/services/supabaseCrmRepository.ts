import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AllergyOverrideAuthorization,
  AuditLogEntry,
  BackendSafetyCapabilities,
  ConsultationMessage,
  ConsultationStatus,
  ConsultationThread,
  DispensingEvent,
  DispensingHashVerificationStatus,
  DoseConfirmationStatus,
  DoseEvent,
  DoseSchedule,
  FollowUpContactLog,
  FollowUpStatus,
  FollowUpTask,
  LabResult,
  Language,
  MedicationCatalogItem,
  MedicationCatalogLoadStatus,
  MedicationPausePeriod,
  MedicationPlanStatus,
  Patient,
  PatientAllergy,
  PatientApkInvitation,
  PatientMedicationPlan,
  Pharmacy,
  PharmacyStaff,
  RegimenVersion,
  StaffRole,
} from '../types/domain';
import { normalizeIraqiPhone } from '../i18n/translations';
import { AuthenticatedPharmacistContext, AuthErrorCode } from './authService';
import { getActiveBaghdadDateStr } from './clockService';
import {
  ContactLogInput,
  CrmState,
  FollowUpInput,
  generateEntityUuid,
  IAsyncCrmRepository,
  LabResultInput,
  NewMedicationPlanInput,
  NewPatientInput,
  RecordDispensingInput,
} from './crmRepository';
import { calculateDispensingForecast, computeRefillProjection } from './scheduleEngine';
import {
  AllergyPersistenceVerificationError,
  buildAllergiesRpcPayload,
  verifyPersistedAllergies,
} from './patientAllergyHelpers';
import {
  assessMedicationAllergyRisk,
  buildAllergyOverrideEvidencePayload,
  computeDispensingPayloadHash,
  DispensingRefillSnapshotInput,
  validateAllergyOverrideAuthorization,
  validateDispensingInput,
  validateMedicationEditAllowed,
  validateMedicationPlanInput,
} from './clinicalSafety';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Explicit non-secret column list permitted by 0002_stage2a_rls_and_security.sql.
 * NEVER query `patient_apk_invitations` with `select('*')` because token_hash,
 * pharmacist_pin_hash, and sms_otp_hash have zero SELECT grant for `authenticated`.
 */
export const PATIENT_APK_INVITATION_SELECT_COLUMNS = [
  'id',
  'pharmacy_id',
  'patient_id',
  'invitation_purpose',
  'recovery_reason',
  'approved_by_owner_id',
  'recovery_identity_verified',
  'target_phone',
  'status',
  'issued_at',
  'expires_at',
  'activated_at',
  'revoked_at',
  'issued_by_staff_id',
  'issued_by_staff_name',
  'failed_attempts',
  'max_attempts',
  'otp_send_count',
  'activated_device_label',
].join(', ');

export const STAGE2B_SQL_DEPENDENCIES = {
  atomicPatientWriteRpc: {
    objectName:
      'public.create_patient_with_clinical_tags(...) & public.update_patient_with_clinical_tags(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Creating or updating a patient together with patient_conditions and patient_allergies must execute in a single database transaction so partial writes cannot occur.',
  },
  atomicMedicationPlanRpc: {
    objectName: 'public.create_medication_plan_with_version(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Creating a patient_medication_plans row and its initial regimen_versions v1 row must execute atomically in one database transaction.',
  },
  atomicRegimenVersionUpdateRpc: {
    objectName: 'public.update_medication_plan_version(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Closing the open regimen_versions row, inserting the next version, and updating patient_medication_plans must execute in one database transaction.',
  },
  atomicMedicationStatusRpc: {
    objectName: 'public.change_medication_plan_status(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Opening/closing medication_pause_periods and updating patient_medication_plans.status must execute in one database transaction.',
  },
  atomicDispensingRpc: {
    objectName: 'public.record_dispensing_with_refill(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Appending an immutable dispensing_events ledger row and updating refill_assessments must execute in one database transaction without compensating deletes.',
  },
  atomicConsultationReplyRpc: {
    objectName: 'public.send_consultation_reply(...)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      'Inserting an immutable consultation_messages row and updating consultation_threads status/timestamp must execute atomically.',
  },
  revokeInvitationRpc: {
    objectName: 'public.revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      '0002 grants SELECT only on patient_apk_invitations to authenticated and provides no direct UPDATE grant or revocation RPC.',
  },
  clinicalAuditLogTriggers: {
    objectName: 'SECURITY DEFINER audit_logs insert triggers / RPC wrappers',
    stageRequired: 'Stage 2B Migration 0003',
    reason:
      '0002 grants SELECT only on audit_logs to authenticated so clients cannot forge audit entries; server triggers must record clinical events.',
  },
  ownerStaffProvisioningEdgeFn: {
    objectName: 'Edge Function: owner-provision-staff (+ bootstrap-first-owner)',
    stageRequired: 'Stage 2B Edge Deployment',
    reason:
      '0002 grants no client INSERT policy on pharmacy_staff; service_role Edge Functions are required for owner-controlled staff onboarding and initial pharmacy/owner bootstrap.',
  },
  patientActivationStage2c: {
    objectName: 'Stage 2C Patient Activation (Scannable QR + SMS OTP Gateway + Recovery Edge Fn)',
    stageRequired: 'Stage 2C Activation Release',
    reason:
      'Connected Mode patient activation remains disabled until standards-compliant scannable QR generation, SMS OTP gateway dispatch, and recovery session revocation Edge Functions are implemented and verified.',
  },
  scheduledDoseMaterializationPreAndroid: {
    objectName: 'Pre-Android Scheduled Dose Materialization Engine (public.scheduled_doses)',
    stageRequired: 'Pre-Android Stage 2C Prerequisite Gate',
    reason:
      'Creating/updating medication plans or pause windows must server-authorize and materialize upcoming public.scheduled_doses occurrences (without altering completed historical dose_events) before launching the native Android Kotlin + Jetpack Compose APK.',
  },
} as const;

export class Stage2bSqlDependencyError extends Error {
  public readonly dependencyKey: keyof typeof STAGE2B_SQL_DEPENDENCIES;

  constructor(dependencyKey: keyof typeof STAGE2B_SQL_DEPENDENCIES, detail?: string) {
    const dep = STAGE2B_SQL_DEPENDENCIES[dependencyKey];
    super(
      `${dep.stageRequired} required (${dep.objectName}): ${dep.reason}${
        detail ? ` [${detail}]` : ''
      }`
    );
    this.name = 'Stage2bSqlDependencyError';
    this.dependencyKey = dependencyKey;
  }
}

export class ConnectedAuthorizationError extends Error {
  public readonly errorCode: AuthErrorCode;

  constructor(errorCode: AuthErrorCode, message: string) {
    super(message);
    this.name = 'ConnectedAuthorizationError';
    this.errorCode = errorCode;
  }
}

export function isConnectedAuthorizationError(err: unknown): err is ConnectedAuthorizationError {
  return err instanceof ConnectedAuthorizationError;
}

export function isSupabaseRlsPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; pgCode?: unknown; message?: unknown };
  if (candidate.code === '42501' || candidate.pgCode === '42501') {
    return true;
  }
  const msg = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return (
    msg.includes('permission or tenant rls policy denied') ||
    msg.includes('row-level security policy') ||
    msg.includes('authorization denied')
  );
}

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

function attachPgCode(err: Error, code?: string): Error {
  if (code) {
    (err as Error & { pgCode?: string }).pgCode = code;
  }
  return err;
}

function formatSupabaseError(error: PostgrestErrorLike, operation: string): Error {
  if (error.code === '42501') {
    return attachPgCode(
      new Error(`Permission or tenant RLS policy denied (${operation}): ${error.message}`),
      error.code
    );
  }
  if (error.code === '23505') {
    return attachPgCode(
      new Error(`Duplicate record constraint violation (${operation}): ${error.message}`),
      error.code
    );
  }
  if (error.code === '23P01') {
    return attachPgCode(
      new Error(`Overlapping pause period rejected (${operation}): ${error.message}`),
      error.code
    );
  }
  if (error.code === '40001') {
    return attachPgCode(
      new Error(`Version conflict (${operation}): ${error.message}`),
      error.code
    );
  }
  if (error.code === '23514') {
    return attachPgCode(
      new Error(`Clinical integrity check failed (${operation}): ${error.message}`),
      error.code
    );
  }
  return attachPgCode(
    new Error(`Supabase error during ${operation}: ${error.message}`),
    error.code
  );
}

function assertNoError(error: PostgrestErrorLike | null, operation: string): void {
  if (error) {
    throw formatSupabaseError(error, operation);
  }
}

function isMissingRpcFunctionError(error: PostgrestErrorLike, rpcName: string): boolean {
  if (error.code === '42501') {
    return false;
  }
  const msg = error.message.toLowerCase();
  const target = rpcName.toLowerCase();
  if (error.code === 'PGRST202' || error.code === '42883') {
    return true;
  }
  if (msg.includes('could not find the function') && msg.includes(target)) {
    return true;
  }
  return msg.includes('function') && msg.includes(target) && msg.includes('does not exist');
}

function throwMappedRpcError(
  error: PostgrestErrorLike,
  rpcName: string,
  dependencyKey: keyof typeof STAGE2B_SQL_DEPENDENCIES
): never {
  if (isMissingRpcFunctionError(error, rpcName)) {
    throw new Stage2bSqlDependencyError(dependencyKey, error.message);
  }
  throw formatSupabaseError(error, `rpc ${rpcName}`);
}

export function toOptionalUuid(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export function assertAuthoritativeCatalogReference(catalogId?: string): string | null {
  if (catalogId === undefined || catalogId === null) return null;
  const trimmed = catalogId.trim();
  if (!trimmed) return null;
  if (!UUID_RE.test(trimmed)) {
    throw new Error(
      `Invalid catalog reference (${trimmed}): Connected Mode requires an authoritative medication_catalog UUID; bundled demo catalog identifiers are forbidden.`
    );
  }
  return trimmed;
}

function isMissingColumnSchemaError(error: PostgrestErrorLike | null): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = error.message.toLowerCase();
  return msg.includes('column') && (msg.includes('does not exist') || msg.includes('schema cache'));
}

function normalizeVerificationStatus(
  raw: unknown,
  hasV2CatalogColumns: boolean
): MedicationCatalogItem['ingredientVerificationStatus'] {
  if (!hasV2CatalogColumns) return 'unverified';
  if (raw === 'verified' || raw === 'partial' || raw === 'unverified') {
    return raw;
  }
  return 'unverified';
}

export function mapMedicationCatalogRow(
  row: Record<string, unknown>,
  hasV2CatalogColumns: boolean
): MedicationCatalogItem {
  const strengths = Array.isArray(row.available_strengths)
    ? row.available_strengths.map((s) => String(s)).filter(Boolean)
    : [];
  const activeIngredients =
    hasV2CatalogColumns && Array.isArray(row.active_ingredients)
      ? row.active_ingredients.map((s) => String(s).trim()).filter(Boolean)
      : undefined;
  return {
    id: String(row.id),
    brandName: String(row.brand_name),
    genericName: String(row.generic_name),
    activeIngredients,
    availableStrengths: strengths,
    defaultDosageForm: row.default_dosage_form as MedicationCatalogItem['defaultDosageForm'],
    defaultRoute: row.default_route as MedicationCatalogItem['defaultRoute'],
    category: String(row.category ?? ''),
    ingredientVerificationStatus: normalizeVerificationStatus(
      row.ingredient_verification_status,
      hasV2CatalogColumns
    ),
    ingredientSource:
      hasV2CatalogColumns && row.ingredient_source ? String(row.ingredient_source) : undefined,
    ingredientReviewedAt:
      hasV2CatalogColumns && row.ingredient_reviewed_at
        ? String(row.ingredient_reviewed_at)
        : undefined,
    ingredientReviewedBy:
      hasV2CatalogColumns && row.ingredient_reviewed_by
        ? String(row.ingredient_reviewed_by)
        : undefined,
  };
}

export interface ReconstructedDispensingHashMetadata {
  clientEventUuid?: string;
  clientPayloadHash?: string;
  serverPayloadHash?: string;
  clientHashProvided: boolean;
  clientServerHashMatched?: boolean;
  hashVerificationStatus: DispensingHashVerificationStatus;
  rpcVersion: 'v2' | 'legacy_0004';
}

/**
 * Reconstructs dispensing idempotency and payload hash provenance faithfully from
 * persisted PostgreSQL columns and `calculation_inputs` JSONB without ever fabricating
 * missing hashes or misinterpreting `dispensing_events.client_payload_hash` (which in
 * Stage 2C.2C `_v2` stores the authoritative server-computed SHA-256 digest).
 */
export function reconstructDispensingHashMetadata(
  rawRow: Record<string, unknown>
): ReconstructedDispensingHashMetadata {
  const calcInputs =
    rawRow.calculation_inputs && typeof rawRow.calculation_inputs === 'object'
      ? (rawRow.calculation_inputs as Record<string, unknown>)
      : undefined;

  const clientEventUuid =
    typeof rawRow.client_event_uuid === 'string' && rawRow.client_event_uuid.trim().length > 0
      ? rawRow.client_event_uuid.trim()
      : typeof calcInputs?.clientSubmissionId === 'string' &&
          calcInputs.clientSubmissionId.trim().length > 0
        ? calcInputs.clientSubmissionId.trim()
        : undefined;

  const columnServerHash =
    typeof rawRow.client_payload_hash === 'string' && rawRow.client_payload_hash.trim().length > 0
      ? rawRow.client_payload_hash.trim()
      : undefined;

  const calcServerHash =
    typeof calcInputs?.serverPayloadHash === 'string' &&
    calcInputs.serverPayloadHash.trim().length > 0
      ? calcInputs.serverPayloadHash.trim()
      : undefined;

  const calcClientHash =
    typeof calcInputs?.clientPayloadHash === 'string' &&
    calcInputs.clientPayloadHash.trim().length > 0
      ? calcInputs.clientPayloadHash.trim()
      : undefined;

  const isV2Record =
    calcInputs?.rpcVersion === 'v2' ||
    Boolean(columnServerHash) ||
    Boolean(calcServerHash) ||
    typeof calcInputs?.clientHashProvided === 'boolean' ||
    typeof rawRow.client_event_uuid === 'string';

  if (!isV2Record) {
    return {
      clientEventUuid,
      clientPayloadHash: calcClientHash,
      serverPayloadHash: undefined,
      clientHashProvided: Boolean(calcClientHash),
      clientServerHashMatched: undefined,
      hashVerificationStatus: 'legacy_0004',
      rpcVersion: 'legacy_0004',
    };
  }

  const serverPayloadHash = calcServerHash ?? columnServerHash;
  const clientPayloadHash = calcClientHash;
  const clientHashProvided =
    typeof calcInputs?.clientHashProvided === 'boolean'
      ? calcInputs.clientHashProvided
      : Boolean(clientPayloadHash);

  let clientServerHashMatched: boolean | undefined;
  let hashVerificationStatus: DispensingHashVerificationStatus;

  if (!serverPayloadHash) {
    clientServerHashMatched = undefined;
    hashVerificationStatus = 'v2_server_hash_missing';
  } else if (!clientPayloadHash) {
    clientServerHashMatched = undefined;
    hashVerificationStatus = 'v2_client_hash_missing';
  } else if (
    clientPayloadHash === serverPayloadHash &&
    calcInputs?.clientServerHashMatched !== false
  ) {
    clientServerHashMatched = true;
    hashVerificationStatus = 'v2_matched';
  } else {
    clientServerHashMatched = false;
    hashVerificationStatus = 'v2_mismatch';
  }

  return {
    clientEventUuid,
    clientPayloadHash,
    serverPayloadHash,
    clientHashProvided,
    clientServerHashMatched,
    hashVerificationStatus,
    rpcVersion: 'v2',
  };
}

/**
 * Builds a column-safe UPDATE payload matching 0002_stage2a_rls_and_security.sql
 * column-level UPDATE grants on `public.patients` (never touching patient_code,
 * registration_date, pharmacy_id, auth_user_id, or id).
 */
export function buildSafePatientUpdatePatch(updates: Partial<Patient>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.fullName !== undefined) patch.full_name = updates.fullName.trim();
  if (updates.phone !== undefined) patch.phone = normalizeIraqiPhone(updates.phone.trim());
  if (updates.phoneOwnerType !== undefined) patch.phone_owner_type = updates.phoneOwnerType;
  if (updates.caregiverName !== undefined) {
    patch.caregiver_name = updates.caregiverName.trim() || null;
  }
  if (updates.dateOfBirth !== undefined) patch.date_of_birth = updates.dateOfBirth;
  if (updates.sex !== undefined) patch.sex = updates.sex;
  if (updates.contactPreference !== undefined) {
    patch.contact_preference = updates.contactPreference;
  }
  if (updates.clinicalNotes !== undefined) patch.clinical_notes = updates.clinicalNotes;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.archivedAt !== undefined) patch.archived_at = updates.archivedAt ?? null;
  if (updates.archivedReason !== undefined) patch.archived_reason = updates.archivedReason ?? null;
  return patch;
}

function mapPharmacyRow(row: Record<string, unknown>): Pharmacy {
  return {
    id: String(row.id),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    city: String(row.city),
    governorate: String(row.governorate),
    licenseNumber: String(row.license_number),
    phone: String(row.phone),
    timezone: 'Asia/Baghdad',
  };
}

function mapStaffRow(row: Record<string, unknown>): PharmacyStaff {
  return {
    id: String(row.id),
    pharmacyId: String(row.pharmacy_id),
    fullName: String(row.full_name),
    role: row.role as PharmacyStaff['role'],
    syndicateLicense: row.syndicate_license ? String(row.syndicate_license) : undefined,
    phone: String(row.phone),
    isActive: Boolean(row.is_active),
  };
}

export function createEmptyConnectedCrmState(): CrmState {
  return {
    pharmacy: {
      id: '',
      nameAr: '',
      nameEn: '',
      city: '',
      governorate: '',
      licenseNumber: '',
      phone: '',
      timezone: 'Asia/Baghdad',
    },
    staff: [],
    activeStaffId: '',
    patients: [],
    medicationCatalog: [],
    catalogLoadStatus: 'unavailable',
    medicationPlans: [],
    dispensingEvents: [],
    doseEvents: [],
    labResults: [],
    followUps: [],
    consultations: [],
    invitations: [],
    auditLogs: [],
  };
}

export const DEFAULT_SUPABASE_PAGE_SIZE = 500;
export const DEFAULT_SUPABASE_MAX_ROWS = 25_000;

export const DEFAULT_VERIFIED_CAPABILITY_TTL_MS = 300_000;
export const DEFAULT_NON_VERIFIED_CAPABILITY_TTL_MS = 30_000;

export const LEGACY_0004_SAFETY_CAPABILITIES: BackendSafetyCapabilities = {
  stage: 'migration_0004_legacy',
  supportsV2MedicationPlans: false,
  supportsV2DispensingIdempotency: false,
  enforcesServerCriticalAllergyOverride: false,
  enforcesServerAllergyUncertainty: false,
  legacy0004RpcsRetired: false,
  probeStatus: 'legacy_missing_rpc',
};

interface PaginatedRangeQuery {
  range(
    from: number,
    to: number
  ): PromiseLike<{ data: unknown; error: PostgrestErrorLike | null }>;
}

export class SupabaseCrmRepository implements IAsyncCrmRepository {
  public readonly mode = 'supabase_stage2' as const;
  private readonly client: SupabaseClient;
  private readonly authContext: AuthenticatedPharmacistContext;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly verifiedCapabilityTtlMs: number;
  private readonly nonVerifiedCapabilityTtlMs: number;
  private readonly nowProvider: () => number;
  private latestVerifiedStaffName: string | null = null;
  private cachedCapabilities: BackendSafetyCapabilities | null = null;
  private cachedCapabilitiesAtMs = 0;
  private inFlightCapabilityProbe: Promise<BackendSafetyCapabilities> | null = null;

  constructor(
    client: SupabaseClient,
    authContext: AuthenticatedPharmacistContext,
    options?: {
      pageSize?: number;
      maxRows?: number;
      verifiedCapabilityTtlMs?: number;
      nonVerifiedCapabilityTtlMs?: number;
      nowProvider?: () => number;
    }
  ) {
    this.client = client;
    this.authContext = authContext;
    this.pageSize = Math.max(1, options?.pageSize ?? DEFAULT_SUPABASE_PAGE_SIZE);
    this.maxRows = Math.max(this.pageSize, options?.maxRows ?? DEFAULT_SUPABASE_MAX_ROWS);
    this.verifiedCapabilityTtlMs = Math.max(
      0,
      options?.verifiedCapabilityTtlMs ?? DEFAULT_VERIFIED_CAPABILITY_TTL_MS
    );
    this.nonVerifiedCapabilityTtlMs = Math.max(
      0,
      options?.nonVerifiedCapabilityTtlMs ?? DEFAULT_NON_VERIFIED_CAPABILITY_TTL_MS
    );
    this.nowProvider = options?.nowProvider ?? (() => Date.now());
  }

  public async detectBackendCapabilitiesAsync(
    forceRefresh = false
  ): Promise<BackendSafetyCapabilities> {
    const nowMs = this.nowProvider();
    if (!forceRefresh && this.cachedCapabilities) {
      const ttl =
        this.cachedCapabilities.probeStatus === 'verified_v2'
          ? this.verifiedCapabilityTtlMs
          : this.nonVerifiedCapabilityTtlMs;
      if (nowMs - this.cachedCapabilitiesAtMs < ttl) {
        return this.cachedCapabilities;
      }
    }

    if (!forceRefresh && this.inFlightCapabilityProbe) {
      return this.inFlightCapabilityProbe;
    }

    const probePromise = (async (): Promise<BackendSafetyCapabilities> => {
      const rpcName = 'get_clinical_safety_capabilities';
      const { data, error } = await this.client.rpc(rpcName);
      const probeNowMs = this.nowProvider();
      if (error) {
        if (isMissingRpcFunctionError(error, rpcName)) {
          const legacyCaps: BackendSafetyCapabilities = {
            ...LEGACY_0004_SAFETY_CAPABILITIES,
            probeStatus: 'legacy_missing_rpc',
            checkedAt: new Date(probeNowMs).toISOString(),
          };
          this.cachedCapabilities = legacyCaps;
          this.cachedCapabilitiesAtMs = probeNowMs;
          return legacyCaps;
        }
        // 42501 permission denial or transport/database failures MUST fail closed, never downgrade to legacy
        assertNoError(error, `rpc ${rpcName}`);
      }

      const payload =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null;

      const stage = payload?.stage;
      const isKnownV2Stage = stage === 'stage2c2b_v2' || stage === 'stage2c2c_v2';
      const hasRequiredBooleans =
        payload !== null &&
        typeof payload.supportsV2MedicationPlans === 'boolean' &&
        typeof payload.supportsV2DispensingIdempotency === 'boolean' &&
        typeof payload.enforcesServerCriticalAllergyOverride === 'boolean' &&
        (stage !== 'stage2c2c_v2' || typeof payload.enforcesServerAllergyUncertainty === 'boolean') &&
        (payload.legacy0004RpcsRetired === undefined ||
          typeof payload.legacy0004RpcsRetired === 'boolean');

      if (payload && payload.ok === true && isKnownV2Stage && hasRequiredBooleans) {
        const v2Caps: BackendSafetyCapabilities = {
          stage: stage as BackendSafetyCapabilities['stage'],
          supportsV2MedicationPlans: payload.supportsV2MedicationPlans === true,
          supportsV2DispensingIdempotency: payload.supportsV2DispensingIdempotency === true,
          enforcesServerCriticalAllergyOverride:
            payload.enforcesServerCriticalAllergyOverride === true,
          enforcesServerAllergyUncertainty:
            stage === 'stage2c2c_v2' ? payload.enforcesServerAllergyUncertainty === true : false,
          legacy0004RpcsRetired: payload.legacy0004RpcsRetired === true,
          probeStatus: 'verified_v2',
          checkedAt: new Date(probeNowMs).toISOString(),
        };
        this.cachedCapabilities = v2Caps;
        this.cachedCapabilitiesAtMs = probeNowMs;
        return v2Caps;
      }

      const malformedCaps: BackendSafetyCapabilities = {
        ...LEGACY_0004_SAFETY_CAPABILITIES,
        stage: 'migration_0004_legacy',
        supportsV2MedicationPlans: false,
        supportsV2DispensingIdempotency: false,
        enforcesServerCriticalAllergyOverride: false,
        enforcesServerAllergyUncertainty: false,
        legacy0004RpcsRetired: false,
        probeStatus: 'malformed_response',
        checkedAt: new Date(probeNowMs).toISOString(),
      };
      this.cachedCapabilities = malformedCaps;
      this.cachedCapabilitiesAtMs = probeNowMs;
      return malformedCaps;
    })();

    if (!forceRefresh) {
      this.inFlightCapabilityProbe = probePromise;
    }

    try {
      return await probePromise;
    } finally {
      if (this.inFlightCapabilityProbe === probePromise) {
        this.inFlightCapabilityProbe = null;
      }
    }
  }

  public getBackendCapabilitiesAsync(forceRefresh = false): Promise<BackendSafetyCapabilities> {
    return this.detectBackendCapabilitiesAsync(forceRefresh);
  }

  public refreshBackendCapabilitiesAsync(): Promise<BackendSafetyCapabilities> {
    return this.detectBackendCapabilitiesAsync(true);
  }

  private get pharmacyId(): string {
    return this.authContext.pharmacyId;
  }

  private get userId(): string {
    return this.authContext.userId;
  }

  private get staffName(): string {
    return this.latestVerifiedStaffName ?? this.authContext.staff.fullName;
  }

  private async fetchAllPaginatedRows(
    operation: string,
    buildQuery: () => PaginatedRangeQuery
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let from = 0;

    while (true) {
      const to = from + this.pageSize - 1;
      const { data, error } = await buildQuery().range(from, to);
      assertNoError(error, operation);

      const batch = (data ?? []) as Array<Record<string, unknown>>;
      rows.push(...batch);

      if (rows.length > this.maxRows) {
        throw new Error(
          `Dataset completeness guard triggered (${operation}): loaded ${rows.length} rows, exceeding safety ceiling of ${this.maxRows} rows. Paginated server-filtered views are required.`
        );
      }

      if (batch.length < this.pageSize) {
        break;
      }

      if (rows.length === this.maxRows) {
        const { data: extra, error: extraErr } = await buildQuery().range(
          this.maxRows,
          this.maxRows
        );
        assertNoError(extraErr, `${operation} completeness check`);
        if (Array.isArray(extra) && extra.length > 0) {
          throw new Error(
            `Dataset completeness guard triggered (${operation}): table exceeds safety ceiling of ${this.maxRows} rows without truncation.`
          );
        }
        break;
      }

      from += batch.length;
    }

    return rows;
  }

  public async resetAsync(): Promise<CrmState> {
    throw new Error(
      'Demo dataset reset is forbidden in Connected Supabase Mode.'
    );
  }

  public async setActiveStaffAsync(_staffId: string): Promise<CrmState> {
    throw new Error(
      'Manual staff switching is forbidden in Connected Mode; operator identity is bound strictly to Supabase auth.uid().'
    );
  }

  private async loadMedicationCatalogSafely(
    preferV2CatalogCols: boolean
  ): Promise<{
    items: MedicationCatalogItem[];
    status: MedicationCatalogLoadStatus;
    error?: string;
  }> {
    const baseCols =
      'id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category, is_active';
    const v2Cols =
      'id, brand_name, generic_name, available_strengths, default_dosage_form, default_route, category, active_ingredients, ingredient_verification_status, ingredient_source, ingredient_reviewed_at, ingredient_reviewed_by, is_active';

    try {
      const rows = await this.fetchAllPaginatedRows('load medication_catalog', () =>
        this.client
          .from('medication_catalog')
          .select(preferV2CatalogCols ? v2Cols : baseCols)
          .eq('is_active', true)
          .order('brand_name', { ascending: true })
          .order('id', { ascending: true })
      );
      return {
        items: rows.map((row) => mapMedicationCatalogRow(row, preferV2CatalogCols)),
        status: 'loaded',
      };
    } catch (err) {
      const pgErr = err as { pgCode?: string; code?: string; message?: string };
      if (
        preferV2CatalogCols &&
        isMissingColumnSchemaError({
          code: pgErr?.pgCode ?? pgErr?.code,
          message: pgErr?.message ?? '',
        })
      ) {
        try {
          const fallbackRows = await this.fetchAllPaginatedRows('load medication_catalog (base)', () =>
            this.client
              .from('medication_catalog')
              .select(baseCols)
              .eq('is_active', true)
              .order('brand_name', { ascending: true })
              .order('id', { ascending: true })
          );
          return {
            items: fallbackRows.map((row) => mapMedicationCatalogRow(row, false)),
            status: 'loaded',
          };
        } catch (fallbackErr) {
          return {
            items: [],
            status: 'error',
            error:
              fallbackErr instanceof Error
                ? fallbackErr.message
                : 'Failed to load authoritative medication catalog.',
          };
        }
      }
      return {
        items: [],
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Failed to load authoritative medication catalog.',
      };
    }
  }

  public async getStateAsync(): Promise<CrmState> {
    const pid = this.pharmacyId;
    const capabilities =
      typeof (this.client as { rpc?: unknown }).rpc === 'function'
        ? await this.detectBackendCapabilitiesAsync()
        : LEGACY_0004_SAFETY_CAPABILITIES;
    const useV2DispensingCols =
      capabilities.probeStatus === 'verified_v2' && capabilities.supportsV2DispensingIdempotency;
    const preferV2CatalogCols =
      capabilities.probeStatus === 'verified_v2' && capabilities.stage === 'stage2c2c_v2';

    const [
      pharmacyRes,
      staffRows,
      patientRows,
      conditionRows,
      allergyRows,
      catalogResult,
      planRows,
      versionRows,
      pauseRows,
      dispensingRows,
      doseEventRows,
      labRows,
      followUpRows,
      contactLogRows,
      threadRows,
      messageRows,
      invitationRows,
      auditLogRows,
    ] = await Promise.all([
      this.client
        .from('pharmacies')
        .select('id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active')
        .eq('id', pid)
        .maybeSingle(),
      this.fetchAllPaginatedRows('load pharmacy_staff', () =>
        this.client
          .from('pharmacy_staff')
          .select('id, pharmacy_id, full_name, role, syndicate_license, phone, is_active')
          .eq('pharmacy_id', pid)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load patients', () =>
        this.client
          .from('patients')
          .select(
            'id, pharmacy_id, patient_code, full_name, phone, phone_owner_type, caregiver_name, date_of_birth, sex, contact_preference, clinical_notes, registration_date, status, archived_at, archived_reason'
          )
          .eq('pharmacy_id', pid)
          .order('registration_date', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load patient_conditions', () =>
        this.client
          .from('patient_conditions')
          .select('id, pharmacy_id, patient_id, condition_name, status, created_at')
          .eq('pharmacy_id', pid)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load patient_allergies', () =>
        this.client
          .from('patient_allergies')
          .select('id, pharmacy_id, patient_id, substance, severity, reaction, status, created_at')
          .eq('pharmacy_id', pid)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.loadMedicationCatalogSafely(preferV2CatalogCols),
      this.fetchAllPaginatedRows('load patient_medication_plans', () =>
        this.client
          .from('patient_medication_plans')
          .select(
            'id, pharmacy_id, patient_id, catalog_id, brand_name, generic_name, strength, dosage_form, route, dose_amount, dose_unit, food_relation, verified_instructions, prescriber_name, prescriber_specialty, start_date, end_date, is_ongoing, duration_days, status, status_changed_at, status_change_reason, current_version_number, schedule, created_at, updated_at'
          )
          .eq('pharmacy_id', pid)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load regimen_versions', () =>
        this.client
          .from('regimen_versions')
          .select(
            'id, pharmacy_id, medication_plan_id, version_number, effective_from, effective_to, dose_amount, dose_unit, food_relation, verified_instructions, schedule, changed_by_staff_name, change_reason, created_at'
          )
          .eq('pharmacy_id', pid)
          .order('version_number', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load medication_pause_periods', () =>
        this.client
          .from('medication_pause_periods')
          .select('id, pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, created_at')
          .eq('pharmacy_id', pid)
          .order('paused_from', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load dispensing_events', () => {
        const baseSelect = useV2DispensingCols
          ? this.client
              .from('dispensing_events')
              .select(
                'id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number, dispensed_quantity, quantity_unit, package_count, package_size, batch_number, expiry_date, dispensing_date, dispensed_by_staff_id, dispensed_by_staff_name, notes, estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date, forecast_assumptions, is_partial_fill, calculation_source, verification_status, algorithm_version, calculation_inputs, client_event_uuid, client_payload_hash, created_at'
              )
          : this.client
              .from('dispensing_events')
              .select(
                'id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number, dispensed_quantity, quantity_unit, package_count, package_size, batch_number, expiry_date, dispensing_date, dispensed_by_staff_id, dispensed_by_staff_name, notes, estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date, forecast_assumptions, is_partial_fill, calculation_source, verification_status, algorithm_version, calculation_inputs, created_at'
              );
        return baseSelect
          .eq('pharmacy_id', pid)
          .order('dispensing_date', { ascending: false })
          .order('id', { ascending: true });
      }),
      this.fetchAllPaginatedRows('load dose_events', () =>
        this.client
          .from('dose_events')
          .select(
            'id, pharmacy_id, patient_id, medication_plan_id, regimen_version_number, scheduled_date, scheduled_time24, planned_dose_amount, dose_unit, status, confirmed_at, patient_note'
          )
          .eq('pharmacy_id', pid)
          .order('scheduled_date', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load lab_results', () =>
        this.client
          .from('lab_results')
          .select(
            'id, pharmacy_id, patient_id, test_name, value, unit, reference_range, is_abnormal, test_date, notes, recorded_by_staff_name'
          )
          .eq('pharmacy_id', pid)
          .order('test_date', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load follow_up_tasks', () =>
        this.client
          .from('follow_up_tasks')
          .select(
            'id, pharmacy_id, patient_id, related_medication_plan_id, type, due_date, status, notes, assigned_staff_name, created_at'
          )
          .eq('pharmacy_id', pid)
          .order('due_date', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load follow_up_contact_logs', () =>
        this.client
          .from('follow_up_contact_logs')
          .select(
            'id, pharmacy_id, follow_up_task_id, contacted_at, channel, outcome, summary, staff_name'
          )
          .eq('pharmacy_id', pid)
          .order('contacted_at', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load consultation_threads', () =>
        this.client
          .from('consultation_threads')
          .select('id, pharmacy_id, patient_id, subject, status, updated_at')
          .eq('pharmacy_id', pid)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load consultation_messages', () =>
        this.client
          .from('consultation_messages')
          .select(
            'id, pharmacy_id, thread_id, sender_type, sender_staff_id, sender_name, body, approved_by_pharmacist, sent_at'
          )
          .eq('pharmacy_id', pid)
          .order('sent_at', { ascending: true })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load patient_apk_invitations', () =>
        this.client
          .from('patient_apk_invitations')
          .select(PATIENT_APK_INVITATION_SELECT_COLUMNS)
          .eq('pharmacy_id', pid)
          .order('issued_at', { ascending: false })
          .order('id', { ascending: true })
      ),
      this.fetchAllPaginatedRows('load audit_logs', () =>
        this.client
          .from('audit_logs')
          .select(
            'id, pharmacy_id, timestamp, actor_name, actor_role, action, entity_type, entity_id, summary_ar, summary_en'
          )
          .eq('pharmacy_id', pid)
          .order('timestamp', { ascending: false })
          .order('id', { ascending: true })
      ),
    ]);

    assertNoError(pharmacyRes.error, 'load pharmacy');

    const pharmacyRow = pharmacyRes.data as unknown as Record<string, unknown> | null;
    if (!pharmacyRow || String(pharmacyRow.id) !== pid || pharmacyRow.is_active !== true) {
      throw new ConnectedAuthorizationError(
        'PHARMACY_INACTIVE',
        'Authoritative pharmacy record is missing, mismatched, or inactive.'
      );
    }
    const pharmacy = mapPharmacyRow(pharmacyRow);

    const staff = staffRows.map(mapStaffRow);
    const currentStaff = staff.find(
      (member) => member.id === this.userId && member.pharmacyId === pid
    );
    if (!currentStaff) {
      throw new ConnectedAuthorizationError(
        'UNAUTHORIZED_STAFF_NOT_FOUND',
        'Authenticated user is not an active member of the assigned pharmacy.'
      );
    }
    if (!currentStaff.isActive) {
      throw new ConnectedAuthorizationError(
        'STAFF_INACTIVE',
        'Authenticated pharmacist staff account has been deactivated.'
      );
    }
    if (
      currentStaff.role !== 'pharmacy_owner' &&
      currentStaff.role !== 'authorized_pharmacist'
    ) {
      throw new ConnectedAuthorizationError(
        'ROLE_NOT_AUTHORIZED',
        `Staff role ${currentStaff.role} is not authorized for pharmacist CRM access.`
      );
    }
    this.latestVerifiedStaffName = currentStaff.fullName;

    const conditionsByPatient = new Map<string, string[]>();
    for (const row of conditionRows) {
      if (row.status && String(row.status) !== 'active') continue;
      const patientId = String(row.patient_id);
      const existing = conditionsByPatient.get(patientId) ?? [];
      existing.push(String(row.condition_name));
      conditionsByPatient.set(patientId, existing);
    }

    const allergiesByPatient = new Map<string, PatientAllergy[]>();
    for (const row of allergyRows) {
      if (row.status && String(row.status) !== 'active') continue;
      const patientId = String(row.patient_id);
      const existing = allergiesByPatient.get(patientId) ?? [];
      existing.push({
        id: String(row.id),
        substance: String(row.substance),
        severity: row.severity as PatientAllergy['severity'],
        reaction: row.reaction ? String(row.reaction) : undefined,
      });
      allergiesByPatient.set(patientId, existing);
    }

    const patients: Patient[] = patientRows.map((row) => {
      const id = String(row.id);
      return {
        id,
        patientCode: String(row.patient_code),
        pharmacyId: String(row.pharmacy_id),
        fullName: String(row.full_name),
        phone: String(row.phone),
        phoneOwnerType: (row.phone_owner_type as Patient['phoneOwnerType']) ?? 'self',
        caregiverName: row.caregiver_name ? String(row.caregiver_name) : undefined,
        dateOfBirth: String(row.date_of_birth),
        sex: row.sex as Patient['sex'],
        chronicConditions: conditionsByPatient.get(id) ?? [],
        allergies: allergiesByPatient.get(id) ?? [],
        contactPreference: row.contact_preference as Patient['contactPreference'],
        clinicalNotes: String(row.clinical_notes ?? ''),
        registrationDate: String(row.registration_date),
        status: row.status as Patient['status'],
        archivedAt: row.archived_at ? String(row.archived_at) : undefined,
        archivedReason: row.archived_reason ? String(row.archived_reason) : undefined,
      };
    });

    const versionsByPlan = new Map<string, RegimenVersion[]>();
    for (const row of versionRows) {
      const planId = String(row.medication_plan_id);
      const list = versionsByPlan.get(planId) ?? [];
      list.push({
        versionNumber: Number(row.version_number),
        effectiveFrom: String(row.effective_from),
        effectiveTo: row.effective_to ? String(row.effective_to) : undefined,
        doseAmount: Number(row.dose_amount),
        doseUnit: String(row.dose_unit),
        foodRelation: row.food_relation as RegimenVersion['foodRelation'],
        verifiedInstructions: String(row.verified_instructions),
        schedule: row.schedule as DoseSchedule,
        changedByStaffName: String(row.changed_by_staff_name),
        changeReason: String(row.change_reason),
        createdAt: String(row.created_at),
      });
      versionsByPlan.set(planId, list);
    }

    const pausesByPlan = new Map<string, MedicationPausePeriod[]>();
    for (const row of pauseRows) {
      const planId = String(row.medication_plan_id);
      const list = pausesByPlan.get(planId) ?? [];
      list.push({
        pausedFrom: String(row.paused_from),
        resumedAt: row.resumed_at ? String(row.resumed_at) : undefined,
        reason: row.reason ? String(row.reason) : undefined,
      });
      pausesByPlan.set(planId, list);
    }

    const medicationPlans: PatientMedicationPlan[] = planRows.map((row) => {
      const id = String(row.id);
      return {
        id,
        patientId: String(row.patient_id),
        pharmacyId: String(row.pharmacy_id),
        catalogId: row.catalog_id ? String(row.catalog_id) : undefined,
        brandName: String(row.brand_name),
        genericName: String(row.generic_name),
        strength: String(row.strength),
        dosageForm: row.dosage_form as PatientMedicationPlan['dosageForm'],
        route: row.route as PatientMedicationPlan['route'],
        doseAmount: Number(row.dose_amount),
        doseUnit: String(row.dose_unit),
        foodRelation: row.food_relation as PatientMedicationPlan['foodRelation'],
        verifiedInstructions: String(row.verified_instructions),
        prescriberName: row.prescriber_name ? String(row.prescriber_name) : undefined,
        prescriberSpecialty: row.prescriber_specialty
          ? String(row.prescriber_specialty)
          : undefined,
        startDate: String(row.start_date),
        endDate: row.end_date ? String(row.end_date) : undefined,
        isOngoing: Boolean(row.is_ongoing),
        durationDays:
          row.duration_days !== null && row.duration_days !== undefined
            ? Number(row.duration_days)
            : undefined,
        status: row.status as PatientMedicationPlan['status'],
        statusChangedAt: row.status_changed_at ? String(row.status_changed_at) : undefined,
        statusChangeReason: row.status_change_reason
          ? String(row.status_change_reason)
          : undefined,
        pausePeriods: pausesByPlan.get(id) ?? [],
        currentVersionNumber: Number(row.current_version_number),
        schedule: row.schedule as DoseSchedule,
        regimenHistory: versionsByPlan.get(id) ?? [],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });

    const dispensingEvents: DispensingEvent[] = dispensingRows.map((row) => {
      const rawRow = row as Record<string, unknown>;
      const calcInputs =
        rawRow.calculation_inputs && typeof rawRow.calculation_inputs === 'object'
          ? (rawRow.calculation_inputs as Record<string, unknown>)
          : undefined;
      const overrideObj =
        calcInputs?.allergyOverride && typeof calcInputs.allergyOverride === 'object'
          ? (calcInputs.allergyOverride as Record<string, unknown>)
          : undefined;
      const allergyOverrideSummary =
        overrideObj && typeof overrideObj.prescriberName === 'string'
          ? `${String(overrideObj.authorizationSource ?? 'override')}: ${overrideObj.prescriberName}`
          : undefined;
      const hashMeta = reconstructDispensingHashMetadata(rawRow);

      return {
        id: String(row.id),
        pharmacyId: String(row.pharmacy_id),
        patientId: String(row.patient_id),
        medicationPlanId: String(row.medication_plan_id),
        regimenVersionNumber: Number(row.regimen_version_number),
        dispensedQuantity: Number(row.dispensed_quantity),
        quantityUnit: String(row.quantity_unit),
        packageCount:
          row.package_count !== null && row.package_count !== undefined
            ? Number(row.package_count)
            : undefined,
        packageSize:
          row.package_size !== null && row.package_size !== undefined
            ? Number(row.package_size)
            : undefined,
        batchNumber: row.batch_number ? String(row.batch_number) : undefined,
        expiryDate: row.expiry_date ? String(row.expiry_date) : undefined,
        dispensingDate: String(row.dispensing_date),
        dispensedByStaffId: String(row.dispensed_by_staff_id),
        dispensedByStaffName: String(row.dispensed_by_staff_name),
        notes: row.notes ? String(row.notes) : undefined,
        estimatedDailyConsumption:
          row.estimated_daily_consumption !== null && row.estimated_daily_consumption !== undefined
            ? Number(row.estimated_daily_consumption)
            : null,
        estimatedSupplyDays:
          row.estimated_supply_days !== null && row.estimated_supply_days !== undefined
            ? Number(row.estimated_supply_days)
            : null,
        estimatedSupplyEndDate: row.estimated_supply_end_date
          ? String(row.estimated_supply_end_date)
          : null,
        forecastAssumptions: String(row.forecast_assumptions),
        isPartialFill: Boolean(row.is_partial_fill),
        calculationSource: row.calculation_source
          ? (String(row.calculation_source) as DispensingEvent['calculationSource'])
          : undefined,
        verificationStatus: row.verification_status
          ? (String(row.verification_status) as DispensingEvent['verificationStatus'])
          : undefined,
        algorithmVersion: row.algorithm_version ? String(row.algorithm_version) : undefined,
        clientEventUuid: hashMeta.clientEventUuid,
        clientPayloadHash: hashMeta.clientPayloadHash,
        serverPayloadHash: hashMeta.serverPayloadHash,
        clientHashProvided: hashMeta.clientHashProvided,
        clientServerHashMatched: hashMeta.clientServerHashMatched,
        hashVerificationStatus: hashMeta.hashVerificationStatus,
        rpcVersion: hashMeta.rpcVersion,
        allergyOverrideSummary,
        createdAt: String(row.created_at),
      };
    });

    const doseEvents: DoseEvent[] = doseEventRows.map((row) => ({
      id: String(row.id),
      patientId: String(row.patient_id),
      medicationPlanId: String(row.medication_plan_id),
      regimenVersionNumber: Number(row.regimen_version_number),
      scheduledDate: String(row.scheduled_date),
      scheduledTime24: String(row.scheduled_time24),
      plannedDoseAmount: Number(row.planned_dose_amount),
      doseUnit: String(row.dose_unit),
      status: row.status as DoseEvent['status'],
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : undefined,
      patientNote: row.patient_note ? String(row.patient_note) : undefined,
    }));

    const labResults: LabResult[] = labRows.map((row) => ({
      id: String(row.id),
      patientId: String(row.patient_id),
      pharmacyId: String(row.pharmacy_id),
      testName: String(row.test_name),
      value: String(row.value),
      unit: String(row.unit),
      referenceRange: String(row.reference_range),
      isAbnormal: Boolean(row.is_abnormal),
      testDate: String(row.test_date),
      notes: row.notes ? String(row.notes) : undefined,
      recordedByStaffName: String(row.recorded_by_staff_name),
    }));

    const contactLogsByTask = new Map<string, FollowUpContactLog[]>();
    for (const row of contactLogRows) {
      const taskId = String(row.follow_up_task_id);
      const list = contactLogsByTask.get(taskId) ?? [];
      list.push({
        id: String(row.id),
        contactedAt: String(row.contacted_at),
        channel: row.channel as FollowUpContactLog['channel'],
        outcome: row.outcome as FollowUpContactLog['outcome'],
        summary: String(row.summary),
        staffName: String(row.staff_name),
      });
      contactLogsByTask.set(taskId, list);
    }

    const followUps: FollowUpTask[] = followUpRows.map((row) => {
      const id = String(row.id);
      return {
        id,
        pharmacyId: String(row.pharmacy_id),
        patientId: String(row.patient_id),
        relatedMedicationPlanId: row.related_medication_plan_id
          ? String(row.related_medication_plan_id)
          : undefined,
        type: row.type as FollowUpTask['type'],
        dueDate: String(row.due_date),
        status: row.status as FollowUpTask['status'],
        notes: String(row.notes ?? ''),
        assignedStaffName: String(row.assigned_staff_name),
        contactHistory: contactLogsByTask.get(id) ?? [],
        createdAt: String(row.created_at),
      };
    });

    const messagesByThread = new Map<string, ConsultationMessage[]>();
    for (const row of messageRows) {
      const threadId = String(row.thread_id);
      const list = messagesByThread.get(threadId) ?? [];
      const senderType = row.sender_type as ConsultationMessage['senderType'];
      const senderStaffId = row.sender_staff_id ? String(row.sender_staff_id) : undefined;
      list.push({
        id: String(row.id),
        senderType,
        senderStaffId,
        senderName: String(row.sender_name),
        body: String(row.body),
        sentAt: String(row.sent_at),
        approvedByPharmacist:
          senderType === 'pharmacist' &&
          Boolean(senderStaffId && senderStaffId.trim().length > 0) &&
          Boolean(row.approved_by_pharmacist),
      });
      messagesByThread.set(threadId, list);
    }

    const consultations: ConsultationThread[] = threadRows.map((row) => {
      const id = String(row.id);
      return {
        id,
        pharmacyId: String(row.pharmacy_id),
        patientId: String(row.patient_id),
        subject: String(row.subject),
        status: row.status as ConsultationThread['status'],
        messages: messagesByThread.get(id) ?? [],
        updatedAt: String(row.updated_at),
      };
    });

    // Preserve most recent invitation per patient while honoring 0002 non-secret projection
    const latestInvitationByPatient = new Map<string, PatientApkInvitation>();
    for (const row of invitationRows) {
      const patientId = String(row.patient_id);
      if (latestInvitationByPatient.has(patientId)) continue;
      const id = String(row.id);
      latestInvitationByPatient.set(patientId, {
        id,
        pharmacyId: String(row.pharmacy_id),
        patientId,
        status: row.status as PatientApkInvitation['status'],
        mockInviteCode: id.slice(0, 8).toUpperCase(),
        mockActivationUrl: '',
        issuedAt: row.issued_at ? String(row.issued_at) : undefined,
        expiresAt: row.expires_at ? String(row.expires_at) : undefined,
        activatedAt: row.activated_at ? String(row.activated_at) : undefined,
        revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
        issuedByStaffName: row.issued_by_staff_name
          ? String(row.issued_by_staff_name)
          : undefined,
        deviceLabel: row.activated_device_label
          ? String(row.activated_device_label)
          : undefined,
        invitationPurpose: row.invitation_purpose as PatientApkInvitation['invitationPurpose'],
        targetPhone: row.target_phone ? String(row.target_phone) : undefined,
      });
    }

    const auditLogs: AuditLogEntry[] = auditLogRows.map((row) => ({
      id: String(row.id),
      pharmacyId: String(row.pharmacy_id),
      timestamp: String(row.timestamp),
      actorName: String(row.actor_name),
      actorRole: row.actor_role as StaffRole,
      action: String(row.action),
      entityType: row.entity_type as AuditLogEntry['entityType'],
      entityId: String(row.entity_id),
      summaryAr: String(row.summary_ar),
      summaryEn: String(row.summary_en),
    }));

    return {
      pharmacy,
      staff,
      activeStaffId: this.userId,
      patients,
      medicationCatalog: catalogResult.items,
      catalogLoadStatus: catalogResult.status,
      catalogLoadError: catalogResult.error,
      medicationPlans,
      dispensingEvents,
      doseEvents,
      labResults,
      followUps,
      consultations,
      invitations: Array.from(latestInvitationByPatient.values()),
      auditLogs,
    };
  }

  public async addPatientAsync(
    data: NewPatientInput
  ): Promise<{ state: CrmState; patient: Patient }> {
    const rpcName = 'create_patient_with_clinical_tags';
    const submittedAllergies = data.allergies ?? [];
    const { data: rpcData, error } = await this.client.rpc(rpcName, {
      p_patient_code: data.patientCode.trim(),
      p_full_name: data.fullName.trim(),
      p_phone: normalizeIraqiPhone(data.phone.trim()),
      p_phone_owner_type: data.phoneOwnerType ?? 'self',
      p_caregiver_name: data.caregiverName?.trim() || null,
      p_date_of_birth: data.dateOfBirth,
      p_sex: data.sex,
      p_contact_preference: data.contactPreference,
      p_clinical_notes: data.clinicalNotes ?? '',
      p_registration_date: data.registrationDate || getActiveBaghdadDateStr(),
      p_chronic_conditions: data.chronicConditions ?? [],
      p_allergies: buildAllergiesRpcPayload(submittedAllergies),
    });

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicPatientWriteRpc');
    }

    const payload = rpcData as { ok?: boolean; patientId?: string } | null;
    const patientId = payload?.patientId;
    if (!patientId) {
      throw new Error(`Unexpected response from ${rpcName}: missing patientId.`);
    }

    const state = await this.getStateAsync();
    const patient = state.patients.find((p) => p.id === patientId);
    if (!patient) {
      throw new Error(
        `Created patient ${patientId} could not be reloaded from authoritative pharmacy state.`
      );
    }

    const allergyCheck = verifyPersistedAllergies(submittedAllergies, patient.allergies);
    if (!allergyCheck.ok) {
      throw new AllergyPersistenceVerificationError(allergyCheck.reason, state);
    }

    return { state, patient };
  }

  public async updatePatientAsync(
    patientId: string,
    updates: Partial<Patient>
  ): Promise<CrmState> {
    const rpcName = 'update_patient_with_clinical_tags';
    const patch = buildSafePatientUpdatePatch(updates);
    const { error } = await this.client.rpc(rpcName, {
      p_patient_id: patientId,
      p_patch: patch,
      p_chronic_conditions:
        updates.chronicConditions !== undefined ? updates.chronicConditions : null,
      p_allergies:
        updates.allergies !== undefined ? buildAllergiesRpcPayload(updates.allergies) : null,
    });

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicPatientWriteRpc');
    }

    const state = await this.getStateAsync();
    const patient = state.patients.find((p) => p.id === patientId);
    if (!patient) {
      throw new Error(
        'Updated patient record could not be reloaded from authoritative pharmacy state.'
      );
    }

    if (updates.allergies !== undefined) {
      const allergyCheck = verifyPersistedAllergies(updates.allergies, patient.allergies);
      if (!allergyCheck.ok) {
        throw new AllergyPersistenceVerificationError(allergyCheck.reason, state);
      }
    }

    return state;
  }

  public async archivePatientAsync(patientId: string, reason: string): Promise<CrmState> {
    const today = getActiveBaghdadDateStr();
    const { error } = await this.client
      .from('patients')
      .update({
        status: 'archived',
        archived_at: today,
        archived_reason: reason.trim() || 'Archived by pharmacist',
        updated_at: new Date().toISOString(),
      })
      .eq('id', patientId)
      .eq('pharmacy_id', this.pharmacyId);
    assertNoError(error, 'archive patient');
    return this.getStateAsync();
  }

  public async restorePatientAsync(patientId: string): Promise<CrmState> {
    const { error } = await this.client
      .from('patients')
      .update({
        status: 'active',
        archived_at: null,
        archived_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', patientId)
      .eq('pharmacy_id', this.pharmacyId);
    assertNoError(error, 'restore patient');
    return this.getStateAsync();
  }

  public async addMedicationPlanAsync(
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<{ state: CrmState; plan: PatientMedicationPlan }> {
    const validation = validateMedicationPlanInput(data, 'en');
    if (!validation.valid) {
      throw new Error(validation.errors[0]);
    }
    const authoritativeCatalogId = assertAuthoritativeCatalogReference(data.catalogId);

    const preState = await this.getStateAsync();
    const patient = preState.patients.find((p) => p.id === data.patientId);
    const catalogRecord = authoritativeCatalogId
      ? preState.medicationCatalog.find((c) => c.id === authoritativeCatalogId)
      : undefined;
    let allergyOverrideEvidence: Record<string, unknown> | null = null;
    if (patient) {
      if (patient.status !== 'active') {
        throw new Error('Cannot add medication plan for an archived patient.');
      }
      const allergyAssessment = assessMedicationAllergyRisk(
        patient,
        {
          catalogId: authoritativeCatalogId ?? undefined,
          catalogRecord,
          brandName: data.brandName,
          genericName: data.genericName,
          strength: data.strength,
        },
        'en',
        {
          authoritativeCatalogOnly: true,
          catalogLookupFailed: preState.catalogLoadStatus !== 'loaded',
        }
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
      if (allergyAssessment.requiresPharmacistAcknowledgment && allergyOverride) {
        allergyOverrideEvidence = buildAllergyOverrideEvidencePayload(
          allergyAssessment,
          allergyOverride,
          this.staffName
        );
      }
    }

    const capabilities = await this.detectBackendCapabilitiesAsync();
    const useV2 = capabilities.supportsV2MedicationPlans;
    const rpcName = useV2
      ? 'create_medication_plan_with_version_v2'
      : 'create_medication_plan_with_version';
    const baseRpcArgs = {
      p_patient_id: data.patientId,
      p_catalog_id: authoritativeCatalogId,
      p_brand_name: data.brandName.trim(),
      p_generic_name: data.genericName.trim(),
      p_strength: data.strength.trim(),
      p_dosage_form: data.dosageForm,
      p_route: data.route,
      p_dose_amount: data.doseAmount,
      p_dose_unit: data.doseUnit.trim(),
      p_food_relation: data.foodRelation,
      p_verified_instructions: data.verifiedInstructions.trim(),
      p_prescriber_name: data.prescriberName?.trim() || null,
      p_prescriber_specialty: data.prescriberSpecialty?.trim() || null,
      p_start_date: data.startDate,
      p_end_date: data.isOngoing ? null : (data.endDate ?? null),
      p_is_ongoing: data.isOngoing,
      p_duration_days: data.isOngoing ? null : (data.durationDays ?? null),
      p_schedule: data.schedule,
    };
    const { data: rpcData, error } = await this.client.rpc(
      rpcName,
      useV2
        ? { ...baseRpcArgs, p_allergy_override_evidence: allergyOverrideEvidence }
        : baseRpcArgs
    );

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicMedicationPlanRpc');
    }

    const payload = rpcData as { ok?: boolean; planId?: string } | null;
    const planId = payload?.planId;
    if (!planId) {
      throw new Error(`Unexpected response from ${rpcName}: missing planId.`);
    }

    const state = await this.getStateAsync();
    const plan = state.medicationPlans.find((m) => m.id === planId);
    if (!plan) {
      throw new Error(
        `Created medication plan ${planId} could not be reloaded from authoritative pharmacy state.`
      );
    }

    return { state, plan };
  }

  public async updateMedicationPlanAsync(
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    effectiveDate: string = getActiveBaghdadDateStr(),
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ): Promise<CrmState> {
    const cleanReason = changeReason.trim();
    if (cleanReason.length < 3) {
      throw new Error('Regimen change reason must be at least 3 characters.');
    }
    const validation = validateMedicationPlanInput(updates, 'en');
    if (!validation.valid) {
      throw new Error(validation.errors[0]);
    }
    const authoritativeCatalogId = assertAuthoritativeCatalogReference(updates.catalogId);

    const preState = await this.getStateAsync();
    const existingPlan = preState.medicationPlans.find((m) => m.id === planId);
    let allergyOverrideEvidence: Record<string, unknown> | null = null;
    if (existingPlan) {
      const editCheck = validateMedicationEditAllowed(existingPlan, 'en', expectedVersionNumber);
      if (!editCheck.allowed) {
        throw new Error(editCheck.error);
      }
      const effectiveCatalogId = authoritativeCatalogId ?? existingPlan.catalogId;
      const catalogRecord = effectiveCatalogId
        ? preState.medicationCatalog.find((c) => c.id === effectiveCatalogId)
        : undefined;
      const patient = preState.patients.find((p) => p.id === existingPlan.patientId);
      if (patient) {
        const allergyAssessment = assessMedicationAllergyRisk(
          patient,
          {
            catalogId: effectiveCatalogId,
            catalogRecord,
            brandName: updates.brandName,
            genericName: updates.genericName,
            strength: updates.strength,
          },
          'en',
          {
            authoritativeCatalogOnly: true,
            catalogLookupFailed: preState.catalogLoadStatus !== 'loaded',
          }
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
        if (allergyAssessment.requiresPharmacistAcknowledgment && allergyOverride) {
          allergyOverrideEvidence = buildAllergyOverrideEvidencePayload(
            allergyAssessment,
            allergyOverride,
            this.staffName
          );
        }
      }
    }

    const capabilities = await this.detectBackendCapabilitiesAsync();
    const useV2 = capabilities.supportsV2MedicationPlans;
    const resolvedExpectedVersion = expectedVersionNumber ?? existingPlan?.currentVersionNumber;
    if (
      useV2 &&
      (existingPlan || expectedVersionNumber !== undefined) &&
      (!Number.isInteger(resolvedExpectedVersion) || (resolvedExpectedVersion ?? 0) < 1)
    ) {
      throw new Error('Expected regimen version number (>= 1) is required for versioned update.');
    }
    const effectiveExpectedVersion = resolvedExpectedVersion ?? 1;

    const rpcName = useV2
      ? 'update_medication_plan_version_v2'
      : 'update_medication_plan_version';
    const baseRpcArgs = {
      p_plan_id: planId,
      p_brand_name: updates.brandName.trim(),
      p_generic_name: updates.genericName.trim(),
      p_strength: updates.strength.trim(),
      p_dosage_form: updates.dosageForm,
      p_route: updates.route,
      p_dose_amount: updates.doseAmount,
      p_dose_unit: updates.doseUnit.trim(),
      p_food_relation: updates.foodRelation,
      p_verified_instructions: updates.verifiedInstructions.trim(),
      p_prescriber_name: updates.prescriberName?.trim() || null,
      p_prescriber_specialty: updates.prescriberSpecialty?.trim() || null,
      p_start_date: updates.startDate,
      p_end_date: updates.isOngoing ? null : (updates.endDate ?? null),
      p_is_ongoing: updates.isOngoing,
      p_duration_days: updates.isOngoing ? null : (updates.durationDays ?? null),
      p_schedule: updates.schedule,
      p_change_reason: cleanReason,
      p_effective_date: effectiveDate,
    };
    const { error } = await this.client.rpc(
      rpcName,
      useV2
        ? {
            ...baseRpcArgs,
            p_expected_version_number: effectiveExpectedVersion,
            p_allergy_override_evidence: allergyOverrideEvidence,
          }
        : baseRpcArgs
    );

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicRegimenVersionUpdateRpc');
    }

    return this.getStateAsync();
  }

  public async changeMedicationStatusAsync(
    planId: string,
    status: MedicationPlanStatus,
    reason: string,
    effectiveDate: string = getActiveBaghdadDateStr()
  ): Promise<CrmState> {
    const cleanReason = reason.trim();
    if (cleanReason.length < 2) {
      throw new Error('Medication status change reason must be at least 2 characters.');
    }

    const rpcName = 'change_medication_plan_status';
    const { error } = await this.client.rpc(rpcName, {
      p_plan_id: planId,
      p_status: status,
      p_reason: cleanReason,
      p_effective_date: effectiveDate,
    });

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicMedicationStatusRpc');
    }

    return this.getStateAsync();
  }

  public async recordDispensingAsync(
    params: RecordDispensingInput,
    lang: Language
  ): Promise<{ state: CrmState; event: DispensingEvent | null }> {
    if (!Number.isFinite(params.dispensedQuantity) || params.dispensedQuantity <= 0) {
      throw new Error('Dispensed quantity must be a finite number greater than zero.');
    }

    const preState = await this.getStateAsync();
    const patient = preState.patients.find((p) => p.id === params.patientId);
    const plan = preState.medicationPlans.find(
      (m) => m.id === params.medicationPlanId && m.patientId === params.patientId
    );
    if (!patient || !plan) {
      throw new Error(
        `Cannot dispense: patient (${params.patientId}) or medication plan (${params.medicationPlanId}) was not found in active pharmacy state.`
      );
    }

    const dispValidation = validateDispensingInput(params, lang, {
      patient,
      plan,
      allowIncompatibleUnit: false,
    });
    if (!dispValidation.valid) {
      throw new Error(dispValidation.errors[0]);
    }

    const catalogRecord = plan.catalogId
      ? preState.medicationCatalog.find((c) => c.id === plan.catalogId)
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
      lang,
      {
        authoritativeCatalogOnly: true,
        catalogLookupFailed: preState.catalogLoadStatus !== 'loaded',
      }
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
    const allergyOverrideEvidence =
      allergyAssessment.requiresPharmacistAcknowledgment && params.allergyOverrideAuthorization
        ? buildAllergyOverrideEvidencePayload(
            allergyAssessment,
            params.allergyOverrideAuthorization,
            this.staffName
          )
        : null;

    // Exclude any already-committed row with the same clientEventUuid when projecting
    // cumulative refill metrics so network retries produce the exact same fingerprint.
    const priorEventsWithoutSelf = params.clientEventUuid
      ? preState.dispensingEvents.filter((d) => d.clientEventUuid !== params.clientEventUuid)
      : preState.dispensingEvents;

    const forecast = calculateDispensingForecast(
      plan,
      params.dispensedQuantity,
      params.dispensingDate,
      lang,
      params.quantityUnit
    );

    const pendingSyntheticEvent: DispensingEvent = {
      id: 'pending-fill',
      pharmacyId: this.pharmacyId,
      patientId: params.patientId,
      medicationPlanId: params.medicationPlanId,
      regimenVersionNumber: plan.currentVersionNumber,
      dispensedQuantity: params.dispensedQuantity,
      quantityUnit: params.quantityUnit.trim(),
      packageCount: params.packageCount,
      packageSize: params.packageSize,
      batchNumber: params.batchNumber?.trim() || undefined,
      expiryDate: params.expiryDate,
      dispensingDate: params.dispensingDate,
      dispensedByStaffId: this.userId,
      dispensedByStaffName: this.staffName,
      notes: params.notes?.trim() || undefined,
      estimatedDailyConsumption: forecast.estimatedDailyConsumption,
      estimatedSupplyDays: forecast.estimatedSupplyDays,
      estimatedSupplyEndDate: forecast.estimatedSupplyEndDate,
      forecastAssumptions: forecast.assumptionsText,
      isPartialFill: params.isPartialFill,
      createdAt: new Date().toISOString(),
    };

    const refDateStr =
      params.dispensingDate > getActiveBaghdadDateStr()
        ? params.dispensingDate
        : getActiveBaghdadDateStr();
    const projection = computeRefillProjection(
      plan,
      patient,
      [...priorEventsWithoutSelf, pendingSyntheticEvent],
      lang,
      refDateStr
    );

    const resolvedExpectedVersion =
      params.expectedRegimenVersionNumber ?? plan.currentVersionNumber;

    const effectiveRefillSnapshot: DispensingRefillSnapshotInput = params.refillSnapshot ?? {
      estimatedDailyConsumption: forecast.estimatedDailyConsumption,
      estimatedSupplyDays: forecast.estimatedSupplyDays,
      estimatedSupplyEndDate: forecast.estimatedSupplyEndDate,
      totalDispensedAnalyzed: projection.totalDispensedAnalyzed ?? params.dispensedQuantity,
      estimatedRemainingUnits: projection.estimatedRemainingUnits,
      estimatedDaysRemaining: projection.estimatedDaysRemaining,
      refillStatus: projection.refillStatus,
      refillSupplyEndDate: projection.estimatedSupplyEndDate,
      forecastAssumptions: forecast.assumptionsText,
      uncertaintyNote: projection.uncertaintyNote,
      calculationSource: 'provisional_client_unverified',
      algorithmVersion: 'masar_refill_v1',
    };

    const payloadHash =
      params.clientPayloadHash ??
      computeDispensingPayloadHash({
        patientId: params.patientId,
        medicationPlanId: params.medicationPlanId,
        dispensedQuantity: params.dispensedQuantity,
        quantityUnit: params.quantityUnit,
        packageCount: params.packageCount,
        packageSize: params.packageSize,
        batchNumber: params.batchNumber,
        expiryDate: params.expiryDate,
        dispensingDate: params.dispensingDate,
        isPartialFill: params.isPartialFill,
        notes: params.notes,
        expectedRegimenVersionNumber: resolvedExpectedVersion,
        allergyOverrideAuthorization:
          allergyOverrideEvidence ?? params.allergyOverrideAuthorization ?? null,
        refillSnapshot: effectiveRefillSnapshot,
      });

    if (params.clientEventUuid) {
      const existing = preState.dispensingEvents.find(
        (d) => d.clientEventUuid === params.clientEventUuid
      );
      if (existing) {
        const isV2Existing = existing.rpcVersion === 'v2';
        if (isV2Existing) {
          if (existing.hashVerificationStatus === 'v2_mismatch') {
            throw new Error(
              lang === 'ar'
                ? 'تعارض تكامل البصمة: بصمة العميل المحفوظة لا تطابق البصمة الخادمية للعملية.'
                : 'Idempotency integrity mismatch: persisted client and server payload hashes disagree.'
            );
          }
          const authoritativeHash = existing.clientPayloadHash ?? existing.serverPayloadHash;
          if (!authoritativeHash) {
            throw new Error(
              lang === 'ar'
                ? 'تعذر التحقق من عدم التكرار: السجل الخادمي يفتقر إلى بصمة الحمولة.'
                : 'Idempotency verification error: committed v2 dispensing record is missing its payload hash.'
            );
          }
          if (authoritativeHash !== payloadHash) {
            throw new Error(
              lang === 'ar'
                ? 'تعارض عدم التكرار: تم إعادة استخدام معرف العملية (clientEventUuid) مع تفاصيل صرف مختلفة.'
                : 'Idempotency conflict: clientEventUuid was reused with modified dispensing details.'
            );
          }
        } else if (existing.clientPayloadHash) {
          if (existing.clientPayloadHash !== payloadHash) {
            throw new Error(
              lang === 'ar'
                ? 'تعارض عدم التكرار: تم إعادة استخدام معرف العملية (clientEventUuid) مع تفاصيل صرف مختلفة.'
                : 'Idempotency conflict: clientEventUuid was reused with modified dispensing details.'
            );
          }
        } else {
          // Legacy 0004 row without persisted clientPayloadHash: compare core dispensing fields + version
          const legacyExistingHash = computeDispensingPayloadHash({
            patientId: existing.patientId,
            medicationPlanId: existing.medicationPlanId,
            dispensedQuantity: existing.dispensedQuantity,
            quantityUnit: existing.quantityUnit,
            packageCount: existing.packageCount,
            packageSize: existing.packageSize,
            batchNumber: existing.batchNumber,
            expiryDate: existing.expiryDate,
            dispensingDate: existing.dispensingDate,
            isPartialFill: existing.isPartialFill,
            notes: existing.notes,
            expectedRegimenVersionNumber: existing.regimenVersionNumber,
          });
          const legacyIncomingHash = computeDispensingPayloadHash({
            patientId: params.patientId,
            medicationPlanId: params.medicationPlanId,
            dispensedQuantity: params.dispensedQuantity,
            quantityUnit: params.quantityUnit,
            packageCount: params.packageCount,
            packageSize: params.packageSize,
            batchNumber: params.batchNumber,
            expiryDate: params.expiryDate,
            dispensingDate: params.dispensingDate,
            isPartialFill: params.isPartialFill,
            notes: params.notes,
            expectedRegimenVersionNumber: resolvedExpectedVersion,
          });
          if (legacyExistingHash !== legacyIncomingHash) {
            throw new Error(
              lang === 'ar'
                ? 'تعارض عدم التكرار: تم إعادة استخدام معرف العملية (clientEventUuid) مع تفاصيل صرف مختلفة.'
                : 'Idempotency conflict: clientEventUuid was reused with modified dispensing details.'
            );
          }
        }
        return { state: preState, event: existing };
      }
    }

    const capabilities = await this.detectBackendCapabilitiesAsync();
    const useV2 = capabilities.supportsV2DispensingIdempotency;
    if (useV2 && (!Number.isInteger(resolvedExpectedVersion) || resolvedExpectedVersion < 1)) {
      throw new Error('Expected regimen version number (>= 1) is required for v2 dispensing.');
    }

    const effectiveClientUuid =
      params.clientEventUuid && UUID_RE.test(params.clientEventUuid.trim())
        ? params.clientEventUuid.trim()
        : useV2
          ? generateEntityUuid()
          : params.clientEventUuid?.trim() || undefined;

    const rpcName = useV2
      ? 'record_dispensing_with_refill_v2'
      : 'record_dispensing_with_refill';
    const baseRpcArgs = {
      p_patient_id: params.patientId,
      p_medication_plan_id: params.medicationPlanId,
      p_dispensed_quantity: params.dispensedQuantity,
      p_quantity_unit: params.quantityUnit.trim(),
      p_package_count: params.packageCount ?? null,
      p_package_size: params.packageSize ?? null,
      p_batch_number: params.batchNumber?.trim() || null,
      p_expiry_date: params.expiryDate ?? null,
      p_dispensing_date: params.dispensingDate,
      p_is_partial_fill: params.isPartialFill,
      p_notes: params.notes?.trim() || null,
      p_estimated_daily_consumption: effectiveRefillSnapshot.estimatedDailyConsumption ?? null,
      p_estimated_supply_days: effectiveRefillSnapshot.estimatedSupplyDays ?? null,
      p_estimated_supply_end_date: effectiveRefillSnapshot.estimatedSupplyEndDate ?? null,
      p_forecast_assumptions:
        effectiveRefillSnapshot.forecastAssumptions ?? forecast.assumptionsText,
      p_total_dispensed_analyzed:
        effectiveRefillSnapshot.totalDispensedAnalyzed ?? params.dispensedQuantity,
      p_estimated_remaining_units: effectiveRefillSnapshot.estimatedRemainingUnits ?? null,
      p_estimated_days_remaining: effectiveRefillSnapshot.estimatedDaysRemaining ?? null,
      p_refill_status: effectiveRefillSnapshot.refillStatus ?? projection.refillStatus,
      p_refill_supply_end_date: effectiveRefillSnapshot.refillSupplyEndDate ?? null,
      p_uncertainty_note: effectiveRefillSnapshot.uncertaintyNote ?? projection.uncertaintyNote,
      p_calculation_source:
        effectiveRefillSnapshot.calculationSource ?? 'provisional_client_unverified',
      p_algorithm_version: effectiveRefillSnapshot.algorithmVersion ?? 'masar_refill_v1',
      p_calculation_inputs: {
        refDate: refDateStr,
        lang,
        regimenVersionNumber: plan.currentVersionNumber,
        expectedRegimenVersionNumber: resolvedExpectedVersion,
        scheduleFrequencyType: plan.schedule.frequencyType,
        dispensedQuantity: params.dispensedQuantity,
        quantityUnit: params.quantityUnit.trim(),
        clientPayloadHash: payloadHash,
        ...(effectiveClientUuid ? { clientSubmissionId: effectiveClientUuid } : {}),
        ...(allergyOverrideEvidence ? { allergyOverride: allergyOverrideEvidence } : {}),
      },
    };
    const { data: rpcData, error } = await this.client.rpc(
      rpcName,
      useV2
        ? {
            ...baseRpcArgs,
            p_expected_regimen_version_number: resolvedExpectedVersion,
            p_client_event_uuid: effectiveClientUuid,
            p_client_payload_hash: payloadHash,
            p_allergy_override_evidence: allergyOverrideEvidence,
          }
        : baseRpcArgs
    );

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicDispensingRpc');
    }

    const payload = rpcData as {
      ok?: boolean;
      dispensingEventId?: string;
      idempotentReplay?: boolean;
    } | null;
    const dispensingEventId = payload?.dispensingEventId;
    const state = await this.getStateAsync();
    const event = dispensingEventId
      ? state.dispensingEvents.find((d) => d.id === dispensingEventId) ?? null
      : null;

    return { state, event };
  }

  public async updateDoseEventStatusAsync(
    doseId: string,
    status: DoseConfirmationStatus,
    note?: string
  ): Promise<CrmState> {
    // 0002 grants column-level UPDATE (status, patient_note) ONLY on dose_events.
    // Triggers automatically enforce server confirmed_at / updated_at.
    const patch: Record<string, unknown> = { status };
    if (note !== undefined) {
      patch.patient_note = note.trim() || null;
    }

    const { error } = await this.client
      .from('dose_events')
      .update(patch)
      .eq('id', doseId)
      .eq('pharmacy_id', this.pharmacyId);
    assertNoError(error, 'update dose_events');
    return this.getStateAsync();
  }

  public async addLabResultAsync(data: LabResultInput): Promise<CrmState> {
    const { error } = await this.client.from('lab_results').insert({
      pharmacy_id: this.pharmacyId,
      patient_id: data.patientId,
      test_name: data.testName.trim(),
      value: data.value.trim(),
      unit: data.unit.trim(),
      reference_range: data.referenceRange.trim() || '—',
      is_abnormal: data.isAbnormal,
      test_date: data.testDate,
      notes: data.notes?.trim() || null,
      recorded_by_staff_id: this.userId,
      recorded_by_staff_name: this.staffName,
    });
    assertNoError(error, 'insert lab_results');
    return this.getStateAsync();
  }

  public async addFollowUpAsync(data: FollowUpInput): Promise<CrmState> {
    const { error } = await this.client.from('follow_up_tasks').insert({
      pharmacy_id: this.pharmacyId,
      patient_id: data.patientId,
      related_medication_plan_id: toOptionalUuid(data.relatedMedicationPlanId),
      type: data.type,
      due_date: data.dueDate,
      status: data.status,
      notes: data.notes.trim(),
      assigned_staff_id: this.userId,
      assigned_staff_name: data.assignedStaffName.trim() || this.staffName,
    });
    assertNoError(error, 'insert follow_up_tasks');
    return this.getStateAsync();
  }

  public async updateFollowUpStatusAsync(
    followUpId: string,
    status: FollowUpStatus
  ): Promise<CrmState> {
    const { error } = await this.client
      .from('follow_up_tasks')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', followUpId)
      .eq('pharmacy_id', this.pharmacyId);
    assertNoError(error, 'update follow_up_tasks status');
    return this.getStateAsync();
  }

  public async addFollowUpContactLogAsync(
    followUpId: string,
    log: ContactLogInput
  ): Promise<CrmState> {
    const { error } = await this.client.from('follow_up_contact_logs').insert({
      pharmacy_id: this.pharmacyId,
      follow_up_task_id: followUpId,
      channel: log.channel,
      outcome: log.outcome,
      summary: log.summary.trim(),
      staff_id: this.userId,
      staff_name: this.staffName,
    });
    assertNoError(error, 'insert follow_up_contact_logs');
    return this.getStateAsync();
  }

  public async sendConsultationReplyAsync(
    threadId: string,
    body: string,
    newStatus?: ConsultationStatus
  ): Promise<CrmState> {
    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error('Reply body cannot be empty.');
    }

    const rpcName = 'send_consultation_reply';
    const { error } = await this.client.rpc(rpcName, {
      p_thread_id: threadId,
      p_body: trimmed,
      p_new_status: newStatus ?? null,
    });

    if (error) {
      throwMappedRpcError(error, rpcName, 'atomicConsultationReplyRpc');
    }

    return this.getStateAsync();
  }

  public async updateConsultationStatusAsync(
    threadId: string,
    status: ConsultationStatus
  ): Promise<CrmState> {
    const { error } = await this.client
      .from('consultation_threads')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', threadId)
      .eq('pharmacy_id', this.pharmacyId);
    assertNoError(error, 'update consultation thread status');
    return this.getStateAsync();
  }

  public async issueInvitationAsync(
    _patientId: string,
    _method: 'national_id_last4' | 'dob_and_phone_otp',
    _refDateStr?: string
  ): Promise<{ state: CrmState; invitation: PatientApkInvitation | null }> {
    throw new Stage2bSqlDependencyError(
      'patientActivationStage2c',
      'Patient APK invitation issuance is disabled in Connected Mode until Stage 2C scannable QR generation, SMS OTP delivery, and recovery Edge Functions are implemented.'
    );
  }

  public async revokeInvitationAsync(
    patientId: string,
    reason: string = 'Pharmacist revoked pending invitation'
  ): Promise<CrmState> {
    const cleanReason =
      reason.trim().length >= 3 ? reason.trim() : 'Pharmacist revoked pending invitation';

    const rpcName = 'revoke_patient_apk_invitation';
    const { data, error } = await this.client.rpc(rpcName, {
      p_patient_id: patientId,
      p_reason: cleanReason,
    });

    if (error) {
      throwMappedRpcError(error, rpcName, 'revokeInvitationRpc');
    }

    const payload = data as { ok?: boolean; errorCode?: string } | null;
    if (payload && payload.ok === false) {
      throw new Error(`Invitation revocation rejected: ${payload.errorCode ?? 'UNKNOWN_ERROR'}`);
    }

    return this.getStateAsync();
  }
}
