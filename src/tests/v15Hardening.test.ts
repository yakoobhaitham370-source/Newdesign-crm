import assert from 'node:assert/strict';
import {
  BAGHDAD_TIMEZONE,
  getBaghdadTodayDateStr,
  isValidIraqiPhone,
  normalizeIraqiPhone,
} from '../i18n/translations';
import {
  computeAllRefillProjections,
  computeDashboardKpis,
  findDuplicateActiveMedication,
  findDuplicatePatientMatch,
  findRecentDuplicateDispensing,
  InMemoryCrmAdapter,
} from '../services/crmRepository';
import {
  calculateDispensingForecast,
  computeDailyConsumption,
  computeRefillProjection,
  generateScheduledOccurrences,
  getBaghdadWeekday,
  validateSchedule,
} from '../services/scheduleEngine';
import { SUPABASE_STAGE2_SCHEMA_SPEC } from '../types/supabaseSchemaSpec';
import { DoseSchedule } from '../types/domain';

function runV15HardeningTests() {
  let passed = 0;
  const pass = (name: string) => {
    passed++;
    console.log(`PASS [${passed}] ${name}`);
  };

  console.log('=== MASAR Care V1.5 Automated QA & Clinical Logic Test Suite ===');

  // ---------------------------------------------------------------------------
  // 1. Iraqi Phone Validation & Normalization + Duplicate Patient Detection
  // ---------------------------------------------------------------------------
  assert.equal(isValidIraqiPhone('07701234567'), true);
  assert.equal(isValidIraqiPhone('+964 780-123-4567'), true);
  assert.equal(isValidIraqiPhone('009647501234567'), true);
  assert.equal(normalizeIraqiPhone('+964 780-123-4567'), '07801234567');
  assert.equal(normalizeIraqiPhone('009647501234567'), '07501234567');
  assert.equal(isValidIraqiPhone('07101234567'), false, 'Invalid Iraqi prefix 071 rejected');
  assert.equal(isValidIraqiPhone('0770123456'), false, 'Short number rejected');
  assert.equal(isValidIraqiPhone('1234567890'), false);

  const adapter = new InMemoryCrmAdapter();
  const initialState = adapter.getState();
  const firstPatient = initialState.patients[0];

  const dupByIntlPhone = findDuplicatePatientMatch(initialState.patients, {
    patientCode: 'MC-999',
    phone: `+964${firstPatient.phone.slice(1)}`,
    fullName: 'Different Name',
    dateOfBirth: '1980-01-01',
  });
  assert.equal(dupByIntlPhone.phoneConflict?.id, firstPatient.id, 'Detects duplicate phone across +964/07 formats');

  const dupSelfExcluded = findDuplicatePatientMatch(
    initialState.patients,
    {
      patientCode: firstPatient.patientCode,
      phone: firstPatient.phone,
      fullName: firstPatient.fullName,
      dateOfBirth: firstPatient.dateOfBirth,
    },
    firstPatient.id
  );
  assert.equal(dupSelfExcluded.codeConflict, undefined);
  assert.equal(dupSelfExcluded.phoneConflict, undefined);
  assert.equal(dupSelfExcluded.nameDobConflict, undefined);
  pass('Iraqi phone formats, normalization, and duplicate patient detection');

  // ---------------------------------------------------------------------------
  // 2. Patient Lifecycle: Add, Edit, Archive (preserve meds), Restore
  // ---------------------------------------------------------------------------
  const { patient: pNew } = adapter.addPatient({
    patientCode: 'MC-801',
    fullName: 'علي حسين الكاظمي',
    phone: '+9647712223344',
    dateOfBirth: '1965-03-14',
    sex: 'male',
    chronicConditions: ['ارتفاع ضغط الدم'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: 'حالة اختبار V1.5',
    registrationDate: '2026-11-12',
  });
  assert.equal(pNew.phone, '07712223344', 'Stored phone normalized to 07XXXXXXXXX');
  adapter.updatePatient(pNew.id, { clinicalNotes: 'تم تحديث الملاحظة السريرية' });
  assert.equal(
    adapter.getState().patients.find((p) => p.id === pNew.id)?.clinicalNotes,
    'تم تحديث الملاحظة السريرية'
  );
  adapter.archivePatient(pNew.id, 'اختبار الأرشفة');
  assert.equal(adapter.getState().patients.find((p) => p.id === pNew.id)?.status, 'archived');
  adapter.restorePatient(pNew.id);
  assert.equal(adapter.getState().patients.find((p) => p.id === pNew.id)?.status, 'active');
  pass('Patient CRUD, phone normalization, archive & restore');

  // ---------------------------------------------------------------------------
  // 3. Medication Management, Version Preservation, Newest-First, Duplicate Guard
  // ---------------------------------------------------------------------------
  const { plan: med1 } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Concor',
    genericName: 'Bisoprolol Fumarate',
    strength: '5 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'قرص',
    foodRelation: 'after_food',
    verifiedInstructions: 'قرص صباحاً ونصف قرص مساءً.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 2,
      doseSlots: [
        { id: 'slot-am', time24: '08:00', doseAmount: 1, label: 'صباحاً' },
        { id: 'slot-pm', time24: '20:00', doseAmount: 0.5, label: 'مساءً' },
      ],
      timezone: BAGHDAD_TIMEZONE,
    },
  });

  const dupActiveMed = findDuplicateActiveMedication(
    adapter.getState().medicationPlans,
    pNew.id,
    'bisoprolol fumarate',
    '5mg'
  );
  assert.equal(dupActiveMed?.id, med1.id, 'Duplicate active medication detected');

  // Update regimen -> v2 preserved
  adapter.updateMedicationPlan(
    med1.id,
    {
      ...med1,
      doseAmount: 1,
      verifiedInstructions: 'قرص واحد صباحاً فقط.',
      schedule: {
        frequencyType: 'daily',
        timesPerDay: 1,
        doseSlots: [{ id: 'slot-am-v2', time24: '08:00', doseAmount: 1 }],
        timezone: BAGHDAD_TIMEZONE,
      },
    },
    'تعديل الجرعة بعد استقرار النبض',
    '2026-11-12'
  );
  const med1Updated = adapter.getState().medicationPlans.find((m) => m.id === med1.id)!;
  assert.equal(med1Updated.currentVersionNumber, 2);
  assert.equal(med1Updated.regimenHistory.length, 2);
  assert.equal(med1Updated.regimenHistory[0].effectiveTo, '2026-11-12');

  // Pause & resume & discontinue
  adapter.changeMedicationStatus(med1.id, 'paused', 'إيقاف مؤقت للمتابعة');
  assert.equal(adapter.getState().medicationPlans.find((m) => m.id === med1.id)?.status, 'paused');
  assert.equal(
    computeDailyConsumption(adapter.getState().medicationPlans.find((m) => m.id === med1.id)!).dailyRate,
    null
  );
  adapter.changeMedicationStatus(med1.id, 'active', 'استئناف العلاج');
  assert.equal(adapter.getState().medicationPlans.find((m) => m.id === med1.id)?.status, 'active');

  // Add second med slightly later -> must sort ahead or at index 0
  const { plan: med2 } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Lipitor',
    genericName: 'Atorvastatin',
    strength: '20 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'قرص',
    foodRelation: 'any_time',
    verifiedInstructions: 'قرص واحد ليلاً.',
    startDate: '2026-11-12',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 's-night', time24: '22:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const patientPlans = adapter.getState().medicationPlans.filter((m) => m.patientId === pNew.id);
  assert.equal(patientPlans[0].id, med2.id, 'Newly added medication appears at the top');
  pass('Medication CRUD, version preservation, pause/resume, duplicate active med detection, newest-first order');

  // ---------------------------------------------------------------------------
  // 4. Scheduling Engine: All Patterns, Midnight Boundaries & Asia/Baghdad
  // ---------------------------------------------------------------------------
  // 4a. Every 8 hours starting at 22:00 crosses midnight cleanly
  const { plan: hourlyPlan } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Augmentin',
    genericName: 'Amoxicillin/Clavulanate',
    strength: '1 g',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'قرص',
    foodRelation: 'with_food',
    verifiedInstructions: 'قرص كل ٨ ساعات لمدة ٧ أيام.',
    startDate: '2026-11-12',
    endDate: '2026-11-14',
    isOngoing: false,
    durationDays: 2,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 3,
      intervalValue: 8,
      intervalUnit: 'hours',
      doseSlots: [{ id: 'h1', time24: '22:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const hourlyOcc = generateScheduledOccurrences(hourlyPlan, '2026-11-12', '2026-11-13');
  assert.deepEqual(
    hourlyOcc.map((o) => `${o.date} ${o.time24}`),
    ['2026-11-12 22:00', '2026-11-13 06:00', '2026-11-13 14:00', '2026-11-13 22:00'],
    'Every 8 hours from 22:00 crosses midnight cleanly in Asia/Baghdad'
  );
  assert.ok(hourlyOcc[0].isoBaghdad.endsWith('+03:00'));

  // 4b. Selected weekdays (Sun=0, Tue=2, Thu=4) -> 2026-11-12 is Thursday!
  assert.equal(getBaghdadWeekday('2026-11-12'), 4, '2026-11-12 is Thursday (4) in Baghdad');
  const { plan: weekdayPlan } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Methotrexate',
    genericName: 'Methotrexate',
    strength: '2.5 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 2,
    doseUnit: 'قرص',
    foodRelation: 'after_food',
    verifiedInstructions: 'كل أحد وثلاثاء وخميس.',
    startDate: '2026-11-12',
    isOngoing: true,
    schedule: {
      frequencyType: 'weekdays',
      timesPerDay: 1,
      selectedWeekdays: [0, 2, 4],
      doseSlots: [{ id: 'wd1', time24: '09:00', doseAmount: 2 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const wdOcc = generateScheduledOccurrences(weekdayPlan, '2026-11-12', '2026-11-19');
  assert.deepEqual(
    wdOcc.map((o) => o.date),
    ['2026-11-12', '2026-11-15', '2026-11-17', '2026-11-19']
  );

  // 4c. Cyclic 21 ON / 7 OFF
  const { plan: cyclicPlan } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Cycle Pill',
    genericName: 'Cyclic Drug',
    strength: '10 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'قرص',
    foodRelation: 'any_time',
    verifiedInstructions: '٢١ يوم أخذ ثم ٧ أيام توقف.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'cyclic',
      timesPerDay: 1,
      cycleOnDays: 21,
      cycleOffDays: 7,
      doseSlots: [{ id: 'c1', time24: '21:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const cycleOcc = generateScheduledOccurrences(cyclicPlan, '2026-11-01', '2026-12-01');
  assert.equal(cycleOcc.length, 24, '21 days ON (Nov 1-21), 7 OFF (Nov 22-28), 3 ON (Nov 29-Dec 1)');
  assert.equal(cycleOcc.some((o) => o.date === '2026-11-22'), false, 'Day 22 is in OFF window');
  assert.equal(cycleOcc.some((o) => o.date === '2026-11-29'), true, 'Day 29 starts cycle 2');

  // 4d. Every N days & paused cutoff & PRN
  const { plan: every3DaysPlan } = adapter.addMedicationPlan({
    patientId: pNew.id,
    brandName: 'Alendronate',
    genericName: 'Alendronic Acid',
    strength: '70 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'قرص',
    foodRelation: 'before_food',
    verifiedInstructions: 'كل ٣ أيام قبل الإفطار.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 1,
      intervalValue: 3,
      intervalUnit: 'days',
      doseSlots: [{ id: 'e3', time24: '07:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const e3Occ = generateScheduledOccurrences(every3DaysPlan, '2026-11-01', '2026-11-10');
  assert.deepEqual(
    e3Occ.map((o) => o.date),
    ['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10']
  );

  // Paused cutoff
  adapter.changeMedicationStatus(every3DaysPlan.id, 'paused', 'توقف مؤقت', '2026-11-12');
  const pausedEvery3 = adapter.getState().medicationPlans.find((m) => m.id === every3DaysPlan.id)!;
  const occAfterPause = generateScheduledOccurrences(pausedEvery3, '2026-11-12', '2026-11-20');
  assert.equal(occAfterPause.length, 0, 'Paused plan emits zero occurrences from statusChangedAt onward');

  // Invalid schedules rejected
  const badSlotSchedule: DoseSchedule = {
    frequencyType: 'daily',
    timesPerDay: 1,
    doseSlots: [{ id: 'bad', time24: '25:99', doseAmount: -1 }],
    timezone: BAGHDAD_TIMEZONE,
  };
  assert.equal(validateSchedule(badSlotSchedule, 'ar').valid, false);
  assert.ok(getBaghdadTodayDateStr(new Date('2026-11-12T22:30:00Z')) === '2026-11-13', 'Baghdad UTC+3 date boundary verified');
  pass('Scheduling engine occurrences, midnight boundaries, cycles, weekdays, pause cutoffs & Baghdad TZ');

  // ---------------------------------------------------------------------------
  // 5. Dispensing & Refill Projections (Unable to Estimate, Cumulative Fills, Separation)
  // ---------------------------------------------------------------------------
  // 5a. Brand new active plan with 0 dispensing events -> unable_to_estimate (NOT overdue!)
  const projNoDispense = computeRefillProjection(
    med2,
    pNew,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-12'
  );
  assert.equal(projNoDispense.refillStatus, 'unable_to_estimate');
  assert.equal(projNoDispense.estimatedSupplyEndDate, null);
  assert.equal(projNoDispense.estimatedRemainingUnits, null);

  // 5b. Invalid quantities rejected
  const badForecast = calculateDispensingForecast(med2, 0, '2026-11-12', 'en');
  assert.equal(badForecast.estimatedSupplyEndDate, null);
  const badDispenseResult = adapter.recordDispensing(
    {
      patientId: pNew.id,
      medicationPlanId: med2.id,
      dispensedQuantity: -5,
      quantityUnit: 'قرص',
      dispensingDate: '2026-11-12',
      isPartialFill: false,
    },
    'en'
  );
  assert.equal(badDispenseResult.event, null, 'Negative dispensing quantity rejected');

  // 5c. Cumulative multi-dispensing carryover calculation
  // Fill 1: 30 units on 2026-11-01 at 1/day -> 11 remaining on Nov 20
  adapter.recordDispensing(
    {
      patientId: pNew.id,
      medicationPlanId: med2.id,
      dispensedQuantity: 30,
      quantityUnit: 'قرص',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  // Fill 2: 30 units on 2026-11-20 -> carryover (30 - 19 = 11) + 30 = 41 units -> lasts until 2026-12-31!
  adapter.recordDispensing(
    {
      patientId: pNew.id,
      medicationPlanId: med2.id,
      dispensedQuantity: 30,
      quantityUnit: 'قرص',
      dispensingDate: '2026-11-20',
      isPartialFill: false,
    },
    'en'
  );
  const cumulativeProj = computeRefillProjection(
    med2,
    pNew,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-25'
  );
  assert.equal(cumulativeProj.totalDispensedAnalyzed, 60);
  assert.equal(cumulativeProj.estimatedRemainingUnits, 36); // 41 - 5 = 36
  assert.equal(cumulativeProj.estimatedSupplyEndDate, '2026-12-31');

  // Duplicate dispensing check
  const dupDispense = findRecentDuplicateDispensing(
    adapter.getState().dispensingEvents,
    pNew.id,
    med2.id,
    '2026-11-20',
    30
  );
  assert.ok(dupDispense !== undefined, 'Duplicate same-day identical dispensing detected');

  // Dispensing never auto-marks doseEvents as taken
  const doseCountBefore = adapter.getState().doseEvents.filter((d) => d.status === 'taken').length;
  adapter.recordDispensing(
    {
      patientId: pNew.id,
      medicationPlanId: med1.id,
      dispensedQuantity: 30,
      quantityUnit: 'قرص',
      dispensingDate: '2026-11-12',
      isPartialFill: false,
    },
    'ar'
  );
  const doseCountAfter = adapter.getState().doseEvents.filter((d) => d.status === 'taken').length;
  assert.equal(doseCountBefore, doseCountAfter, 'Dispensing does not mark doses as taken');

  // KPI exclusion of unable_to_estimate
  const allProjs = computeAllRefillProjections(adapter.getState(), 'ar', '2026-11-12');
  const kpis = computeDashboardKpis(adapter.getState(), 'ar', '2026-11-12');
  const expectedDueSoon = allProjs.filter(
    (r) => r.refillStatus === 'overdue' || r.refillStatus === 'due_soon'
  ).length;
  assert.equal(kpis.refillsDueSoonCount, expectedDueSoon);
  pass('Dispensing validation, cumulative multi-fill refills, unable_to_estimate & adherence separation');

  // ---------------------------------------------------------------------------
  // 6. Patient Invitation Lifecycle (Pharmacist-Only Mock)
  // ---------------------------------------------------------------------------
  const { invitation: inv1 } = adapter.issueInvitation(pNew.id, 'dob_and_phone_otp');
  assert.equal(inv1?.status, 'pending');

  // Revoke -> cannot simulate activation afterward
  adapter.revokeInvitation(pNew.id);
  assert.equal(
    adapter.getState().invitations.find((i) => i.patientId === pNew.id)?.status,
    'revoked'
  );
  adapter.simulateInvitationActivation(pNew.id);
  assert.equal(
    adapter.getState().invitations.find((i) => i.patientId === pNew.id)?.status,
    'revoked',
    'Revoked invitation cannot be activated'
  );

  // Re-issue -> expire -> cannot activate expired invitation
  adapter.issueInvitation(pNew.id, 'national_id_last4');
  adapter.simulateInvitationExpiry(pNew.id);
  adapter.simulateInvitationActivation(pNew.id);
  assert.equal(
    adapter.getState().invitations.find((i) => i.patientId === pNew.id)?.status,
    'expired',
    'Expired invitation cannot be activated'
  );

  // Re-issue -> activate -> re-issue replaces activated with audit entry
  adapter.issueInvitation(pNew.id, 'dob_and_phone_otp');
  adapter.simulateInvitationActivation(pNew.id);
  assert.equal(
    adapter.getState().invitations.find((i) => i.patientId === pNew.id)?.status,
    'activated'
  );
  adapter.issueInvitation(pNew.id, 'dob_and_phone_otp');
  assert.equal(adapter.getState().auditLogs[0].action, 'INVITATION_REPLACED_ACTIVATED');
  pass('Mock APK invitation lifecycle (pending/revoked/expired/activated/replaced)');

  // ---------------------------------------------------------------------------
  // 7. Data Isolation & Stage 2 Supabase Schema Readiness
  // ---------------------------------------------------------------------------
  const otherPatient = initialState.patients[0];
  const otherProjIds = allProjs
    .filter((r) => r.patientId === otherPatient.id)
    .map((r) => r.medicationPlanId);
  assert.equal(otherProjIds.includes(med2.id), false, 'Patient medication projections strictly isolated');
  assert.ok(SUPABASE_STAGE2_SCHEMA_SPEC.length >= 11, 'Stage 2 Supabase schema spec complete');
  assert.ok(
    SUPABASE_STAGE2_SCHEMA_SPEC.every((t) => t.rlsPolicySummary.length > 0),
    'Every Stage 2 table documents an RLS policy'
  );
  pass('Patient data isolation and Stage 2 Supabase adapter/schema readiness');

  console.log(`\nALL ${passed} V1.5 HARDENING TEST SUITES PASSED!`);
}

runV15HardeningTests();
