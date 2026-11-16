import type { DispensingRefillSnapshotInput } from '../../services/clinicalSafety';
import type { AllergyOverrideAuthorization } from '../../types/domain';

export interface DecimalParityVector {
  input: number | null;
  expected: string;
}

export const CANONICAL_DECIMAL4_VECTORS: DecimalParityVector[] = [
  { input: null, expected: '<NULL>' },
  { input: 0, expected: '0.0000' },
  { input: -0.00001, expected: '0.0000' },
  { input: -0.5, expected: '-0.5000' },
  { input: 0.5, expected: '0.5000' },
  { input: 2.00005, expected: '2.0001' },
  { input: 10.50005, expected: '10.5001' },
  { input: -2.00005, expected: '-2.0001' },
  { input: 999999999.99995, expected: '1000000000.0000' },
];

export interface DispensingFingerprintVector {
  id: string;
  description: string;
  input: {
    patientId: string;
    medicationPlanId: string;
    dispensedQuantity: number;
    quantityUnit: string;
    packageCount?: number | null;
    packageSize?: number | null;
    batchNumber?: string | null;
    expiryDate?: string | null;
    dispensingDate: string;
    isPartialFill: boolean;
    notes?: string | null;
    expectedRegimenVersionNumber: number;
    allergyOverrideAuthorization?: AllergyOverrideAuthorization | Record<string, unknown> | null;
    refillSnapshot?: DispensingRefillSnapshotInput | null;
  };
  expectedCanonicalString: string;
  expectedSha256Hex: string;
}

const BASE_PAT_ID = '2c2c0002-0000-4000-8000-000000000001';
const BASE_PLAN_ID = '2c2c0005-0000-4000-8000-000000000001';

export const DISPENSING_FINGERPRINT_VECTORS: DispensingFingerprintVector[] = [
  {
    id: 'null_and_missing_fields',
    description:
      'Null/missing optional package, batch, expiry, notes, allergy override, and refill estimates',
    input: {
      patientId: BASE_PAT_ID,
      medicationPlanId: BASE_PLAN_ID,
      dispensedQuantity: 30,
      quantityUnit: 'Tablet',
      packageCount: null,
      packageSize: null,
      batchNumber: null,
      expiryDate: null,
      dispensingDate: '2026-11-16',
      isPartialFill: false,
      notes: '   ',
      expectedRegimenVersionNumber: 1,
      allergyOverrideAuthorization: null,
      refillSnapshot: null,
    },
    expectedCanonicalString:
      '2c2c0002-0000-4000-8000-000000000001|2c2c0005-0000-4000-8000-000000000001|30.0000|tablet|<NULL>|<NULL>|<NULL>|<NULL>|2026-11-16|false|<NULL>|1|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|provisional_client_unverified|masar_refill_v1',
    expectedSha256Hex:
      'ee3fe835fb3f376ff8edae43d430ab9926d441e150661ed04ceebed41809c80d',
  },
  {
    id: 'positive_and_negative_decimals',
    description: 'Positive decimal inputs plus mixed-case batch normalization',
    input: {
      patientId: BASE_PAT_ID,
      medicationPlanId: BASE_PLAN_ID,
      dispensedQuantity: 12.5,
      quantityUnit: 'mL',
      packageCount: 1,
      packageSize: 15.25,
      batchNumber: '  BATCH-Ax9  ',
      expiryDate: '2027-08-31',
      dispensingDate: '2026-11-16',
      isPartialFill: true,
      notes: 'Half bottle titration',
      expectedRegimenVersionNumber: 2,
      allergyOverrideAuthorization: null,
      refillSnapshot: {
        estimatedDailyConsumption: 2.5,
        estimatedSupplyDays: 5,
        estimatedSupplyEndDate: '2026-11-21',
        totalDispensedAnalyzed: 12.5,
        estimatedRemainingUnits: 0.75,
        estimatedDaysRemaining: 0,
        refillStatus: 'on_track',
        refillSupplyEndDate: '2026-11-21',
        forecastAssumptions: 'Linear daily titration',
        uncertaintyNote: 'Exact bottle fill',
        calculationSource: 'provisional_client_unverified',
        algorithmVersion: 'masar_refill_v1',
      },
    },
    expectedCanonicalString:
      '2c2c0002-0000-4000-8000-000000000001|2c2c0005-0000-4000-8000-000000000001|12.5000|ml|1|15.2500|batch-ax9|2027-08-31|2026-11-16|true|Half bottle titration|2|<NULL>|2.5000|5|2026-11-21|12.5000|0.7500|0|on_track|2026-11-21|Linear daily titration|Exact bottle fill|provisional_client_unverified|masar_refill_v1',
    expectedSha256Hex:
      'fa0c41a6d02221379669a399e545d55071858ee835a67cde96b19b77307d682e',
  },
  {
    id: 'rounding_boundaries_half_away_from_zero',
    description: 'Exact IEEE-754 drift traps: 2.00005 -> 2.0001 and 10.50005 -> 10.5001',
    input: {
      patientId: BASE_PAT_ID,
      medicationPlanId: BASE_PLAN_ID,
      dispensedQuantity: 2.00005,
      quantityUnit: 'capsule',
      packageCount: 1,
      packageSize: 10.50005,
      batchNumber: 'RND-01',
      expiryDate: '2027-12-01',
      dispensingDate: '2026-11-16',
      isPartialFill: true,
      notes: 'Boundary rounding vector',
      expectedRegimenVersionNumber: 3,
      allergyOverrideAuthorization: null,
      refillSnapshot: {
        estimatedDailyConsumption: 1.00005,
        estimatedSupplyDays: 2,
        estimatedSupplyEndDate: '2026-11-18',
        totalDispensedAnalyzed: 2.00005,
        estimatedRemainingUnits: 0.00004,
        estimatedDaysRemaining: 1,
        refillStatus: 'due_soon',
        refillSupplyEndDate: '2026-11-18',
        forecastAssumptions: 'Half away from zero test',
        uncertaintyNote: 'Boundary check',
        calculationSource: 'provisional_client_unverified',
        algorithmVersion: 'masar_refill_v1',
      },
    },
    expectedCanonicalString:
      '2c2c0002-0000-4000-8000-000000000001|2c2c0005-0000-4000-8000-000000000001|2.0001|capsule|1|10.5001|rnd-01|2027-12-01|2026-11-16|true|Boundary rounding vector|3|<NULL>|1.0001|2|2026-11-18|2.0001|0.0000|1|due_soon|2026-11-18|Half away from zero test|Boundary check|provisional_client_unverified|masar_refill_v1',
    expectedSha256Hex:
      '96ca45aded1d410380f90015755de71b8ea17a6eab1cfb38ac03f8d6c4a4b919',
  },
  {
    id: 'large_quantity_no_mask_overflow',
    description: 'Large quantity >= 10^9 rounded cleanly without 9-digit to_char ### overflow',
    input: {
      patientId: BASE_PAT_ID,
      medicationPlanId: BASE_PLAN_ID,
      dispensedQuantity: 999999999.99995,
      quantityUnit: 'iu',
      packageCount: 10,
      packageSize: 100000000.00005,
      batchNumber: 'LG-999',
      expiryDate: '2028-01-01',
      dispensingDate: '2026-11-16',
      isPartialFill: false,
      notes: 'Large quantity formatting parity check',
      expectedRegimenVersionNumber: 1,
      allergyOverrideAuthorization: null,
      refillSnapshot: {
        estimatedDailyConsumption: 100000000.00005,
        estimatedSupplyDays: 10,
        estimatedSupplyEndDate: '2026-11-26',
        totalDispensedAnalyzed: 999999999.99995,
        estimatedRemainingUnits: 999999999.99995,
        estimatedDaysRemaining: 10,
        refillStatus: 'on_track',
        refillSupplyEndDate: '2026-11-26',
        forecastAssumptions: 'Large unit scale parity',
        uncertaintyNote: 'No mask overflow',
        calculationSource: 'provisional_client_unverified',
        algorithmVersion: 'masar_refill_v1',
      },
    },
    expectedCanonicalString:
      '2c2c0002-0000-4000-8000-000000000001|2c2c0005-0000-4000-8000-000000000001|1000000000.0000|iu|10|100000000.0001|lg-999|2028-01-01|2026-11-16|false|Large quantity formatting parity check|1|<NULL>|100000000.0001|10|2026-11-26|1000000000.0000|1000000000.0000|10|on_track|2026-11-26|Large unit scale parity|No mask overflow|provisional_client_unverified|masar_refill_v1',
    expectedSha256Hex:
      '240582b6d3c2b3bd6b65f31c5ea2629fb5802b247a1f173102e1e7a48944ac59',
  },
  {
    id: 'arabic_utf8_notes_and_override',
    description: 'Arabic UTF-8 clinical notes, unit, prescriber authorization & all 12 refill fields',
    input: {
      patientId: BASE_PAT_ID,
      medicationPlanId: BASE_PLAN_ID,
      dispensedQuantity: 28,
      quantityUnit: 'قرص',
      packageCount: 1,
      packageSize: 28,
      batchNumber: 'IQ-2026-AR',
      expiryDate: '2027-09-15',
      dispensingDate: '2026-11-16',
      isPartialFill: false,
      notes: 'صرف علاجي موثق — يؤخذ قرص واحد بعد العشاء مع متابعة الضغط',
      expectedRegimenVersionNumber: 4,
      allergyOverrideAuthorization: {
        level: 'critical_conflict',
        acknowledged: true,
        prescriberName: 'د. طارق النعيمي',
        authorizationSource: 'prescriber_written_order',
        authorizationReference: 'RX-BAGHDAD-771',
        clinicalJustification: 'تأكيد الطبيب الاختصاصي مع المراقبة اللصيقة للمراجع.',
      },
      refillSnapshot: {
        estimatedDailyConsumption: 1,
        estimatedSupplyDays: 28,
        estimatedSupplyEndDate: '2026-12-14',
        totalDispensedAnalyzed: 56,
        estimatedRemainingUnits: 28,
        estimatedDaysRemaining: 28,
        refillStatus: 'upcoming',
        refillSupplyEndDate: '2026-12-14',
        forecastAssumptions: 'قرص واحد يومياً مساءً',
        uncertaintyNote: 'تقدير أولي قابل للمراجعة السريرية',
        calculationSource: 'provisional_client_unverified',
        algorithmVersion: 'masar_refill_v1',
      },
    },
    expectedCanonicalString:
      '2c2c0002-0000-4000-8000-000000000001|2c2c0005-0000-4000-8000-000000000001|28.0000|قرص|1|28.0000|iq-2026-ar|2027-09-15|2026-11-16|false|صرف علاجي موثق — يؤخذ قرص واحد بعد العشاء مع متابعة الضغط|4|critical_conflict::true::د. طارق النعيمي::prescriber_written_order::RX-BAGHDAD-771::تأكيد الطبيب الاختصاصي مع المراقبة اللصيقة للمراجع.|1.0000|28|2026-12-14|56.0000|28.0000|28|upcoming|2026-12-14|قرص واحد يومياً مساءً|تقدير أولي قابل للمراجعة السريرية|provisional_client_unverified|masar_refill_v1',
    expectedSha256Hex:
      '1247fc01827b736134f54bc74f5187fbb17136b42ad9efd150f32110b8e02511',
  },
];
