import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { calculateAge } from '../i18n/translations';
import {
  FixedBaghdadClock,
  formatBaghdadDate,
  formatBaghdadTime,
  getActiveClock,
  isDemoClockModeEnabled,
  LiveBaghdadClock,
  msUntilNextBaghdadMidnight,
  resolveRuntimeClockMode,
  setActiveClock,
} from '../services/clockService';
import {
  AsyncInMemoryCrmRepository,
  computeDashboardKpis,
  findDuplicatePatientMatch,
  generateEntityUuid,
  InMemoryCrmAdapter,
} from '../services/crmRepository';
import {
  areUnitsCompatibleForRefill,
  calculateDispensingForecast,
  computeRefillProjection,
  simulateSupplyDepletionFromOccurrences,
} from '../services/scheduleEngine';
import { SUPABASE_STAGE2_SCHEMA_SPEC } from '../types/supabaseSchemaSpec';

console.log('===================================================================');
console.log('MASAR Care — Independent Source Audit Remediation Suite (Stage A+B)');
console.log('===================================================================');

let passedSuites = 0;

// ============================================================================
// SUITE 1: H1 & F3/F4 — Timezone-Aware Asia/Baghdad Clock, Midnight & Resume
// ============================================================================
{
  // Before Baghdad midnight: 2026-11-12T20:59:59Z == 2026-11-12T23:59:59+03:00
  const justBeforeBaghdadMidnight = new Date('2026-11-12T20:59:59.000Z');
  // After Baghdad midnight: 2026-11-12T21:00:01Z == 2026-11-13T00:00:01+03:00
  const justAfterBaghdadMidnight = new Date('2026-11-12T21:00:01.000Z');

  assert.equal(formatBaghdadDate(justBeforeBaghdadMidnight), '2026-11-12');
  assert.equal(formatBaghdadTime(justBeforeBaghdadMidnight), '23:59');
  assert.equal(
    msUntilNextBaghdadMidnight(justBeforeBaghdadMidnight) <= 2500,
    true,
    'Midnight timer helper must return <= 2.5s when 1s before Baghdad midnight'
  );

  assert.equal(
    formatBaghdadDate(justAfterBaghdadMidnight),
    '2026-11-13',
    'Baghdad clock must roll over to 2026-11-13 at 21:00 UTC (00:00+03:00)'
  );
  assert.equal(
    formatBaghdadTime(justAfterBaghdadMidnight),
    '00:00',
    'Baghdad time must format as 00:00 in 24-hour local time'
  );

  // Simulated clock advancing across midnight (equivalent to midnight timer or foreground/resume sync)
  let simulatedNow = justBeforeBaghdadMidnight;
  const liveClock = new LiveBaghdadClock(() => simulatedNow);
  setActiveClock(liveClock);
  assert.equal(getActiveClock().todayDateStr(), '2026-11-12');
  assert.equal(getActiveClock().mode, 'live_baghdad');

  // Verify calculateAge honors active clock across a birthday boundary
  assert.equal(calculateAge('1980-11-13'), 45, 'Before birthday (Nov 12) age must be 45');

  // Advance across Baghdad midnight (app resume / midnight tick)
  simulatedNow = justAfterBaghdadMidnight;
  assert.equal(getActiveClock().todayDateStr(), '2026-11-13');
  assert.equal(calculateAge('1980-11-13'), 46, 'On birthday (Nov 13) age must increment to 46');

  // Verify invitation issuance & 7-day expiry use active Baghdad clock instead of fixed 2026-11-12
  const adapter = new InMemoryCrmAdapter();
  const targetPatient = adapter.getState().patients[0];
  const { invitation } = adapter.issueInvitation(targetPatient.id, 'dob_and_phone_otp');
  assert.ok(invitation?.issuedAt && invitation?.expiresAt, 'Invitation timestamps must be issued');
  assert.ok(
    invitation.issuedAt.startsWith('2026-11-13'),
    `Invitation issuedAt must follow live Baghdad date 2026-11-13, got ${invitation.issuedAt}`
  );
  assert.ok(
    invitation.expiresAt.startsWith('2026-11-20'),
    `Invitation expiresAt must be +7 days (2026-11-20), got ${invitation.expiresAt}`
  );

  // Verify archiving uses live Baghdad clock by default
  const archivedState = adapter.archivePatient(targetPatient.id, 'Moved pharmacy');
  const archivedPat = archivedState.patients.find((p) => p.id === targetPatient.id);
  assert.equal(archivedPat?.archivedAt, '2026-11-13');

  // Verify dispensing forecast + refill projection react to Baghdad date progression
  const freshAdapter = new InMemoryCrmAdapter();
  const kpisOn12 = computeDashboardKpis(freshAdapter.getState(), 'ar', '2026-11-12');
  const kpisOn13 = computeDashboardKpis(freshAdapter.getState(), 'ar', '2026-11-13');
  assert.ok(
    kpisOn12.todaysDispensingCount >= 1 && kpisOn13.todaysDispensingCount === 0,
    'Dashboard KPIs must dynamically reflect the injected Baghdad reference date'
  );

  // Refill projection shifts remaining days between Nov 12 and Nov 13 when called with active clock
  const { patient: refillPat } = freshAdapter.addPatient({
    patientCode: 'MC-CLK-1',
    fullName: 'اختبار منتصف الليل',
    phone: '07703334455',
    dateOfBirth: '1975-05-01',
    sex: 'male',
    chronicConditions: ['السكري'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: '',
    registrationDate: '2026-11-12',
  });
  const { plan: refillPlan } = freshAdapter.addMedicationPlan({
    patientId: refillPat.id,
    brandName: 'Metformin',
    genericName: 'Metformin',
    strength: '500mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: 'قرص واحد يومياً',
    startDate: '2026-11-10',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 's1', time24: '08:00', doseAmount: 1 }],
      timezone: 'Asia/Baghdad',
    },
  });
  const { event: refillDisp } = freshAdapter.recordDispensing(
    {
      patientId: refillPat.id,
      medicationPlanId: refillPlan.id,
      dispensedQuantity: 10,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-10',
      isPartialFill: false,
    },
    'en'
  );
  assert.ok(refillDisp);
  simulatedNow = justBeforeBaghdadMidnight;
  const projNov12 = computeRefillProjection(refillPlan, refillPat, [refillDisp], 'en');
  simulatedNow = justAfterBaghdadMidnight;
  const projNov13 = computeRefillProjection(refillPlan, refillPat, [refillDisp], 'en');
  assert.equal(
    (projNov12.estimatedDaysRemaining ?? 0) - (projNov13.estimatedDaysRemaining ?? 0),
    1,
    'Refill days remaining must decrement by 1 across Baghdad midnight'
  );

  // Restore deterministic fixed fixture clock for subsequent tests
  const fixtureClock = new FixedBaghdadClock('2026-11-12', '14:00');
  setActiveClock(fixtureClock);
  assert.equal(getActiveClock().todayDateStr(), '2026-11-12');
  assert.equal(getActiveClock().mode, 'fixed_fixture');

  // V1.5.4-QA: Production clinical builds (DEV=false or PROD=true) CANNOT enable fixed_fixture even if VITE_ENABLE_DEMO_CLOCK='true'
  assert.equal(isDemoClockModeEnabled({ DEV: false, VITE_ENABLE_DEMO_CLOCK: 'false' }), false);
  assert.equal(isDemoClockModeEnabled({ DEV: false, VITE_ENABLE_DEMO_CLOCK: 'true' }), false);
  assert.equal(
    isDemoClockModeEnabled({ PROD: true, DEV: false, VITE_ENABLE_DEMO_CLOCK: 'true' }),
    false
  );
  assert.equal(resolveRuntimeClockMode('fixed_fixture', false), 'live_baghdad');
  assert.equal(isDemoClockModeEnabled({ DEV: true }), true);
  assert.equal(isDemoClockModeEnabled({ DEV: true, VITE_DISABLE_DEMO_CLOCK: 'true' }), false);
  assert.equal(resolveRuntimeClockMode('fixed_fixture', true), 'fixed_fixture');

  passedSuites++;
  console.log(
    '[PASS] Suite 1 (H1/F3/F4/M1): Live Asia/Baghdad clock, midnight rollover, production demo-mode gate, invitations & refill transitions verified'
  );
}

// ============================================================================
// SUITE 2: H2 — Async Repository Contract, Error Boundary & RFC 4122 UUIDs
// ============================================================================
async function runAsyncRepoSuite() {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const sampleUuid = generateEntityUuid();
  assert.match(sampleUuid, uuidRegex, 'generateEntityUuid() must return RFC 4122 v4 UUID');

  const syncAdapter = new InMemoryCrmAdapter();
  const asyncRepo = new AsyncInMemoryCrmRepository(syncAdapter, 5);

  const { patient } = await asyncRepo.addPatientAsync({
    patientCode: 'MC-950',
    fullName: 'سعدون العبيدي',
    phone: '07701122334',
    phoneOwnerType: 'self',
    dateOfBirth: '1968-04-12',
    sex: 'male',
    chronicConditions: ['ارتفاع ضغط الدم'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: 'مراجع جديد لاختبار UUID',
    registrationDate: '2026-11-12',
  });

  assert.match(patient.id, uuidRegex, 'Created Patient ID must be a valid RFC 4122 UUID');

  const { plan } = await asyncRepo.addMedicationPlanAsync({
    patientId: patient.id,
    brandName: 'Concor',
    genericName: 'Bisoprolol',
    strength: '5mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: 'قرص واحد صباحاً',
    startDate: '2026-11-12',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 's1', time24: '08:00', doseAmount: 1 }],
      timezone: 'Asia/Baghdad',
    },
  });
  assert.match(plan.id, uuidRegex, 'Created MedicationPlan ID must be a valid RFC 4122 UUID');

  const { event } = await asyncRepo.recordDispensingAsync(
    {
      patientId: patient.id,
      medicationPlanId: plan.id,
      dispensedQuantity: 30,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-12',
      isPartialFill: false,
    },
    'en'
  );
  assert.ok(event, 'Dispensing event must be recorded via async repository');
  assert.match(event.id, uuidRegex, 'Created DispensingEvent ID must be a valid RFC 4122 UUID');

  // Verify error propagation when remote repository fails
  asyncRepo.injectNextError(new Error('SUPABASE_NETWORK_TIMEOUT'));
  let caughtError: Error | null = null;
  try {
    await asyncRepo.getStateAsync();
  } catch (err) {
    caughtError = err as Error;
  }
  assert.ok(caughtError, 'AsyncInMemoryCrmRepository must propagate injected network errors');
  assert.equal(caughtError.message, 'SUPABASE_NETWORK_TIMEOUT');

  passedSuites++;
  console.log('[PASS] Suite 2 (H2): Async repository contract, error handling & RFC 4122 UUIDs verified');
}

// ============================================================================
// SUITE 3: H7 — Finite Treatment Courses, Surplus Stock & Unit Compatibility
// ============================================================================
function runFiniteAndSurplusRefillSuite() {
  const adapter = new InMemoryCrmAdapter();
  const { patient } = adapter.addPatient({
    patientCode: 'MC-951',
    fullName: 'ليلى الكاظمي',
    phone: '07801122334',
    dateOfBirth: '1980-09-01',
    sex: 'female',
    chronicConditions: [],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: '',
    registrationDate: '2026-11-01',
  });

  // 3A. Finite 7-day antibiotic course (2026-11-01 to 2026-11-07, 1 tablet twice daily = 14 tablets total)
  const { plan: finitePlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Augmentin',
    genericName: 'Amoxicillin / Clavulanate',
    strength: '1g',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: 'قرص كل 12 ساعة لمدة 7 أيام فقط',
    startDate: '2026-11-01',
    endDate: '2026-11-07',
    isOngoing: false,
    durationDays: 7,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 2,
      doseSlots: [
        { id: 's1', time24: '08:00', doseAmount: 1 },
        { id: 's2', time24: '20:00', doseAmount: 1 },
      ],
      timezone: 'Asia/Baghdad',
    },
  });

  // Dispense exact 14 tablets for the 7-day finite course
  const finiteForecast = calculateDispensingForecast(finitePlan, 14, '2026-11-01', 'en', 'tablet');
  assert.equal(
    finiteForecast.estimatedSupplyEndDate,
    null,
    'Finite course with full 14-tablet supply must NOT invent a refill date after endDate'
  );

  const { event: finiteDisp } = adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: finitePlan.id,
      dispensedQuantity: 14,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  assert.ok(finiteDisp);

  const finiteProjMidCourse = computeRefillProjection(
    finitePlan,
    patient,
    [finiteDisp],
    'en',
    '2026-11-04'
  );
  assert.equal(
    finiteProjMidCourse.estimatedSupplyEndDate,
    null,
    'Mid-course projection for fully supplied finite regimen must have estimatedSupplyEndDate = null'
  );
  assert.equal(finiteProjMidCourse.refillStatus, 'on_track');

  // Partial dispense of only 6 tablets (3 days) on a 7-day finite course MUST project depletion on day 4 (2026-11-04)
  const partialSim = simulateSupplyDepletionFromOccurrences(finitePlan, '2026-11-01', 6);
  assert.equal(
    partialSim.estimatedSupplyEndDate,
    '2026-11-04',
    'Under-dispensed finite course (6 of 14 tablets) must still flag depletion on 2026-11-04'
  );

  // 3B. Long-term surplus stock exceeding the 3650-day horizon must NOT invent a horizon+1 refill date
  const { plan: chronicPlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Euthyrox',
    genericName: 'Levothyroxine',
    strength: '50mcg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'before_food',
    verifiedInstructions: 'قرص صباحاً قبل الإفطار',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 's1', time24: '07:00', doseAmount: 1 }],
      timezone: 'Asia/Baghdad',
    },
  });

  const surplusSim = simulateSupplyDepletionFromOccurrences(chronicPlan, '2026-11-01', 5000);
  assert.equal(surplusSim.noDepletionWithinPlan, true);
  assert.equal(
    surplusSim.estimatedSupplyEndDate,
    null,
    'Surplus stock exceeding 3650-day horizon must return null end date instead of horizon clamp'
  );

  // 3C. Incompatible doseUnit vs dispensed quantityUnit must return unable_to_estimate
  assert.equal(areUnitsCompatibleForRefill('قرص', 'tablet'), true);
  assert.equal(areUnitsCompatibleForRefill('بخة', 'مل'), false);

  const mismatchProj = computeRefillProjection(
    chronicPlan,
    patient,
    [
      {
        ...finiteDisp,
        id: generateEntityUuid(),
        medicationPlanId: chronicPlan.id,
        dispensedQuantity: 100,
        quantityUnit: 'mL', // incompatible with 'tablet'
        dispensingDate: '2026-11-01',
      },
    ],
    'en',
    '2026-11-12'
  );
  assert.equal(
    mismatchProj.refillStatus,
    'unable_to_estimate',
    'Incompatible dispensing unit (mL vs tablet) must return unable_to_estimate'
  );
  assert.equal(mismatchProj.estimatedSupplyEndDate, null);

  passedSuites++;
  console.log('[PASS] Suite 3 (H7): Finite courses, surplus stock & unit compatibility guards verified');
}

// ============================================================================
// SUITE 4: H5 — Shared Family / Caregiver Phone Number Support
// ============================================================================
function runSharedFamilyPhoneSuite() {
  const adapter = new InMemoryCrmAdapter();
  const sharedCaregiverPhone = '07709998877';

  const { patient: parent1 } = adapter.addPatient({
    patientCode: 'MC-961',
    fullName: 'الحاج محمود العاني',
    phone: sharedCaregiverPhone,
    phoneOwnerType: 'caregiver',
    caregiverName: 'علي محمود (الابن)',
    dateOfBirth: '1952-03-10',
    sex: 'male',
    chronicConditions: ['السكري النوع الثاني'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: '',
    registrationDate: '2026-11-12',
  });

  // Duplicate check warns pharmacist that the phone is shared, while registration is permitted
  const dupCheck = findDuplicatePatientMatch(adapter.getState().patients, {
    patientCode: 'MC-962',
    phone: sharedCaregiverPhone,
    fullName: 'الحاجة سعاد العاني',
    dateOfBirth: '1956-07-22',
  });
  assert.equal(
    dupCheck.phoneConflict?.id,
    parent1.id,
    'Duplicate detector must surface shared phone warning for pharmacist confirmation'
  );

  const { patient: parent2 } = adapter.addPatient({
    patientCode: 'MC-962',
    fullName: 'الحاجة سعاد العاني',
    phone: sharedCaregiverPhone,
    phoneOwnerType: 'family_shared',
    caregiverName: 'علي محمود (الابن)',
    dateOfBirth: '1956-07-22',
    sex: 'female',
    chronicConditions: ['ارتفاع ضغط الدم'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: '',
    registrationDate: '2026-11-12',
  });

  assert.equal(parent1.phone, parent2.phone);
  assert.equal(parent1.phoneOwnerType, 'caregiver');
  assert.equal(parent2.phoneOwnerType, 'family_shared');

  const patientsSpec = SUPABASE_STAGE2_SCHEMA_SPEC.find((t) => t.tableName === 'patients');
  assert.ok(patientsSpec);
  assert.ok(
    !patientsSpec.uniqueConstraints.includes('(pharmacy_id, phone)'),
    'patients table spec must NOT enforce hard UNIQUE(pharmacy_id, phone) blocking family members'
  );

  passedSuites++;
  console.log('[PASS] Suite 4 (H5): Shared caregiver/family phone numbers & warning workflow verified');
}

// ============================================================================
// SUITE 5: Stage A SQL Draft Static Verification (C1, C2, C3, C4, H3, H4, H6, H8, M6, M7)
// ============================================================================
function runSqlDraftStaticVerificationSuite() {
  const mig1Path = path.resolve(process.cwd(), 'supabase/migrations/0001_stage2a_core_schema.sql');
  const mig2Path = path.resolve(
    process.cwd(),
    'supabase/migrations/0002_stage2a_rls_and_security.sql'
  );
  const testSqlPath = path.resolve(
    process.cwd(),
    'supabase/tests/stage2a_negative_security_and_integrity.test.sql'
  );

  const mig1 = fs.readFileSync(mig1Path, 'utf8');
  const mig2 = fs.readFileSync(mig2Path, 'utf8');
  const testSql = fs.readFileSync(testSqlPath, 'utf8');

  // C4: Composite patient + medication_plan uniqueness & FKs
  assert.ok(
    mig1.includes('UNIQUE (id, patient_id, pharmacy_id)'),
    '0001 must define UNIQUE (id, patient_id, pharmacy_id) on patient_medication_plans (C4)'
  );
  assert.ok(
    mig1.includes('FOREIGN KEY (medication_plan_id, patient_id, pharmacy_id)') &&
      mig1.includes('REFERENCES public.patient_medication_plans(id, patient_id, pharmacy_id)'),
    '0001 must enforce composite FK (medication_plan_id, patient_id, pharmacy_id) across child tables (C4)'
  );

  // H5: No UNIQUE(pharmacy_id, phone) on patients; phone_owner_type present
  const patientsTableBlock =
    mig1.split('CREATE TABLE public.patients (')[1]?.split(');')[0] ?? '';
  assert.ok(
    patientsTableBlock.length > 0 && !patientsTableBlock.includes('UNIQUE (pharmacy_id, phone)'),
    '0001 must remove hard UNIQUE (pharmacy_id, phone) on patients (H5)'
  );
  assert.ok(
    patientsTableBlock.includes("phone_owner_type text NOT NULL DEFAULT 'self'"),
    '0001 must include phone_owner_type on patients (H5)'
  );

  // H6: Column-specific ON DELETE SET NULL
  assert.ok(
    mig1.includes('ON DELETE SET NULL (scheduled_dose_id)') &&
      mig1.includes('ON DELETE SET NULL (last_dispensing_event_id)') &&
      mig1.includes('ON DELETE SET NULL (related_medication_plan_id)'),
    '0001 must use PostgreSQL 15+ column-specific ON DELETE SET NULL (...) so non-nullable tenant keys never fail (H6)'
  );

  // H8: Invitation purpose & recovery ceremony
  assert.ok(
    mig1.includes("invitation_purpose IN ('initial_activation', 'device_replacement_recovery')"),
    '0001 must support invitation_purpose for explicit recovery ceremony (H8)'
  );

  // M6 & F2: Concurrency-safe btree_gist exclusion constraint + SQLSTATE 23P01 pause trigger & provenance
  assert.ok(
    mig1.includes('CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA extensions;') &&
      mig1.includes('CONSTRAINT ex_medication_pause_periods_no_overlap') &&
      mig1.includes("USING ERRCODE = '23P01'") &&
      mig1.includes('trg_pause_periods_no_overlap') &&
      mig1.includes('trg_dose_events_provenance'),
    '0001 must enforce btree_gist exclusion constraint (23P01) in extensions schema and provenance triggers (M6, F2, H3)'
  );

  // V1.5.4 H1: Scheduled-dose provenance + confirm_scheduled_dose RPC + unscheduled_dose_reports separation
  assert.ok(
    mig1.includes('CREATE TABLE public.unscheduled_dose_reports') &&
      mig1.includes('is_verified_schedule boolean NOT NULL DEFAULT false CHECK (is_verified_schedule = false)') &&
      mig1.includes('NEW.scheduled_dose_id IS NULL') &&
      mig1.includes('NEW.planned_dose_amount := v_sd.planned_dose_amount;') &&
      mig2.includes('CREATE OR REPLACE FUNCTION public.confirm_scheduled_dose(') &&
      mig2.includes('DUPLICATE_DOSE_CONFIRMATION_BLOCKED') &&
      !mig2.includes('CREATE POLICY dose_events_patient_confirm'),
    '0001/0002 must enforce scheduled-dose provenance, confirm_scheduled_dose RPC, and separate unscheduled_dose_reports (H1)'
  );

  // V1.5.4 H2: No global REVOKE ALL ON ALL TABLES/SEQUENCES IN SCHEMA public
  assert.ok(
    !mig2.includes('REVOKE ALL ON ALL TABLES IN SCHEMA public') &&
      !mig2.includes('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public') &&
      mig2.includes('REVOKE ALL ON TABLE public.unscheduled_dose_reports FROM PUBLIC, anon, authenticated;'),
    '0002 must scope REVOKE statements strictly to enumerated MASAR tables (H2)'
  );

  // M7, H3 & F9: Private app_security schema + CSPRNG unbiased rejection sampling + schema-qualified extensions.*
  assert.ok(
    mig2.includes('CREATE SCHEMA IF NOT EXISTS app_security;') &&
      mig2.includes('app_security.generate_csprng_6digit_code()') &&
      mig2.includes('extensions.gen_random_bytes(4)') &&
      mig2.includes('extensions.digest(') &&
      mig2.includes('extensions.crypt(') &&
      mig2.includes('extensions.gen_salt(') &&
      mig2.includes('2147400000') &&
      mig2.includes('EXIT WHEN v_raw < v_limit;'),
    '0002 must use unbiased rejection sampling and schema-qualified extensions.* pgcrypto calls (H3, M7, F9)'
  );
  assert.ok(
    !mig2.includes('floor(random()'),
    '0002 must NOT use non-cryptographic random() for PIN or OTP generation (H3)'
  );

  // C1, C2, C3, H4: Non-rollback JSONB returns + request_invitation_sms_otp + owner-approved recovery ceremony
  assert.ok(
    mig2.includes('CREATE OR REPLACE FUNCTION public.request_invitation_sms_otp(') &&
      mig2.includes('p_bootstrap_auth_user_id uuid') &&
      mig2.includes('RECOVERY_REQUIRES_PHARMACY_OWNER_APPROVAL') &&
      mig2.includes('RECOVERY_IDENTITY_VERIFICATION_REQUIRED') &&
      mig1.includes('approved_by_owner_id uuid'),
    '0001/0002 must enforce owner-approved & identity-verified device recovery (C3, H4)'
  );
  assert.ok(
    mig2.includes(
      'REVOKE ALL ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;'
    ) &&
      mig2.includes(
        'GRANT EXECUTE ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) TO service_role;'
      ),
    '0002 must restrict redeem_patient_apk_invitation execution to service_role only (C2)'
  );

  // Verify F1, F8 & V1.5.4 H1/H4 SQL test coverage in negative SQL test file
  assert.ok(
    testSql.includes('INSERT INTO auth.users') &&
      testSql.includes('INSERT INTO public.pharmacy_staff') &&
      testSql.includes('license_number') &&
      testSql.includes('scheduled_time24') &&
      testSql.includes('dispensing_date') &&
      !testSql.includes('full_name_ar') &&
      !testSql.includes('owner_Display_name') &&
      testSql.includes('SET LOCAL ROLE authenticated') &&
      testSql.includes('SET LOCAL ROLE anon') &&
      testSql.includes('TEST FAILURE [F8]') &&
      testSql.includes('TEST FAILURE [C4]') &&
      testSql.includes('TEST FAILURE [C1]') &&
      testSql.includes('TEST FAILURE [C2]') &&
      testSql.includes('TEST FAILURE [H1]') &&
      testSql.includes('TEST FAILURE [H4-RECOVERY]'),
    'stage2a_negative_security_and_integrity.test.sql must align with 0001/0002 DDL and cover V1.5.4 H1/H4 negative tests'
  );

  // Verify F3/F4 & M1: Zero runtime APP_REFERENCE_DATE references and production demo-clock gate
  const srcTranslations = fs.readFileSync(
    path.resolve(process.cwd(), 'src/i18n/translations.ts'),
    'utf8'
  );
  const srcCrmCtx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/context/CrmContext.tsx'),
    'utf8'
  );
  assert.ok(
    !srcTranslations.includes('APP_REFERENCE_DATE') &&
      srcCrmCtx.includes("initialClockMode = 'live_baghdad'") &&
      srcCrmCtx.includes('resolveRuntimeClockMode'),
    'Runtime source must remove APP_REFERENCE_DATE, default to live_baghdad, and gate fixed_fixture mode (F3, F4, M1)'
  );

  // V1.5.4-QA: Explicit trigger rejection of is_verified_schedule != false (23514),
  // concurrent confirm_scheduled_dose serialization + unique_violation handling,
  // non-reused unscheduled client_event_uuid test fixtures, and repaired two-session concurrency harness.
  const concTestPath = path.resolve(
    process.cwd(),
    'supabase/tests/stage2a_concurrency_and_retry.test.sql'
  );
  const concRunnerPath = path.resolve(
    process.cwd(),
    'supabase/tests/run_stage2a_concurrency_and_retry.sh'
  );
  assert.ok(
    fs.existsSync(concTestPath) && fs.existsSync(concRunnerPath),
    'Both stage2a_concurrency_and_retry.test.sql and run_stage2a_concurrency_and_retry.sh must exist'
  );
  const concTestSql = fs.readFileSync(concTestPath, 'utf8');
  const concSqlNoComments = concTestSql.replace(/--.*$/gm, '');
  const concRunnerSh = fs.readFileSync(concRunnerPath, 'utf8');

  assert.ok(
    concSqlNoComments.includes('license_number') &&
      concSqlNoComments.includes('syndicate_license') &&
      concSqlNoComments.includes('is_active') &&
      concSqlNoComments.includes('created_by_staff_id') &&
      concSqlNoComments.includes('auth_linked_at') &&
      !concSqlNoComments.includes('account_status') &&
      !concSqlNoComments.includes('account_activated_at') &&
      !/DELETE\s+FROM\s+public\.regimen_versions/i.test(concSqlNoComments) &&
      concSqlNoComments.includes('v_cnt_a <> 1') &&
      concSqlNoComments.includes('v_cnt_b <> 1') &&
      concSqlNoComments.includes('v_cnt_c_total <> 1') &&
      concSqlNoComments.includes('HARNESS USAGE ERROR'),
    'stage2a_concurrency_and_retry.test.sql must match 0001 columns, omit illegal regimen_versions DELETE, and enforce count=1 assertions'
  );

  assert.ok(
    concRunnerSh.includes('MASAR_DISPOSABLE_DEV_APPROVED') &&
      concRunnerSh.includes('MASAR_EXPECTED_DB_NAME') &&
      concRunnerSh.includes('MASAR_EXPECTED_DB_HOST') &&
      concRunnerSh.includes('run_two_workers "case_a"') &&
      concRunnerSh.includes('run_two_workers "case_b"') &&
      concRunnerSh.includes('run_two_workers "case_c"') &&
      concRunnerSh.includes('DUPLICATE_DOSE_CONFIRMATION_BLOCKED') &&
      concRunnerSh.includes('CLIENT_EVENT_UUID_CONFLICT'),
    'run_stage2a_concurrency_and_retry.sh must enforce production-refusal guards and execute parallel Cases A, B, and C'
  );

  assert.ok(
    mig1.includes('IF NEW.is_verified_schedule IS DISTINCT FROM false THEN') &&
      mig1.includes("USING ERRCODE = '23514';") &&
      mig2.includes('pg_catalog.pg_advisory_xact_lock(') &&
      mig2.includes("'masar_confirm_sd:'") &&
      mig2.includes("'masar_confirm_ev:'") &&
      mig2.includes('EXCEPTION WHEN unique_violation THEN'),
    '0001/0002 must reject supplied true on unscheduled_dose_reports (23514) and handle concurrent confirm_scheduled_dose retries cleanly'
  );

  assert.ok(
    testSql.includes('v_ev_uuid_unsched_bad') &&
      testSql.includes('v_ev_uuid_unsched_ok1') &&
      testSql.includes('v_ev_uuid_unsched_ok2') &&
      !testSql.includes('v_ev_uuid_unsched,') &&
      testSql.includes('UNVERIFIED POSTGRESQL / SUPABASE RUNTIME ASSUMPTIONS'),
    'stage2a_negative_security_and_integrity.test.sql must use distinct unscheduled UUIDs and document pending SET LOCAL ROLE validation'
  );

  const pkgJsonRaw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
  const pkgJson = JSON.parse(pkgJsonRaw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(
    pkgJson.devDependencies?.esbuild,
    undefined,
    'package.json must not declare conflicting direct esbuild ^0.25.0 devDependency alongside Vite 8'
  );

  passedSuites++;
  console.log(
    '[PASS] Suite 5 (Stage A+V1.5.4-QA Static): Draft migrations 0001/0002, concurrency handling, unscheduled SQL test reconciliation, scoped grants & production boundary verified'
  );
}

async function main() {
  await runAsyncRepoSuite();
  runFiniteAndSurplusRefillSuite();
  runSharedFamilyPhoneSuite();
  runSqlDraftStaticVerificationSuite();
  console.log('-------------------------------------------------------------------');
  console.log(`ALL ${passedSuites}/5 AUDIT REMEDIATION TEST SUITES PASSED.`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
