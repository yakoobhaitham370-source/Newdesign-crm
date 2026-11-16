import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MEDICATION_CATALOG } from '../data/seedData';
import {
  assessMedicationAllergyRisk,
  buildAllergyOverrideEvidencePayload,
  buildCanonicalDispensingFingerprintString,
  classifyUncertainNetworkError,
  computeDispensingPayloadHash,
  formatCanonicalDecimal4,
  isCatalogRecordVerified,
  isValidIsoCalendarDate,
  MAX_REASONABLE_DOSE_AMOUNT,
  validateAllergyOverrideAuthorization,
  validateDispensingInput,
  validateDosageFormRouteCompatibility,
  validateDosageFormUnitCompatibility,
  validateMedicationEditAllowed,
  validateMedicationPlanInput,
  validateMedicationStatusTransition,
} from '../services/clinicalSafety';
import {
  CANONICAL_DECIMAL4_VECTORS,
  DISPENSING_FINGERPRINT_VECTORS,
} from './fixtures/dispensingFingerprintVectors';
import {
  InMemoryCrmAdapter,
  type NewMedicationPlanInput,
} from '../services/crmRepository';
import {
  buildDispensingIdempotencyScopeKey,
  clearAllPendingDispensingUuids,
  clearPendingDispensingUuid,
  getOrCreatePendingDispensingUuid,
  getPendingDispensingUuids,
  peekPendingDispensingUuid,
  type StorageLike,
} from '../services/dispensingIdempotencyStore';
import { ConnectedSessionController } from '../services/connectedSessionController';
import {
  areUnitsCompatibleForRefill,
  calculateDispensingForecast,
  computeRefillProjection,
  normalizeClinicalUnitCategory,
  validateSchedule,
} from '../services/scheduleEngine';
import {
  createEmptyConnectedCrmState,
  SupabaseCrmRepository,
} from '../services/supabaseCrmRepository';
import type {
  AllergyOverrideAuthorization,
  BackendSafetyCapabilities,
  DispensingEvent,
  DoseSchedule,
  MedicationCatalogItem,
  Patient,
  PatientMedicationPlan,
} from '../types/domain';

function makeValidSchedule(overrides: Partial<DoseSchedule> = {}): DoseSchedule {
  return {
    frequencyType: 'daily',
    timesPerDay: 2,
    doseSlots: [
      { id: 's1', time24: '08:00', doseAmount: 1 },
      { id: 's2', time24: '20:00', doseAmount: 1 },
    ],
    timezone: 'Asia/Baghdad',
    ...overrides,
  };
}

function makeValidPlanInput(
  patientId: string,
  overrides: Partial<NewMedicationPlanInput> = {}
): NewMedicationPlanInput {
  return {
    patientId,
    brandName: 'Glucophage',
    genericName: 'Metformin HCl',
    strength: '500 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: 'Take 1 tablet twice daily after meals.',
    startDate: '2026-11-01',
    isOngoing: true,
    schedule: makeValidSchedule(),
    ...overrides,
  };
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'pat-test-1',
    patientCode: 'PAT-2C2-001',
    pharmacyId: 'pharm-1',
    fullName: 'مراجع اختبار السلامة',
    phone: '07701234567',
    phoneOwnerType: 'self',
    dateOfBirth: '1980-05-10',
    sex: 'male',
    chronicConditions: ['Type 2 Diabetes'],
    allergies: [
      {
        id: 'alg-pen',
        substance: 'Penicillin',
        severity: 'severe',
        reaction: 'Anaphylaxis',
      },
    ],
    contactPreference: 'whatsapp',
    clinicalNotes: '',
    registrationDate: '2026-10-01',
    status: 'active',
    ...overrides,
  };
}

function makePlan(overrides: Partial<PatientMedicationPlan> = {}): PatientMedicationPlan {
  return {
    id: 'plan-test-1',
    patientId: 'pat-test-1',
    pharmacyId: 'pharm-1',
    brandName: 'Glucophage',
    genericName: 'Metformin HCl',
    strength: '500 mg',
    dosageForm: 'tablet',
    route: 'oral',
    doseAmount: 1,
    doseUnit: 'tablet',
    foodRelation: 'after_food',
    verifiedInstructions: 'Take 1 tablet twice daily after meals.',
    startDate: '2026-11-01',
    isOngoing: true,
    status: 'active',
    pausePeriods: [],
    currentVersionNumber: 1,
    schedule: makeValidSchedule(),
    regimenHistory: [],
    createdAt: '2026-11-01T08:00:00Z',
    updatedAt: '2026-11-01T08:00:00Z',
    ...overrides,
  };
}

async function runTests() {
  console.log('=== MASAR Care Stage 2C.2 Clinical Safety & Refill Protection Suite ===');

  // --------------------------------------------------------------------------
  // 1. Medication Dose, Route, Unit, Schedule & Calendar Validation
  // --------------------------------------------------------------------------
  {
    const baseInput = makeValidPlanInput('pat-1');
    assert.equal(validateMedicationPlanInput(baseInput, 'en').valid, true);
    assert.equal(validateMedicationPlanInput(baseInput, 'ar').valid, true);

    // Zero, negative, NaN, and absurd doses must reject
    for (const badDose of [0, -1, Number.NaN, MAX_REASONABLE_DOSE_AMOUNT + 1]) {
      const res = validateMedicationPlanInput(
        makeValidPlanInput('pat-1', { doseAmount: badDose }),
        'en'
      );
      assert.equal(res.valid, false, `Expected doseAmount=${badDose} to fail`);
    }

    // Mass/strength unit trap (e.g., entering "mg" as doseUnit on tablet/capsule/syrup/inhaler)
    for (const form of ['tablet', 'capsule', 'syrup', 'inhaler', 'sachet'] as const) {
      const unitRes = validateDosageFormUnitCompatibility(form, 'mg', 'en');
      assert.equal(unitRes.valid, false, `mg should be rejected for ${form}`);
      assert.match(unitRes.error ?? '', /strength|mass/i);
    }

    // Valid dosage-form units including Arabic/English injection units
    assert.equal(validateDosageFormUnitCompatibility('tablet', 'قرص', 'ar').valid, true);
    assert.equal(validateDosageFormUnitCompatibility('syrup', 'مل', 'ar').valid, true);
    assert.equal(validateDosageFormUnitCompatibility('inhaler', 'بخة', 'ar').valid, true);
    assert.equal(validateDosageFormUnitCompatibility('injection', 'وحدة / حقنة', 'ar').valid, true);
    assert.equal(validateDosageFormUnitCompatibility('injection', 'IU / inj', 'en').valid, true);
    assert.equal(validateDosageFormUnitCompatibility('cream', 'تطبيق موضعي', 'ar').valid, true);

    // Route-dosageForm incompatibility
    assert.equal(validateDosageFormRouteCompatibility('tablet', 'intravenous', 'en').valid, false);
    assert.equal(validateDosageFormRouteCompatibility('inhaler', 'oral', 'en').valid, false);
    assert.equal(validateDosageFormRouteCompatibility('cream', 'oral', 'en').valid, false);
    assert.equal(validateDosageFormRouteCompatibility('injection', 'subcutaneous', 'en').valid, true);
    assert.equal(validateDosageFormRouteCompatibility('drops', 'ophthalmic', 'en').valid, true);

    // Calendar date validation (2026-02-30 & 2026-02-29 non-leap year must fail; 2024-02-29 passes)
    assert.equal(isValidIsoCalendarDate('2026-02-30'), false);
    assert.equal(isValidIsoCalendarDate('2026-02-29'), false);
    assert.equal(isValidIsoCalendarDate('2024-02-29'), true);
    assert.equal(isValidIsoCalendarDate('2026-11-15'), true);

    const badDateRes = validateMedicationPlanInput(
      makeValidPlanInput('pat-1', { startDate: '2026-02-30' }),
      'en'
    );
    assert.equal(badDateRes.valid, false);

    // End date before start date & invalid durationDays
    const endBeforeStart = validateMedicationPlanInput(
      makeValidPlanInput('pat-1', {
        isOngoing: false,
        startDate: '2026-11-10',
        endDate: '2026-11-05',
        durationDays: 5,
      }),
      'en'
    );
    assert.equal(endBeforeStart.valid, false);

    const fractionalDays = validateMedicationPlanInput(
      makeValidPlanInput('pat-1', {
        isOngoing: false,
        startDate: '2026-11-01',
        endDate: '2026-11-10',
        durationDays: 2.5,
      }),
      'en'
    );
    assert.equal(fractionalDays.valid, false);

    // Schedule validation: duplicate time slots, daily count mismatch, interval hours multi-slot, PRN with slots
    const dupSlots = validateSchedule(
      makeValidSchedule({
        timesPerDay: 2,
        doseSlots: [
          { id: 's1', time24: '08:00', doseAmount: 1 },
          { id: 's2', time24: '08:00', doseAmount: 1 },
        ],
      }),
      'en'
    );
    assert.equal(dupSlots.valid, false);

    const dailyMismatch = validateSchedule(
      makeValidSchedule({
        timesPerDay: 3,
        doseSlots: [
          { id: 's1', time24: '08:00', doseAmount: 1 },
          { id: 's2', time24: '20:00', doseAmount: 1 },
        ],
      }),
      'en'
    );
    assert.equal(dailyMismatch.valid, false);

    const intervalHoursMultiSlot = validateSchedule(
      {
        frequencyType: 'interval',
        timesPerDay: 2,
        intervalValue: 8,
        intervalUnit: 'hours',
        doseSlots: [
          { id: 's1', time24: '08:00', doseAmount: 1 },
          { id: 's2', time24: '16:00', doseAmount: 1 },
        ],
        timezone: 'Asia/Baghdad',
      },
      'en'
    );
    assert.equal(intervalHoursMultiSlot.valid, false);

    const prnWithSlots = validateSchedule(
      {
        frequencyType: 'prn',
        timesPerDay: 0,
        prnIndication: 'Pain',
        prnMaxPerDay: 4,
        doseSlots: [{ id: 's1', time24: '08:00', doseAmount: 1 }],
        timezone: 'Asia/Baghdad',
      },
      'en'
    );
    assert.equal(prnWithSlots.valid, false);
  }

  // --------------------------------------------------------------------------
  // 2. Regimen Lifecycle, Immutability, & Archived Patient Enforcement
  // --------------------------------------------------------------------------
  {
    const adapter = new InMemoryCrmAdapter();
    const firstPatient = adapter.getState().patients[0];
    const firstPlan = adapter.getState().medicationPlans.find(
      (m) => m.patientId === firstPatient.id && m.status === 'active'
    )!;
    assert.ok(firstPlan);

    // Edit with valid reason increments version and deep-clones historical version
    const originalVersionCount = firstPlan.regimenHistory.length;
    const originalFirstSlotTime = firstPlan.regimenHistory[0]?.schedule.doseSlots[0]?.time24;

    adapter.updateMedicationPlan(
      firstPlan.id,
      makeValidPlanInput(firstPatient.id, {
        brandName: firstPlan.brandName,
        genericName: firstPlan.genericName,
        strength: firstPlan.strength,
        doseAmount: firstPlan.doseAmount,
        doseUnit: firstPlan.doseUnit,
        schedule: makeValidSchedule({
          timesPerDay: 1,
          doseSlots: [{ id: 'new-slot', time24: '09:30', doseAmount: firstPlan.doseAmount }],
        }),
      }),
      'Adjusted timing per clinician note',
      '2026-11-15',
      firstPlan.currentVersionNumber
    );

    const updatedPlan = adapter.getState().medicationPlans.find((m) => m.id === firstPlan.id)!;
    assert.equal(updatedPlan.currentVersionNumber, firstPlan.currentVersionNumber + 1);
    assert.equal(updatedPlan.regimenHistory.length, originalVersionCount + 1);
    assert.equal(updatedPlan.regimenHistory[0]?.schedule.doseSlots[0]?.time24, originalFirstSlotTime);

    // Mutating returned schedule slot does not corrupt stored regimenHistory
    updatedPlan.schedule.doseSlots[0].time24 = '23:59';
    assert.notEqual(
      updatedPlan.regimenHistory[updatedPlan.regimenHistory.length - 1]?.schedule.doseSlots[0]?.time24,
      '23:59'
    );

    // Stale expectedVersionNumber must be rejected
    assert.throws(
      () =>
        adapter.updateMedicationPlan(
          firstPlan.id,
          makeValidPlanInput(firstPatient.id),
          'Stale edit attempt',
          '2026-11-15',
          1 // stale!
        ),
      /version/i
    );

    // Discontinue plan, then verify editing and status resurrection are blocked
    adapter.changeMedicationStatus(firstPlan.id, 'discontinued', 'Switched therapy', '2026-11-15');
    const discPlan = adapter.getState().medicationPlans.find((m) => m.id === firstPlan.id)!;
    assert.equal(validateMedicationEditAllowed(discPlan, 'en').allowed, false);
    assert.equal(validateMedicationStatusTransition('discontinued', 'active', 'Retry', 'en').allowed, false);
    assert.equal(validateMedicationStatusTransition('discontinued', 'paused', 'Retry', 'en').allowed, false);
    assert.equal(validateMedicationStatusTransition('archived', 'active', 'Retry', 'en').allowed, false);

    assert.throws(
      () =>
        adapter.updateMedicationPlan(
          firstPlan.id,
          makeValidPlanInput(firstPatient.id),
          'Illegal edit on discontinued plan',
          '2026-11-15'
        ),
      /discontinued|immutable/i
    );
    assert.throws(
      () => adapter.changeMedicationStatus(firstPlan.id, 'active', 'Resurrect', '2026-11-15'),
      /discontinued|reactivate/i
    );

    // Archived patient blocks new medication plans & dispensing
    adapter.archivePatient(firstPatient.id, 'Transferred clinic', '2026-11-15');
    assert.throws(
      () => adapter.addMedicationPlan(makeValidPlanInput(firstPatient.id)),
      /archived/i
    );
  }

  // --------------------------------------------------------------------------
  // 3. Verified INN/Class Allergy Screening (Strict Clinical Honesty)
  // --------------------------------------------------------------------------
  {
    const penPatient = makePatient();

    // Severe penicillin allergy + Amoxicillin -> critical_conflict requiring pharmacist acknowledgment
    const amoxRisk = assessMedicationAllergyRisk(
      penPatient,
      { brandName: 'Amoxil', genericName: 'Amoxicillin', strength: '500 mg' },
      'en'
    );
    assert.equal(amoxRisk.level, 'critical_conflict');
    assert.equal(amoxRisk.severityTone, 'critical');
    assert.equal(amoxRisk.requiresPharmacistAcknowledgment, true);
    assert.ok(amoxRisk.message.includes('PAT-2C2-001'));
    assert.ok(amoxRisk.message.includes('Amoxil'));

    // Penicillin allergy + Cephalexin -> verified beta-lactam cross-reactivity caution
    const cephRisk = assessMedicationAllergyRisk(
      penPatient,
      { brandName: 'Keflex', genericName: 'Cephalexin', strength: '500 mg' },
      'en'
    );
    assert.equal(cephRisk.level, 'caution_cross_reactivity');
    assert.equal(cephRisk.requiresPharmacistAcknowledgment, true);

    // Aspirin allergy + Ibuprofen -> NSAID shared-class cross-reactivity caution (`possible_conflict`),
    // whereas Aspirin + Aspirin or broad NSAIDs + Ibuprofen -> confirmed `allergy_conflict`
    const nsaidPatient = makePatient({
      allergies: [
        { id: 'a-asa', substance: 'Aspirin', severity: 'moderate', reaction: 'Bronchospasm' },
      ],
    });
    const ibuCrossRisk = assessMedicationAllergyRisk(
      nsaidPatient,
      { brandName: 'Brufen', genericName: 'Ibuprofen', strength: '400 mg' },
      'en'
    );
    assert.equal(ibuCrossRisk.level, 'caution_cross_reactivity');
    assert.equal(ibuCrossRisk.conflictCategory, 'possible_conflict');
    assert.equal(ibuCrossRisk.requiresPharmacistAcknowledgment, true);

    const asaDirectRisk = assessMedicationAllergyRisk(
      nsaidPatient,
      { brandName: 'Aspirin Protect', genericName: 'Aspirin', strength: '100 mg' },
      'en'
    );
    assert.equal(asaDirectRisk.level, 'allergy_conflict');
    assert.equal(asaDirectRisk.conflictCategory, 'non_severe_conflict');

    const broadNsaidPatient = makePatient({
      allergies: [
        { id: 'a-nsaid', substance: 'NSAIDs', severity: 'moderate', reaction: 'Bronchospasm' },
      ],
    });
    const broadNsaidIbuRisk = assessMedicationAllergyRisk(
      broadNsaidPatient,
      { brandName: 'Brufen', genericName: 'Ibuprofen', strength: '400 mg' },
      'en'
    );
    assert.equal(broadNsaidIbuRisk.level, 'allergy_conflict');
    assert.equal(broadNsaidIbuRisk.conflictCategory, 'non_severe_conflict');

    // Sulfonamide allergy + Bactrim (Co-trimoxazole) -> critical conflict
    const sulfaPatient = makePatient({
      allergies: [
        { id: 'a-sulfa', substance: 'Sulfonamides', severity: 'severe', reaction: 'Stevens-Johnson' },
      ],
    });
    const sulfaRisk = assessMedicationAllergyRisk(
      sulfaPatient,
      { brandName: 'Bactrim', genericName: 'Trimethoprim/Sulfamethoxazole', strength: '480 mg' },
      'ar'
    );
    assert.equal(sulfaRisk.level, 'critical_conflict');
    assert.equal(sulfaRisk.severityTone, 'critical');
    assert.equal(sulfaRisk.requiresPharmacistAcknowledgment, true);

    // Unknown brand-only drug -> NEVER say "Safe", must return insufficient_ingredient_data
    const unknownRisk = assessMedicationAllergyRisk(
      penPatient,
      { brandName: 'MysteryCompoundX', genericName: 'UnknownExtract99', strength: '10 mg' },
      'en'
    );
    assert.equal(unknownRisk.level, 'insufficient_ingredient_data');
    assert.equal(unknownRisk.severityTone, 'warning');
    assert.equal(unknownRisk.requiresPharmacistAcknowledgment, true);

    // Zero documented allergies -> NEVER say "Safe", must return no_documented_allergies notice
    const zeroAllergyPatient = makePatient({ allergies: [] });
    const zeroAllergyRisk = assessMedicationAllergyRisk(
      zeroAllergyPatient,
      { brandName: 'Glucophage', genericName: 'Metformin HCl', strength: '500 mg' },
      'en'
    );
    assert.equal(zeroAllergyRisk.level, 'no_documented_allergies');
    assert.equal(zeroAllergyRisk.severityTone, 'warning');
    assert.ok(!/safe/i.test(zeroAllergyRisk.title));

    // Allergy missing reaction details -> incomplete_allergy_data notice
    const incompleteAllergyPatient = makePatient({
      allergies: [{ id: 'a-inc', substance: 'Penicillin', severity: 'mild', reaction: '' }],
    });
    const incompleteRisk = assessMedicationAllergyRisk(
      incompleteAllergyPatient,
      { brandName: 'Glucophage', genericName: 'Metformin HCl', strength: '500 mg' },
      'en'
    );
    assert.equal(incompleteRisk.level, 'incomplete_allergy_data');
    assert.equal(incompleteRisk.severityTone, 'warning');

    // Verified INN + complete allergy records + no conflict -> no_known_conflict_verified
    const verifiedNoConflict = assessMedicationAllergyRisk(
      penPatient,
      { brandName: 'Glucophage', genericName: 'Metformin HCl', strength: '500 mg' },
      'en'
    );
    assert.equal(verifiedNoConflict.level, 'no_known_conflict_verified');
    assert.equal(verifiedNoConflict.requiresPharmacistAcknowledgment, false);
  }

  // --------------------------------------------------------------------------
  // 4. Dispensing Safety, Pack Math, Expiry, Idempotency & Network Errors
  // --------------------------------------------------------------------------
  {
    const patient = makePatient();
    const plan = makePlan();

    // Expired stock block (expiryDate < dispensingDate)
    const expiredRes = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        expiryDate: '2026-10-31',
        dispensingDate: '2026-11-15',
        isPartialFill: false,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(expiredRes.valid, false);
    assert.match(expiredRes.errors[0], /expired/i);

    // Near-expiry warning (<= 30 days) allows dispensing with explicit warning
    const nearExpiryRes = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        expiryDate: '2026-12-05',
        dispensingDate: '2026-11-15',
        isPartialFill: false,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(nearExpiryRes.valid, true);
    assert.equal(nearExpiryRes.warnings.length, 1);

    // Future dispensingDate block in UI-level check
    const futureRes = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        dispensingDate: '2026-11-20',
        isPartialFill: false,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(futureRes.valid, false);

    // Pack math mismatch without isPartialFill rejected; with isPartialFill (<= packTotal) allowed; exceeding packTotal rejected
    const packMismatch = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 20,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(packMismatch.valid, false);

    const partialValid = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 15,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: true,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(partialValid.valid, true);

    const partialOverPack = validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: plan.id,
        dispensedQuantity: 45,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: true,
      },
      'en',
      { patient, plan, todayStr: '2026-11-15' }
    );
    assert.equal(partialOverPack.valid, false);

    // Paused plan, archived patient, cross-patient plan, incompatible unit, stale regimen version
    assert.equal(
      validateDispensingInput(
        {
          patientId: patient.id,
          medicationPlanId: plan.id,
          dispensedQuantity: 30,
          quantityUnit: 'tablet',
          dispensingDate: '2026-11-15',
          isPartialFill: false,
        },
        'en',
        { patient, plan: makePlan({ status: 'paused' }), todayStr: '2026-11-15' }
      ).valid,
      false
    );

    assert.equal(
      validateDispensingInput(
        {
          patientId: patient.id,
          medicationPlanId: plan.id,
          dispensedQuantity: 30,
          quantityUnit: 'tablet',
          dispensingDate: '2026-11-15',
          isPartialFill: false,
        },
        'en',
        { patient: makePatient({ status: 'archived' }), plan, todayStr: '2026-11-15' }
      ).valid,
      false
    );

    assert.equal(
      validateDispensingInput(
        {
          patientId: 'other-patient',
          medicationPlanId: plan.id,
          dispensedQuantity: 30,
          quantityUnit: 'tablet',
          dispensingDate: '2026-11-15',
          isPartialFill: false,
        },
        'en',
        { patient: makePatient({ id: 'other-patient' }), plan, todayStr: '2026-11-15' }
      ).valid,
      false
    );

    assert.equal(
      validateDispensingInput(
        {
          patientId: patient.id,
          medicationPlanId: plan.id,
          dispensedQuantity: 30,
          quantityUnit: 'mL',
          dispensingDate: '2026-11-15',
          isPartialFill: false,
        },
        'en',
        { patient, plan, todayStr: '2026-11-15', allowIncompatibleUnit: false }
      ).valid,
      false
    );

    assert.equal(
      validateDispensingInput(
        {
          patientId: patient.id,
          medicationPlanId: plan.id,
          dispensedQuantity: 30,
          quantityUnit: 'tablet',
          dispensingDate: '2026-11-15',
          isPartialFill: false,
          expectedRegimenVersionNumber: 1,
        },
        'en',
        { patient, plan: makePlan({ currentVersionNumber: 2 }), todayStr: '2026-11-15' }
      ).valid,
      false
    );

    // ClientEventUuid idempotency in InMemoryCrmAdapter
    const adapter = new InMemoryCrmAdapter();
    const activePat = adapter.getState().patients[0];
    const activePlan = adapter
      .getState()
      .medicationPlans.find((m) => m.patientId === activePat.id && m.status === 'active')!;
    const beforeCount = adapter.getState().dispensingEvents.length;
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const firstSave = adapter.recordDispensing(
      {
        patientId: activePat.id,
        medicationPlanId: activePlan.id,
        dispensedQuantity: 30,
        quantityUnit: activePlan.doseUnit,
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        expectedRegimenVersionNumber: activePlan.currentVersionNumber,
        clientEventUuid: uuid,
      },
      'en'
    );
    const secondSave = adapter.recordDispensing(
      {
        patientId: activePat.id,
        medicationPlanId: activePlan.id,
        dispensedQuantity: 30,
        quantityUnit: activePlan.doseUnit,
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        expectedRegimenVersionNumber: activePlan.currentVersionNumber,
        clientEventUuid: uuid,
      },
      'en'
    );
    assert.equal(adapter.getState().dispensingEvents.length, beforeCount + 1);
    assert.equal(firstSave.event?.id, secondSave.event?.id);

    // Uncertain network error classification
    const fetchFail = classifyUncertainNetworkError(new TypeError('Failed to fetch'), 'en');
    assert.equal(fetchFail.isUncertainOutcome, true);
    assert.match(fetchFail.userMessage, /refresh the dispensing ledger/i);

    const deterministicRejection = classifyUncertainNetworkError(
      { pgCode: '23514', message: 'Clinical integrity check failed' },
      'en'
    );
    assert.equal(deterministicRejection.isUncertainOutcome, false);
  }

  // --------------------------------------------------------------------------
  // 5. Refill Engine Unit Safety & Baghdad Boundary Edge Cases
  // --------------------------------------------------------------------------
  {
    // Blank units MUST NOT match as compatible
    assert.equal(areUnitsCompatibleForRefill('', ''), false);
    assert.equal(areUnitsCompatibleForRefill('   ', ''), false);
    assert.equal(areUnitsCompatibleForRefill('tablet', ''), false);

    // Arabic & English unit normalization parity
    assert.equal(areUnitsCompatibleForRefill('وحدة / حقنة', 'IU / inj'), true);
    assert.equal(areUnitsCompatibleForRefill('تطبيق موضعي', 'application'), true);
    assert.equal(normalizeClinicalUnitCategory('mg'), 'mg');
    assert.equal(normalizeClinicalUnitCategory('مل'), 'ml');
    assert.equal(areUnitsCompatibleForRefill('mg', 'tablet'), false);
    assert.equal(areUnitsCompatibleForRefill('mL', 'bottle'), false);

    // PRN / Paused / Variable / Discontinued / Regimen-change / Multi-fill / Baghdad midnight
    const patient = makePatient();
    const bidPlan = makePlan({
      startDate: '2026-11-01',
      schedule: makeValidSchedule({ timesPerDay: 2 }), // 2 tablets/day
    });

    const multiEvents: DispensingEvent[] = [
      {
        id: 'disp-1',
        pharmacyId: 'pharm-1',
        patientId: patient.id,
        medicationPlanId: bidPlan.id,
        regimenVersionNumber: 1,
        dispensedQuantity: 10,
        quantityUnit: 'tablet',
        dispensingDate: '2026-11-01',
        dispensedByStaffId: 'staff-1',
        dispensedByStaffName: 'Pharmacist',
        estimatedDailyConsumption: 2,
        estimatedSupplyDays: 5,
        estimatedSupplyEndDate: '2026-11-06',
        forecastAssumptions: 'test',
        isPartialFill: false,
        createdAt: '2026-11-01T09:00:00Z',
      },
      {
        id: 'disp-2',
        pharmacyId: 'pharm-1',
        patientId: patient.id,
        medicationPlanId: bidPlan.id,
        regimenVersionNumber: 1,
        dispensedQuantity: 10,
        quantityUnit: 'tablet',
        dispensingDate: '2026-11-05',
        dispensedByStaffId: 'staff-1',
        dispensedByStaffName: 'Pharmacist',
        estimatedDailyConsumption: 2,
        estimatedSupplyDays: 5,
        estimatedSupplyEndDate: '2026-11-10',
        forecastAssumptions: 'test',
        isPartialFill: false,
        createdAt: '2026-11-05T09:00:00Z',
      },
    ];

    // Total 20 tablets starting 2026-11-01 at 2/day -> depletes on 2026-11-11
    const projBefore = computeRefillProjection(bidPlan, patient, multiEvents, 'en', '2026-11-06');
    assert.equal(projBefore.estimatedRemainingUnits, 10);
    assert.equal(projBefore.estimatedDaysRemaining, 5);
    assert.equal(projBefore.estimatedSupplyEndDate, '2026-11-11');

    // Interval Q8h forecast (3/day)
    const q8hPlan = makePlan({
      schedule: {
        frequencyType: 'interval',
        timesPerDay: 1,
        intervalValue: 8,
        intervalUnit: 'hours',
        doseSlots: [{ id: 's1', time24: '08:00', doseAmount: 1 }],
        timezone: 'Asia/Baghdad',
      },
    });
    const q8hForecast = calculateDispensingForecast(q8hPlan, 21, '2026-11-15', 'en', 'tablet');
    assert.equal(q8hForecast.estimatedDailyConsumption, 3);
    assert.equal(q8hForecast.estimatedSupplyDays, 7);

    // Invalid calendar date returns unable_to_estimate instead of crashing or drifting
    const badDateForecast = calculateDispensingForecast(bidPlan, 30, '2026-02-30', 'en', 'tablet');
    assert.equal(badDateForecast.estimatedSupplyEndDate, null);

    // PRN plan never generates overdue refill status
    const prnPlan = makePlan({
      schedule: {
        frequencyType: 'prn',
        timesPerDay: 0,
        prnIndication: 'Wheezing',
        prnMaxPerDay: 4,
        doseSlots: [],
        timezone: 'Asia/Baghdad',
      },
    });
    const prnProj = computeRefillProjection(prnPlan, patient, multiEvents, 'en', '2026-11-15');
    assert.equal(prnProj.refillStatus, 'paused_or_prn');
  }

  // --------------------------------------------------------------------------
  // 6. Connected SupabaseCrmRepository Parity & Draft SQL Presence Checks
  // --------------------------------------------------------------------------
  {
    let rpcCallCount = 0;
    const fakeStateRow = {
      pharmacies: {
        id: 'pharm-1',
        name_ar: 'صيدلية مسار',
        name_en: 'MASAR Pharmacy',
        license_number: 'LIC-1',
        city: 'Baghdad',
        governorate: 'Baghdad',
        phone: '07700000000',
        timezone: 'Asia/Baghdad',
        is_active: true,
      },
      pharmacy_staff: [
        {
          id: 'user-1',
          pharmacy_id: 'pharm-1',
          full_name: 'د. صيدلي',
          role: 'pharmacy_owner',
          phone: '07700000001',
          syndicate_license: 'PH-1',
          is_active: true,
        },
      ],
      patients: [
        {
          id: 'pat-1',
          patient_code: 'DEV-TEST-001',
          pharmacy_id: 'pharm-1',
          full_name: 'مريض مسار التجريبي',
          phone: '07701234567',
          phone_owner_type: 'self',
          caregiver_name: null,
          date_of_birth: '1980-01-01',
          sex: 'male',
          contact_preference: 'whatsapp',
          clinical_notes: '',
          registration_date: '2026-10-01',
          status: 'active',
          archived_at: null,
          archived_reason: null,
        },
      ],
      patient_conditions: [],
      patient_allergies: [],
      patient_medication_plans: [
        {
          id: 'plan-1',
          pharmacy_id: 'pharm-1',
          patient_id: 'pat-1',
          catalog_id: null,
          brand_name: 'Glucophage',
          generic_name: 'Metformin HCl',
          strength: '500 mg',
          dosage_form: 'tablet',
          route: 'oral',
          dose_amount: 1,
          dose_unit: 'tablet',
          food_relation: 'after_food',
          verified_instructions: 'Take 1 tablet twice daily',
          prescriber_name: null,
          prescriber_specialty: null,
          start_date: '2026-11-01',
          end_date: null,
          is_ongoing: true,
          duration_days: null,
          status: 'active',
          status_changed_at: null,
          status_change_reason: null,
          current_version_number: 1,
          schedule: makeValidSchedule(),
          created_at: '2026-11-01T08:00:00Z',
          updated_at: '2026-11-01T08:00:00Z',
        },
      ],
      regimen_versions: [],
      medication_pause_periods: [],
      dispensing_events: [
        {
          id: 'disp-existing',
          pharmacy_id: 'pharm-1',
          patient_id: 'pat-1',
          medication_plan_id: 'plan-1',
          regimen_version_number: 1,
          dispensed_quantity: 30,
          quantity_unit: 'tablet',
          package_count: 1,
          package_size: 30,
          batch_number: null,
          expiry_date: null,
          dispensing_date: '2026-11-15',
          dispensed_by_staff_id: 'user-1',
          dispensed_by_staff_name: 'د. صيدلي',
          notes: null,
          estimated_daily_consumption: 2,
          estimated_supply_days: 15,
          estimated_supply_end_date: '2026-11-30',
          forecast_assumptions: 'test',
          is_partial_fill: false,
          calculation_source: 'provisional_client_unverified',
          verification_status: 'provisional_unverified',
          algorithm_version: 'masar_refill_v1',
          calculation_inputs: { clientSubmissionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          created_at: '2026-11-15T08:00:00Z',
        },
      ],
      dose_events: [],
      lab_results: [],
      follow_up_tasks: [],
      follow_up_contact_logs: [],
      consultation_threads: [],
      consultation_messages: [],
      patient_apk_invitations: [],
      audit_logs: [],
    };

    const mockClient = {
      from: (table: string) => {
        const makeChain = (): Record<string, unknown> => ({
          select: () => makeChain(),
          eq: () => makeChain(),
          order: () => makeChain(),
          single: async () => ({
            data: table === 'pharmacies' ? fakeStateRow.pharmacies : null,
            error: null,
          }),
          maybeSingle: async () => ({
            data: table === 'pharmacies' ? fakeStateRow.pharmacies : null,
            error: null,
          }),
          range: async () => ({
            data: (fakeStateRow as Record<string, unknown>)[table] ?? [],
            error: null,
          }),
        });
        return makeChain();
      },
      rpc: async (fnName: string) => {
        if (fnName === 'get_clinical_safety_capabilities') {
          return {
            data: null,
            error: {
              code: 'PGRST202',
              message:
                'Could not find the function public.get_clinical_safety_capabilities without parameters in the schema cache',
            },
          };
        }
        rpcCallCount += 1;
        return { data: { ok: true, dispensingEventId: 'disp-existing' }, error: null };
      },
    } as unknown as SupabaseClient;

    const repo = new SupabaseCrmRepository(mockClient, {
      userId: 'user-1',
      email: 'owner@masar.iq',
      pharmacyId: 'pharm-1',
      role: 'pharmacy_owner',
      staff: {
        id: 'user-1',
        pharmacyId: 'pharm-1',
        fullName: 'د. صيدلي',
        role: 'pharmacy_owner',
        phone: '07700000001',
        syndicateLicense: 'PH-1',
        isActive: true,
      },
      pharmacy: {
        id: 'pharm-1',
        nameAr: 'صيدلية مسار',
        nameEn: 'MASAR Pharmacy',
        city: 'Baghdad',
        governorate: 'Baghdad',
        licenseNumber: 'LIC-1',
        phone: '07700000000',
        timezone: 'Asia/Baghdad',
      },
    });

    // Reject expired batch BEFORE calling RPC
    await assert.rejects(
      () =>
        repo.recordDispensingAsync(
          {
            patientId: 'pat-1',
            medicationPlanId: 'plan-1',
            dispensedQuantity: 30,
            quantityUnit: 'tablet',
            expiryDate: '2026-10-01',
            dispensingDate: '2026-11-15',
            isPartialFill: false,
          },
          'en'
        ),
      /expired/i
    );
    assert.equal(rpcCallCount, 0);

    // Reject invalid medication plan payload BEFORE calling RPC
    await assert.rejects(
      () =>
        repo.addMedicationPlanAsync(
          makeValidPlanInput('pat-1', { dosageForm: 'tablet', doseUnit: 'mg' })
        ),
      /strength|mass/i
    );
    assert.equal(rpcCallCount, 0);

    // Idempotent replay of matching clientEventUuid returns existing event without duplicate RPC
    const replay = await repo.recordDispensingAsync(
      {
        patientId: 'pat-1',
        medicationPlanId: 'plan-1',
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        clientEventUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      'en'
    );
    assert.equal(replay.event?.id, 'disp-existing');
    assert.equal(rpcCallCount, 0);

    // Verify Stage 2C.2C separated SQL artifacts live in supabase/drafts and supabase/tests
    const legacyDraftPath = path.resolve(
      process.cwd(),
      'supabase/drafts/stage2c2_clinical_safety_draft.sql'
    );
    assert.equal(fs.existsSync(legacyDraftPath), false);
    assert.equal(
      fs.existsSync(path.resolve(process.cwd(), 'supabase/drafts/stage2c2b_migration_DRAFT.sql')),
      false
    );

    const migrationDraftPath = path.resolve(
      process.cwd(),
      'supabase/drafts/stage2c2c_migration_DRAFT.sql'
    );
    assert.equal(fs.existsSync(migrationDraftPath), true);
    const migrationSql = fs.readFileSync(migrationDraftPath, 'utf8');
    assert.match(migrationSql, /STAGE 2C\.2C/i);
    assert.match(migrationSql, /ux_dispensing_events_pharmacy_client_uuid/);
  }

  // --------------------------------------------------------------------------
  // 7. Stage 2C.2A & Stage 2C.2B Corrections (Simulated Client/Adapter + SQL Checks)
  //    NOTE: Connected PostgreSQL tests here are client-side / mocked RPC
  //    simulations; live DB `bkidngfzsubmyunacnju` stays on migration 0004
  //    until `supabase/drafts/stage2c2b_migration_DRAFT.sql` is promoted.
  // --------------------------------------------------------------------------
  {
    const createMemoryStorage = (): { store: StorageLike; dump: () => Record<string, string> } => {
      const backing = new Map<string, string>();
      return {
        store: {
          getItem: (k) => backing.get(k) ?? null,
          setItem: (k, v) => {
            backing.set(k, v);
          },
          removeItem: (k) => {
            backing.delete(k);
          },
        },
        dump: () => Object.fromEntries(backing.entries()),
      };
    };

    // 7A. Non-PHI retry UUID persistence across uncertain network timeout & page reload
    const memStorage = createMemoryStorage();
    const dispenseBase = {
      patientId: 'pat-1',
      medicationPlanId: 'plan-1',
      dispensedQuantity: 30,
      quantityUnit: 'tablet',
      packageCount: 1,
      packageSize: 30,
      batchNumber: 'B-2C2A',
      expiryDate: '2027-06-01',
      dispensingDate: '2026-11-15',
      isPartialFill: false,
      notes: 'Simulated timeout recovery',
    };
    const scopeKey = buildDispensingIdempotencyScopeKey('pharm-1', dispenseBase);
    const initialUuid = getOrCreatePendingDispensingUuid(
      scopeKey,
      () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      memStorage.store,
      1_700_000_000_000
    );
    // Simulate reload: same scopeKey yields same UUID; zero PHI present in serialized storage
    const afterReloadUuid = getOrCreatePendingDispensingUuid(
      scopeKey,
      () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      memStorage.store,
      1_700_000_010_000
    );
    assert.equal(afterReloadUuid, initialUuid);
    const dumpedJson = JSON.stringify(memStorage.dump());
    assert.equal(dumpedJson.includes('pat-1'), false);
    assert.equal(dumpedJson.includes('Glucophage'), false);
    assert.equal(dumpedJson.includes('B-2C2A'), false);

    // Payload change produces distinct scope key and fresh UUID
    const alteredScopeKey = buildDispensingIdempotencyScopeKey('pharm-1', {
      ...dispenseBase,
      dispensedQuantity: 60,
    });
    assert.notEqual(alteredScopeKey, scopeKey);
    clearPendingDispensingUuid(scopeKey, memStorage.store, 1_700_000_020_000);
    assert.equal(peekPendingDispensingUuid(scopeKey, memStorage.store, 1_700_000_020_000), null);
    clearAllPendingDispensingUuids(memStorage.store);

    // 7B. Simulated network timeout on commit + retry + concurrent duplicate + UUID payload mismatch
    let networkTimedOutOnce = false;
    const simulatedServerEvents: Array<Record<string, unknown>> = [];
    const seenServerUuids = new Map<string, { eventId: string; hash: string }>();

    const makeStatefulMockClient = (opts?: {
      simulateTimeoutFirstWrite?: boolean;
      forceVersion40001?: boolean;
      backendMode?: 'migration_0004_legacy' | 'stage2c2b_v2' | 'auth_denied';
      rpcCallLog?: Array<{ fnName: string; args: Record<string, unknown> }>;
    }) =>
      ({
        from: (table: string) => {
          const baseRows: Record<string, unknown> = {
            pharmacies: {
              id: 'pharm-1',
              name_ar: 'صيدلية مسار',
              name_en: 'MASAR Pharmacy',
              license_number: 'LIC-1',
              city: 'Baghdad',
              governorate: 'Baghdad',
              phone: '07700000000',
              timezone: 'Asia/Baghdad',
              is_active: true,
            },
            pharmacy_staff: [
              {
                id: 'user-1',
                pharmacy_id: 'pharm-1',
                full_name: 'د. صيدلي',
                role: 'pharmacy_owner',
                phone: '07700000001',
                syndicate_license: 'PH-1',
                is_active: true,
              },
            ],
            patients: [
              {
                id: 'pat-1',
                patient_code: 'DEV-TEST-001',
                pharmacy_id: 'pharm-1',
                full_name: 'مريض مسار التجريبي',
                phone: '07701234567',
                phone_owner_type: 'self',
                caregiver_name: null,
                date_of_birth: '1980-01-01',
                sex: 'male',
                contact_preference: 'whatsapp',
                clinical_notes: '',
                registration_date: '2026-10-01',
                status: 'active',
                archived_at: null,
                archived_reason: null,
              },
            ],
            patient_conditions: [],
            patient_allergies: [],
            patient_medication_plans: [
              {
                id: 'plan-1',
                pharmacy_id: 'pharm-1',
                patient_id: 'pat-1',
                catalog_id: null,
                brand_name: 'Glucophage',
                generic_name: 'Metformin HCl',
                strength: '500 mg',
                dosage_form: 'tablet',
                route: 'oral',
                dose_amount: 1,
                dose_unit: 'tablet',
                food_relation: 'after_food',
                verified_instructions: 'Take 1 tablet twice daily',
                prescriber_name: null,
                prescriber_specialty: null,
                start_date: '2026-11-01',
                end_date: null,
                is_ongoing: true,
                duration_days: null,
                status: 'active',
                status_changed_at: null,
                status_change_reason: null,
                current_version_number: 2,
                schedule: makeValidSchedule(),
                created_at: '2026-11-01T08:00:00Z',
                updated_at: '2026-11-01T08:00:00Z',
              },
            ],
            regimen_versions: [],
            medication_pause_periods: [],
            dispensing_events: simulatedServerEvents,
            dose_events: [],
            lab_results: [],
            follow_up_tasks: [],
            follow_up_contact_logs: [],
            consultation_threads: [],
            consultation_messages: [],
            patient_apk_invitations: [],
            audit_logs: [],
          };
          const makeChain = (): Record<string, unknown> => ({
            select: () => makeChain(),
            eq: () => makeChain(),
            order: () => makeChain(),
            single: async () => ({
              data: table === 'pharmacies' ? baseRows.pharmacies : null,
              error: null,
            }),
            maybeSingle: async () => ({
              data: table === 'pharmacies' ? baseRows.pharmacies : null,
              error: null,
            }),
            range: async () => ({
              data: (baseRows[table] as unknown[]) ?? [],
              error: null,
            }),
          });
          return makeChain();
        },
        rpc: async (fnName: string, args: Record<string, unknown> = {}) => {
          opts?.rpcCallLog?.push({ fnName, args });

          if (fnName === 'get_clinical_safety_capabilities') {
            if (opts?.backendMode === 'auth_denied') {
              return {
                data: null,
                error: {
                  code: '42501',
                  message: 'Active pharmacist session required',
                },
              };
            }
            if (opts?.backendMode === 'migration_0004_legacy') {
              return {
                data: null,
                error: {
                  code: 'PGRST202',
                  message:
                    'Could not find the function public.get_clinical_safety_capabilities without parameters in the schema cache',
                },
              };
            }
            return {
              data: {
                ok: true,
                stage: 'stage2c2b_v2',
                supportsV2MedicationPlans: true,
                supportsV2DispensingIdempotency: true,
                enforcesServerCriticalAllergyOverride: true,
                serverRefillAuthorityReady: true,
              },
              error: null,
            };
          }

          if (opts?.backendMode === 'migration_0004_legacy' && fnName.endsWith('_v2')) {
            return {
              data: null,
              error: {
                code: 'PGRST202',
                message: `Could not find the function public.${fnName} in the schema cache`,
              },
            };
          }

          if (opts?.forceVersion40001) {
            return {
              data: null,
              error: {
                code: '40001',
                message: 'Regimen version mismatch: expected v1, current v2.',
              },
            };
          }

          if (
            fnName === 'create_medication_plan_with_version' ||
            fnName === 'create_medication_plan_with_version_v2'
          ) {
            return { data: { ok: true, planId: 'plan-1' }, error: null };
          }

          if (
            fnName === 'update_medication_plan_version' ||
            fnName === 'update_medication_plan_version_v2'
          ) {
            return { data: { ok: true, planId: String(args.p_plan_id ?? 'plan-1') }, error: null };
          }

          if (
            fnName === 'record_dispensing_with_refill' ||
            fnName === 'record_dispensing_with_refill_v2'
          ) {
            const calcInputs = (args.p_calculation_inputs as Record<string, unknown> | undefined) ?? {};
            const uuid = String(args.p_client_event_uuid ?? calcInputs.clientSubmissionId ?? '');
            const payloadHash = String(args.p_client_payload_hash ?? calcInputs.clientPayloadHash ?? '');
            const existing = uuid ? seenServerUuids.get(uuid) : undefined;
            if (!existing) {
              const eventId = `disp-${simulatedServerEvents.length + 1}`;
              if (uuid) {
                seenServerUuids.set(uuid, { eventId, hash: payloadHash });
              }
              simulatedServerEvents.push({
                id: eventId,
                pharmacy_id: 'pharm-1',
                patient_id: args.p_patient_id,
                medication_plan_id: args.p_medication_plan_id,
                regimen_version_number: 2,
                dispensed_quantity: args.p_dispensed_quantity,
                quantity_unit: args.p_quantity_unit,
                package_count: args.p_package_count,
                package_size: args.p_package_size,
                batch_number: args.p_batch_number,
                expiry_date: args.p_expiry_date,
                dispensing_date: args.p_dispensing_date,
                dispensed_by_staff_id: 'user-1',
                dispensed_by_staff_name: 'د. صيدلي',
                notes: args.p_notes,
                estimated_daily_consumption: 2,
                estimated_supply_days: 15,
                estimated_supply_end_date: '2026-11-30',
                forecast_assumptions: 'test',
                is_partial_fill: args.p_is_partial_fill,
                calculation_source: 'provisional_client_unverified',
                verification_status: 'provisional_unverified',
                algorithm_version: 'masar_refill_v1',
                calculation_inputs: args.p_calculation_inputs,
                created_at: '2026-11-15T10:00:00Z',
              });
              if (opts?.simulateTimeoutFirstWrite && !networkTimedOutOnce) {
                networkTimedOutOnce = true;
                throw new Error('Failed to fetch: network timeout after server commit');
              }
              return { data: { ok: true, dispensingEventId: eventId, idempotentReplay: false }, error: null };
            }
            if (existing.hash !== payloadHash) {
              return {
                data: null,
                error: { code: '23514', message: 'Idempotency conflict: client_event_uuid reused with modified payload.' },
              };
            }
            return { data: { ok: true, dispensingEventId: existing.eventId, idempotentReplay: true }, error: null };
          }
          return { data: { ok: true }, error: null };
        },
      }) as unknown as SupabaseClient;

    const pharmacistCtx = {
      userId: 'user-1',
      email: 'owner@masar.iq',
      pharmacyId: 'pharm-1',
      role: 'pharmacy_owner' as const,
      staff: {
        id: 'user-1',
        pharmacyId: 'pharm-1',
        fullName: 'د. صيدلي',
        role: 'pharmacy_owner' as const,
        phone: '07700000001',
        syndicateLicense: 'PH-1',
        isActive: true,
      },
      pharmacy: {
        id: 'pharm-1',
        nameAr: 'صيدلية مسار',
        nameEn: 'MASAR Pharmacy',
        city: 'Baghdad',
        governorate: 'Baghdad',
        licenseNumber: 'LIC-1',
        phone: '07700000000',
        timezone: 'Asia/Baghdad' as const,
      },
    };

    const timeoutRepo = new SupabaseCrmRepository(
      makeStatefulMockClient({ simulateTimeoutFirstWrite: true }),
      pharmacistCtx
    );
    const retryPayloadHash = computeDispensingPayloadHash(dispenseBase);

    // 1) First request commits on server then times out over network
    await assert.rejects(
      () =>
        timeoutRepo.recordDispensingAsync(
          {
            ...dispenseBase,
            expectedRegimenVersionNumber: 2,
            clientEventUuid: initialUuid,
            clientPayloadHash: retryPayloadHash,
          },
          'en'
        ),
      /Failed to fetch/i
    );
    assert.equal(simulatedServerEvents.length, 1);

    // 2) Retry with same clientEventUuid & same payload finds committed event via getStateAsync (refresh/replay)
    const retryRes = await timeoutRepo.recordDispensingAsync(
      {
        ...dispenseBase,
        expectedRegimenVersionNumber: 2,
        clientEventUuid: initialUuid,
        clientPayloadHash: retryPayloadHash,
      },
      'en'
    );
    assert.equal(retryRes.event?.id, 'disp-1');
    assert.equal(retryRes.event?.clientEventUuid, initialUuid);
    assert.equal(retryRes.event?.clientPayloadHash, retryPayloadHash);
    assert.equal(simulatedServerEvents.length, 1);

    // 3) Reusing committed clientEventUuid with modified dispensing quantity fails cleanly
    await assert.rejects(
      () =>
        timeoutRepo.recordDispensingAsync(
          {
            ...dispenseBase,
            dispensedQuantity: 60,
            packageCount: 2,
            expectedRegimenVersionNumber: 2,
            clientEventUuid: initialUuid,
          },
          'en'
        ),
      /Idempotency conflict|modified dispensing details/i
    );

    // 4) Simultaneous duplicate requests against InMemoryCrmAdapter produce exactly one event
    const adapter = new InMemoryCrmAdapter();
    const stateA = adapter.getState();
    const pA = stateA.patients[0];
    const mA = stateA.medicationPlans.find((m) => m.patientId === pA.id && m.status === 'active')!;
    const dupUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const d1 = adapter.recordDispensing(
      {
        patientId: pA.id,
        medicationPlanId: mA.id,
        dispensedQuantity: 30,
        quantityUnit: mA.doseUnit,
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        expectedRegimenVersionNumber: mA.currentVersionNumber,
        clientEventUuid: dupUuid,
      },
      'en'
    );
    const d2 = adapter.recordDispensing(
      {
        patientId: pA.id,
        medicationPlanId: mA.id,
        dispensedQuantity: 30,
        quantityUnit: mA.doseUnit,
        packageCount: 1,
        packageSize: 30,
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        expectedRegimenVersionNumber: mA.currentVersionNumber,
        clientEventUuid: dupUuid,
      },
      'en'
    );
    assert.equal(d1.event?.id, d2.event?.id);
    assert.equal(
      d2.state.dispensingEvents.filter((e) => e.clientEventUuid === dupUuid).length,
      1
    );
    assert.throws(
      () =>
        adapter.recordDispensing(
          {
            patientId: pA.id,
            medicationPlanId: mA.id,
            dispensedQuantity: 60,
            quantityUnit: mA.doseUnit,
            packageCount: 2,
            packageSize: 30,
            dispensingDate: '2026-11-15',
            isPartialFill: false,
            expectedRegimenVersionNumber: mA.currentVersionNumber,
            clientEventUuid: dupUuid,
          },
          'en'
        ),
      /Idempotency conflict/i
    );

    // 7C. Stale medication version edit & stale dispensing rejected both client-side and via server 40001
    await assert.rejects(
      () =>
        timeoutRepo.updateMedicationPlanAsync(
          'plan-1',
          makeValidPlanInput('pat-1', { strength: '850 mg' }),
          'Dose adjustment',
          '2026-11-16',
          1 // current_version_number is 2!
        ),
      /version conflict|refresh/i
    );
    await assert.rejects(
      () =>
        timeoutRepo.recordDispensingAsync(
          {
            ...dispenseBase,
            dispensingDate: '2026-11-16',
            expectedRegimenVersionNumber: 1, // current_version_number is 2!
            clientEventUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
          'en'
        ),
      /Regimen version conflict|refresh/i
    );
    const classified40001 = classifyUncertainNetworkError(
      { code: '40001', message: 'Regimen version mismatch: expected v1, current v2.' },
      'en'
    );
    assert.equal(classified40001.isUncertainOutcome, false);
    assert.match(classified40001.userMessage, /version mismatch|version conflict|concurrent/i);

    // Server-simulated 40001 when bypassing local version check (expectedVersionNumber omitted)
    const serverConflictRepo = new SupabaseCrmRepository(
      makeStatefulMockClient({ forceVersion40001: true }),
      pharmacistCtx
    );
    await assert.rejects(
      () =>
        serverConflictRepo.updateMedicationPlanAsync(
          'plan-1',
          makeValidPlanInput('pat-1', { strength: '850 mg' }),
          'Concurrent edit test'
        ),
      /Concurrent modification|version conflict|40001|mismatch/i
    );

    // 7D. Combination drug screening: Janumet = Sitagliptin + Metformin HCl
    const metforminAllergyPatient = makePatient({
      id: 'pat-met-allergy',
      allergies: [
        {
          id: 'alg-met',
          substance: 'Metformin',
          severity: 'severe',
          reaction: 'Lactic acidosis / severe intolerance',
        },
      ],
    });
    // Brand-only entry for Janumet catches secondary Metformin HCl
    const janumetBrandOnly = assessMedicationAllergyRisk(
      metforminAllergyPatient,
      { brandName: 'Janumet', genericName: '', strength: '50/500 mg' },
      'en'
    );
    assert.equal(janumetBrandOnly.level, 'critical_conflict');
    assert.equal(janumetBrandOnly.requiresDocumentedOverride, true);
    assert.equal(
      janumetBrandOnly.verifiedIngredients.some((i) => i.toLowerCase().includes('metformin')),
      true
    );

    // Partial/incomplete generic name "Sitagliptin" on Janumet still catches combo Metformin conflict
    const janumetPartialGeneric = assessMedicationAllergyRisk(
      metforminAllergyPatient,
      { brandName: 'Janumet', genericName: 'Sitagliptin', strength: '50/500 mg' },
      'en'
    );
    assert.equal(janumetPartialGeneric.level, 'critical_conflict');
    assert.equal(janumetPartialGeneric.requiresDocumentedOverride, true);

    // Verified single-ingredient Sitagliptin (Januvia) with no Metformin clears cleanly
    const sitagliptinVerifiedSingle = assessMedicationAllergyRisk(
      metforminAllergyPatient,
      { brandName: 'Januvia', genericName: 'Sitagliptin', strength: '100 mg' },
      'en'
    );
    assert.equal(sitagliptinVerifiedSingle.level, 'no_known_conflict_verified');

    // Incomplete generic declaration for known combo (Janumet declared as Sitagliptin only)
    // OR partial unrecognized combination NEVER returns "no_known_conflict_verified"
    const penicillinPatient = makePatient({ id: 'pat-pen-only' });
    const janumetIncompleteGeneric = assessMedicationAllergyRisk(
      penicillinPatient,
      { brandName: 'Janumet', genericName: 'Sitagliptin', strength: '50/500 mg' },
      'en'
    );
    assert.equal(janumetIncompleteGeneric.level, 'insufficient_ingredient_data');
    assert.equal(janumetIncompleteGeneric.requiresPharmacistAcknowledgment, true);

    const partialUnrecognized = assessMedicationAllergyRisk(
      metforminAllergyPatient,
      { brandName: 'ComboX Plus', genericName: 'Sitagliptin / UnverifiedAgent', strength: '50/500 mg' },
      'en'
    );
    assert.equal(partialUnrecognized.level, 'insufficient_ingredient_data');
    assert.equal(partialUnrecognized.requiresPharmacistAcknowledgment, true);

    // 7E. Documented critical allergy override: checkbox-only rejected, structured authorization accepted & audited
    const checkboxOnlyAuth: AllergyOverrideAuthorization = { acknowledged: true };
    const checkboxReject = validateAllergyOverrideAuthorization(
      janumetBrandOnly,
      checkboxOnlyAuth,
      'en'
    );
    assert.equal(checkboxReject.valid, false);
    assert.equal(checkboxReject.errors.length >= 2, true);

    const completeAuth: AllergyOverrideAuthorization = {
      acknowledged: true,
      prescriberName: 'Dr. Tariq Al-Nuaimi',
      authorizationSource: 'prescriber_written_order',
      authorizationReference: 'RX-2026-901',
      clinicalJustification: 'Endocrinologist documented continuation with renal monitoring.',
    };
    const completePass = validateAllergyOverrideAuthorization(janumetBrandOnly, completeAuth, 'en');
    assert.equal(completePass.valid, true);
    const builtEvidence = buildAllergyOverrideEvidencePayload(
      janumetBrandOnly,
      completeAuth,
      'د. صيدلي'
    );
    assert.equal(builtEvidence.prescriberName, 'Dr. Tariq Al-Nuaimi');
    assert.equal(builtEvidence.authorizationSource, 'prescriber_written_order');

    // InMemoryCrmAdapter blocks checkbox-only critical override on plan add & dispense, accepts complete override & writes audit log
    const metPatCreated = adapter.addPatient({
      patientCode: 'PAT-JAN-01',
      fullName: 'مريض جانوميت',
      phone: '07709998877',
      phoneOwnerType: 'self',
      dateOfBirth: '1978-03-14',
      sex: 'male',
      chronicConditions: ['Type 2 Diabetes'],
      allergies: [
        {
          id: 'alg-met-1',
          substance: 'Metformin',
          severity: 'severe',
          reaction: 'Severe hypersensitivity',
        },
      ],
      contactPreference: 'whatsapp',
      clinicalNotes: '',
      registrationDate: '2026-11-01',
    });
    assert.throws(
      () =>
        adapter.addMedicationPlan(
          makeValidPlanInput(metPatCreated.patient.id, {
            catalogId: 'cat-janumet',
            brandName: 'Janumet',
            genericName: 'Sitagliptin',
            strength: '50/500 mg',
          }),
          checkboxOnlyAuth
        ),
      /authorizing prescriber|clinical justification/i
    );
    const janPlanAdded = adapter.addMedicationPlan(
      makeValidPlanInput(metPatCreated.patient.id, {
        catalogId: 'cat-janumet',
        brandName: 'Janumet',
        genericName: 'Sitagliptin',
        strength: '50/500 mg',
      }),
      completeAuth
    );
    assert.throws(
      () =>
        adapter.recordDispensing(
          {
            patientId: metPatCreated.patient.id,
            medicationPlanId: janPlanAdded.plan.id,
            dispensedQuantity: 30,
            quantityUnit: 'tablet',
            dispensingDate: '2026-11-15',
            isPartialFill: false,
            expectedRegimenVersionNumber: janPlanAdded.plan.currentVersionNumber,
            allergyOverrideAuthorization: checkboxOnlyAuth,
          },
          'en'
        ),
      /authorizing prescriber|clinical justification/i
    );
    const janDispensed = adapter.recordDispensing(
      {
        patientId: metPatCreated.patient.id,
        medicationPlanId: janPlanAdded.plan.id,
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        dispensingDate: '2026-11-15',
        isPartialFill: false,
        expectedRegimenVersionNumber: janPlanAdded.plan.currentVersionNumber,
        clientEventUuid: '11112222-3333-4444-8555-666677778888',
        allergyOverrideAuthorization: completeAuth,
      },
      'en'
    );
    assert.match(janDispensed.event?.allergyOverrideSummary ?? '', /Dr\. Tariq Al-Nuaimi/);
    assert.equal(
      janDispensed.state.auditLogs.some(
        (l) => l.entityId === janDispensed.event?.id && l.summaryEn.includes('Dr. Tariq Al-Nuaimi')
      ),
      true
    );

    // 7F. Static checks on separated Stage 2C.2C SQL artifacts & SupabaseCrmRepository SELECT projection
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_migration_DRAFT.sql'),
      'utf8'
    );
    assert.match(migrationSql, /^BEGIN;/m);
    assert.match(migrationSql, /\nCOMMIT;\s*$/m);
    assert.doesNotMatch(migrationSql, /\bROLLBACK\s*;/i);
    assert.doesNotMatch(migrationSql, /2c2c0000|TST-2C2C/i);
    assert.doesNotMatch(migrationSql, /Key additions inside|Body retains 0004 inserts/i);
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_clinical_safety_capabilities\(\)/);
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.create_medication_plan_with_version_v2\(/);
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.update_medication_plan_version_v2\(/);
    assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.record_dispensing_with_refill_v2\(/);
    assert.match(migrationSql, /assess_critical_allergy_conflict/);
    assert.match(migrationSql, /validate_allergy_override_evidence/);
    assert.match(migrationSql, /verified_inn_registry/);
    assert.match(migrationSql, /verified_combination_registry/);
    assert.match(migrationSql, /enforcesServerAllergyUncertainty/);
    assert.match(migrationSql, /pg_advisory_xact_lock/);
    assert.match(migrationSql, /extensions\.digest/);
    assert.match(migrationSql, /USING ERRCODE = '40001'/);
    // Verify Arabic unit tokens & variable schedule mode parity
    for (const token of ['variable', 'مجم', 'مكغ', 'غ', 'عبوة سائل', 'عبوة', 'دهنة']) {
      assert.equal(migrationSql.includes(`'${token}'`), true, `Migration SQL missing token ${token}`);
    }

    const rollbackTestSql = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/tests/stage2c2c_rollback_verification_DRAFT.sql'),
      'utf8'
    );
    const executableRollbackSql = rollbackTestSql.replace(/--.*$/gm, '');
    assert.match(executableRollbackSql, /^BEGIN;/m);
    assert.match(executableRollbackSql, /\nROLLBACK;\s*$/m);
    assert.doesNotMatch(executableRollbackSql, /\bCOMMIT\s*;/i);
    assert.doesNotMatch(
      executableRollbackSql,
      /\b(CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|ALTER\s+TABLE|CREATE\s+INDEX|DROP\s+FUNCTION)\b/i
    );
    assert.doesNotMatch(rollbackTestSql, /whatsapp_manual|medication_change|'refill_due'|'reached'|'prn_intake'/);
    assert.doesNotMatch(rollbackTestSql, /WHEN SQLSTATE '23514' THEN NULL;/i);
    assert.match(rollbackTestSql, /GET STACKED DIAGNOSTICS/);
    assert.match(rollbackTestSql, /created_by_staff_id/);
    assert.match(rollbackTestSql, /stage2c2d_disposable_concurrency_plan\.md/);

    const preflightPostcheckSql = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/tests/stage2c2c_read_only_preflight_postcheck.sql'),
      'utf8'
    );
    const executablePreflightSql = preflightPostcheckSql.replace(/--.*$/gm, '');
    assert.doesNotMatch(
      executablePreflightSql,
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/i
    );
    assert.doesNotMatch(executablePreflightSql, /\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    assert.match(preflightPostcheckSql, /DEV-TEST-001/);
    assert.match(preflightPostcheckSql, /2c2c%/);
    assert.match(preflightPostcheckSql, /get_clinical_safety_capabilities/);

    const supabaseRepoSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/supabaseCrmRepository.ts'),
      'utf8'
    );
    assert.match(
      supabaseRepoSrc,
      /dispensing_events'\)\s*\.select\(\s*'[^']*calculation_inputs[^']*'/
    );

    // 7G. Dual-backend capability probe & RPC routing tests (0004 legacy vs Stage 2C.2B _v2)
    const legacyCallLog: Array<{ fnName: string; args: Record<string, unknown> }> = [];
    const legacyRepo = new SupabaseCrmRepository(
      makeStatefulMockClient({ backendMode: 'migration_0004_legacy', rpcCallLog: legacyCallLog }),
      pharmacistCtx
    );
    const legacyCaps = await legacyRepo.getBackendCapabilitiesAsync();
    assert.equal(legacyCaps.stage, 'migration_0004_legacy');
    assert.equal(legacyCaps.supportsV2MedicationPlans, false);
    assert.equal(legacyCaps.supportsV2DispensingIdempotency, false);
    assert.equal(legacyCaps.enforcesServerCriticalAllergyOverride, false);

    await legacyRepo.addMedicationPlanAsync(makeValidPlanInput('pat-1'));
    const legacyCreateCall = legacyCallLog.find((c) => c.fnName === 'create_medication_plan_with_version');
    assert.ok(legacyCreateCall, 'Legacy mode must route to 0004 create_medication_plan_with_version');
    assert.equal(Object.keys(legacyCreateCall.args).length, 18);
    assert.equal('p_allergy_override_evidence' in legacyCreateCall.args, false);

    await legacyRepo.updateMedicationPlanAsync(
      'plan-1',
      makeValidPlanInput('pat-1', { strength: '850 mg' }),
      'Legacy dose adjustment',
      '2026-11-16',
      2
    );
    const legacyUpdateCall = legacyCallLog.find((c) => c.fnName === 'update_medication_plan_version');
    assert.ok(legacyUpdateCall, 'Legacy mode must route to 0004 update_medication_plan_version');
    assert.equal(Object.keys(legacyUpdateCall.args).length, 19);
    assert.equal('p_expected_version_number' in legacyUpdateCall.args, false);

    await legacyRepo.recordDispensingAsync(
      {
        ...dispenseBase,
        dispensedQuantity: 60,
        packageCount: 2,
        clientEventUuid: '77777777-7777-4777-8777-777777777777',
      },
      'en'
    );
    const legacyDispenseCall = legacyCallLog.find((c) => c.fnName === 'record_dispensing_with_refill');
    assert.ok(legacyDispenseCall, 'Legacy mode must route to 0004 record_dispensing_with_refill');
    assert.equal(Object.keys(legacyDispenseCall.args).length, 24);
    assert.equal('p_client_event_uuid' in legacyDispenseCall.args, false);

    const v2CallLog: Array<{ fnName: string; args: Record<string, unknown> }> = [];
    const v2Repo = new SupabaseCrmRepository(
      makeStatefulMockClient({ backendMode: 'stage2c2b_v2', rpcCallLog: v2CallLog }),
      pharmacistCtx
    );
    const v2Caps = await v2Repo.getBackendCapabilitiesAsync();
    assert.equal(v2Caps.stage, 'stage2c2b_v2');
    assert.equal(v2Caps.supportsV2MedicationPlans, true);
    assert.equal(v2Caps.supportsV2DispensingIdempotency, true);
    assert.equal(v2Caps.enforcesServerCriticalAllergyOverride, true);

    await v2Repo.addMedicationPlanAsync(makeValidPlanInput('pat-1'));
    const v2CreateCall = v2CallLog.find((c) => c.fnName === 'create_medication_plan_with_version_v2');
    assert.ok(v2CreateCall, 'Stage 2C.2B mode must route to create_medication_plan_with_version_v2');
    assert.equal(Object.keys(v2CreateCall.args).length, 19);
    assert.equal('p_allergy_override_evidence' in v2CreateCall.args, true);

    await v2Repo.updateMedicationPlanAsync(
      'plan-1',
      makeValidPlanInput('pat-1', { strength: '850 mg' }),
      'V2 dose adjustment',
      '2026-11-16',
      2
    );
    const v2UpdateCall = v2CallLog.find((c) => c.fnName === 'update_medication_plan_version_v2');
    assert.ok(v2UpdateCall, 'Stage 2C.2B mode must route to update_medication_plan_version_v2');
    assert.equal(Object.keys(v2UpdateCall.args).length, 21);
    assert.equal(v2UpdateCall.args.p_expected_version_number, 2);

    await v2Repo.recordDispensingAsync(
      {
        ...dispenseBase,
        dispensedQuantity: 90,
        packageCount: 3,
        expectedRegimenVersionNumber: 2,
        clientEventUuid: '88888888-8888-4888-8888-888888888888',
      },
      'en'
    );
    const v2DispenseCall = v2CallLog.find((c) => c.fnName === 'record_dispensing_with_refill_v2');
    assert.ok(v2DispenseCall, 'Stage 2C.2B mode must route to record_dispensing_with_refill_v2');
    assert.equal(Object.keys(v2DispenseCall.args).length, 28);
    assert.equal(v2DispenseCall.args.p_expected_regimen_version_number, 2);
    assert.equal(
      v2DispenseCall.args.p_client_event_uuid,
      '88888888-8888-4888-8888-888888888888'
    );

    // Non-missing 42501 auth denial from get_clinical_safety_capabilities must NEVER silently fall back
    const authDeniedRepo = new SupabaseCrmRepository(
      makeStatefulMockClient({ backendMode: 'auth_denied' }),
      pharmacistCtx
    );
    await assert.rejects(
      () => authDeniedRepo.getBackendCapabilitiesAsync(),
      /Active pharmacist session required|42501|permission/i
    );

    // ------------------------------------------------------------------------
    // 8. Stage 2C.2C Hardening Verification Suite
    // ------------------------------------------------------------------------
    // 8A. Capability detection security: 42883 missing RPC, malformed responses,
    //     non-boolean flag coercion refusal, TTL expiry & mid-session upgrade refresh
    {
      let currentStage: 'missing_42883' | 'malformed_array' | 'malformed_missing_flag' | 'malformed_bad_stage' | 'stage2c2c_v2' =
        'missing_42883';
      let fakeNow = 1_700_000_000_000;
      let probeCalls = 0;

      const probeQueryChain: Record<string, any> = {
        select: () => probeQueryChain,
        eq: () => probeQueryChain,
        order: () => probeQueryChain,
        single: async () => ({
          data: {
            id: 'pharm-1',
            name_ar: 'صيدلية مسار',
            name_en: 'MASAR Pharmacy',
            city: 'Baghdad',
            governorate: 'Baghdad',
            license_number: 'LIC-1',
            phone: '07700000000',
            timezone: 'Asia/Baghdad',
            is_active: true,
          },
          error: null,
        }),
        maybeSingle: async () => ({
          data: {
            id: 'pharm-1',
            name_ar: 'صيدلية مسار',
            name_en: 'MASAR Pharmacy',
            city: 'Baghdad',
            governorate: 'Baghdad',
            license_number: 'LIC-1',
            phone: '07700000000',
            timezone: 'Asia/Baghdad',
            is_active: true,
          },
          error: null,
        }),
        range: async (fromIdx: number) => ({
          data:
            fromIdx > 0
              ? []
              : [
                  {
                    id: 'user-1',
                    pharmacy_id: 'pharm-1',
                    full_name: 'د. صيدلي',
                    role: 'pharmacy_owner',
                    phone: '07700000001',
                    syndicate_license: 'PH-1',
                    is_active: true,
                  },
                ],
          error: null,
        }),
      };

      const makeProbeClient = () =>
        ({
          from: () => probeQueryChain,
          rpc: async (fnName: string) => {
            if (fnName !== 'get_clinical_safety_capabilities') {
              return { data: { ok: true }, error: null };
            }
            probeCalls += 1;
            if (currentStage === 'missing_42883') {
              return {
                data: null,
                error: {
                  code: '42883',
                  message: 'function public.get_clinical_safety_capabilities() does not exist',
                },
              };
            }
            if (currentStage === 'malformed_array') {
              return { data: ['unexpected'], error: null };
            }
            if (currentStage === 'malformed_missing_flag') {
              return {
                data: {
                  ok: true,
                  stage: 'stage2c2c_v2',
                  supportsV2MedicationPlans: true,
                  // supportsV2DispensingIdempotency omitted — must NEVER default to true!
                  enforcesServerCriticalAllergyOverride: 'true',
                },
                error: null,
              };
            }
            if (currentStage === 'malformed_bad_stage') {
              return {
                data: {
                  ok: true,
                  stage: 'unknown_future_stage',
                  supportsV2MedicationPlans: true,
                  supportsV2DispensingIdempotency: true,
                  enforcesServerCriticalAllergyOverride: true,
                },
                error: null,
              };
            }
            return {
              data: {
                ok: true,
                stage: 'stage2c2c_v2',
                supportsV2MedicationPlans: true,
                supportsV2DispensingIdempotency: true,
                enforcesServerCriticalAllergyOverride: true,
                enforcesServerAllergyUncertainty: true,
                legacy0004RpcsRetired: false,
              },
              error: null,
            };
          },
        }) as unknown as SupabaseClient;

      const probeRepo = new SupabaseCrmRepository(makeProbeClient(), pharmacistCtx, {
        nonVerifiedCapabilityTtlMs: 30_000,
        verifiedCapabilityTtlMs: 300_000,
        nowProvider: () => fakeNow,
      });

      const capsMissing = await probeRepo.getBackendCapabilitiesAsync();
      assert.equal(capsMissing.probeStatus, 'legacy_missing_rpc');
      assert.equal(capsMissing.stage, 'migration_0004_legacy');
      assert.equal(capsMissing.supportsV2MedicationPlans, false);
      assert.equal(capsMissing.enforcesServerCriticalAllergyOverride, false);

      // Cached within TTL (< 30s)
      const callsBefore = probeCalls;
      await probeRepo.getBackendCapabilitiesAsync();
      assert.equal(probeCalls, callsBefore);

      // Malformed array response -> conservative fallback (`malformed_response`), all booleans false
      currentStage = 'malformed_array';
      const capsArr = await probeRepo.refreshBackendCapabilitiesAsync();
      assert.equal(capsArr.probeStatus, 'malformed_response');
      assert.equal(capsArr.supportsV2MedicationPlans, false);
      assert.equal(capsArr.supportsV2DispensingIdempotency, false);
      assert.equal(capsArr.enforcesServerCriticalAllergyOverride, false);

      // Missing/non-boolean feature flag never defaults to true
      currentStage = 'malformed_missing_flag';
      const capsPartial = await probeRepo.refreshBackendCapabilitiesAsync();
      assert.equal(capsPartial.probeStatus, 'malformed_response');
      assert.equal(capsPartial.supportsV2MedicationPlans, false);
      assert.equal(capsPartial.supportsV2DispensingIdempotency, false);
      assert.equal(capsPartial.enforcesServerCriticalAllergyOverride, false);

      // Unknown stage rejected conservatively
      currentStage = 'malformed_bad_stage';
      const capsBadStage = await probeRepo.refreshBackendCapabilitiesAsync();
      assert.equal(capsBadStage.probeStatus, 'malformed_response');
      assert.equal(capsBadStage.supportsV2MedicationPlans, false);

      // Database upgraded mid-session -> short non-verified TTL expires after 31s
      currentStage = 'stage2c2c_v2';
      fakeNow += 31_000;
      const capsUpgraded = await probeRepo.getBackendCapabilitiesAsync();
      assert.equal(capsUpgraded.probeStatus, 'verified_v2');
      assert.equal(capsUpgraded.stage, 'stage2c2c_v2');
      assert.equal(capsUpgraded.supportsV2MedicationPlans, true);
      assert.equal(capsUpgraded.supportsV2DispensingIdempotency, true);
      assert.equal(capsUpgraded.enforcesServerCriticalAllergyOverride, true);
      assert.equal(capsUpgraded.enforcesServerAllergyUncertainty, true);
      assert.equal(capsUpgraded.legacy0004RpcsRetired, false);

      // ConnectedSessionController manual refreshCapabilities() pushes updated capabilities to UI callback
      let observedCaps: BackendSafetyCapabilities | null = null;
      let ctrlRepo: SupabaseCrmRepository | null = probeRepo;
      const controller = new ConnectedSessionController({
        client: makeProbeClient(),
        createRepository: () => probeRepo,
        callbacks: {
          getLang: () => 'en',
          setRepo: (r) => {
            ctrlRepo = r as SupabaseCrmRepository | null;
          },
          getRepo: () => ctrlRepo,
          setState: () => undefined,
          setAuthStatus: () => undefined,
          setAuthError: () => undefined,
          setHasUnauthorizedSession: () => undefined,
          setAuthenticatedPharmacist: () => undefined,
          setIsLoading: () => undefined,
          setAsyncError: () => undefined,
          setBackendCapabilities: (caps) => {
            observedCaps = caps;
          },
          resetNavigation: () => undefined,
        },
      });
      assert.equal(await controller.refreshCapabilities(), null);
      const authOpGen = controller.getCoordinator().beginOperation();
      assert.equal(
        controller.getCoordinator().markAuthenticated(authOpGen, pharmacistCtx.userId),
        true
      );
      const refreshedViaCtrl = await controller.refreshCapabilities();
      assert.equal(refreshedViaCtrl?.stage, 'stage2c2c_v2');
      assert.equal((observedCaps as BackendSafetyCapabilities | null)?.probeStatus, 'verified_v2');
      assert.equal(createEmptyConnectedCrmState().patients.length, 0);
    }

    // 8B. Dispensing idempotency hardening (all 8 edge cases + canonical fingerprint parity)
    {
      const baseRefillSnapshot = {
        estimatedDailyConsumption: 2,
        estimatedSupplyDays: 15,
        estimatedSupplyEndDate: '2026-12-01',
        totalDispensedAnalyzed: 30,
        estimatedRemainingUnits: 30,
        estimatedDaysRemaining: 15,
        refillStatus: 'on_track',
        refillSupplyEndDate: '2026-12-01',
        forecastAssumptions: 'test',
        uncertaintyNote: 'test',
        calculationSource: 'provisional_client_unverified',
        algorithmVersion: 'masar_refill_v1',
      };
      const baseDispInput = {
        patientId: 'pat-1',
        medicationPlanId: 'plan-1',
        dispensedQuantity: 30,
        quantityUnit: 'tablet',
        packageCount: 1,
        packageSize: 30,
        batchNumber: 'B-2C2C',
        expiryDate: '2027-06-01',
        dispensingDate: '2026-11-16',
        isPartialFill: false,
        notes: 'Full 4-group fingerprint test',
        expectedRegimenVersionNumber: 2,
        allergyOverrideAuthorization: { ...completeAuth, level: 'critical_conflict' as const },
        refillSnapshot: baseRefillSnapshot,
      };

      const canonStr = buildCanonicalDispensingFingerprintString(baseDispInput);
      assert.match(canonStr, /30\.0000\|tablet\|1\|30\.0000\|b-2c2c\|2027-06-01\|2026-11-16\|false\|Full 4-group fingerprint test\|2\|critical_conflict::true::Dr\. Tariq Al-Nuaimi/);

      const hBase = computeDispensingPayloadHash(baseDispInput);
      // 1) Altered allergyOverrideAuthorization changes hash
      assert.notEqual(
        computeDispensingPayloadHash({
          ...baseDispInput,
          allergyOverrideAuthorization: {
            ...completeAuth,
            clinicalJustification: 'Completely altered justification text.',
          },
        }),
        hBase
      );
      // 2) Altered quantity changes hash
      assert.notEqual(
        computeDispensingPayloadHash({ ...baseDispInput, dispensedQuantity: 60, packageCount: 2 }),
        hBase
      );
      // 3) Altered batch/expiry changes hash
      assert.notEqual(
        computeDispensingPayloadHash({ ...baseDispInput, batchNumber: 'B-OTHER' }),
        hBase
      );
      assert.notEqual(
        computeDispensingPayloadHash({ ...baseDispInput, expiryDate: '2028-01-01' }),
        hBase
      );
      // 4) Altered refill snapshot changes hash
      assert.notEqual(
        computeDispensingPayloadHash({
          ...baseDispInput,
          refillSnapshot: { ...baseRefillSnapshot, refillStatus: 'due_soon' },
        }),
        hBase
      );
      // 5) Altered expectedRegimenVersionNumber changes hash
      assert.notEqual(
        computeDispensingPayloadHash({ ...baseDispInput, expectedRegimenVersionNumber: 3 }),
        hBase
      );

      // 6) Retry after simulated page reload excludes committed pending UUID before recomputing refill snapshot
      const storageMap = new Map<string, string>();
      const reloadStorage: StorageLike = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => {
          storageMap.set(k, v);
        },
        removeItem: (k) => {
          storageMap.delete(k);
        },
      };
      const user1Key = buildDispensingIdempotencyScopeKey('pharm-1', 'user-1', baseDispInput);
      const user2Key = buildDispensingIdempotencyScopeKey('pharm-1', 'user-2', baseDispInput);
      assert.notEqual(user1Key, user2Key, 'Scope keys must isolate distinct authenticated users');

      const pendingId = getOrCreatePendingDispensingUuid(
        user1Key,
        () => '12345678-1234-4234-8234-1234567890ab',
        reloadStorage,
        1_700_000_000_000
      );
      const pendingSet = getPendingDispensingUuids(reloadStorage, 1_700_000_010_000);
      assert.equal(pendingSet.has(pendingId), true);

      // Simulate user sign-out WITHOUT wiping pending retry UUIDs -> re-auth restores identical UUID & zero PHI stored
      const afterReauthUuid = getOrCreatePendingDispensingUuid(
        user1Key,
        () => '99999999-9999-4999-8999-999999999999',
        reloadStorage,
        1_700_000_020_000
      );
      assert.equal(afterReauthUuid, pendingId);
      const storedRaw = JSON.stringify(Array.from(storageMap.entries()));
      assert.equal(storedRaw.includes('pat-1'), false);
      assert.equal(storedRaw.includes('user-1'), false);
      assert.equal(storedRaw.includes('B-2C2C'), false);
      assert.equal(storedRaw.includes('Dr. Tariq'), false);

      // 7) Server retry idempotency + tampering detection on 4-group fields via InMemoryCrmAdapter
      const idempAdapter = new InMemoryCrmAdapter();
      const sInit = idempAdapter.getState();
      const p0 = sInit.patients[0];
      const m0 = sInit.medicationPlans.find((m) => m.patientId === p0.id && m.status === 'active')!;
      const retryUuid = '22223333-4444-4555-8666-777788889999';
      const firstCommit = idempAdapter.recordDispensing(
        {
          patientId: p0.id,
          medicationPlanId: m0.id,
          dispensedQuantity: 30,
          quantityUnit: m0.doseUnit,
          packageCount: 1,
          packageSize: 30,
          batchNumber: 'B-OK',
          expiryDate: '2027-06-01',
          dispensingDate: '2026-11-16',
          isPartialFill: false,
          expectedRegimenVersionNumber: m0.currentVersionNumber,
          clientEventUuid: retryUuid,
          refillSnapshot: baseRefillSnapshot,
        },
        'en'
      );
      assert.throws(
        () =>
          idempAdapter.recordDispensing(
            {
              patientId: p0.id,
              medicationPlanId: m0.id,
              dispensedQuantity: 30,
              quantityUnit: m0.doseUnit,
              packageCount: 1,
              packageSize: 30,
              batchNumber: 'B-TAMPERED',
              expiryDate: '2027-06-01',
              dispensingDate: '2026-11-16',
              isPartialFill: false,
              expectedRegimenVersionNumber: m0.currentVersionNumber,
              clientEventUuid: retryUuid,
              refillSnapshot: baseRefillSnapshot,
            },
            'en'
          ),
        /Idempotency conflict/i
      );
      const replayCommit = idempAdapter.recordDispensing(
        {
          patientId: p0.id,
          medicationPlanId: m0.id,
          dispensedQuantity: 30,
          quantityUnit: m0.doseUnit,
          packageCount: 1,
          packageSize: 30,
          batchNumber: 'B-OK',
          expiryDate: '2027-06-01',
          dispensingDate: '2026-11-16',
          isPartialFill: false,
          expectedRegimenVersionNumber: m0.currentVersionNumber,
          clientEventUuid: retryUuid,
          refillSnapshot: baseRefillSnapshot,
        },
        'en'
      );
      assert.equal(replayCommit.event?.id, firstCommit.event?.id);
    }

    // 8C. Clinical allergy uncertainty classification & documented rationale enforcement
    {
      const severePenPatient = makePatient({ id: 'pat-pen-2c2c' });

      // Cross-reactivity (`possible_conflict`) on severe penicillin patient requires >= 10 char justification
      const cephRisk = assessMedicationAllergyRisk(
        severePenPatient,
        { brandName: 'Keflex', genericName: 'Cephalexin', strength: '500 mg' },
        'en'
      );
      assert.equal(cephRisk.level, 'caution_cross_reactivity');
      assert.equal(cephRisk.conflictCategory, 'possible_conflict');
      assert.equal(cephRisk.requiresDocumentedReview, true);
      assert.equal(cephRisk.requiresDocumentedOverride, false);
      assert.equal(
        validateAllergyOverrideAuthorization(cephRisk, { acknowledged: true }, 'en').valid,
        false
      );
      assert.equal(
        validateAllergyOverrideAuthorization(
          cephRisk,
          {
            acknowledged: true,
            clinicalJustification: 'Verified tolerated cephalosporin course in prior records.',
          },
          'en'
        ).valid,
        true
      );

      // Unknown active ingredient coverage on severe-allergy patient (`unknown_ingredient_coverage`)
      const unknownRisk = assessMedicationAllergyRisk(
        severePenPatient,
        { brandName: 'NovelMix', genericName: 'UnregisteredNewEntity', strength: '10 mg' },
        'en'
      );
      assert.equal(unknownRisk.level, 'insufficient_ingredient_data');
      assert.equal(unknownRisk.conflictCategory, 'unknown_ingredient_coverage');
      assert.equal(unknownRisk.requiresDocumentedReview, true);
      assert.equal(
        validateAllergyOverrideAuthorization(unknownRisk, { acknowledged: true }, 'en').valid,
        false
      );

      // Brand vs declared generic contradiction (`Glucophage` + `Atorvastatin` -> `possible_conflict`)
      const mismatchRisk = assessMedicationAllergyRisk(
        severePenPatient,
        { brandName: 'Glucophage', genericName: 'Atorvastatin', strength: '20 mg' },
        'en'
      );
      assert.equal(mismatchRisk.level, 'insufficient_ingredient_data');
      assert.equal(mismatchRisk.conflictCategory, 'possible_conflict');
      assert.equal(mismatchRisk.requiresDocumentedReview, true);

      // Verify SupabaseCrmRepository sends `p_allergy_override_evidence` for uncertain/cross-reactive cases
      const uncertainRpcLog: Array<{ fnName: string; args: Record<string, unknown> }> = [];
      const severeClient = makeStatefulMockClient({ backendMode: 'stage2c2b_v2', rpcCallLog: uncertainRpcLog });
      // Override from() patient_allergies to include severe Penicillin allergy
      const severeRepoClient = {
        ...severeClient,
        from: (table: string) => {
          const orig = severeClient.from(table);
          if (table !== 'patient_allergies') return orig;
          return {
            ...orig,
            select: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    range: async (fromIdx: number) => ({
                      data:
                        fromIdx > 0
                          ? []
                          : [
                              {
                                id: 'alg-pen-1',
                                pharmacy_id: 'pharm-1',
                                patient_id: 'pat-1',
                                substance: 'Penicillin',
                                severity: 'severe',
                                reaction: 'Anaphylaxis',
                                status: 'active',
                              },
                            ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        },
        rpc: async (fnName: string, args: Record<string, unknown> = {}) => {
          uncertainRpcLog.push({ fnName, args });
          if (fnName === 'get_clinical_safety_capabilities') {
            return {
              data: {
                ok: true,
                stage: 'stage2c2c_v2',
                supportsV2MedicationPlans: true,
                supportsV2DispensingIdempotency: true,
                enforcesServerCriticalAllergyOverride: true,
                enforcesServerAllergyUncertainty: true,
                legacy0004RpcsRetired: false,
              },
              error: null,
            };
          }
          if (fnName === 'create_medication_plan_with_version_v2') {
            return { data: { ok: true, planId: 'plan-1' }, error: null };
          }
          return { data: { ok: true }, error: null };
        },
      } as unknown as SupabaseClient;

      const uncertainRepo = new SupabaseCrmRepository(severeRepoClient, pharmacistCtx);
      await assert.rejects(
        () =>
          uncertainRepo.addMedicationPlanAsync(
            makeValidPlanInput('pat-1', { brandName: 'NovelMix', genericName: 'NovelUnknownAgent' }),
            { acknowledged: true }
          ),
        /clinical review justification|10 characters/i
      );

      await uncertainRepo.addMedicationPlanAsync(
        makeValidPlanInput('pat-1', { brandName: 'NovelMix', genericName: 'NovelUnknownAgent' }),
        {
          acknowledged: true,
          clinicalJustification: 'Verified package insert confirms zero penicillin ingredients.',
        }
      );
      const createWithEvidence = uncertainRpcLog.find(
        (c) => c.fnName === 'create_medication_plan_with_version_v2'
      );
      assert.ok(createWithEvidence);
      const sentEvidence = createWithEvidence.args.p_allergy_override_evidence as Record<
        string,
        unknown
      > | null;
      assert.equal(sentEvidence?.conflictCategory, 'unknown_ingredient_coverage');
      assert.equal(sentEvidence?.hasSeverePatientAllergies, true);
    }

    // 8D. Phase 2 Legacy 0004 RPC Retirement SQL Static Verification
    {
      const phase2Sql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_phase2_legacy_rpc_retirement_DRAFT.sql'),
        'utf8'
      );
      const executablePhase2 = phase2Sql.replace(/--.*$/gm, '');
      assert.match(executablePhase2, /^BEGIN;/m);
      assert.match(executablePhase2, /\nCOMMIT;\s*$/m);
      assert.match(phase2Sql, /'legacy0004RpcsRetired',\s*true/);
      assert.match(phase2Sql, /COALESCE\(al\.metadata->>'rpcVersion',\s*''\)\s*<>\s*'v2'/);
      assert.match(phase2Sql, /DROP FUNCTION IF EXISTS public\.create_medication_plan_with_version\(/);
      assert.match(phase2Sql, /DROP FUNCTION IF EXISTS public\.update_medication_plan_version\(/);
      assert.match(phase2Sql, /DROP FUNCTION IF EXISTS public\.record_dispensing_with_refill\(/);
      assert.match(phase2Sql, /REVOKE ALL ON FUNCTION public\.create_medication_plan_with_version/);
      assert.match(phase2Sql, /REVOKE ALL ON FUNCTION public\.update_medication_plan_version/);
      assert.match(phase2Sql, /REVOKE ALL ON FUNCTION public\.record_dispensing_with_refill/);
    }

    // ------------------------------------------------------------------------
    // 9. Stage 2C.2D Targeted Pre-Migration Corrections
    // ------------------------------------------------------------------------
    // 9A. Split INN identity vs shared-class cross-reactivity & nonspecific labels
    {
      const severeSingleInnCases: Array<{
        allergySubstance: string;
        sameDrugBrand: string;
        sameDrugGeneric: string;
        siblingBrand: string;
        siblingGeneric: string;
      }> = [
        {
          allergySubstance: 'Ketoprofen',
          sameDrugBrand: 'Profenid',
          sameDrugGeneric: 'Ketoprofen',
          siblingBrand: 'Toradol',
          siblingGeneric: 'Ketorolac',
        },
        {
          allergySubstance: 'Ketoprofen',
          sameDrugBrand: 'Profenid',
          sameDrugGeneric: 'Ketoprofen',
          siblingBrand: 'Indocid',
          siblingGeneric: 'Indomethacin',
        },
        {
          allergySubstance: 'Enalapril',
          sameDrugBrand: 'Renitec',
          sameDrugGeneric: 'Enalapril',
          siblingBrand: 'Tritace',
          siblingGeneric: 'Ramipril',
        },
        {
          allergySubstance: 'Enalapril',
          sameDrugBrand: 'Renitec',
          sameDrugGeneric: 'Enalapril',
          siblingBrand: 'Zestril',
          siblingGeneric: 'Lisinopril',
        },
        {
          allergySubstance: 'Sulfamethoxazole',
          sameDrugBrand: 'Bactrim',
          sameDrugGeneric: 'Trimethoprim / Sulfamethoxazole',
          siblingBrand: 'Salazopyrin',
          siblingGeneric: 'Sulfasalazine',
        },
        {
          allergySubstance: 'Flucloxacillin',
          sameDrugBrand: 'Floxapen',
          sameDrugGeneric: 'Flucloxacillin',
          siblingBrand: 'Orbenin',
          siblingGeneric: 'Cloxacillin',
        },
        {
          allergySubstance: 'Benzylpenicillin',
          sameDrugBrand: 'Penicillin G',
          sameDrugGeneric: 'Benzylpenicillin',
          siblingBrand: 'Ospen',
          siblingGeneric: 'Phenoxymethylpenicillin',
        },
      ];

      for (const tc of severeSingleInnCases) {
        const pt = makePatient({
          id: `pat-split-${tc.allergySubstance.toLowerCase()}`,
          allergies: [
            {
              id: 'a-1',
              substance: tc.allergySubstance,
              severity: 'severe',
              reaction: 'Severe hypersensitivity',
            },
          ],
        });

        const exactMatch = assessMedicationAllergyRisk(
          pt,
          { brandName: tc.sameDrugBrand, genericName: tc.sameDrugGeneric, strength: '10 mg' },
          'en'
        );
        assert.equal(
          exactMatch.level,
          'critical_conflict',
          `${tc.allergySubstance} + ${tc.sameDrugGeneric} must be exact critical_conflict`
        );
        assert.equal(exactMatch.requiresDocumentedOverride, true);

        const siblingMatch = assessMedicationAllergyRisk(
          pt,
          { brandName: tc.siblingBrand, genericName: tc.siblingGeneric, strength: '10 mg' },
          'en'
        );
        assert.equal(
          siblingMatch.level,
          'caution_cross_reactivity',
          `${tc.allergySubstance} + ${tc.siblingGeneric} must be class caution_cross_reactivity, NOT collapsed exact INN conflict`
        );
        assert.equal(siblingMatch.conflictCategory, 'possible_conflict');
        assert.equal(siblingMatch.requiresDocumentedReview, true);
        assert.equal(siblingMatch.requiresDocumentedOverride, false);
      }

      // Nonspecific class / family labels (`Insulin`, `أنسولين`, `Sulfa`, `سلفا`) NEVER collapse to a single specific INN as exact critical
      const insulinLabelPat = makePatient({
        allergies: [
          { id: 'a-ins', substance: 'أنسولين', severity: 'severe', reaction: 'Urticaria' },
        ],
      });
      const lantusCaution = assessMedicationAllergyRisk(
        insulinLabelPat,
        { brandName: 'Lantus SoloStar', genericName: 'Insulin Glargine', strength: '100 IU/mL' },
        'ar'
      );
      assert.equal(lantusCaution.level, 'caution_cross_reactivity');
      assert.equal(lantusCaution.conflictCategory, 'possible_conflict');

      const specificGlarginePat = makePatient({
        allergies: [
          { id: 'a-glg', substance: 'Insulin Glargine', severity: 'severe', reaction: 'Anaphylaxis' },
        ],
      });
      const glargineCritical = assessMedicationAllergyRisk(
        specificGlarginePat,
        { brandName: 'Lantus SoloStar', genericName: 'Insulin Glargine', strength: '100 IU/mL' },
        'en'
      );
      assert.equal(glargineCritical.level, 'critical_conflict');

      const sulfaArPat = makePatient({
        allergies: [
          { id: 'a-sul', substance: 'سلفا', severity: 'severe', reaction: 'Rash' },
        ],
      });
      const furosemideSulfaCaution = assessMedicationAllergyRisk(
        sulfaArPat,
        { brandName: 'Lasix', genericName: 'Furosemide', strength: '40 mg' },
        'en'
      );
      assert.equal(furosemideSulfaCaution.level, 'caution_cross_reactivity');
      assert.equal(furosemideSulfaCaution.conflictCategory, 'possible_conflict');

      // Specific Penicillin-class broad allergy (`Penicillin`) still flags Amoxicillin/Augmentin/Tazocin as critical_conflict
      // and Cephalexin (different beta-lactam subclass) as caution_cross_reactivity
      const broadPenPat = makePatient({
        allergies: [
          { id: 'a-pen', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        ],
      });
      for (const combo of [
        { brandName: 'Augmentin', genericName: 'Amoxicillin / Clavulanic Acid', strength: '1 g' },
        { brandName: 'Tazocin', genericName: 'Piperacillin / Tazobactam', strength: '4.5 g' },
      ]) {
        const res = assessMedicationAllergyRisk(broadPenPat, combo, 'en');
        assert.equal(res.level, 'critical_conflict', `${combo.brandName} must trigger critical_conflict`);
      }

      // Catalog provenance completeness across all 13 curated catalog entries
      assert.equal(MEDICATION_CATALOG.length, 13);
      for (const item of MEDICATION_CATALOG) {
        assert.equal(item.ingredientVerificationStatus, 'verified', `${item.brandName} must be verified`);
        assert.ok(
          Array.isArray(item.activeIngredients) && item.activeIngredients.length >= 1,
          `${item.brandName} missing activeIngredients`
        );
        assert.ok(item.ingredientSource && item.ingredientSource.length >= 5, `${item.brandName} missing ingredientSource`);
        assert.ok(isValidIsoCalendarDate(item.ingredientReviewedAt), `${item.brandName} invalid ingredientReviewedAt`);
        assert.ok(item.ingredientReviewedBy && item.ingredientReviewedBy.length >= 5, `${item.brandName} missing ingredientReviewedBy`);
      }
    }

    // 9B. Deterministic canonical decimal rounding & SHA-256 fingerprint parity vectors
    {
      for (const decVec of CANONICAL_DECIMAL4_VECTORS) {
        assert.equal(
          formatCanonicalDecimal4(decVec.input),
          decVec.expected,
          `formatCanonicalDecimal4(${String(decVec.input)}) parity mismatch`
        );
      }

      const rollbackSqlForHashes = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_rollback_verification_DRAFT.sql'),
        'utf8'
      );
      for (const vec of DISPENSING_FINGERPRINT_VECTORS) {
        const canon = buildCanonicalDispensingFingerprintString(vec.input);
        assert.equal(
          canon,
          vec.expectedCanonicalString,
          `Canonical string mismatch for vector ${vec.id}`
        );

        const tsHash = computeDispensingPayloadHash(vec.input);
        const nodeSha = createHash('sha256').update(canon, 'utf8').digest('hex');
        assert.equal(tsHash, vec.expectedSha256Hex, `TS hash mismatch for vector ${vec.id}`);
        assert.equal(nodeSha, vec.expectedSha256Hex, `Node SHA-256 mismatch for vector ${vec.id}`);

        assert.equal(
          rollbackSqlForHashes.includes(vec.expectedSha256Hex),
          true,
          `Rollback verification SQL missing vector ${vec.id} hash ${vec.expectedSha256Hex}`
        );
      }
    }

    // 9C. Static SQL verification of Stage 2C.2D migration, preflight, Phase 2 gates, & concurrency plan
    {
      const migSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_migration_DRAFT.sql'),
        'utf8'
      );
      assert.match(migSql, /ingredient_source/);
      assert.match(migSql, /ingredient_reviewed_at/);
      assert.match(migSql, /ingredient_reviewed_by/);
      assert.match(migSql, /chk_medication_catalog_verified_provenance/);
      assert.match(migSql, /ingredient_verification_status <> 'verified'/);
      assert.match(migSql, /CREATE TABLE IF NOT EXISTS app_security\.verified_broad_class_labels/);
      assert.match(migSql, /CREATE TABLE IF NOT EXISTS app_security\.verified_drug_class_relationships/);
      assert.match(migSql, /CREATE OR REPLACE FUNCTION app_security\.format_canonical_decimal4\(p_val numeric\)/);
      assert.match(migSql, /'shadow_audit_only'/);
      assert.match(migSql, /'clientPayloadHashMismatch'/);
      assert.match(migSql, /DELETE FROM app_security\.verified_inn_registry\s+WHERE canonical_inn = 'penicillin';/);
      // Ensure collapsed INN alias tuples no longer exist in verified_inn_registry `aliases` column (2nd ARRAY[...])
      assert.doesNotMatch(migSql, /\('ketoprofen',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'ketorolac'/);
      assert.doesNotMatch(migSql, /\('enalapril',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'ramipril'/);
      assert.doesNotMatch(migSql, /\('sulfamethoxazole',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'sulfadiazine'/);
      assert.doesNotMatch(migSql, /\('flucloxacillin',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'cloxacillin'/);
      assert.doesNotMatch(migSql, /\('insulin glargine',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'insulin'(?:,|])/);
      assert.doesNotMatch(migSql, /\('insulin glargine',\s*ARRAY\[[^\]]*\],\s*ARRAY\[[^\]]*'أنسولين'(?:,|])/);

      const phase2Sql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_phase2_legacy_rpc_retirement_DRAFT.sql'),
        'utf8'
      );
      assert.match(phase2Sql, /interval '7 days'/);
      assert.match(phase2Sql, /v_v2_write_count_7d < 1/);
      assert.match(phase2Sql, /clientPayloadHashMismatch/);
      assert.match(phase2Sql, /masar\.phase2_cutover_approved/);
      assert.match(phase2Sql, /masar\.phase2_rollout_verified/);
      assert.match(phase2Sql, /masar\.phase2_approver/);
      assert.match(phase2Sql, /EXCEPTION WHEN SQLSTATE '42883' THEN/);
      assert.match(phase2Sql, /DOCUMENTED ROLLBACK & EMERGENCY RECOVERY STRATEGY/);

      const preflightSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_read_only_preflight_postcheck.sql'),
        'utf8'
      );
      assert.match(preflightSql, /has_catalog_provenance_check/);
      assert.match(preflightSql, /has_verified_broad_class_labels/);
      assert.match(preflightSql, /has_verified_drug_class_relationships/);
      assert.match(preflightSql, /has_format_canonical_decimal4/);
      assert.match(preflightSql, /legacy_0004_writes_7d/);
      assert.match(preflightSql, /v2_dispense_hash_mismatched_7d/);

      const rollbackSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_rollback_verification_DRAFT.sql'),
        'utf8'
      );
      const afterAuthRoleIdx = rollbackSql.search(/^\s*SET LOCAL ROLE authenticated;/m);
      assert.ok(afterAuthRoleIdx > 0);
      const underAuthBlock = rollbackSql.slice(afterAuthRoleIdx);
      assert.doesNotMatch(
        underAuthBlock,
        /\b(INSERT INTO|UPDATE)\s+public\.patient_medication_plans\b/i,
        'patient_medication_plans privileges are revoked from authenticated in 0003; must use RPCs after SET LOCAL ROLE authenticated'
      );
      assert.match(underAuthBlock, /public\.update_medication_plan_version_v2\(/);

      const concurrencyPlan = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2d_disposable_concurrency_plan.md'),
        'utf8'
      );
      assert.match(concurrencyPlan, /pg_advisory_xact_lock/);
      assert.match(concurrencyPlan, /FOR UPDATE/);
      assert.match(concurrencyPlan, /40001/);
      assert.match(concurrencyPlan, /23514/);
      assert.doesNotMatch(concurrencyPlan, /DELETE FROM public\.audit_logs/i);
      assert.doesNotMatch(concurrencyPlan, /DELETE FROM public\.dispensing_events/i);
      assert.doesNotMatch(concurrencyPlan, /DELETE FROM public\.regimen_versions/i);
      assert.doesNotMatch(concurrencyPlan, /ALTER\s+TABLE\s+[^\n;]*\bDISABLE\s+TRIGGER\b/i);
      assert.match(concurrencyPlan, /DROP DATABASE IF EXISTS/);
      assert.match(concurrencyPlan, /supabase db reset --local/);
      assert.match(concurrencyPlan, /prevent_ledger_mutation\(\)/);
      assert.match(concurrencyPlan, /stage2c2c_read_only_preflight_postcheck\.sql/);
    }

    // -------------------------------------------------------------------------
    // 10. Stage 2C.2D Final Pre-Migration Patch Regression Suite
    // -------------------------------------------------------------------------

    // 10A. Fail-closed verified catalog CHECK constraint & negative SQL constraint tests
    {
      const migSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_migration_DRAFT.sql'),
        'utf8'
      );
      assert.match(migSql, /CREATE OR REPLACE FUNCTION app_security\.text_array_has_non_blank_elements\(p_arr text\[\]\)/);
      assert.match(migSql, /pg_catalog\.cardinality\(active_ingredients\) > 0/);
      assert.match(migSql, /pg_catalog\.array_position\(active_ingredients, NULL\) IS NULL/);
      assert.match(migSql, /app_security\.text_array_has_non_blank_elements\(active_ingredients\) IS TRUE/);
      assert.doesNotMatch(migSql, /array_length\(active_ingredients,\s*1\)\s*>=\s*1/);

      const rollbackSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_rollback_verification_DRAFT.sql'),
        'utf8'
      );
      assert.match(rollbackSql, /TST-2C2C-EmptyArr/);
      assert.match(rollbackSql, /TST-2C2C-NullElem/);
      assert.match(rollbackSql, /TST-2C2C-BlankElem/);
      assert.match(rollbackSql, /TST-2C2C-BlankProv/);
      assert.match(rollbackSql, /CONSTRAINT_NAME/);
      assert.match(rollbackSql, /GlucoSecret/);
      assert.match(rollbackSql, /TST-2C2C-UnverifiedMed/);
      assert.match(rollbackSql, /مسكنات/);
    }

    // 10B. Complete 6-case fail-closed ingredient coverage matrix
    {
      const safetySrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/services/clinicalSafety.ts'),
        'utf8'
      );
      assert.doesNotMatch(safetySrc, /\|\|\s*!brandSuggestsCombination/);

      const penPat = makePatient({
        id: 'pat-cov-pen',
        allergies: [
          { id: 'a-pen', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        ],
      });
      const metPat = makePatient({
        id: 'pat-cov-met',
        allergies: [
          { id: 'a-met', substance: 'Metformin', severity: 'severe', reaction: 'Lactic intolerance' },
        ],
      });

      // Case 1: Verified single-ingredient products -> verified_clear (no_known_conflict_verified)
      for (const med of [
        { brandName: 'Glucophage', genericName: 'Metformin HCl', strength: '500 mg' },
        { brandName: 'Glucophage XR', genericName: 'Metformin HCl', strength: '1000 mg XR' },
        { catalogId: 'cat-losartan', brandName: 'Cozaar', genericName: 'Losartan Potassium', strength: '50 mg' },
      ]) {
        const res = assessMedicationAllergyRisk(penPat, med, 'en');
        assert.equal(res.level, 'no_known_conflict_verified', `${med.brandName} must be verified clear`);
        assert.equal(res.conflictCategory, 'verified_clear');
      }

      // Case 2: Verified combination products -> verified_clear (no_known_conflict_verified)
      for (const combo of [
        { catalogId: 'cat-janumet', brandName: 'Janumet', genericName: 'Sitagliptin / Metformin HCl', strength: '50/500 mg' },
        { catalogId: 'cat-budesonide-formoterol', brandName: 'Symbicort Turbuhaler', genericName: 'Budesonide / Formoterol', strength: '160/4.5 mcg' },
      ]) {
        const res = assessMedicationAllergyRisk(penPat, combo, 'en');
        assert.equal(res.level, 'no_known_conflict_verified', `${combo.brandName} must be verified clear`);
        assert.equal(res.conflictCategory, 'verified_clear');
      }

      // Case 3: Unknown brand + one recognized generic -> MUST NEVER receive verified_clear,
      //         while direct Metformin allergy STILL blocks as critical_conflict
      for (const unknownBrandMed of [
        { brandName: 'GlucoSecret', genericName: 'Metformin', strength: '500 mg' },
        { brandName: 'MysteryMet-500', genericName: 'Metformin HCl', strength: '500 mg' },
        { brandName: 'Glucophage Mystery', genericName: 'Metformin HCl', strength: '500 mg' },
      ]) {
        const penRes = assessMedicationAllergyRisk(penPat, unknownBrandMed, 'en');
        assert.equal(
          penRes.level,
          'insufficient_ingredient_data',
          `${unknownBrandMed.brandName} must fail closed as insufficient_ingredient_data`
        );
        assert.equal(penRes.conflictCategory, 'unknown_ingredient_coverage');
        assert.notEqual(penRes.conflictCategory, 'verified_clear');
        assert.equal(penRes.requiresDocumentedReview, true);

        const metRes = assessMedicationAllergyRisk(metPat, unknownBrandMed, 'en');
        assert.equal(
          metRes.level,
          'critical_conflict',
          `${unknownBrandMed.brandName} must still detect direct Metformin allergy`
        );
        assert.equal(metRes.conflictCategory, 'recognized_critical');
      }

      // Case 4: Partial generic declarations -> insufficient_ingredient_data
      for (const partialMed of [
        { catalogId: 'cat-janumet', brandName: 'Janumet', genericName: 'Sitagliptin', strength: '50/500 mg' },
        { brandName: 'ComboX', genericName: 'Metformin / UnknownAgent', strength: '500 mg' },
      ]) {
        const res = assessMedicationAllergyRisk(penPat, partialMed, 'en');
        assert.equal(res.level, 'insufficient_ingredient_data');
        assert.equal(res.conflictCategory, 'unknown_ingredient_coverage');
      }

      // Case 5: Contradictory brand/generic declarations -> insufficient_ingredient_data (possible_conflict)
      for (const mismatchMed of [
        { brandName: 'Glucophage', genericName: 'Atorvastatin', strength: '20 mg' },
        { catalogId: 'cat-losartan', brandName: 'Cozaar', genericName: 'Atorvastatin', strength: '50 mg' },
      ]) {
        const res = assessMedicationAllergyRisk(penPat, mismatchMed, 'en');
        assert.equal(res.level, 'insufficient_ingredient_data');
        assert.equal(res.conflictCategory, 'possible_conflict');
      }

      // Case 6: Unverified or partial catalog record -> insufficient_ingredient_data,
      //         while direct Metformin allergy STILL blocks as critical_conflict
      for (const status of ['unverified', 'partial'] as const) {
        const unverifiedCat: MedicationCatalogItem = {
          id: `cat-unverified-${status}`,
          brandName: 'Glucophage',
          genericName: 'Metformin HCl',
          availableStrengths: ['500 mg'],
          defaultDosageForm: 'tablet',
          defaultRoute: 'oral',
          category: 'Antidiabetic',
          activeIngredients: status === 'unverified' ? [] : ['Metformin HCl'],
          ingredientVerificationStatus: status,
        };
        const penRes = assessMedicationAllergyRisk(
          penPat,
          {
            catalogId: unverifiedCat.id,
            catalogRecord: unverifiedCat,
            brandName: 'Glucophage',
            genericName: 'Metformin HCl',
            strength: '500 mg',
          },
          'en'
        );
        assert.equal(penRes.level, 'insufficient_ingredient_data');
        assert.equal(penRes.conflictCategory, 'unknown_ingredient_coverage');

        const metRes = assessMedicationAllergyRisk(
          metPat,
          {
            catalogId: unverifiedCat.id,
            catalogRecord: unverifiedCat,
            brandName: 'Glucophage',
            genericName: 'Metformin HCl',
            strength: '500 mg',
          },
          'en'
        );
        assert.equal(metRes.level, 'critical_conflict');
      }

      // Unknown catalogId also fails closed (cannot verify catalog provenance)
      const missingCatalogRes = assessMedicationAllergyRisk(
        penPat,
        { catalogId: 'cat-does-not-exist', brandName: 'Cozaar', genericName: 'Losartan Potassium', strength: '50 mg' },
        'en'
      );
      assert.equal(missingCatalogRes.level, 'insufficient_ingredient_data');
      assert.equal(missingCatalogRes.conflictCategory, 'unknown_ingredient_coverage');
    }

    // 10C. Nonspecific Arabic & English analgesic/steroid allergy regressions (TS + SQL parity)
    {
      const migSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_migration_DRAFT.sql'),
        'utf8'
      );
      assert.doesNotMatch(
        migSql,
        /\('nsaid_confirmed',\s*'nsaid',\s*ARRAY\[[^\]]*'مسكنات'/
      );
      assert.match(
        migSql,
        /\('analgesic_nsaid_nonspecific',\s*'nsaid',\s*ARRAY\[[^\]]*'مسكنات'[^\]]*\],\s*'nonspecific_class_caution'\)/
      );
      assert.match(
        migSql,
        /\('analgesic_acetaminophen_nonspecific',\s*'acetaminophen',\s*ARRAY\[[^\]]*'مسكنات'[^\]]*\],\s*'nonspecific_class_caution'\)/
      );

      for (const label of ['مسكنات', 'مسكن', 'painkillers', 'analgesics']) {
        const pt = makePatient({
          id: `pat-analg-${label}`,
          allergies: [{ id: 'a-alg', substance: label, severity: 'severe', reaction: 'Swelling' }],
        });

        const ibuRes = assessMedicationAllergyRisk(
          pt,
          { brandName: 'Brufen', genericName: 'Ibuprofen', strength: '400 mg' },
          'ar'
        );
        assert.equal(ibuRes.level, 'caution_cross_reactivity', `${label} + Ibuprofen must be caution, not confirmed NSAID critical`);
        assert.equal(ibuRes.conflictCategory, 'possible_conflict');
        assert.equal(ibuRes.requiresDocumentedReview, true);
        assert.equal(ibuRes.requiresDocumentedOverride, false);

        const paraRes = assessMedicationAllergyRisk(
          pt,
          { brandName: 'Panadol', genericName: 'Paracetamol', strength: '500 mg' },
          'ar'
        );
        assert.equal(paraRes.level, 'caution_cross_reactivity', `${label} + Paracetamol must be caution`);
        assert.equal(paraRes.conflictCategory, 'possible_conflict');
        assert.equal(paraRes.requiresDocumentedReview, true);
        assert.equal(paraRes.requiresDocumentedOverride, false);
      }

      const steroidArPat = makePatient({
        id: 'pat-steroid-ar',
        allergies: [{ id: 'a-cort', substance: 'كورتيزون', severity: 'severe', reaction: 'Rash' }],
      });
      const symbicortCaution = assessMedicationAllergyRisk(
        steroidArPat,
        { catalogId: 'cat-budesonide-formoterol', brandName: 'Symbicort Turbuhaler', genericName: 'Budesonide / Formoterol', strength: '160/4.5 mcg' },
        'ar'
      );
      assert.equal(symbicortCaution.level, 'caution_cross_reactivity');
      assert.equal(symbicortCaution.conflictCategory, 'possible_conflict');

      // Confirmed NSAID allergy still blocks Ibuprofen critically and clears Paracetamol
      for (const nsaidLabel of ['NSAIDs', 'مضادات الالتهاب غير الستيرويدية']) {
        const nsaidPat = makePatient({
          id: `pat-nsaid-${nsaidLabel}`,
          allergies: [{ id: 'a-nsaid', substance: nsaidLabel, severity: 'severe', reaction: 'Bronchospasm' }],
        });
        const ibuCrit = assessMedicationAllergyRisk(
          nsaidPat,
          { brandName: 'Brufen', genericName: 'Ibuprofen', strength: '400 mg' },
          'en'
        );
        assert.equal(ibuCrit.level, 'critical_conflict');
        assert.equal(ibuCrit.conflictCategory, 'recognized_critical');

        const paraClear = assessMedicationAllergyRisk(
          nsaidPat,
          { brandName: 'Panadol', genericName: 'Paracetamol', strength: '500 mg' },
          'en'
        );
        assert.equal(paraClear.level, 'no_known_conflict_verified');
      }
    }

    // 10D. Tightened Phase 2 Gate 2 & preflight readiness checks
    {
      const phase2Sql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_phase2_legacy_rpc_retirement_DRAFT.sql'),
        'utf8'
      );
      assert.match(phase2Sql, /app_security\.text_array_has_non_blank_elements\(text\[\]\)/);
      assert.match(phase2Sql, /v_v2_dispense_count_7d < 1/);
      assert.match(phase2Sql, /v_v2_dispense_missing_hash_7d > 0/);
      assert.match(phase2Sql, /v_v2_dispense_matched_hash_7d <> v_v2_dispense_count_7d/);

      const preflightSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_read_only_preflight_postcheck.sql'),
        'utf8'
      );
      assert.match(preflightSql, /v2_dispense_total_7d/);
      assert.match(preflightSql, /v2_dispense_missing_hash_7d/);
      assert.match(preflightSql, /v2_dispense_hash_mismatched_7d/);
      assert.match(preflightSql, /phase2_hash_readiness_ok/);
      assert.match(preflightSql, /leftover_catalog/);
    }

    // -------------------------------------------------------------------------
    // 11. Stage 2C.2E Targeted Clinical Safety Corrections Regression Suite
    // -------------------------------------------------------------------------

    // 11A. Verified catalog ingredient completeness (Metformin + unrecognized fictional ingredient)
    {
      const penPat = makePatient({
        id: 'pat-2c2e-pen',
        allergies: [
          { id: 'a-pen', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        ],
      });
      const metPat = makePatient({
        id: 'pat-2c2e-met',
        allergies: [
          { id: 'a-met', substance: 'Metformin', severity: 'severe', reaction: 'Hypersensitivity' },
        ],
      });
      const sitaPat = makePatient({
        id: 'pat-2c2e-sita',
        allergies: [
          { id: 'a-sita', substance: 'Sitagliptin', severity: 'severe', reaction: 'Angioedema' },
        ],
      });

      const mixedCatalogRecord: MedicationCatalogItem = {
        id: 'cat-custom-mixed-unknown',
        brandName: 'CustomGlucoMix',
        genericName: 'Metformin HCl',
        activeIngredients: ['Metformin HCl', 'FictionalUnknownExtra'],
        availableStrengths: ['500 mg'],
        defaultDosageForm: 'tablet',
        defaultRoute: 'oral',
        category: 'Antidiabetic',
        ingredientVerificationStatus: 'verified',
        ingredientSource: 'Review Fixture',
        ingredientReviewedAt: '2026-11-16',
        ingredientReviewedBy: 'Reviewer',
      };

      // Even though status='verified', unrecognized extra ingredient fails `isCatalogRecordVerified()`
      assert.equal(isCatalogRecordVerified(mixedCatalogRecord), false);

      // Single-element stuffed combo string like 'Metformin HCl / UnknownExtra' also fails strict catalog verification
      assert.equal(
        isCatalogRecordVerified({
          ...mixedCatalogRecord,
          activeIngredients: ['Metformin HCl / UnknownExtra'],
        }),
        false
      );

      // All 13 curated catalog items must pass strict INN verification
      for (const item of MEDICATION_CATALOG) {
        assert.equal(isCatalogRecordVerified(item), true, `${item.brandName} must pass strict INN catalog verification`);
      }

      // Unknown extra ingredient in catalog row MUST NOT return `no_known_conflict_verified`
      const mixedPenRes = assessMedicationAllergyRisk(
        penPat,
        {
          catalogId: mixedCatalogRecord.id,
          catalogRecord: mixedCatalogRecord,
          brandName: 'CustomGlucoMix',
          genericName: 'Metformin HCl',
          strength: '500 mg',
        },
        'en'
      );
      assert.equal(mixedPenRes.level, 'insufficient_ingredient_data');
      assert.equal(mixedPenRes.conflictCategory, 'unknown_ingredient_coverage');
      assert.notEqual(mixedPenRes.level, 'no_known_conflict_verified');

      // Direct Metformin allergy on the same mixed catalog row STILL triggers critical_conflict
      const mixedMetRes = assessMedicationAllergyRisk(
        metPat,
        {
          catalogId: mixedCatalogRecord.id,
          catalogRecord: mixedCatalogRecord,
          brandName: 'CustomGlucoMix',
          genericName: 'Metformin HCl',
          strength: '500 mg',
        },
        'en'
      );
      assert.equal(mixedMetRes.level, 'critical_conflict');
      assert.equal(mixedMetRes.conflictCategory, 'recognized_critical');

      // Partial declaration against a multi-ingredient + unknown catalog row fails closed & keeps screening
      const partialCatalogRecord: MedicationCatalogItem = {
        ...mixedCatalogRecord,
        id: 'cat-custom-partial-unknown',
        brandName: 'CustomSitMetMix',
        genericName: 'Sitagliptin / Metformin HCl',
        activeIngredients: ['Sitagliptin', 'Metformin HCl', 'FictionalUnknownExtra'],
      };
      const partialPenRes = assessMedicationAllergyRisk(
        penPat,
        {
          catalogId: partialCatalogRecord.id,
          catalogRecord: partialCatalogRecord,
          brandName: 'CustomSitMetMix',
          genericName: 'Sitagliptin',
          strength: '50/500 mg',
        },
        'en'
      );
      assert.equal(partialPenRes.level, 'insufficient_ingredient_data');
      assert.equal(partialPenRes.conflictCategory, 'unknown_ingredient_coverage');

      const partialHiddenMetRes = assessMedicationAllergyRisk(
        metPat,
        {
          catalogId: partialCatalogRecord.id,
          catalogRecord: partialCatalogRecord,
          brandName: 'CustomSitMetMix',
          genericName: 'Sitagliptin',
          strength: '50/500 mg',
        },
        'en'
      );
      assert.equal(partialHiddenMetRes.level, 'critical_conflict');

      // Contradictory declared generic against mixed catalog row triggers possible_conflict
      const contradictoryRes = assessMedicationAllergyRisk(
        penPat,
        {
          catalogId: mixedCatalogRecord.id,
          catalogRecord: mixedCatalogRecord,
          brandName: 'CustomGlucoMix',
          genericName: 'Atorvastatin',
          strength: '500 mg',
        },
        'en'
      );
      assert.equal(contradictoryRes.level, 'insufficient_ingredient_data');
      assert.equal(contradictoryRes.conflictCategory, 'possible_conflict');

      // Mismatched catalogId paired with another verified brand (e.g., cat-janumet + Glucophage) fails closed
      // while preserving Sitagliptin screening from the linked Janumet catalog record
      const mismatchCatPenRes = assessMedicationAllergyRisk(
        penPat,
        {
          catalogId: 'cat-janumet',
          brandName: 'Glucophage',
          genericName: 'Metformin HCl',
          strength: '500 mg',
        },
        'en'
      );
      assert.equal(mismatchCatPenRes.level, 'insufficient_ingredient_data');
      assert.equal(mismatchCatPenRes.conflictCategory, 'unknown_ingredient_coverage');

      const mismatchCatSitaRes = assessMedicationAllergyRisk(
        sitaPat,
        {
          catalogId: 'cat-janumet',
          brandName: 'Glucophage',
          genericName: 'Metformin HCl',
          strength: '500 mg',
        },
        'en'
      );
      assert.equal(mismatchCatSitaRes.level, 'critical_conflict');
    }

    // 11B. Verified combination brand matching: exact vs harmless suffixes vs unrecognized extensions
    {
      const penPat = makePatient({
        id: 'pat-2c2e-combo-pen',
        allergies: [
          { id: 'a-pen', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        ],
      });
      const metPat = makePatient({
        id: 'pat-2c2e-combo-met',
        allergies: [
          { id: 'a-met', substance: 'Metformin', severity: 'severe', reaction: 'Severe reaction' },
        ],
      });
      const losartanPat = makePatient({
        id: 'pat-2c2e-combo-los',
        allergies: [
          { id: 'a-los', substance: 'Losartan', severity: 'severe', reaction: 'Angioedema' },
        ],
      });

      // Unrecognized extended combination brand names MUST NOT acquire full formulation verification
      for (const extendedBrand of [
        'Janumet Mystery',
        'Janumet Plus',
        'Janumet Forte',
        'Janumet Extra',
        'Symbicort Mystery',
        'Glucovance Plus',
      ]) {
        const res = assessMedicationAllergyRisk(
          penPat,
          {
            brandName: extendedBrand,
            genericName:
              extendedBrand.startsWith('Symbicort')
                ? 'Budesonide / Formoterol'
                : extendedBrand.startsWith('Glucovance')
                  ? 'Glyburide / Metformin HCl'
                  : 'Sitagliptin / Metformin HCl',
            strength: '50/500 mg',
          },
          'en'
        );
        assert.equal(
          res.level,
          'insufficient_ingredient_data',
          `${extendedBrand} must fail closed as insufficient_ingredient_data, never verified clear`
        );
        assert.equal(res.conflictCategory, 'unknown_ingredient_coverage');
      }

      // Direct hidden allergy screening STILL triggers critical_conflict on `Janumet Mystery` even with partial generic
      const mysteryHiddenMet = assessMedicationAllergyRisk(
        metPat,
        {
          brandName: 'Janumet Mystery',
          genericName: 'Sitagliptin',
          strength: '50/500 mg',
        },
        'en'
      );
      assert.equal(mysteryHiddenMet.level, 'critical_conflict');
      assert.equal(mysteryHiddenMet.conflictCategory, 'recognized_critical');

      // Positive legitimate verified combination products (exact matches & explicitly approved harmless suffixes)
      for (const legitimateCombo of [
        { brandName: 'Janumet', genericName: 'Sitagliptin / Metformin HCl', strength: '50/500 mg' },
        { brandName: 'Janumet XR', genericName: 'Sitagliptin / Metformin HCl', strength: '50/1000 mg' },
        { brandName: 'Janumet 50/500 mg', genericName: 'Sitagliptin / Metformin HCl', strength: '50/500 mg' },
        { brandName: 'Janumet 50/1000 mg Tablets', genericName: 'Sitagliptin / Metformin HCl', strength: '50/1000 mg' },
        { brandName: 'Symbicort Turbuhaler', genericName: 'Budesonide / Formoterol', strength: '160/4.5 mcg' },
        { brandName: 'Symbicort 160/4.5 mcg', genericName: 'Budesonide / Formoterol', strength: '160/4.5 mcg' },
        { brandName: 'Augmentin', genericName: 'Amoxicillin / Clavulanic Acid', strength: '1 g' },
        { brandName: 'Augmentin 1 g', genericName: 'Amoxicillin / Clavulanic Acid', strength: '1 g' },
        { brandName: 'Augmentin 625 mg Tablets', genericName: 'Amoxicillin / Clavulanic Acid', strength: '625 mg' },
        { brandName: 'Tazocin 4.5 g', genericName: 'Piperacillin / Tazobactam', strength: '4.5 g' },
        { brandName: 'Bactrim', genericName: 'Trimethoprim / Sulfamethoxazole', strength: '800/160 mg' },
        { brandName: 'Glucovance 5/500 mg', genericName: 'Glyburide / Metformin HCl', strength: '5/500 mg' },
      ]) {
        const res = assessMedicationAllergyRisk(losartanPat, legitimateCombo, 'en');
        assert.equal(
          res.level,
          'no_known_conflict_verified',
          `Legitimate combination ${legitimateCombo.brandName} must clear cleanly`
        );
        assert.equal(res.conflictCategory, 'verified_clear');
      }
    }

    // 11C. Static SQL verification of Stage 2C.2E parity, constraint NULL safety, and role-permission model
    {
      const migSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/drafts/stage2c2c_migration_DRAFT.sql'),
        'utf8'
      );
      // Constraint helper NULL, whitespace, 1D-array, and least-privilege checks
      assert.match(migSql, /pg_catalog\.array_ndims\(p_arr\) = 1/);
      assert.match(migSql, /pg_catalog\.regexp_replace\(elem,\s*'\\s\+',\s*'',\s*'g'\)/);
      assert.match(migSql, /COALESCE\(ingredient_verification_status,\s*''\) <> 'verified'/);
      assert.match(migSql, /pg_catalog\.array_ndims\(active_ingredients\) = 1/);
      assert.match(
        migSql,
        /REVOKE ALL ON FUNCTION app_security\.text_array_has_non_blank_elements\(text\[\]\) FROM PUBLIC, anon, authenticated;/
      );
      assert.match(
        migSql,
        /GRANT EXECUTE ON FUNCTION app_security\.text_array_has_non_blank_elements\(text\[\]\) TO service_role;/
      );

      // SQL assessment checks for combo exact match, unrecognized catalog ingredients, and catalog mismatch
      assert.match(migSql, /v_combo_exact_verified/);
      assert.match(migSql, /'unrecognized_catalog:' \|\| COALESCE\(NULLIF\(v_part_clean, ''\), 'blank'\)/);
      assert.match(migSql, /'catalog_record_mismatch'/);

      // Verify rollback test & preflight & concurrency plan reflect Stage 2C.2E checks
      const rollbackSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_rollback_verification_DRAFT.sql'),
        'utf8'
      );
      assert.match(rollbackSql, /SET LOCAL ROLE service_role;/);
      assert.match(rollbackSql, /TST-2C2E-TabElem/);
      assert.match(rollbackSql, /TST-2C2E-MultiDim/);
      assert.match(rollbackSql, /TST-2C2E-MixedUnknown/);
      assert.match(rollbackSql, /Janumet Mystery/);
      assert.match(rollbackSql, /has_function_privilege\('authenticated',\s*'app_security\.text_array_has_non_blank_elements\(text\[\]\)',\s*'EXECUTE'\)/);

      const preflightSql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/tests/stage2c2c_read_only_preflight_postcheck.sql'),
        'utf8'
      );
      assert.match(preflightSql, /TST-2C2E-%/);
    }
  }

  console.log('ALL STAGE 2C.2 CLINICAL SAFETY & REFILL PROTECTION TESTS PASSED');
}

runTests().catch((err) => {
  console.error('STAGE 2C.2 TESTS FAILED:', err);
  process.exit(1);
});
