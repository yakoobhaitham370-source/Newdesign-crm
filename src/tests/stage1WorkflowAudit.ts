import assert from 'node:assert/strict';
import {
  buildDispensingEventRecord,
  buildMockInvitation,
  buildNewMedicationPlanWithVersion,
  buildUpdatedMedicationPlanVersion,
  computeAllRefillProjections,
  computeDashboardKpis,
  createInitialCrmState,
} from '../services/crmRepository';
import {
  calculateDispensingForecast,
  computeDailyConsumption,
  computeRefillProjection,
  formatScheduleSummary,
  validateSchedule,
} from '../services/scheduleEngine';
import { DoseSchedule, Patient } from '../types/domain';

function runAuditTests() {
  console.log('--- MASAR Care Stage 1 Automated Workflow & Logic Audit ---');

  // 1. Initial seed state & KPI calculation
  let state = createInitialCrmState();
  const initialKpis = computeDashboardKpis(state, 'ar', '2026-11-12');
  assert.equal(initialKpis.totalPatients, 5, 'Should have 5 active seeded patients (1 archived excluded)');
  assert.equal(initialKpis.activeChronicPatients, 5);
  assert.equal(initialKpis.activeMedicationPlans, 8);
  assert.equal(initialKpis.todaysDispensingCount, 1);
  console.log('PASS [1] Initial KPIs dynamically computed from seed repository');

  // 2. Register a new fictional patient
  const newPatient: Patient = {
    id: 'pat-test-901',
    patientCode: 'MC-901',
    pharmacyId: state.pharmacy.id,
    fullName: 'حسام عبد الكريم المالكي',
    phone: '07709998877',
    dateOfBirth: '1968-05-10',
    sex: 'male',
    chronicConditions: ['السكري النوع الثاني', 'ارتفاع ضغط الدم'],
    allergies: [{ id: 'alg-t1', substance: 'Penicillin', severity: 'severe' }],
    contactPreference: 'whatsapp',
    clinicalNotes: 'حالة تجريبية للتحقق من المسار الكامل',
    registrationDate: '2026-11-12',
    status: 'active',
  };
  state = { ...state, patients: [newPatient, ...state.patients] };

  const afterPatientKpis = computeDashboardKpis(state, 'ar', '2026-11-12');
  assert.equal(afterPatientKpis.totalPatients, 6, 'Total active patients should increment to 6');
  console.log('PASS [2] Fictional patient registration updates shared KPIs');

  // 3. Medication Scheduling validation & incompatibility guard
  const valid36HourIntervalSchedule: DoseSchedule = {
    frequencyType: 'interval',
    timesPerDay: 1,
    intervalValue: 36,
    intervalUnit: 'hours',
    doseSlots: [{ id: 's-36h', time24: '08:00', doseAmount: 1 }],
    timezone: 'Asia/Baghdad',
  };
  assert.equal(
    validateSchedule(valid36HourIntervalSchedule, 'ar').valid,
    true,
    'Every 36 hours is a valid multi-day hourly interval'
  );

  const invalidIntervalSchedule: DoseSchedule = {
    frequencyType: 'interval',
    timesPerDay: 1,
    intervalValue: 0,
    intervalUnit: 'hours',
    doseSlots: [{ id: 's-bad', time24: '08:00', doseAmount: 1 }],
    timezone: 'Asia/Baghdad',
  };
  const invalidCheck = validateSchedule(invalidIntervalSchedule, 'ar');
  assert.equal(invalidCheck.valid, false, 'Interval < 1 hour must be rejected');

  const validTwiceDailySchedule: DoseSchedule = {
    frequencyType: 'daily',
    timesPerDay: 2,
    doseSlots: [
      { id: 's-am', time24: '08:00', doseAmount: 1, label: 'صباحاً' },
      { id: 's-pm', time24: '20:00', doseAmount: 0.5, label: 'مساءً' },
    ],
    timezone: 'Asia/Baghdad',
  };
  assert.equal(validateSchedule(validTwiceDailySchedule, 'ar').valid, true);
  assert.ok(formatScheduleSummary(validTwiceDailySchedule, 'قرص', 'ar', true).includes('12:00') === false);

  const createdPlan = buildNewMedicationPlanWithVersion(
    {
      patientId: newPatient.id,
      brandName: 'Concor',
      genericName: 'Bisoprolol Fumarate',
      strength: '5 mg',
      dosageForm: 'tablet',
      route: 'oral',
      doseAmount: 1,
      doseUnit: 'قرص',
      foodRelation: 'after_food',
      verifiedInstructions: 'قرص صباحاً ونصف قرص مساءً بعد الطعام.',
      startDate: '2026-11-12',
      isOngoing: true,
      schedule: validTwiceDailySchedule,
    },
    state.staff[0].fullName
  );
  state = { ...state, medicationPlans: [createdPlan, ...state.medicationPlans] };
  assert.equal(createdPlan.currentVersionNumber, 1);
  assert.equal(createdPlan.regimenHistory.length, 1);
  assert.equal(computeDailyConsumption(createdPlan).dailyRate, 1.5, 'Daily consumption should sum 1 + 0.5 = 1.5/day');
  console.log('PASS [3] Medication scheduling validation & per-slot daily rate calculation');

  // 4. Regimen update preserves previous version
  const updatedPlan = buildUpdatedMedicationPlanVersion(
    createdPlan,
    {
      ...createdPlan,
      doseAmount: 1,
      verifiedInstructions: 'قرص واحد صباحاً فقط بعد مراجعة النبض.',
      schedule: {
        frequencyType: 'daily',
        timesPerDay: 1,
        doseSlots: [{ id: 's-am-v2', time24: '08:00', doseAmount: 1 }],
        timezone: 'Asia/Baghdad',
      },
    },
    state.staff[0].fullName,
    'تخفيض الجرعة المسائية',
    '2026-11-12'
  );
  state = {
    ...state,
    medicationPlans: state.medicationPlans.map((m) => (m.id === createdPlan.id ? updatedPlan : m)),
  };
  assert.equal(updatedPlan.currentVersionNumber, 2);
  assert.equal(updatedPlan.regimenHistory.length, 2);
  assert.equal(updatedPlan.regimenHistory[0].effectiveTo, '2026-11-12');
  console.log('PASS [4] Regimen editing preserves historical version #1');

  // 5. Dispensing event & refill projection calculation
  const forecast = calculateDispensingForecast(updatedPlan, 30, '2026-11-12', 'ar');
  assert.equal(forecast.estimatedSupplyDays, 30);
  assert.equal(forecast.estimatedSupplyEndDate, '2026-12-12');

  const dispenseEvt = buildDispensingEventRecord(
    state,
    {
      patientId: newPatient.id,
      medicationPlan: updatedPlan,
      dispensedQuantity: 30,
      quantityUnit: 'قرص',
      packageCount: 1,
      packageSize: 30,
      dispensingDate: '2026-11-12',
      isPartialFill: false,
    },
    'ar'
  );
  state = { ...state, dispensingEvents: [dispenseEvt, ...state.dispensingEvents] };
  const projection = computeRefillProjection(
    updatedPlan,
    newPatient,
    state.dispensingEvents,
    'ar',
    '2026-11-12'
  );
  assert.equal(projection.estimatedSupplyEndDate, '2026-12-12');
  assert.equal(projection.refillStatus, 'on_track');

  // Simulate 25 days later -> due soon (5 days remaining)
  const projectionLater = computeRefillProjection(
    updatedPlan,
    newPatient,
    state.dispensingEvents,
    'ar',
    '2026-12-07'
  );
  assert.equal(projectionLater.estimatedDaysRemaining, 5);
  assert.equal(projectionLater.refillStatus, 'due_soon');
  console.log('PASS [5] Dispensing forecast & dynamic refill status projection');

  // 6. Cyclic & PRN schedule edge cases
  const cyclicSchedule: DoseSchedule = {
    frequencyType: 'cyclic',
    timesPerDay: 1,
    cycleOnDays: 21,
    cycleOffDays: 7,
    doseSlots: [{ id: 'cyc-1', time24: '21:00', doseAmount: 1 }],
    timezone: 'Asia/Baghdad',
  };
  const cyclicPlan = buildNewMedicationPlanWithVersion(
    {
      patientId: newPatient.id,
      brandName: 'Cyclic Med',
      genericName: 'Test Generic',
      strength: '10 mg',
      dosageForm: 'tablet',
      route: 'oral',
      doseAmount: 1,
      doseUnit: 'قرص',
      foodRelation: 'any_time',
      verifiedInstructions: '٢١ يوم علاج و٧ أيام توقف.',
      startDate: '2026-11-12',
      isOngoing: true,
      schedule: cyclicSchedule,
    },
    state.staff[0].fullName
  );
  assert.equal(computeDailyConsumption(cyclicPlan).dailyRate, 0.75, '21/28 = 0.75/day');

  const prnPlan = buildNewMedicationPlanWithVersion(
    {
      patientId: newPatient.id,
      brandName: 'Ventolin',
      genericName: 'Salbutamol',
      strength: '100 mcg',
      dosageForm: 'inhaler',
      route: 'inhalation',
      doseAmount: 2,
      doseUnit: 'بخة',
      foodRelation: 'any_time',
      verifiedInstructions: 'عند ضيق التنفس فقط.',
      startDate: '2026-11-12',
      isOngoing: true,
      schedule: {
        frequencyType: 'prn',
        timesPerDay: 0,
        prnIndication: 'ضيق التنفس',
        prnMaxPerDay: 8,
        doseSlots: [],
        timezone: 'Asia/Baghdad',
      },
    },
    state.staff[0].fullName
  );
  assert.equal(computeDailyConsumption(prnPlan).dailyRate, null, 'PRN must not assume fixed daily depletion');
  console.log('PASS [6] Cyclic & PRN scheduling calculations verified');

  // 7. Mock APK invitation generation
  const inv = buildMockInvitation(state, newPatient, 'dob_and_phone_otp');
  assert.equal(inv.status, 'pending');
  assert.ok(inv.mockInviteCode.startsWith('DEMO-MC901-'));
  console.log('PASS [7] Pharmacist-only mock APK invitation generation verified');

  // 8. Global refill projections check
  const allProjections = computeAllRefillProjections(state, 'ar', '2026-11-12');
  assert.ok(allProjections.length >= 9);
  console.log('PASS [8] All Stage 1 workflow assertions passed!');
}

runAuditTests();
