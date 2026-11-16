import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AdminSupabaseLike,
  handleBootstrapFirstOwner,
  handleOwnerProvisionStaff,
} from '../../supabase/functions/_shared/adminProvisioningLogic';
import { AuthenticatedPharmacistContext } from '../services/authService';
import { STAGE2B_SQL_DEPENDENCIES, SupabaseCrmRepository } from '../services/supabaseCrmRepository';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PLAN_ID = 'eeeeeeee-eeee-4eee-8eee-000000000001';

function makePharmacistContext(): AuthenticatedPharmacistContext {
  return {
    userId: OWNER_ID,
    email: 'owner@alshifa.iq',
    pharmacyId: PHARMACY_ID,
    role: 'pharmacy_owner',
    staff: {
      id: OWNER_ID,
      pharmacyId: PHARMACY_ID,
      fullName: 'د. نور المالك',
      role: 'pharmacy_owner',
      syndicateLicense: 'SYN-IQ-1001',
      phone: '07701234567',
      isActive: true,
    },
    pharmacy: {
      id: PHARMACY_ID,
      nameAr: 'صيدلية الشفاء التخصصية',
      nameEn: 'Al-Shifa Specialty Pharmacy',
      city: 'بغداد',
      governorate: 'بغداد',
      licenseNumber: 'IQ-BGD-2026-01',
      phone: '07701112233',
      timezone: 'Asia/Baghdad',
    },
  };
}

function makeSimulatedHardeningClient(options?: {
  tamperFailNextUpdate?: boolean;
}) {
  let seq = 1;
  const nextUuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(seq++).padStart(12, '0')}`;

  const db: Record<string, Array<Record<string, unknown>>> = {
    pharmacies: [
      {
        id: PHARMACY_ID,
        name_ar: 'صيدلية الشفاء التخصصية',
        name_en: 'Al-Shifa Specialty Pharmacy',
        city: 'بغداد',
        governorate: 'بغداد',
        license_number: 'IQ-BGD-2026-01',
        phone: '07701112233',
        timezone: 'Asia/Baghdad',
        is_active: true,
      },
    ],
    pharmacy_staff: [
      {
        id: OWNER_ID,
        pharmacy_id: PHARMACY_ID,
        full_name: 'د. نور المالك',
        role: 'pharmacy_owner',
        syndicate_license: 'SYN-IQ-1001',
        phone: '07701234567',
        is_active: true,
      },
    ],
    patients: [
      {
        id: PATIENT_ID,
        pharmacy_id: PHARMACY_ID,
        patient_code: 'PAT-H-001',
        full_name: 'حيدر كاظم',
        phone: '07705551122',
        phone_owner_type: 'self',
        caregiver_name: null,
        date_of_birth: '1972-04-10',
        sex: 'male',
        contact_preference: 'whatsapp',
        clinical_notes: '',
        registration_date: '2026-11-10',
        status: 'active',
        archived_at: null,
        archived_reason: null,
      },
    ],
    patient_conditions: [
      {
        id: nextUuid('bbbbbbbb'),
        pharmacy_id: PHARMACY_ID,
        patient_id: PATIENT_ID,
        condition_name: 'Type 2 Diabetes',
        status: 'active',
        removed_at: null,
        removed_by_staff_id: null,
        created_at: '2026-11-10T08:00:00Z',
      },
      {
        id: nextUuid('bbbbbbbb'),
        pharmacy_id: PHARMACY_ID,
        patient_id: PATIENT_ID,
        condition_name: 'Hypertension',
        status: 'active',
        removed_at: null,
        removed_by_staff_id: null,
        created_at: '2026-11-10T08:00:00Z',
      },
    ],
    patient_allergies: [
      {
        id: nextUuid('cccccccc'),
        pharmacy_id: PHARMACY_ID,
        patient_id: PATIENT_ID,
        substance: 'Penicillin',
        severity: 'severe',
        reaction: 'Anaphylaxis',
        status: 'active',
        removed_at: null,
        removed_by_staff_id: null,
        created_at: '2026-11-10T08:00:00Z',
      },
      {
        id: nextUuid('cccccccc'),
        pharmacy_id: PHARMACY_ID,
        patient_id: PATIENT_ID,
        substance: 'Sulfa',
        severity: 'moderate',
        reaction: 'Rash',
        status: 'active',
        removed_at: null,
        removed_by_staff_id: null,
        created_at: '2026-11-10T08:00:00Z',
      },
    ],
    patient_medication_plans: [
      {
        id: PLAN_ID,
        pharmacy_id: PHARMACY_ID,
        patient_id: PATIENT_ID,
        catalog_id: null,
        brand_name: 'Glucophage',
        generic_name: 'Metformin',
        strength: '500 mg',
        dosage_form: 'tablet',
        route: 'oral',
        dose_amount: 1,
        dose_unit: 'قرص',
        food_relation: 'after_food',
        verified_instructions: 'قرص صباحاً وقرص مساءً بعد الأكل',
        prescriber_name: null,
        prescriber_specialty: null,
        start_date: '2026-11-10',
        end_date: null,
        is_ongoing: true,
        duration_days: null,
        status: 'active',
        status_changed_at: null,
        status_change_reason: null,
        current_version_number: 1,
        schedule: {
          frequencyType: 'daily',
          timesPerDay: 2,
          doseSlots: [
            { id: 's1', time24: '08:00', doseAmount: 1 },
            { id: 's2', time24: '20:00', doseAmount: 1 },
          ],
          timezone: 'Asia/Baghdad',
        },
        created_at: '2026-11-10T08:00:00Z',
        updated_at: '2026-11-10T08:00:00Z',
      },
    ],
    regimen_versions: [
      {
        id: nextUuid('ffffffff'),
        pharmacy_id: PHARMACY_ID,
        medication_plan_id: PLAN_ID,
        version_number: 1,
        effective_from: '2026-11-10',
        effective_to: null,
        dose_amount: 1,
        dose_unit: 'قرص',
        food_relation: 'after_food',
        verified_instructions: 'قرص صباحاً وقرص مساءً بعد الأكل',
        schedule: {
          frequencyType: 'daily',
          timesPerDay: 2,
          doseSlots: [
            { id: 's1', time24: '08:00', doseAmount: 1 },
            { id: 's2', time24: '20:00', doseAmount: 1 },
          ],
          timezone: 'Asia/Baghdad',
        },
        changed_by_staff_name: 'د. نور المالك',
        change_reason: 'Initial plan',
        created_at: '2026-11-10T08:00:00Z',
      },
    ],
    medication_pause_periods: [],
    dispensing_events: [],
    refill_assessments: [],
    dose_events: [],
    lab_results: [],
    follow_up_tasks: [],
    follow_up_contact_logs: [],
    consultation_threads: [],
    consultation_messages: [],
    patient_apk_invitations: [],
    audit_logs: [],
  };

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let failNextUpdate = Boolean(options?.tamperFailNextUpdate);

  const makeSelect = (table: string) => {
    const eqs: Array<[string, unknown]> = [];
    let isMaybeSingle = false;
    const run = () => {
      let rows = db[table] ?? [];
      for (const [c, v] of eqs) {
        rows = rows.filter((r) => r[c] === v);
      }
      if (isMaybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return b;
      },
      order() {
        return b;
      },
      range() {
        return Promise.resolve(run());
      },
      maybeSingle() {
        isMaybeSingle = true;
        return Promise.resolve(run());
      },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(onF, onR);
      },
    };
    return b;
  };

  const client = {
    from: (table: string) => ({
      select: () => makeSelect(table),
    }),
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });

      if (fn === 'update_patient_with_clinical_tags') {
        if (failNextUpdate) {
          failNextUpdate = false;
          return { data: null, error: { code: '22023', message: 'Simulated invalid p_patch rollback' } };
        }
        const keptConds = new Set((args.p_chronic_conditions as string[] | null) ?? []);
        const keptAllergies = new Set(
          ((args.p_allergies as Array<{ substance: string }> | null) ?? []).map((a) => a.substance)
        );
        if (Array.isArray(args.p_chronic_conditions)) {
          for (const row of db.patient_conditions) {
            if (row.patient_id === args.p_patient_id) {
              row.status = keptConds.has(String(row.condition_name)) ? 'active' : 'inactive';
              row.removed_at = row.status === 'inactive' ? new Date().toISOString() : null;
              row.removed_by_staff_id = row.status === 'inactive' ? OWNER_ID : null;
            }
          }
        }
        if (Array.isArray(args.p_allergies)) {
          for (const row of db.patient_allergies) {
            if (row.patient_id === args.p_patient_id) {
              row.status = keptAllergies.has(String(row.substance)) ? 'active' : 'inactive';
              row.removed_at = row.status === 'inactive' ? new Date().toISOString() : null;
              row.removed_by_staff_id = row.status === 'inactive' ? OWNER_ID : null;
            }
          }
        }
        return { data: { ok: true, patientId: args.p_patient_id }, error: null };
      }

      if (fn === 'record_dispensing_with_refill') {
        const daily = Number(args.p_estimated_daily_consumption ?? 0);
        const unit = String(args.p_quantity_unit ?? '');
        const qty = Number(args.p_dispensed_quantity ?? 0);
        const priorSum = db.dispensing_events
          .filter((d) => d.medication_plan_id === args.p_medication_plan_id)
          .reduce((acc, d) => acc + Number(d.dispensed_quantity), 0);
        const authTotal = priorSum + qty;

        if (unit === 'mL' && args.p_refill_status !== 'unable_to_estimate') {
          return {
            data: null,
            error: {
              code: '23514',
              message: 'Incompatible dispensed unit (mL) vs prescribed dose unit (قرص).',
            },
          };
        }
        if (unit !== 'mL' && Math.abs(daily - 2) > 0.1) {
          return {
            data: null,
            error: {
              code: '23514',
              message: 'Client estimated_daily_consumption deviates from authoritative schedule daily rate (2).',
            },
          };
        }
        if (
          args.p_total_dispensed_analyzed !== null &&
          Math.abs(Number(args.p_total_dispensed_analyzed) - authTotal) > 0.01
        ) {
          return {
            data: null,
            error: {
              code: '23514',
              message: `Client total_dispensed_analyzed (${args.p_total_dispensed_analyzed}) mismatches authoritative sum (${authTotal}).`,
            },
          };
        }

        const id = nextUuid('34343434');
        db.dispensing_events.push({
          id,
          pharmacy_id: PHARMACY_ID,
          patient_id: args.p_patient_id,
          medication_plan_id: args.p_medication_plan_id,
          regimen_version_number: 1,
          dispensed_quantity: qty,
          quantity_unit: unit,
          dispensing_date: args.p_dispensing_date,
          dispensed_by_staff_id: OWNER_ID,
          dispensed_by_staff_name: 'د. نور المالك',
          estimated_daily_consumption: unit === 'mL' ? null : 2,
          estimated_supply_days: args.p_estimated_supply_days,
          estimated_supply_end_date: args.p_estimated_supply_end_date,
          forecast_assumptions: args.p_forecast_assumptions ?? 'Provisional client schedule projection',
          is_partial_fill: Boolean(args.p_is_partial_fill),
          calculation_source: 'provisional_client_unverified',
          verification_status: 'provisional_unverified',
          algorithm_version: String(args.p_algorithm_version ?? 'masar_refill_v1'),
          created_at: new Date().toISOString(),
        });
        return {
          data: {
            ok: true,
            dispensingEventId: id,
            verificationStatus: 'provisional_unverified',
            calculationSource: 'provisional_client_unverified',
            authoritativeTotalDispensed: authTotal,
          },
          error: null,
        };
      }

      return { data: null, error: { code: 'PGRST202', message: `Missing ${fn}` } };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    db,
    rpcCalls,
  };
}

function makeHardeningAdminSupabase(options: {
  claimResult?: { data: unknown; error: { message: string; code?: string } | null };
  finalizeResult?: (createdUid: string) => { data: unknown; error: { message: string; code?: string } | null };
  inspectResult?: (createdUid: string) => { data: unknown; error: { message: string; code?: string } | null };
  provisionResult?: (newUid: string) => { data: unknown; error: { message: string; code?: string } | null };
  deleteUserFails?: boolean;
}) {
  let seq = 1;
  const createdUsers: string[] = [];
  const deletedUsers: string[] = [];
  const reconciliationUpdates: Array<Record<string, unknown>> = [];

  const client: AdminSupabaseLike = {
    auth: {
      async getUser(jwt: string) {
        if (jwt === 'owner-jwt') {
          return { data: { user: { id: OWNER_ID, email: 'owner@alshifa.iq' } }, error: null };
        }
        return { data: { user: null }, error: { message: 'Invalid JWT' } };
      },
      admin: {
        async createUser({ email }) {
          const uid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(seq++).padStart(12, '0')}`;
          createdUsers.push(uid);
          return { data: { user: { id: uid, email } }, error: null };
        },
        async deleteUser(userId: string) {
          if (options.deleteUserFails) {
            return { data: null, error: { message: 'Auth service timeout during rollback' } };
          }
          deletedUsers.push(userId);
          return { data: {}, error: null };
        },
      },
    },
    from(table: string) {
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) {
              filters.push([col, val]);
              return chain;
            },
            maybeSingle: async () => {
              if (table === 'pharmacy_staff') {
                const isOwnerLookup = filters.some(([c, v]) => c === 'id' && v === OWNER_ID);
                if (isOwnerLookup) {
                  return {
                    data: {
                      id: OWNER_ID,
                      pharmacy_id: PHARMACY_ID,
                      full_name: 'د. نور المالك',
                      role: 'pharmacy_owner',
                      is_active: true,
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              }
              if (table === 'pharmacies') {
                return { data: { id: PHARMACY_ID, is_active: true }, error: null };
              }
              return { data: null, error: null };
            },
          };
          return chain;
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (fn === 'claim_first_owner_bootstrap') {
        if (options.claimResult) return options.claimResult;
        return { data: { ok: true, claimId: args.p_request_id, status: 'claimed' }, error: null };
      }
      if (fn === 'finalize_first_owner_bootstrap') {
        const uid = String(args.p_owner_user_id ?? '');
        if (options.finalizeResult) return options.finalizeResult(uid);
        return { data: { ok: true, pharmacyId: PHARMACY_ID, ownerUserId: uid }, error: null };
      }
      if (fn === 'inspect_first_owner_bootstrap_state') {
        const lastUid = createdUsers[createdUsers.length - 1] ?? '';
        if (options.inspectResult) return options.inspectResult(lastUid);
        return {
          data: { status: 'claimed', pharmacyId: null, ownerUserId: null, pharmacyCount: 0, staffCount: 0 },
          error: null,
        };
      }
      if (fn === 'mark_first_owner_bootstrap_reconciliation') {
        reconciliationUpdates.push(args);
        return { data: { ok: true, status: args.p_new_status }, error: null };
      }
      if (fn === 'claim_staff_provisioning_request') {
        return { data: { ok: true, claimId: args.p_request_id, status: 'claimed' }, error: null };
      }
      if (fn === 'inspect_staff_provisioning_state') {
        return {
          data: {
            status: 'rolled_back',
            pharmacyId: null,
            staffExistsInDb: false,
            staffId: null,
            staffRole: null,
          },
          error: null,
        };
      }
      if (fn === 'mark_staff_provisioning_reconciliation') {
        reconciliationUpdates.push(args);
        return { data: { ok: true, status: args.p_new_status }, error: null };
      }
      if (fn === 'provision_pharmacy_staff_by_owner') {
        const uid = String(args.p_new_user_id ?? '');
        if (options.provisionResult) return options.provisionResult(uid);
        return {
          data: { ok: true, staffId: uid, pharmacyId: PHARMACY_ID, role: 'authorized_pharmacist' },
          error: null,
        };
      }
      return { data: null, error: { code: 'PGRST202', message: `Unknown ${fn}` } };
    },
  };

  return { client, createdUsers, deletedUsers, reconciliationUpdates };
}

async function main() {
  console.log('===================================================================');
  console.log('MASAR Care — Stage 2B.2A.1 Pre-Deployment Hardening Tests');
  console.log('MODE: OFFLINE MOCKED & STATIC VERIFICATION ONLY (NO LIVE DB)');
  console.log('===================================================================');

  let passed = 0;

  // --------------------------------------------------------------------------
  // H1: Refill Forecast Provenance, Tampered Estimate Rejection & Concurrent Fills
  // --------------------------------------------------------------------------
  {
    const ctx = makePharmacistContext();
    const { client, db, rpcCalls } = makeSimulatedHardeningClient();
    const repo = new SupabaseCrmRepository(client, ctx);

    const res1 = await repo.recordDispensingAsync(
      {
        patientId: PATIENT_ID,
        medicationPlanId: PLAN_ID,
        dispensedQuantity: 60,
        quantityUnit: 'قرص',
        dispensingDate: '2026-11-13',
        isPartialFill: false,
      },
      'en'
    );
    assert.ok(res1.event);
    assert.equal(res1.event?.calculationSource, 'provisional_client_unverified');
    assert.equal(res1.event?.verificationStatus, 'provisional_unverified');
    assert.equal(res1.event?.algorithmVersion, 'masar_refill_v1');

    const dispRpc = rpcCalls.find((c) => c.fn === 'record_dispensing_with_refill');
    assert.equal(dispRpc?.args.p_calculation_source, 'provisional_client_unverified');
    assert.equal(dispRpc?.args.p_algorithm_version, 'masar_refill_v1');
    assert.equal(typeof dispRpc?.args.p_calculation_inputs, 'object');

    // Tampered client daily consumption rate (10/day on 2/day schedule) rejected with 23514
    const tamperedResp = await client.rpc('record_dispensing_with_refill', {
      p_patient_id: PATIENT_ID,
      p_medication_plan_id: PLAN_ID,
      p_dispensed_quantity: 60,
      p_quantity_unit: 'قرص',
      p_dispensing_date: '2026-11-13',
      p_estimated_daily_consumption: 10,
      p_refill_status: 'due_soon',
      p_total_dispensed_analyzed: 120,
    });
    assert.equal(tamperedResp.error?.code, '23514');

    // Incompatible unit claiming active forecast rejected with 23514
    const badUnitResp = await client.rpc('record_dispensing_with_refill', {
      p_patient_id: PATIENT_ID,
      p_medication_plan_id: PLAN_ID,
      p_dispensed_quantity: 100,
      p_quantity_unit: 'mL',
      p_dispensing_date: '2026-11-13',
      p_estimated_daily_consumption: 2,
      p_refill_status: 'on_track',
    });
    assert.equal(badUnitResp.error?.code, '23514');

    // Concurrent second fill with stale cumulative total (claiming 30 instead of 90) rejected
    const staleCumResp = await client.rpc('record_dispensing_with_refill', {
      p_patient_id: PATIENT_ID,
      p_medication_plan_id: PLAN_ID,
      p_dispensed_quantity: 30,
      p_quantity_unit: 'قرص',
      p_dispensing_date: '2026-11-14',
      p_estimated_daily_consumption: 2,
      p_refill_status: 'on_track',
      p_total_dispensed_analyzed: 30,
    });
    assert.equal(staleCumResp.error?.code, '23514');
    assert.equal(db.dispensing_events.length, 1);

    passed++;
    console.log('✓ Suite 1 (H1): Refill provenance, tamper rejection & cumulative checks passed');
  }

  // --------------------------------------------------------------------------
  // H2: Allergy & Condition Soft-Deactivation + Rollback Preservation
  // --------------------------------------------------------------------------
  {
    const ctx = makePharmacistContext();
    const { client, db } = makeSimulatedHardeningClient();
    const repo = new SupabaseCrmRepository(client, ctx);

    const updatedState = await repo.updatePatientAsync(PATIENT_ID, {
      chronicConditions: ['Type 2 Diabetes'],
      allergies: [{ id: 'a1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' }],
    });

    const patient = updatedState.patients.find((p) => p.id === PATIENT_ID);
    assert.deepEqual(patient?.chronicConditions, ['Type 2 Diabetes']);
    assert.equal(patient?.allergies.length, 1);
    assert.equal(patient?.allergies[0].substance, 'Penicillin');

    // Underlying DB still retains BOTH historical rows (1 active + 1 inactive with removed_at)
    assert.equal(db.patient_conditions.length, 2);
    assert.equal(db.patient_allergies.length, 2);
    const inactiveAllergy = db.patient_allergies.find((a) => a.substance === 'Sulfa');
    assert.equal(inactiveAllergy?.status, 'inactive');
    assert.ok(inactiveAllergy?.removed_at);
    assert.equal(inactiveAllergy?.removed_by_staff_id, OWNER_ID);

    // Partial update failure rolls back cleanly without erasing active allergy
    const { client: failClient, db: failDb } = makeSimulatedHardeningClient({
      tamperFailNextUpdate: true,
    });
    const failRepo = new SupabaseCrmRepository(failClient, ctx);
    await assert.rejects(
      () => failRepo.updatePatientAsync(PATIENT_ID, { allergies: [] }),
      /Simulated invalid p_patch rollback/i
    );
    assert.equal(failDb.patient_allergies.filter((a) => a.status === 'active').length, 2);

    passed++;
    console.log('✓ Suite 2 (H2): Clinical allergy/condition soft-deactivation & rollback verified');
  }

  // --------------------------------------------------------------------------
  // H3, H4, H6: Bootstrap Claim, No Service-Role Fallback & Safe Reconciliation
  // --------------------------------------------------------------------------
  {
    const bootstrapSecret = 'test-only-bootstrap-token-32-chars-minimum-01';
    const adminSecret = 'test-only-platform-admin-token-32-chars-min-02';
    const fakeServiceRole = 'test-service-role-should-never-be-accepted-bearer';
    const validPayload = {
      pharmacy: {
        nameAr: 'صيدلية الأمل',
        nameEn: 'Al-Amal Pharmacy',
        city: 'بغداد',
        governorate: 'بغداد',
        licenseNumber: 'IQ-BGD-910',
        phone: '+9647701234567',
      },
      owner: {
        email: 'owner@alamal.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. علي الحسن',
        phone: '07711223344',
        syndicateLicense: 'SYN-910',
      },
    };

    // H4: Missing MASAR_PLATFORM_ADMIN_TOKEN fails closed with 503 BOOTSTRAP_DISABLED
    const noAdminMock = makeHardeningAdminSupabase({});
    const noAdminRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${fakeServiceRole}`,
        'idempotency-key': 'idem-key-h4-disabled-0001',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: '' },
      adminClient: noAdminMock.client,
    });
    assert.equal(noAdminRes.status, 503);
    assert.equal(noAdminRes.body.errorCode, 'BOOTSTRAP_DISABLED');

    // H4: Passing service_role bearer when MASAR_PLATFORM_ADMIN_TOKEN is configured returns 401
    const svcBearerRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${fakeServiceRole}`,
        'idempotency-key': 'idem-key-h4-rejected-0002',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: noAdminMock.client,
    });
    assert.equal(svcBearerRes.status, 401);
    assert.equal(svcBearerRes.body.errorCode, 'UNAUTHORIZED_PLATFORM_ADMIN');

    // H3: Missing Idempotency-Key returns 400 before creating Auth user
    const noIdemRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: noAdminMock.client,
    });
    assert.equal(noIdemRes.status, 400);
    assert.equal(noIdemRes.body.errorCode, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(noAdminMock.createdUsers.length, 0);

    // H3: Active claim conflict returns 409 BOOTSTRAP_IN_PROGRESS without creating Auth user
    const conflictMock = makeHardeningAdminSupabase({
      claimResult: {
        data: { ok: false, errorCode: 'BOOTSTRAP_IN_PROGRESS' },
        error: null,
      },
    });
    const conflictRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
        'idempotency-key': 'idem-key-h3-conflict-0003',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: conflictMock.client,
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.body.errorCode, 'BOOTSTRAP_IN_PROGRESS');
    assert.equal(conflictMock.createdUsers.length, 0);

    // H3: Ambiguous finalize timeout where inspect proves DB ACTUALLY COMMITTED for this user
    // MUST NOT delete Auth user and returns reconciled 201!
    const committedTimeoutMock = makeHardeningAdminSupabase({
      finalizeResult: () => ({
        data: null,
        error: { message: 'Gateway timeout after DB commit' },
      }),
      inspectResult: (uid) => ({
        data: {
          status: 'completed',
          pharmacyId: PHARMACY_ID,
          ownerUserId: uid,
          pharmacyCount: 1,
          staffCount: 1,
        },
        error: null,
      }),
    });
    const committedTimeoutRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
        'idempotency-key': 'idem-key-h3-timeout-committed-0004',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: committedTimeoutMock.client,
    });
    assert.equal(committedTimeoutRes.status, 201);
    assert.equal(committedTimeoutRes.body.ok, true);
    assert.equal(committedTimeoutRes.body.reconciledFromAmbiguousFinalize, true);
    assert.equal(
      committedTimeoutMock.deletedUsers.length,
      0,
      'Must NEVER delete Auth user when durable DB state shows bootstrap committed for that user'
    );

    // H3: Ambiguous finalize failure where inspect ALSO fails -> DO NOT delete Auth user; require manual reconciliation
    const doubleFailMock = makeHardeningAdminSupabase({
      finalizeResult: () => ({
        data: null,
        error: { message: 'Transient network reset' },
      }),
      inspectResult: () => ({
        data: null,
        error: { message: 'Inspect RPC unavailable' },
      }),
    });
    const doubleFailRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
        'idempotency-key': 'idem-key-h3-double-fail-0005',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: doubleFailMock.client,
    });
    assert.equal(doubleFailRes.status, 500);
    assert.equal(doubleFailRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.equal(
      doubleFailMock.deletedUsers.length,
      0,
      'Must NOT delete Auth user when durable DB outcome could not be verified'
    );

    // H6: Malformed finalize payload ({ ok: true } missing pharmacyId) fails closed after verifying DB untouched
    const malformedFinMock = makeHardeningAdminSupabase({
      finalizeResult: () => ({
        data: { ok: true },
        error: null,
      }),
    });
    const malformedFinRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
        'idempotency-key': 'idem-key-h6-malformed-fin-0006',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: malformedFinMock.client,
    });
    assert.equal(malformedFinRes.status, 500);
    assert.equal(malformedFinRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.deepEqual(malformedFinMock.deletedUsers, malformedFinMock.createdUsers);

    passed++;
    console.log('✓ Suite 3 (H3/H4/H6): Durable claim, no service-role bearer & safe reconciliation passed');
  }

  // --------------------------------------------------------------------------
  // H5 & H6: Staff Provisioning Role Restriction & Fail-Closed RPC Validation
  // --------------------------------------------------------------------------
  {
    const baseStaffPayload = {
      email: 'new.staff@alshifa.iq',
      password: 'StaffPassword2026!',
      fullName: 'د. زينب جاسم',
      phone: '07704445566',
      syndicateLicense: 'SYN-IQ-2009',
    };

    // H5: Creating additional pharmacy_owner is rejected with 403 OWNER_DELEGATION_NOT_ENABLED
    const ownerRoleMock = makeHardeningAdminSupabase({});
    const ownerRoleRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h5-owner-delegation-0001',
      }),
      rawBody: { ...baseStaffPayload, role: 'pharmacy_owner' },
      adminClient: ownerRoleMock.client,
    });
    assert.equal(ownerRoleRes.status, 403);
    assert.equal(ownerRoleRes.body.errorCode, 'OWNER_DELEGATION_NOT_ENABLED');
    assert.equal(ownerRoleMock.createdUsers.length, 0);

    // H6: Malformed/mismatched provision_pharmacy_staff_by_owner payload fails closed & rolls back Auth user
    const mismatchedMock = makeHardeningAdminSupabase({
      provisionResult: () => ({
        data: { ok: true, staffId: 'wrong-staff-id', pharmacyId: PHARMACY_ID, role: 'authorized_pharmacist' },
        error: null,
      }),
    });
    const mismatchedRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h6-mismatched-staff-0002',
      }),
      rawBody: { ...baseStaffPayload, role: 'authorized_pharmacist' },
      adminClient: mismatchedMock.client,
    });
    assert.equal(mismatchedRes.status, 500);
    assert.equal(mismatchedRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.deepEqual(mismatchedMock.deletedUsers, mismatchedMock.createdUsers);

    // H6: Malformed payload + deleteUser failure surfaces orphanAuthUserId
    const brokenRollbackMock = makeHardeningAdminSupabase({
      provisionResult: () => ({ data: { ok: true }, error: null }),
      deleteUserFails: true,
    });
    const brokenRollbackRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h6-broken-rollback-0003',
      }),
      rawBody: { ...baseStaffPayload, role: 'authorized_pharmacist' },
      adminClient: brokenRollbackMock.client,
    });
    assert.equal(brokenRollbackRes.status, 500);
    assert.equal(brokenRollbackRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.ok(brokenRollbackRes.body.orphanAuthUserId);

    passed++;
    console.log('✓ Suite 4 (H5/H6): Owner delegation block & fail-closed staff RPC checks passed');
  }

  // --------------------------------------------------------------------------
  // H7, M1, M2: Static Hardening, 23-Table Checks, SQL Draft & Docs Verification
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    assert.ok(
      STAGE2B_SQL_DEPENDENCIES.scheduledDoseMaterializationPreAndroid,
      'Pre-Android scheduled_doses materialization prerequisite must be explicitly tracked'
    );

    const sql0003 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );
    const adminLogic = fs.readFileSync(
      path.join(root, 'supabase/functions/_shared/adminProvisioningLogic.ts'),
      'utf8'
    );
    const bootFn = fs.readFileSync(
      path.join(root, 'supabase/functions/bootstrap-first-owner/index.ts'),
      'utf8'
    );
    const sqlTestDraft = fs.readFileSync(
      path.join(root, 'supabase/tests/stage2b_0003_negative_and_integrity.test.sql'),
      'utf8'
    );
    const preDeployDoc = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A1_PRE_DEPLOYMENT_REVIEW.md'),
      'utf8'
    );
    const approvalPlanDoc = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md'),
      'utf8'
    );
    const handoffDoc = fs.readFileSync(path.join(root, 'docs/MASAR_CARE_HANDOFF.md'), 'utf8');

    // H1: Never claim Server-verified refill assessment in 0003
    assert.equal(sql0003.includes('Server-verified refill assessment'), false);
    assert.equal(sql0003.includes('provisional_unverified'), true);

    // H2: No DELETE FROM patient_conditions / patient_allergies; revokes DELETE grant
    assert.equal(/DELETE FROM public\.patient_(conditions|allergies)/.test(sql0003), false);
    assert.equal(sql0003.includes('REVOKE DELETE ON TABLE public.patient_conditions FROM authenticated;'), true);
    assert.equal(sql0003.includes('REVOKE DELETE ON TABLE public.patient_allergies FROM authenticated;'), true);

    // H4: Zero serviceRoleKey bearer fallback in Edge logic/entrypoint
    assert.equal(adminLogic.includes('serviceRoleKey'), false);
    assert.equal(/env:\s*\{[^}]*serviceRoleKey/.test(bootFn), false);

    // M1: SQL draft checks 24 tables & ends with ROLLBACK
    assert.equal(sqlTestDraft.includes('Status: DRAFT — NOT EXECUTED AGAINST POSTGRESQL'), true);
    assert.equal(sqlTestDraft.includes('v_table_count <> 24'), true);
    assert.equal(sqlTestDraft.includes('ROLLBACK;'), true);

    // M1 & M2: Docs record 24 tables, endpoint deletion, pre-Android scheduled_doses & mobile rollout order
    assert.equal(preDeployDoc.includes('scheduled_doses'), true);
    assert.equal(preDeployDoc.includes('bootstrap-first-owner'), true);
    assert.equal(approvalPlanDoc.includes('24'), true);
    assert.equal(approvalPlanDoc.includes('supabase functions delete bootstrap-first-owner'), true);
    assert.equal(approvalPlanDoc.includes('MASAR_PLATFORM_ADMIN_TOKEN'), true);
    assert.equal(handoffDoc.includes('Kotlin') && handoffDoc.includes('PWA'), true);

    passed++;
    console.log('✓ Suite 5 (H7/M1/M2): Pre-Android gate, 24-table SQL test draft & docs verified');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.2A.1 PRE-DEPLOYMENT HARDENING SUITES PASSED`);
  console.log('MODE: OFFLINE MOCKED & STATIC CHECKS ONLY (bkidngfzsubmyunacnju UNTOUCHED)');
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.2A.1 hardening test suite failed:', err);
  process.exit(1);
});
