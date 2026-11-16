import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BAGHDAD_TIMEZONE } from '../i18n/translations';
import { InMemoryCrmAdapter } from '../services/crmRepository';
import {
  calculateDispensingForecast,
  computeRefillProjection,
  generateScheduledOccurrences,
  validateSchedule,
} from '../services/scheduleEngine';
import {
  Stage2SecurityPolicyEvaluator,
  SUPABASE_STAGE2_SCHEMA_SPEC,
  UI_MODULE_DATABASE_MAPPING,
} from '../types/supabaseSchemaSpec';

function runV151FinalGapsTests() {
  let passed = 0;
  const pass = (title: string) => {
    passed++;
    console.log(`PASS [${passed}] ${title}`);
  };

  console.log('=== MASAR Care V1.5.1 — Advanced Intervals, Occurrence Refills & Security Suite ===');

  const adapter = new InMemoryCrmAdapter();
  const { patient } = adapter.addPatient({
    patientCode: 'MC-1510',
    fullName: 'زينب عبد الجبار الربيعي',
    phone: '07705554433',
    dateOfBirth: '1970-08-20',
    sex: 'female',
    chronicConditions: ['ارتفاع ضغط الدم', 'السكري النوع الثاني'],
    allergies: [],
    contactPreference: 'whatsapp',
    clinicalNotes: 'مراجعة اختبار V1.5.1',
    registrationDate: '2026-11-01',
  });

  // ===========================================================================
  // TASK 1 — Verify Advanced Medication Intervals (12h, 24h, 36h, 48h, Midnight,
  //          Multi-day, Start/End Boundaries, Paused & Discontinued)
  // ===========================================================================
  for (const hours of [12, 24, 36, 48]) {
    const check = validateSchedule(
      {
        frequencyType: 'interval',
        timesPerDay: 1,
        intervalValue: hours,
        intervalUnit: 'hours',
        doseSlots: [{ id: `h-${hours}`, time24: '08:00', doseAmount: 1 }],
        timezone: BAGHDAD_TIMEZONE,
      },
      'en'
    );
    assert.equal(check.valid, true, `Every ${hours} hours must be accepted as valid`);
  }

  // 1a. Every 12 hours crossing midnight (21:00 -> 09:00 next day -> 21:00)
  const { plan: plan12h } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Eliquis',
    genericName: 'Apixaban',
    strength: '5 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: 'One tablet every 12 hours.',
    startDate: '2026-11-01',
    endDate: '2026-11-03',
    isOngoing: false,
    durationDays: 2,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 2,
      intervalValue: 12,
      intervalUnit: 'hours',
      doseSlots: [{ id: 's12', time24: '21:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const occ12h = generateScheduledOccurrences(plan12h, '2026-11-01', '2026-11-05');
  assert.deepEqual(
    occ12h.map((o) => `${o.date} ${o.time24}`),
    [
      '2026-11-01 21:00',
      '2026-11-02 09:00',
      '2026-11-02 21:00',
      '2026-11-03 09:00',
      '2026-11-03 21:00',
    ],
    'Every 12 hours crosses midnight cleanly and stops at endDate 2026-11-03'
  );

  // 1b. Every 24 hours anchored at 23:30
  const { plan: plan24h } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Lantus',
    genericName: 'Insulin Glargine',
    strength: '100 IU/mL',
    dosageForm: 'injection',
    route: 'subcutaneous',
    doseAmount: 20,
    doseUnit: 'IU',
    foodRelation: 'any_time',
    verifiedInstructions: '20 IU every 24 hours at 23:30.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 1,
      intervalValue: 24,
      intervalUnit: 'hours',
      doseSlots: [{ id: 's24', time24: '23:30', doseAmount: 20 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const occ24h = generateScheduledOccurrences(plan24h, '2026-11-01', '2026-11-04');
  assert.deepEqual(
    occ24h.map((o) => `${o.date} ${o.time24}`),
    ['2026-11-01 23:30', '2026-11-02 23:30', '2026-11-03 23:30', '2026-11-04 23:30']
  );

  // 1c. Every 36 hours (1.5 days) — alternates 08:00 and 20:00 and preserves recurrence anchor
  const { plan: plan36h } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Digoxin',
    genericName: 'Digoxin',
    strength: '0.25 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: 'One tablet every 36 hours (renal-adjusted interval).',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 1,
      intervalValue: 36,
      intervalUnit: 'hours',
      doseSlots: [{ id: 's36', time24: '08:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const occ36hFull = generateScheduledOccurrences(plan36h, '2026-11-01', '2026-11-07');
  assert.deepEqual(
    occ36hFull.map((o) => `${o.date} ${o.time24}`),
    [
      '2026-11-01 08:00',
      '2026-11-02 20:00',
      '2026-11-04 08:00', // Note: 2026-11-03 has 0 doses!
      '2026-11-05 20:00',
      '2026-11-07 08:00',
    ],
    'Every 36h alternates 08:00 -> next day 20:00 -> +2 days 08:00'
  );
  // Querying a later sub-window [2026-11-03, 2026-11-06] must preserve the exact anchor from 2026-11-01 08:00
  const occ36hSubWindow = generateScheduledOccurrences(plan36h, '2026-11-03', '2026-11-06');
  assert.deepEqual(
    occ36hSubWindow.map((o) => `${o.date} ${o.time24}`),
    ['2026-11-04 08:00', '2026-11-05 20:00'],
    'Sub-window query preserves exact 36h recurrence anchor from startDate'
  );

  // 1d. Every 48 hours anchored at 2026-11-01 21:00
  const { plan: plan48h } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Rosuvastatin',
    genericName: 'Rosuvastatin',
    strength: '10 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: 'One tablet every 48 hours at 21:00.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'interval',
      timesPerDay: 1,
      intervalValue: 48,
      intervalUnit: 'hours',
      doseSlots: [{ id: 's48', time24: '21:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  const occ48h = generateScheduledOccurrences(plan48h, '2026-11-02', '2026-11-08');
  assert.deepEqual(
    occ48h.map((o) => `${o.date} ${o.time24}`),
    ['2026-11-03 21:00', '2026-11-05 21:00', '2026-11-07 21:00'],
    'Every 48h preserves odd-day anchor even when queried starting on an even day (Nov 2)'
  );
  pass('TASK 1: Every 12h, 24h, 36h, 48h, midnight transitions, recurrence anchor & boundaries verified');

  // ===========================================================================
  // TASK 2 — Verify Refill Accuracy Using Real Scheduled Occurrences
  // ===========================================================================

  // 2a. 21-day ON / 7-day OFF cyclic treatment (no misleading average daily rate!)
  const { plan: cyclicPlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Yasmin',
    genericName: 'Ethinylestradiol/Drospirenone',
    strength: '0.03/3 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: '1 tablet daily for 21 days, then 7 days off.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'cyclic',
      timesPerDay: 1,
      cycleOnDays: 21,
      cycleOffDays: 7,
      doseSlots: [{ id: 'cyc', time24: '21:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });

  // Partial fill of 14 tablets on Nov 1 -> must deplete after 14 ON days (2026-11-15), NOT 18 days (14 / 0.75)!
  const cyclicForecast14 = calculateDispensingForecast(cyclicPlan, 14, '2026-11-01', 'en');
  assert.equal(
    cyclicForecast14.estimatedSupplyDays,
    14,
    '14 tablets in a 21d ON window last exactly 14 days, not 18 days (naive 14/0.75)'
  );
  assert.equal(cyclicForecast14.estimatedSupplyEndDate, '2026-11-15');

  // Full 21-tablet cycle pack on Nov 1 -> covers 21 ON days (Nov 1-21) + 7 OFF days (Nov 22-28) -> next needed dose on Nov 29
  const cyclicForecast21 = calculateDispensingForecast(cyclicPlan, 21, '2026-11-01', 'en');
  assert.equal(cyclicForecast21.estimatedSupplyDays, 28);
  assert.equal(cyclicForecast21.estimatedSupplyEndDate, '2026-11-29');

  // 25 tablets dispensed on Nov 1 -> covers 21 ON + 7 OFF + 4 ON (Nov 29..Dec 2) -> depletes 2026-12-03
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: cyclicPlan.id,
      dispensedQuantity: 25,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  // Check during the 7-day OFF break (2026-11-25): 21 consumed during Nov 1-21, 0 consumed Nov 22-24 -> 4 remaining!
  const cyclicProjDuringOff = computeRefillProjection(
    cyclicPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-25'
  );
  assert.equal(
    cyclicProjDuringOff.estimatedRemainingUnits,
    4,
    'Zero tablets consumed during 7-day OFF break (4 tablets remain on Nov 25)'
  );
  assert.equal(cyclicProjDuringOff.estimatedSupplyEndDate, '2026-12-03');
  pass('TASK 2a: 21-day ON / 7-day OFF cyclic treatment occurrence-based supply & OFF-window preservation');

  // 2b. Multiple partial dispensing events & early refills with carryover
  const { plan: partialPlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Janumet',
    genericName: 'Sitagliptin/Metformin',
    strength: '50/1000 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'with_food',
    verifiedInstructions: 'One tablet twice daily with meals.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 2,
      doseSlots: [
        { id: 'jm-1', time24: '08:00', doseAmount: 1 },
        { id: 'jm-2', time24: '20:00', doseAmount: 1 },
      ],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  // Partial fill 1: 10 tablets on Nov 1 (2/day)
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: partialPlan.id,
      dispensedQuantity: 10,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: true,
    },
    'en'
  );
  // Partial fill 2 (early): 14 tablets on Nov 5 (4 days elapsed = 8 consumed -> 2 carryover + 14 = 16 tablets)
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: partialPlan.id,
      dispensedQuantity: 14,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-05',
      isPartialFill: true,
    },
    'en'
  );
  // Partial fill 3 (early): 20 tablets on Nov 12 (7 days elapsed = 14 consumed -> 2 carryover + 20 = 22 tablets = 11 days -> Nov 23)
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: partialPlan.id,
      dispensedQuantity: 20,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-12',
      isPartialFill: true,
    },
    'en'
  );
  const partialProj = computeRefillProjection(
    partialPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-12'
  );
  assert.equal(partialProj.totalDispensedAnalyzed, 44);
  assert.equal(partialProj.estimatedRemainingUnits, 22);
  assert.equal(partialProj.estimatedSupplyEndDate, '2026-11-23');
  assert.ok(partialProj.uncertaintyNote.includes('partial fill'));
  assert.ok(partialProj.uncertaintyNote.includes('carryover'));
  pass('TASK 2b: Early refills, carryover stock, and multiple partial dispensing events');

  // 2c. Dose changes with historical effective dates
  // Version 1 (2026-11-01 .. 2026-11-10 = 10 days): 2 tablets/day (20 tablets consumed)
  // Version 2 (effectiveFrom 2026-11-11 onward): reduced to 1 tablet/day
  const { plan: titratedPlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Lasix',
    genericName: 'Furosemide',
    strength: '40 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'before_food',
    verifiedInstructions: '1 tablet at 08:00 and 1 tablet at 14:00.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 2,
      doseSlots: [
        { id: 'lx-1', time24: '08:00', doseAmount: 1 },
        { id: 'lx-2', time24: '14:00', doseAmount: 1 },
      ],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  // Dispense 30 tablets on 2026-11-01
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: titratedPlan.id,
      dispensedQuantity: 30,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  // Physician reduces dose to 1 tablet/day effective 2026-11-11
  adapter.updateMedicationPlan(
    titratedPlan.id,
    {
      ...titratedPlan,
      doseAmount: 1,
      verifiedInstructions: '1 tablet once daily at 08:00.',
      schedule: {
        frequencyType: 'daily',
        timesPerDay: 1,
        doseSlots: [{ id: 'lx-v2', time24: '08:00', doseAmount: 1 }],
        timezone: BAGHDAD_TIMEZONE,
      },
    },
    'Dose reduced after edema resolution',
    '2026-11-11'
  );
  const updatedTitratedPlan = adapter.getState().medicationPlans.find((m) => m.id === titratedPlan.id)!;
  const titratedProj = computeRefillProjection(
    updatedTitratedPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-15'
  );
  // Nov 1..10 (10 days * 2 = 20 consumed) + Nov 11..14 (4 days * 1 = 4 consumed) = 24 consumed -> 6 left on Nov 15!
  // Remaining 6 tablets at 1/day cover Nov 15..20 -> depletes on 2026-11-21!
  assert.equal(titratedProj.estimatedRemainingUnits, 6, '20 consumed under v1 + 4 under v2 = 6 remaining on Nov 15');
  assert.equal(titratedProj.estimatedSupplyEndDate, '2026-11-21', 'Depletes Nov 21 (not Dec 1)');
  pass('TASK 2c: Historical dose changes with effectiveFrom/effectiveTo accurately reflected in supply');

  // 2d. Supply depletion gap between dispensing events (clamped to 0, no negative debt)
  const { plan: gapPlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Crestor',
    genericName: 'Rosuvastatin',
    strength: '20 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: '1 tablet daily at night.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 'cr-1', time24: '22:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  // Fill 1: 10 tablets on Nov 1 (depletes Nov 11; patient has 0 stock Nov 11..19)
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: gapPlan.id,
      dispensedQuantity: 10,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  // Fill 2 (late refill after 9-day gap): 30 tablets on Nov 20 -> must start with 30 tablets, NOT 21!
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: gapPlan.id,
      dispensedQuantity: 30,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-20',
      isPartialFill: false,
    },
    'en'
  );
  const gapProj = computeRefillProjection(
    gapPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-25'
  );
  assert.equal(gapProj.estimatedRemainingUnits, 25, '30 tablets on Nov 20 minus 5 days = 25 (no negative carryover)');
  assert.equal(gapProj.estimatedSupplyEndDate, '2026-12-20');
  assert.ok(gapProj.uncertaintyNote.includes('depletion gap'));
  pass('TASK 2d: Supply depletion between dispensing events clamped at zero before subsequent refill');

  // 2e. Variable daily dose quantities (explicit unequal slots vs unquantified variable -> unable_to_estimate) & PRN
  const { plan: variableUnquantified } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Marevan',
    genericName: 'Warfarin Sodium',
    strength: '5 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'any_time',
    verifiedInstructions: 'Variable dosing adjusted weekly per INR.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'variable',
      timesPerDay: 1,
      variablePatternNote: 'Dose varies daily per weekly INR clinic instructions',
      doseSlots: [],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: variableUnquantified.id,
      dispensedQuantity: 30,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  const varUnquantProj = computeRefillProjection(
    variableUnquantified,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-12'
  );
  assert.equal(varUnquantProj.refillStatus, 'unable_to_estimate');
  assert.equal(varUnquantProj.estimatedSupplyEndDate, null);

  // 2f. Medication Pause & Resume extends supply by exact paused duration
  const { plan: pauseResumePlan } = adapter.addMedicationPlan({
    patientId: patient.id,
    brandName: 'Plavix',
    genericName: 'Clopidogrel',
    strength: '75 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: '1 tablet once daily.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: {
      frequencyType: 'daily',
      timesPerDay: 1,
      doseSlots: [{ id: 'plv-1', time24: '09:00', doseAmount: 1 }],
      timezone: BAGHDAD_TIMEZONE,
    },
  });
  // Dispense 20 tablets on Nov 1 (without pause, would deplete on 2026-11-21)
  adapter.recordDispensing(
    {
      patientId: patient.id,
      medicationPlanId: pauseResumePlan.id,
      dispensedQuantity: 20,
      quantityUnit: 'tablet',
      dispensingDate: '2026-11-01',
      isPartialFill: false,
    },
    'en'
  );
  // Pause on 2026-11-06 for dental procedure, resume on 2026-11-11 (5 paused days: Nov 6..10)
  adapter.changeMedicationStatus(pauseResumePlan.id, 'paused', 'Pre-dental hold', '2026-11-06');
  const whilePausedPlan = adapter.getState().medicationPlans.find((m) => m.id === pauseResumePlan.id)!;
  const projWhilePaused = computeRefillProjection(
    whilePausedPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-08'
  );
  assert.equal(projWhilePaused.refillStatus, 'paused_or_prn');
  assert.equal(projWhilePaused.estimatedSupplyEndDate, null);

  // Resume on 2026-11-11
  adapter.changeMedicationStatus(pauseResumePlan.id, 'active', 'Resumed post-procedure', '2026-11-11');
  const resumedPlan = adapter.getState().medicationPlans.find((m) => m.id === pauseResumePlan.id)!;
  const projAfterResume = computeRefillProjection(
    resumedPlan,
    patient,
    adapter.getState().dispensingEvents,
    'en',
    '2026-11-12'
  );
  // Nov 1..5 (5 consumed) + Nov 6..10 (0 consumed while paused) + Nov 11 (1 consumed) = 6 consumed -> 14 left on Nov 12!
  // Depletes on 2026-11-26 (shifted 5 days later from 2026-11-21)
  assert.equal(projAfterResume.estimatedRemainingUnits, 14);
  assert.equal(projAfterResume.estimatedSupplyEndDate, '2026-11-26');
  pass('TASK 2e/2f: Variable dosing unable_to_estimate guard & pause/resume supply extension verified');

  // ===========================================================================
  // TASK 3 — Verify Database Completeness & SQL Migration Files
  // ===========================================================================
  assert.equal(SUPABASE_STAGE2_SCHEMA_SPEC.length, 22, 'All 22 normalized Stage 2A tables defined');
  assert.equal(UI_MODULE_DATABASE_MAPPING.length, 17, 'All 17 required domain areas mapped to UI modules & tables');

  const sql1Path = path.resolve(import.meta.dirname, '../../supabase/migrations/0001_stage2a_core_schema.sql');
  const sql2Path = path.resolve(import.meta.dirname, '../../supabase/migrations/0002_stage2a_rls_and_security.sql');
  assert.equal(fs.existsSync(sql1Path), true, '0001_stage2a_core_schema.sql exists');
  assert.equal(fs.existsSync(sql2Path), true, '0002_stage2a_rls_and_security.sql exists');

  const sql1Content = fs.readFileSync(sql1Path, 'utf8');
  const sql2Content = fs.readFileSync(sql2Path, 'utf8');
  for (const tbl of SUPABASE_STAGE2_SCHEMA_SPEC) {
    assert.ok(
      sql1Content.includes(`CREATE TABLE public.${tbl.tableName}`),
      `Migration 0001 must define CREATE TABLE public.${tbl.tableName}`
    );
    assert.ok(
      sql2Content.includes(`ALTER TABLE public.${tbl.tableName} ENABLE ROW LEVEL SECURITY;`),
      `Migration 0002 must enable RLS on public.${tbl.tableName}`
    );
    assert.ok(
      sql2Content.includes(`ALTER TABLE public.${tbl.tableName} FORCE ROW LEVEL SECURITY;`),
      `Migration 0002 must force RLS on public.${tbl.tableName}`
    );
  }
  pass('TASK 3: Complete 17-domain UI->DB mapping and 22-table SQL migration files verified');

  // ===========================================================================
  // TASK 4 — Negative Security Tests (Tenant Isolation, Spoofing, Invitations)
  // ===========================================================================
  const secEvaluator = new Stage2SecurityPolicyEvaluator(
    [
      { userId: 'staff-owner-pharmA', pharmacyId: 'pharm-A', role: 'pharmacy_owner', isActive: true },
      { userId: 'staff-pharm-pharmA', pharmacyId: 'pharm-A', role: 'authorized_pharmacist', isActive: true },
      { userId: 'staff-inactive-pharmA', pharmacyId: 'pharm-A', role: 'authorized_pharmacist', isActive: false },
      { userId: 'staff-owner-pharmB', pharmacyId: 'pharm-B', role: 'pharmacy_owner', isActive: true },
    ],
    [
      { patientId: 'pat-A1', pharmacyId: 'pharm-A', authUserId: 'user-pat-A1', status: 'active' },
      { patientId: 'pat-A2', pharmacyId: 'pharm-A', authUserId: 'user-pat-A2', status: 'active' },
      { patientId: 'pat-B1', pharmacyId: 'pharm-B', authUserId: 'user-pat-B1', status: 'active' },
    ],
    [
      {
        id: 'inv-A1',
        patientId: 'pat-A1',
        pharmacyId: 'pharm-A',
        tokenHash: 'valid-sha256-token-hash-a1',
        pharmacistPinHash: 'valid-pin-hash-654321',
        smsOtpHash: 'valid-sms-otp-hash-998877',
        status: 'pending',
        expiresAtMs: 2_000_000_000_000,
        failedAttempts: 0,
        maxAttempts: 5,
      },
    ]
  );

  // Negative 1: Client-editable user_metadata spoofing is completely ignored
  const spoofedPatientCtx = {
    authUid: 'user-pat-A1',
    untrustedUserMetadata: { role: 'pharmacy_owner', pharmacyId: 'pharm-A' },
  };
  assert.equal(
    secEvaluator.canRegisterPatient(spoofedPatientCtx, 'pharm-A'),
    false,
    'Spoofed user_metadata role=pharmacy_owner must NOT allow patient to register patients'
  );
  assert.equal(
    secEvaluator.canMutateClinicalRecord(spoofedPatientCtx, { pharmacyId: 'pharm-A' }),
    false,
    'Spoofed user_metadata must NOT allow patient to mutate clinical records'
  );

  // Negative 2: Cross-pharmacy access blocked (Pharmacy B owner cannot read/mutate Pharmacy A records)
  const pharmBOwnerCtx = { authUid: 'staff-owner-pharmB' };
  assert.equal(
    secEvaluator.canSelectPatientRecord(pharmBOwnerCtx, { patientId: 'pat-A1', pharmacyId: 'pharm-A' }),
    false,
    'Pharmacy B owner cannot read Pharmacy A patient'
  );
  assert.equal(
    secEvaluator.canMutateClinicalRecord(pharmBOwnerCtx, { pharmacyId: 'pharm-A' }),
    false,
    'Pharmacy B owner cannot mutate Pharmacy A clinical records'
  );
  assert.equal(
    secEvaluator.canRegisterPatient(pharmBOwnerCtx, 'pharm-A'),
    false,
    'Pharmacy B owner cannot register patients in Pharmacy A'
  );

  // Negative 3: Deactivated pharmacist blocked from all access
  const inactiveStaffCtx = { authUid: 'staff-inactive-pharmA' };
  assert.equal(
    secEvaluator.canSelectPatientRecord(inactiveStaffCtx, { patientId: 'pat-A1', pharmacyId: 'pharm-A' }),
    false,
    'Deactivated pharmacist cannot read pharmacy records'
  );

  // Negative 4: Authorized pharmacist cannot provision staff (Owner-only privilege)
  const pharmAPharmacistCtx = { authUid: 'staff-pharm-pharmA' };
  assert.equal(secEvaluator.canRegisterPatient(pharmAPharmacistCtx, 'pharm-A'), true);
  assert.equal(
    secEvaluator.canProvisionPharmacistStaff(pharmAPharmacistCtx, 'pharm-A'),
    false,
    'Authorized pharmacist cannot provision staff accounts'
  );

  // Negative 5: Patient A2 cannot read Patient A1 records even within the same pharmacy
  const patA2Ctx = { authUid: 'user-pat-A2' };
  assert.equal(
    secEvaluator.canSelectPatientRecord(patA2Ctx, { patientId: 'pat-A1', pharmacyId: 'pharm-A' }),
    false,
    'Patient A2 cannot read Patient A1 records'
  );
  assert.equal(
    secEvaluator.canSelectPatientRecord(patA2Ctx, { patientId: 'pat-A2', pharmacyId: 'pharm-A' }),
    true,
    'Patient A2 can read own record'
  );
  assert.equal(
    secEvaluator.canSelectInternalFollowUp(patA2Ctx, { pharmacyId: 'pharm-A' }),
    false,
    'Patients cannot read internal pharmacy follow-up tasks'
  );

  // Negative 6: Invitation redemption rejects DOB/National ID alone
  const dobOnlyAttempt = secEvaluator.redeemInvitationRpc({
    invitationId: 'inv-A1',
    providedTokenHash: 'valid-sha256-token-hash-a1',
    onlyDobOrNationalIdProvided: true,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(dobOnlyAttempt.allowed, false);
  assert.equal(
    dobOnlyAttempt.reason,
    'INSUFFICIENT_IDENTITY_PROOF:DOB_OR_NATIONAL_ID_ALONE_REJECTED'
  );

  // Negative 7: Valid token + valid Pharmacist PIN + valid SMS OTP succeeds ONCE, then replay is rejected
  const validRedeem = secEvaluator.redeemInvitationRpc({
    invitationId: 'inv-A1',
    providedTokenHash: 'valid-sha256-token-hash-a1',
    providedPharmacistPinHash: 'valid-pin-hash-654321',
    providedSmsOtpHash: 'valid-sms-otp-hash-998877',
    nowMs: 1_800_000_000_000,
  });
  assert.equal(validRedeem.allowed, true);

  const replayRedeem = secEvaluator.redeemInvitationRpc({
    invitationId: 'inv-A1',
    providedTokenHash: 'valid-sha256-token-hash-a1',
    providedPharmacistPinHash: 'valid-pin-hash-654321',
    providedSmsOtpHash: 'valid-sms-otp-hash-998877',
    nowMs: 1_800_000_005_000,
  });
  assert.equal(replayRedeem.allowed, false);
  assert.equal(replayRedeem.reason, 'INVITATION_NOT_PENDING:activated', 'Single-use token replay blocked');
  pass('TASK 4: Negative security tests (metadata spoofing, cross-tenant, cross-patient, DOB-only rejection, single-use replay) passed');

  console.log(`\nALL ${passed} V1.5.1 FINAL GAPS & STAGE 2A VERIFICATION SUITES PASSED!`);
}

runV151FinalGapsTests();
