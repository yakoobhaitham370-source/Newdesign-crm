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
import { Stage2bSqlDependencyError, SupabaseCrmRepository } from '../services/supabaseCrmRepository';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PHARMACIST_ID = '33333333-3333-4333-8333-333333333333';
const INACTIVE_STAFF_ID = '44444444-4444-4444-8444-444444444444';

function makePharmacistContext(
  userId = OWNER_ID,
  role: 'pharmacy_owner' | 'authorized_pharmacist' = 'pharmacy_owner'
): AuthenticatedPharmacistContext {
  return {
    userId,
    email: 'owner@alshifa.iq',
    pharmacyId: PHARMACY_ID,
    role,
    staff: {
      id: userId,
      pharmacyId: PHARMACY_ID,
      fullName: 'د. نور المالك',
      role,
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

interface SimulatedDb {
  pharmacies: Array<Record<string, unknown>>;
  pharmacy_staff: Array<Record<string, unknown>>;
  patients: Array<Record<string, unknown>>;
  patient_conditions: Array<Record<string, unknown>>;
  patient_allergies: Array<Record<string, unknown>>;
  patient_medication_plans: Array<Record<string, unknown>>;
  regimen_versions: Array<Record<string, unknown>>;
  medication_pause_periods: Array<Record<string, unknown>>;
  dispensing_events: Array<Record<string, unknown>>;
  refill_assessments: Array<Record<string, unknown>>;
  dose_events: Array<Record<string, unknown>>;
  lab_results: Array<Record<string, unknown>>;
  follow_up_tasks: Array<Record<string, unknown>>;
  follow_up_contact_logs: Array<Record<string, unknown>>;
  consultation_threads: Array<Record<string, unknown>>;
  consultation_messages: Array<Record<string, unknown>>;
  patient_apk_invitations: Array<Record<string, unknown>>;
  audit_logs: Array<Record<string, unknown>>;
}

function makeSimulatedCrmClient(options?: {
  forcedRpcError?: (fn: string, args: Record<string, unknown>) => { code: string; message: string } | null;
}) {
  let seq = 100;
  const nextUuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  const db: SimulatedDb = {
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
    patients: [],
    patient_conditions: [],
    patient_allergies: [],
    patient_medication_plans: [],
    regimen_versions: [],
    medication_pause_periods: [],
    dispensing_events: [],
    refill_assessments: [],
    dose_events: [],
    lab_results: [],
    follow_up_tasks: [],
    follow_up_contact_logs: [],
    consultation_threads: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        pharmacy_id: PHARMACY_ID,
        patient_id: '88888888-8888-4888-8888-888888888888',
        subject: 'Dosing timing question',
        status: 'open',
        updated_at: '2026-11-13T08:00:00Z',
      },
    ],
    consultation_messages: [],
    patient_apk_invitations: [],
    audit_logs: [],
  };

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const directWrites: Array<{ table: string; op: string }> = [];

  function makeSelectBuilder(table: keyof SimulatedDb) {
    let rangeBounds: [number, number] | null = null;
    let isMaybeSingle = false;
    const eqFilters: Array<[string, unknown]> = [];

    const run = () => {
      let rows = db[table] ?? [];
      for (const [col, val] of eqFilters) {
        rows = rows.filter((r) => r[col] === val);
      }
      if (isMaybeSingle) {
        return { data: rows[0] ?? null, error: null };
      }
      if (rangeBounds) {
        return { data: rows.slice(rangeBounds[0], rangeBounds[1] + 1), error: null };
      }
      return { data: rows, error: null };
    };

    const b: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return b;
      },
      order() {
        return b;
      },
      range(from: number, to: number) {
        rangeBounds = [from, to];
        return b;
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
  }

  const client = {
    from(table: keyof SimulatedDb) {
      return {
        select: () => makeSelectBuilder(table),
        insert: () => {
          directWrites.push({ table, op: 'insert' });
          return Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } });
        },
        update: () => {
          directWrites.push({ table, op: 'update' });
          return Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } });
        },
        delete: () => {
          directWrites.push({ table, op: 'delete' });
          return Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } });
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const forcedErr = options?.forcedRpcError?.(fn, args);
      if (forcedErr) {
        return { data: null, error: forcedErr };
      }

      if (fn === 'create_patient_with_clinical_tags') {
        const patientId = nextUuid('aaaaaaaa');
        db.patients.push({
          id: patientId,
          pharmacy_id: PHARMACY_ID,
          patient_code: args.p_patient_code,
          full_name: args.p_full_name,
          phone: args.p_phone,
          phone_owner_type: args.p_phone_owner_type,
          caregiver_name: args.p_caregiver_name,
          date_of_birth: args.p_date_of_birth,
          sex: args.p_sex,
          contact_preference: args.p_contact_preference,
          clinical_notes: args.p_clinical_notes,
          registration_date: args.p_registration_date,
          status: 'active',
          archived_at: null,
          archived_reason: null,
        });
        for (const c of (args.p_chronic_conditions as string[]) ?? []) {
          db.patient_conditions.push({
            id: nextUuid('bbbbbbbb'),
            pharmacy_id: PHARMACY_ID,
            patient_id: patientId,
            condition_name: c,
            created_at: new Date().toISOString(),
          });
        }
        for (const a of (args.p_allergies as Array<Record<string, unknown>>) ?? []) {
          db.patient_allergies.push({
            id: nextUuid('cccccccc'),
            pharmacy_id: PHARMACY_ID,
            patient_id: patientId,
            substance: a.substance,
            severity: a.severity,
            reaction: a.reaction,
            created_at: new Date().toISOString(),
          });
        }
        db.audit_logs.unshift({
          id: nextUuid('dddddddd'),
          pharmacy_id: PHARMACY_ID,
          timestamp: new Date().toISOString(),
          actor_name: 'د. نور المالك',
          actor_role: 'pharmacy_owner',
          action: 'PATIENT_REGISTERED',
          entity_type: 'patient',
          entity_id: patientId,
          summary_ar: 'تسجيل المراجع الجديد',
          summary_en: 'Registered new patient',
        });
        return { data: { ok: true, patientId }, error: null };
      }

      if (fn === 'update_patient_with_clinical_tags') {
        const pt = db.patients.find((p) => p.id === args.p_patient_id);
        if (!pt) return { data: null, error: { code: '42501', message: 'Not found' } };
        const patch = args.p_patch as Record<string, unknown>;
        if (patch.full_name !== undefined) pt.full_name = patch.full_name;
        if (patch.phone !== undefined) pt.phone = patch.phone;
        if (Array.isArray(args.p_chronic_conditions)) {
          const kept = new Set(args.p_chronic_conditions as string[]);
          for (const row of db.patient_conditions) {
            if (row.patient_id === args.p_patient_id && !kept.has(String(row.condition_name))) {
              row.status = 'inactive';
              row.removed_at = new Date().toISOString();
            }
          }
          for (const c of args.p_chronic_conditions as string[]) {
            const existing = db.patient_conditions.find(
              (r) => r.patient_id === args.p_patient_id && r.condition_name === c
            );
            if (existing) {
              existing.status = 'active';
              existing.removed_at = null;
            } else {
              db.patient_conditions.push({
                id: nextUuid('bbbbbbbb'),
                pharmacy_id: PHARMACY_ID,
                patient_id: args.p_patient_id,
                condition_name: c,
                status: 'active',
                created_at: new Date().toISOString(),
              });
            }
          }
        }
        if (Array.isArray(args.p_allergies)) {
          const incoming = args.p_allergies as Array<Record<string, unknown>>;
          const kept = new Set(incoming.map((a) => String(a.substance)));
          for (const row of db.patient_allergies) {
            if (row.patient_id === args.p_patient_id && !kept.has(String(row.substance))) {
              row.status = 'inactive';
              row.removed_at = new Date().toISOString();
            }
          }
          for (const a of incoming) {
            const existing = db.patient_allergies.find(
              (r) => r.patient_id === args.p_patient_id && r.substance === a.substance
            );
            if (existing) {
              existing.severity = a.severity;
              existing.reaction = a.reaction;
              existing.status = 'active';
              existing.removed_at = null;
            } else {
              db.patient_allergies.push({
                id: nextUuid('cccccccc'),
                pharmacy_id: PHARMACY_ID,
                patient_id: args.p_patient_id,
                substance: a.substance,
                severity: a.severity,
                reaction: a.reaction,
                status: 'active',
                created_at: new Date().toISOString(),
              });
            }
          }
        }
        db.audit_logs.unshift({
          id: nextUuid('dddddddd'),
          pharmacy_id: PHARMACY_ID,
          timestamp: new Date().toISOString(),
          actor_name: 'د. نور المالك',
          actor_role: 'pharmacy_owner',
          action: 'PATIENT_UPDATED',
          entity_type: 'patient',
          entity_id: args.p_patient_id,
          summary_ar: 'تحديث بيانات المراجع',
          summary_en: 'Updated patient profile',
        });
        return { data: { ok: true, patientId: args.p_patient_id }, error: null };
      }

      if (fn === 'create_medication_plan_with_version') {
        const planId = nextUuid('eeeeeeee');
        const nowIso = new Date().toISOString();
        db.patient_medication_plans.push({
          id: planId,
          pharmacy_id: PHARMACY_ID,
          patient_id: args.p_patient_id,
          catalog_id: args.p_catalog_id,
          brand_name: args.p_brand_name,
          generic_name: args.p_generic_name,
          strength: args.p_strength,
          dosage_form: args.p_dosage_form,
          route: args.p_route,
          dose_amount: args.p_dose_amount,
          dose_unit: args.p_dose_unit,
          food_relation: args.p_food_relation,
          verified_instructions: args.p_verified_instructions,
          prescriber_name: args.p_prescriber_name,
          prescriber_specialty: args.p_prescriber_specialty,
          start_date: args.p_start_date,
          end_date: args.p_end_date,
          is_ongoing: args.p_is_ongoing,
          duration_days: args.p_duration_days,
          status: 'active',
          status_changed_at: null,
          status_change_reason: null,
          current_version_number: 1,
          schedule: args.p_schedule,
          created_at: nowIso,
          updated_at: nowIso,
        });
        db.regimen_versions.push({
          id: nextUuid('ffffffff'),
          pharmacy_id: PHARMACY_ID,
          medication_plan_id: planId,
          version_number: 1,
          effective_from: args.p_start_date,
          effective_to: null,
          dose_amount: args.p_dose_amount,
          dose_unit: args.p_dose_unit,
          food_relation: args.p_food_relation,
          verified_instructions: args.p_verified_instructions,
          schedule: args.p_schedule,
          changed_by_staff_name: 'د. نور المالك',
          change_reason: 'Initial pharmacist-verified plan',
          created_at: nowIso,
        });
        db.audit_logs.unshift({
          id: nextUuid('dddddddd'),
          pharmacy_id: PHARMACY_ID,
          timestamp: nowIso,
          actor_name: 'د. نور المالك',
          actor_role: 'pharmacy_owner',
          action: 'MEDICATION_PLAN_ADDED',
          entity_type: 'medication_plan',
          entity_id: planId,
          summary_ar: 'إضافة خطة علاجية',
          summary_en: 'Added medication plan',
        });
        return { data: { ok: true, planId, versionNumber: 1 }, error: null };
      }

      if (fn === 'update_medication_plan_version') {
        const plan = db.patient_medication_plans.find((m) => m.id === args.p_plan_id);
        if (!plan) return { data: null, error: { code: '42501', message: 'Not found' } };
        const openVer = db.regimen_versions.find(
          (rv) => rv.medication_plan_id === args.p_plan_id && rv.effective_to === null
        );
        if (openVer) {
          openVer.effective_to = args.p_effective_date;
        }
        const nextVer = Number(plan.current_version_number) + 1;
        plan.current_version_number = nextVer;
        plan.dose_amount = args.p_dose_amount;
        plan.verified_instructions = args.p_verified_instructions;
        plan.schedule = args.p_schedule;
        db.regimen_versions.push({
          id: nextUuid('ffffffff'),
          pharmacy_id: PHARMACY_ID,
          medication_plan_id: args.p_plan_id,
          version_number: nextVer,
          effective_from: args.p_effective_date,
          effective_to: null,
          dose_amount: args.p_dose_amount,
          dose_unit: args.p_dose_unit,
          food_relation: args.p_food_relation,
          verified_instructions: args.p_verified_instructions,
          schedule: args.p_schedule,
          changed_by_staff_name: 'د. نور المالك',
          change_reason: args.p_change_reason,
          created_at: new Date().toISOString(),
        });
        return { data: { ok: true, planId: args.p_plan_id, versionNumber: nextVer }, error: null };
      }

      if (fn === 'change_medication_plan_status') {
        const plan = db.patient_medication_plans.find((m) => m.id === args.p_plan_id);
        if (!plan) return { data: null, error: { code: '42501', message: 'Not found' } };
        const openPause = db.medication_pause_periods.find(
          (p) => p.medication_plan_id === args.p_plan_id && p.resumed_at === null
        );
        if (args.p_status === 'paused' && !openPause) {
          db.medication_pause_periods.push({
            id: nextUuid('12121212'),
            pharmacy_id: PHARMACY_ID,
            medication_plan_id: args.p_plan_id,
            paused_from: args.p_effective_date,
            resumed_at: null,
            reason: args.p_reason,
            created_at: new Date().toISOString(),
          });
        } else if (args.p_status !== 'paused' && openPause) {
          openPause.resumed_at = args.p_effective_date;
        }
        plan.status = args.p_status;
        plan.status_changed_at = args.p_status === 'active' ? null : args.p_effective_date;
        plan.status_change_reason = args.p_reason;
        return { data: { ok: true, planId: args.p_plan_id, status: args.p_status }, error: null };
      }

      if (fn === 'record_dispensing_with_refill') {
        const dispId = nextUuid('34343434');
        const plan = db.patient_medication_plans.find((m) => m.id === args.p_medication_plan_id);
        db.dispensing_events.push({
          id: dispId,
          pharmacy_id: PHARMACY_ID,
          patient_id: args.p_patient_id,
          medication_plan_id: args.p_medication_plan_id,
          regimen_version_number: plan?.current_version_number ?? 1,
          dispensed_quantity: args.p_dispensed_quantity,
          quantity_unit: args.p_quantity_unit,
          package_count: args.p_package_count,
          package_size: args.p_package_size,
          batch_number: args.p_batch_number,
          expiry_date: args.p_expiry_date,
          dispensing_date: args.p_dispensing_date,
          dispensed_by_staff_id: OWNER_ID,
          dispensed_by_staff_name: 'د. نور المالك',
          notes: args.p_notes,
          estimated_daily_consumption: args.p_estimated_daily_consumption,
          estimated_supply_days: args.p_estimated_supply_days,
          estimated_supply_end_date: args.p_estimated_supply_end_date,
          forecast_assumptions: args.p_forecast_assumptions,
          is_partial_fill: args.p_is_partial_fill,
          created_at: new Date().toISOString(),
        });
        db.refill_assessments = db.refill_assessments.filter(
          (r) => r.medication_plan_id !== args.p_medication_plan_id
        );
        db.refill_assessments.push({
          id: nextUuid('56565656'),
          medication_plan_id: args.p_medication_plan_id,
          refill_status: args.p_refill_status,
          estimated_supply_end_date: args.p_refill_supply_end_date,
        });
        return { data: { ok: true, dispensingEventId: dispId }, error: null };
      }

      if (fn === 'send_consultation_reply') {
        const thread = db.consultation_threads.find((t) => t.id === args.p_thread_id);
        if (!thread) return { data: null, error: { code: '42501', message: 'Not found' } };
        const msgId = nextUuid('78787878');
        db.consultation_messages.push({
          id: msgId,
          pharmacy_id: PHARMACY_ID,
          thread_id: args.p_thread_id,
          sender_type: 'pharmacist',
          sender_staff_id: OWNER_ID,
          sender_name: 'د. نور المالك',
          body: args.p_body,
          approved_by_pharmacist: true,
          sent_at: new Date().toISOString(),
        });
        if (args.p_new_status) {
          thread.status = args.p_new_status;
        }
        return { data: { ok: true, threadId: args.p_thread_id, messageId: msgId }, error: null };
      }

      return { data: null, error: { code: 'PGRST202', message: `Missing ${fn}` } };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    db,
    rpcCalls,
    directWrites,
  };
}

function makeMockAdminSupabase(options?: {
  bootstrapped?: boolean;
  raceCompleteOnFinalize?: boolean;
  deleteUserFails?: boolean;
  callerUser?: { id: string; email?: string } | null;
  staffRows?: Array<Record<string, unknown>>;
  pharmacyRows?: Array<Record<string, unknown>>;
  rpcErrorOnProvision?: { code: string; message: string } | null;
}) {
  let bootstrapped = options?.bootstrapped ?? false;
  let createdAuthSeq = 1;
  const createdUsers: string[] = [];
  const deletedUsers: string[] = [];
  const staffRows = options?.staffRows ?? [
    {
      id: OWNER_ID,
      pharmacy_id: PHARMACY_ID,
      full_name: 'د. نور المالك',
      role: 'pharmacy_owner',
      phone: '07701234567',
      syndicate_license: 'SYN-IQ-1001',
      is_active: true,
    },
    {
      id: PHARMACIST_ID,
      pharmacy_id: PHARMACY_ID,
      full_name: 'د. علي الصيدلي',
      role: 'authorized_pharmacist',
      phone: '07709998877',
      syndicate_license: 'SYN-IQ-1002',
      is_active: true,
    },
    {
      id: INACTIVE_STAFF_ID,
      pharmacy_id: PHARMACY_ID,
      full_name: 'د. موقوف',
      role: 'pharmacy_owner',
      phone: '07708887766',
      syndicate_license: 'SYN-IQ-1003',
      is_active: false,
    },
  ];
  const pharmacyRows = options?.pharmacyRows ?? [
    {
      id: PHARMACY_ID,
      is_active: true,
    },
  ];

  const client: AdminSupabaseLike = {
    auth: {
      async getUser(jwt: string) {
        if (options?.callerUser === null || jwt === 'invalid-jwt') {
          return { data: { user: null }, error: { message: 'Invalid JWT' } };
        }
        if (jwt === 'owner-jwt') {
          return { data: { user: { id: OWNER_ID, email: 'owner@alshifa.iq' } }, error: null };
        }
        if (jwt === 'pharmacist-jwt') {
          return {
            data: { user: { id: PHARMACIST_ID, email: 'pharm@alshifa.iq' } },
            error: null,
          };
        }
        if (jwt === 'inactive-jwt') {
          return {
            data: { user: { id: INACTIVE_STAFF_ID, email: 'inactive@alshifa.iq' } },
            error: null,
          };
        }
        if (jwt === 'orphan-jwt') {
          return {
            data: { user: { id: '99999999-9999-4999-8999-999999999999' } },
            error: null,
          };
        }
        return { data: { user: options?.callerUser ?? null }, error: null };
      },
      admin: {
        async createUser({ email }) {
          const uid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(createdAuthSeq++).padStart(12, '0')}`;
          createdUsers.push(uid);
          return { data: { user: { id: uid, email } }, error: null };
        },
        async deleteUser(userId: string) {
          if (options?.deleteUserFails) {
            return { data: null, error: { message: 'Auth admin unreachable' } };
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
          const run = () => {
            const rows = table === 'pharmacy_staff' ? staffRows : pharmacyRows;
            const found = rows.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null;
            return { data: found, error: null };
          };
          const chain = {
            eq(col: string, val: unknown) {
              filters.push([col, val]);
              return chain;
            },
            maybeSingle: async () => run(),
          };
          return chain;
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (fn === 'claim_first_owner_bootstrap') {
        if (bootstrapped) {
          return { data: { ok: false, errorCode: 'BOOTSTRAP_ALREADY_COMPLETED' }, error: null };
        }
        return { data: { ok: true, claimId: args.p_request_id, status: 'claimed' }, error: null };
      }
      if (fn === 'inspect_first_owner_bootstrap_state') {
        if (bootstrapped || options?.raceCompleteOnFinalize) {
          return {
            data: {
              status: 'completed',
              pharmacyId: PHARMACY_ID,
              ownerUserId: 'other-owner-uuid',
              pharmacyCount: 1,
              staffCount: 1,
            },
            error: null,
          };
        }
        return {
          data: {
            status: 'claimed',
            pharmacyId: null,
            ownerUserId: null,
            pharmacyCount: 0,
            staffCount: 0,
          },
          error: null,
        };
      }
      if (fn === 'mark_first_owner_bootstrap_reconciliation') {
        return { data: { ok: true, status: args.p_new_status }, error: null };
      }
      if (fn === 'finalize_first_owner_bootstrap') {
        if (bootstrapped || options?.raceCompleteOnFinalize) {
          return { data: { ok: false, errorCode: 'BOOTSTRAP_ALREADY_COMPLETED' }, error: null };
        }
        bootstrapped = true;
        return {
          data: { ok: true, pharmacyId: PHARMACY_ID, ownerUserId: args.p_owner_user_id },
          error: null,
        };
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
        return { data: { ok: true, status: args.p_new_status }, error: null };
      }
      if (fn === 'provision_pharmacy_staff_by_owner') {
        if (options?.rpcErrorOnProvision) {
          return { data: null, error: options.rpcErrorOnProvision };
        }
        return {
          data: {
            ok: true,
            staffId: args.p_new_user_id,
            pharmacyId: PHARMACY_ID,
            role: args.p_role,
          },
          error: null,
        };
      }
      return { data: null, error: { code: 'PGRST202', message: `Unknown ${fn}` } };
    },
  };

  return { client, createdUsers, deletedUsers };
}

async function main() {
  console.log('===================================================================');
  console.log('MASAR Care — Stage 2B.2A Backend Preparation Verification Suite');
  console.log('MODE: OFFLINE MOCKED & STATIC CHECKS ONLY (NO LIVE DB EXECUTED)');
  console.log('===================================================================');

  let passed = 0;

  // --------------------------------------------------------------------------
  // SUITE 1: All 7 Atomic Clinical RPC Integrations + Rollback Behavior
  // --------------------------------------------------------------------------
  {
    const authCtx = makePharmacistContext();
    const { client, db, directWrites } = makeSimulatedCrmClient();
    const repo = new SupabaseCrmRepository(client, authCtx);

    // 1. Atomic patient creation (phone normalized, tags persisted)
    const createdPt = await repo.addPatientAsync({
      patientCode: 'PAT-IQ-901',
      registrationDate: '2026-11-13',
      fullName: 'حيدر كريم البياتي',
      phone: '+9647705554433',
      phoneOwnerType: 'self',
      dateOfBirth: '1975-03-10',
      sex: 'male',
      chronicConditions: ['Type 2 Diabetes', 'Hypertension'],
      allergies: [{ id: 'a1', substance: 'Penicillin', severity: 'severe', reaction: 'Rash' }],
      contactPreference: 'whatsapp',
      clinicalNotes: 'Monitor HbA1c quarterly',
    });
    assert.equal(createdPt.patient.phone, '07705554433');
    assert.deepEqual(createdPt.patient.chronicConditions, ['Type 2 Diabetes', 'Hypertension']);
    assert.equal(createdPt.patient.allergies.length, 1);

    // 2. Atomic patient update + tag sync
    const updatedState = await repo.updatePatientAsync(createdPt.patient.id, {
      fullName: 'حيدر كريم البياتي (محدث)',
      chronicConditions: ['Type 2 Diabetes'],
      allergies: [],
    });
    const updatedPt = updatedState.patients.find((p) => p.id === createdPt.patient.id);
    assert.equal(updatedPt?.fullName, 'حيدر كريم البياتي (محدث)');
    assert.deepEqual(updatedPt?.chronicConditions, ['Type 2 Diabetes']);
    assert.equal(updatedPt?.allergies.length, 0);

    // 3. Atomic medication plan creation (non-UUID catalogId -> null, version 1 created)
    const addedMed = await repo.addMedicationPlanAsync({
      patientId: createdPt.patient.id,
      catalogId: 'med-cat-glucophage',
      brandName: 'Glucophage',
      genericName: 'Metformin HCl',
      strength: '500 mg',
      dosageForm: 'tablet',
      route: 'oral',
      doseAmount: 1,
      doseUnit: 'قرص',
      foodRelation: 'after_food',
      verifiedInstructions: 'قرص واحد بعد العشاء',
      startDate: '2026-11-13',
      isOngoing: true,
      schedule: {
        frequencyType: 'daily',
        timesPerDay: 1,
        doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 1 }],
        timezone: 'Asia/Baghdad',
      },
    });
    assert.equal(addedMed.plan.currentVersionNumber, 1);
    assert.equal(addedMed.plan.catalogId, undefined);
    assert.equal(addedMed.plan.regimenHistory.length, 1);

    // 4. Atomic regimen version update (closes v1, preserves history, creates v2)
    const v2State = await repo.updateMedicationPlanAsync(
      addedMed.plan.id,
      {
        patientId: createdPt.patient.id,
        brandName: 'Glucophage',
        genericName: 'Metformin HCl',
        strength: '500 mg',
        dosageForm: 'tablet',
        route: 'oral',
        doseAmount: 2,
        doseUnit: 'قرص',
        foodRelation: 'after_food',
        verifiedInstructions: 'قرص صباحاً وقرص مساءً بعد الأكل',
        startDate: '2026-11-13',
        isOngoing: true,
        schedule: {
          frequencyType: 'daily',
          timesPerDay: 2,
          doseSlots: [
            { id: 's1', time24: '08:00', doseAmount: 1 },
            { id: 's2', time24: '20:00', doseAmount: 1 },
          ],
          timezone: 'Asia/Baghdad',
        },
      },
      'Glycemic control titration',
      '2026-11-13'
    );
    const v2Plan = v2State.medicationPlans.find((m) => m.id === addedMed.plan.id);
    assert.equal(v2Plan?.currentVersionNumber, 2);
    assert.equal(v2Plan?.regimenHistory.length, 2);
    assert.equal(v2Plan?.regimenHistory[0].effectiveTo, '2026-11-13');
    assert.equal(v2Plan?.regimenHistory[1].effectiveTo, undefined);

    // 5. Atomic pause + resume period tracking
    const pausedState = await repo.changeMedicationStatusAsync(
      addedMed.plan.id,
      'paused',
      'Pre-procedure hold',
      '2026-11-14'
    );
    assert.equal(
      pausedState.medicationPlans.find((m) => m.id === addedMed.plan.id)?.pausePeriods?.length,
      1
    );
    const resumedState = await repo.changeMedicationStatusAsync(
      addedMed.plan.id,
      'active',
      'Procedure cleared',
      '2026-11-16'
    );
    const resumedPlan = resumedState.medicationPlans.find((m) => m.id === addedMed.plan.id);
    assert.equal(resumedPlan?.status, 'active');
    assert.equal(resumedPlan?.pausePeriods?.[0].resumedAt, '2026-11-16');

    // 6. Atomic dispensing with scheduleEngine forecast + refill assessment upsert
    const dispRes = await repo.recordDispensingAsync(
      {
        patientId: createdPt.patient.id,
        medicationPlanId: addedMed.plan.id,
        dispensedQuantity: 60,
        quantityUnit: 'قرص',
        dispensingDate: '2026-11-16',
        isPartialFill: false,
      },
      'en'
    );
    assert.ok(dispRes.event, 'Dispensing event must be returned after atomic reload');
    assert.equal(dispRes.event?.estimatedDailyConsumption, 2);
    assert.equal(db.refill_assessments.length, 1);
    assert.equal(db.refill_assessments[0].refill_status, 'on_track');

    // 7. Atomic consultation reply + status update
    const consultState = await repo.sendConsultationReplyAsync(
      '77777777-7777-4777-8777-777777777777',
      'Take after breakfast and dinner.',
      'resolved'
    );
    const thread = consultState.consultations.find(
      (t) => t.id === '77777777-7777-4777-8777-777777777777'
    );
    assert.equal(thread?.status, 'resolved');
    assert.equal(thread?.messages[0]?.approvedByPharmacist, true);

    assert.equal(directWrites.length, 0, 'Multi-table flows must execute zero direct table writes');

    // 8. Rollback behavior when atomic RPC throws DB error (no partial state persisted)
    const priorPatientCount = db.patients.length;
    const { client: failingClient, db: failingDb } = makeSimulatedCrmClient({
      forcedRpcError: (fn) =>
        fn === 'create_patient_with_clinical_tags'
          ? { code: '23505', message: 'duplicate key value violates unique constraint' }
          : null,
    });
    const failingRepo = new SupabaseCrmRepository(failingClient, authCtx);
    await assert.rejects(
      () =>
        failingRepo.addPatientAsync({
          patientCode: 'PAT-DUP',
          registrationDate: '2026-11-13',
          fullName: 'Duplicate Test',
          phone: '07701119999',
          phoneOwnerType: 'self',
          dateOfBirth: '1985-01-01',
          sex: 'female',
          chronicConditions: ['Asthma'],
          allergies: [],
          contactPreference: 'whatsapp',
          clinicalNotes: '',
        }),
      /Duplicate record constraint violation/i
    );
    assert.equal(failingDb.patients.length, 0);
    assert.equal(failingDb.patient_conditions.length, 0);
    assert.equal(db.patients.length, priorPatientCount);

    passed++;
    console.log('✓ Suite 1: All 7 atomic clinical RPCs & rollback integrity verified (mocked)');
  }

  // --------------------------------------------------------------------------
  // SUITE 2: Cross-Pharmacy Rejection, Inactive Staff & Missing RPC Boundaries
  // --------------------------------------------------------------------------
  {
    const authCtx = makePharmacistContext();
    const { client: rlsDenyClient } = makeSimulatedCrmClient({
      forcedRpcError: () => ({
        code: '42501',
        message: 'Patient belongs to another pharmacy or caller staff is inactive.',
      }),
    });
    const rlsDenyRepo = new SupabaseCrmRepository(rlsDenyClient, authCtx);

    await assert.rejects(
      () =>
        rlsDenyRepo.updatePatientAsync('99999999-9999-4999-8999-999999999999', {
          fullName: 'Cross Tenant Attempt',
        }),
      /Permission or tenant RLS policy denied/i
    );
    await assert.rejects(
      () =>
        rlsDenyRepo.changeMedicationStatusAsync(
          '99999999-9999-4999-8999-999999999999',
          'paused',
          'Cross tenant attempt'
        ),
      /Permission or tenant RLS policy denied/i
    );

    const { client: missingRpcClient } = makeSimulatedCrmClient({
      forcedRpcError: (fn) => ({
        code: '42883',
        message: `function public.${fn} does not exist`,
      }),
    });
    const missingRpcRepo = new SupabaseCrmRepository(missingRpcClient, authCtx);
    await assert.rejects(
      () => missingRpcRepo.sendConsultationReplyAsync('77777777-7777-4777-8777-777777777777', 'Hi'),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError &&
        err.dependencyKey === 'atomicConsultationReplyRpc'
    );
    await assert.rejects(
      () => missingRpcRepo.issueInvitationAsync('88888888-8888-4888-8888-888888888888', 'dob_and_phone_otp'),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError &&
        err.dependencyKey === 'patientActivationStage2c'
    );

    passed++;
    console.log('✓ Suite 2: Cross-pharmacy 42501 denial & missing-RPC fail-closed boundaries verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 3: bootstrap-first-owner Security, Replay Lockout & Race Rollback
  // --------------------------------------------------------------------------
  {
    const bootstrapSecret = 'test-only-bootstrap-token-32-chars-minimum-01';
    const adminSecret = 'test-only-platform-admin-token-32-chars-min-02';
    const validPayload = {
      pharmacy: {
        nameAr: 'صيدلية السلام',
        nameEn: 'Al-Salam Pharmacy',
        city: 'بغداد',
        governorate: 'بغداد',
        licenseNumber: 'IQ-BGD-900',
        phone: '+9647701234567',
      },
      owner: {
        email: 'owner@alsalam.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. سارة أحمد',
        phone: '07711223344',
        syndicateLicense: 'SYN-900',
      },
    };

    // 1. Disabled when MASAR_BOOTSTRAP_TOKEN missing or too short
    const disabledMock = makeMockAdminSupabase();
    const disabledRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: `Bearer ${adminSecret}`,
      }),
      rawBody: validPayload,
      env: { bootstrapToken: '', platformAdminToken: adminSecret },
      adminClient: disabledMock.client,
    });
    assert.equal(disabledRes.status, 503);
    assert.equal(disabledRes.body.errorCode, 'BOOTSTRAP_DISABLED');

    // 2. Unauthorized without matching bootstrap token or admin bearer
    const badTokenRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': 'wrong-token',
        authorization: `Bearer ${adminSecret}`,
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: disabledMock.client,
    });
    assert.equal(badTokenRes.status, 401);
    assert.equal(badTokenRes.body.errorCode, 'UNAUTHORIZED_BOOTSTRAP_TOKEN');

    const badAdminRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: new Headers({
        'x-masar-bootstrap-token': bootstrapSecret,
        authorization: 'Bearer wrong-admin-bearer',
      }),
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: disabledMock.client,
    });
    assert.equal(badAdminRes.status, 401);
    assert.equal(badAdminRes.body.errorCode, 'UNAUTHORIZED_PLATFORM_ADMIN');

    // 3. First bootstrap succeeds; second replay is rejected before Auth creation
    const bootMock = makeMockAdminSupabase();
    const authHeaders = new Headers({
      'x-masar-bootstrap-token': bootstrapSecret,
      authorization: `Bearer ${adminSecret}`,
      'idempotency-key': 'idem-key-stage2b2a-bootstrap-0001',
    });
    const firstRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: authHeaders,
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: bootMock.client,
    });
    assert.equal(firstRes.status, 201);
    assert.equal(firstRes.body.ok, true);
    assert.equal(bootMock.createdUsers.length, 1);

    const replayRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: authHeaders,
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: bootMock.client,
    });
    assert.equal(replayRes.status, 409);
    assert.equal(replayRes.body.errorCode, 'BOOTSTRAP_ALREADY_COMPLETED');
    assert.equal(bootMock.createdUsers.length, 1, 'Replay must not create a second Auth user');

    // 4. Concurrent race during finalize rolls back orphan Auth user cleanly
    const raceMock = makeMockAdminSupabase({ raceCompleteOnFinalize: true });
    const raceRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: authHeaders,
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: raceMock.client,
    });
    assert.equal(raceRes.status, 409);
    assert.equal(raceMock.createdUsers.length, 1);
    assert.deepEqual(
      raceMock.deletedUsers,
      raceMock.createdUsers,
      'Compensating Auth deleteUser must roll back orphan user when finalize loses bootstrap race'
    );

    // 5. Rollback failure surfaces explicit RECONCILIATION_REQUIRED
    const brokenRollbackMock = makeMockAdminSupabase({
      raceCompleteOnFinalize: true,
      deleteUserFails: true,
    });
    const brokenRes = await handleBootstrapFirstOwner({
      method: 'POST',
      headers: authHeaders,
      rawBody: validPayload,
      env: { bootstrapToken: bootstrapSecret, platformAdminToken: adminSecret },
      adminClient: brokenRollbackMock.client,
    });
    assert.equal(brokenRes.status, 500);
    assert.equal(brokenRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.ok(brokenRes.body.orphanAuthUserId);

    passed++;
    console.log('✓ Suite 3: bootstrap-first-owner replay lock & Auth rollback verified (mocked)');
  }

  // --------------------------------------------------------------------------
  // SUITE 4: owner-provision-staff RBAC, Cross-Pharmacy & Duplicate Rollback
  // --------------------------------------------------------------------------
  {
    const staffPayload = {
      email: 'new.pharmacist@alshifa.iq',
      password: 'StaffPassword2026!',
      fullName: 'د. زينب جاسم',
      phone: '+9647704445566',
      role: 'authorized_pharmacist',
      syndicateLicense: 'SYN-IQ-2009',
    };

    const mock = makeMockAdminSupabase();

    // 1. Rejects missing/invalid JWT
    const noJwtRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers(),
      rawBody: staffPayload,
      adminClient: mock.client,
    });
    assert.equal(noJwtRes.status, 401);

    // 2. Rejects authorized_pharmacist (non-owner)
    const nonOwnerRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer pharmacist-jwt' }),
      rawBody: staffPayload,
      adminClient: mock.client,
    });
    assert.equal(nonOwnerRes.status, 403);
    assert.equal(nonOwnerRes.body.errorCode, 'OWNER_ROLE_REQUIRED');

    // 3. Rejects inactive staff account
    const inactiveRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer inactive-jwt' }),
      rawBody: staffPayload,
      adminClient: mock.client,
    });
    assert.equal(inactiveRes.status, 403);
    assert.equal(inactiveRes.body.errorCode, 'CALLER_STAFF_INACTIVE');

    // 4. Rejects user absent from pharmacy_staff
    const orphanCallerRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer orphan-jwt' }),
      rawBody: staffPayload,
      adminClient: mock.client,
    });
    assert.equal(orphanCallerRes.status, 403);
    assert.equal(orphanCallerRes.body.errorCode, 'CALLER_NOT_PHARMACY_STAFF');

    // 5. Rejects inactive pharmacy
    const inactivePhMock = makeMockAdminSupabase({
      pharmacyRows: [{ id: PHARMACY_ID, is_active: false }],
    });
    const inactivePhRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-staff-inactive-ph-0001',
      }),
      rawBody: staffPayload,
      adminClient: inactivePhMock.client,
    });
    assert.equal(inactivePhRes.status, 403);
    assert.equal(inactivePhRes.body.errorCode, 'PHARMACY_INACTIVE');

    // 6. Rejects cross-pharmacy target pharmacyId
    const crossPharmRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-staff-cross-ph-0002',
      }),
      rawBody: { ...staffPayload, pharmacyId: '99999999-9999-4999-8999-999999999999' },
      adminClient: mock.client,
    });
    assert.equal(crossPharmRes.status, 403);
    assert.equal(crossPharmRes.body.errorCode, 'CROSS_PHARMACY_FORBIDDEN');

    // 7. Duplicate phone pre-check blocks before Auth creation
    const dupPhoneRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-staff-dup-phone-0003',
      }),
      rawBody: { ...staffPayload, phone: '07709998877' },
      adminClient: mock.client,
    });
    assert.equal(dupPhoneRes.status, 409);
    assert.equal(dupPhoneRes.body.errorCode, 'DUPLICATE_STAFF_RECORD');
    assert.equal(mock.createdUsers.length, 0);

    // 8. Concurrent DB 23505 failure triggers compensating Auth deleteUser rollback
    const dupRaceMock = makeMockAdminSupabase({
      rpcErrorOnProvision: { code: '23505', message: 'duplicate key pharmacy_staff_phone_key' },
    });
    const dupRaceRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-staff-dup-race-0004',
      }),
      rawBody: staffPayload,
      adminClient: dupRaceMock.client,
    });
    assert.equal(dupRaceRes.status, 409);
    assert.equal(dupRaceRes.body.errorCode, 'DUPLICATE_STAFF_RECORD');
    assert.deepEqual(dupRaceMock.deletedUsers, dupRaceMock.createdUsers);

    // 9. Valid owner provisioning succeeds with owner's authoritative pharmacy_id
    const okRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-staff-valid-ok-0005',
      }),
      rawBody: staffPayload,
      adminClient: mock.client,
    });
    assert.equal(okRes.status, 201);
    assert.equal(okRes.body.ok, true);
    assert.equal(okRes.body.pharmacyId, PHARMACY_ID);
    assert.equal(okRes.body.role, 'authorized_pharmacist');

    passed++;
    console.log('✓ Suite 4: owner-provision-staff RBAC, cross-tenant block & rollback verified (mocked)');
  }

  // --------------------------------------------------------------------------
  // SUITE 5: Static SQL Provenance, Privilege Hardening & Zero Hardcoded Secrets
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    const sql0003 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );
    const edgeLogic = fs.readFileSync(
      path.join(root, 'supabase/functions/_shared/adminProvisioningLogic.ts'),
      'utf8'
    );
    const bootFn = fs.readFileSync(
      path.join(root, 'supabase/functions/bootstrap-first-owner/index.ts'),
      'utf8'
    );
    const staffFn = fs.readFileSync(
      path.join(root, 'supabase/functions/owner-provision-staff/index.ts'),
      'utf8'
    );

    const requiredFunctions = [
      'require_active_pharmacist_context',
      'normalize_clinical_unit_category',
      'compute_plan_daily_rate',
      'compute_staff_provisioning_fingerprint',
      'claim_first_owner_bootstrap',
      'inspect_first_owner_bootstrap_state',
      'mark_first_owner_bootstrap_reconciliation',
      'finalize_first_owner_bootstrap',
      'claim_staff_provisioning_request',
      'inspect_staff_provisioning_state',
      'mark_staff_provisioning_reconciliation',
      'reconcile_expired_staff_provisioning_claim',
      'provision_pharmacy_staff_by_owner',
      'create_patient_with_clinical_tags',
      'update_patient_with_clinical_tags',
      'create_medication_plan_with_version',
      'update_medication_plan_version',
      'change_medication_plan_status',
      'record_dispensing_with_refill',
      'send_consultation_reply',
      'revoke_patient_apk_invitation',
      'write_clinical_audit_log',
    ];
    for (const fn of requiredFunctions) {
      assert.equal(sql0003.includes(fn), true, `Migration 0003 must define ${fn}`);
    }

    assert.equal(sql0003.includes('BEGIN;'), true, 'Migration 0003 must execute in an explicit transaction');
    assert.equal(sql0003.includes('COMMIT;'), true, 'Migration 0003 must end with COMMIT;');

    // All SECURITY DEFINER functions (19) plus IMMUTABLE helpers (3) = 22 total must pin minimal search_path = pg_catalog, pg_temp
    const secDefCount = (sql0003.match(/^SECURITY DEFINER\s*$/gm) ?? []).length;
    const pairedSecDefCount = (
      sql0003.match(/^SECURITY DEFINER\r?\nSET search_path = pg_catalog, pg_temp\s*$/gm) ?? []
    ).length;
    const pinnedSearchPathCount = (
      sql0003.match(/^SET search_path = pg_catalog, pg_temp\s*$/gm) ?? []
    ).length;
    assert.equal(secDefCount, 19, 'Expected 19 SECURITY DEFINER functions in Migration 0003');
    assert.equal(
      pairedSecDefCount,
      secDefCount,
      'Every SECURITY DEFINER function in 0003 must pin SET search_path = pg_catalog, pg_temp'
    );
    assert.equal(pinnedSearchPathCount, 22, 'Expected all 22 functions (19 SECURITY DEFINER + 3 IMMUTABLE helpers) in 0003 to pin search_path');

    // Every client-facing clinical RPC must record an audit_logs entry server-side
    const auditInserts = (sql0003.match(/INSERT INTO public\.audit_logs/g) ?? []).length;
    assert.ok(auditInserts >= 10, 'Expected server-side audit_logs inserts across bootstrap, staff, 7 clinical RPCs, and trigger');

    // service_role-only RPCs must revoke anon & authenticated
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.claim_first_owner_bootstrap(text, uuid, integer) FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.inspect_first_owner_bootstrap_state() FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.mark_first_owner_bootstrap_reconciliation(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.finalize_first_owner_bootstrap('),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION app_security.compute_staff_provisioning_fingerprint('),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.claim_staff_provisioning_request('),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.inspect_staff_provisioning_state(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.mark_staff_provisioning_reconciliation(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.reconcile_expired_staff_provisioning_claim('),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE ALL ON FUNCTION public.provision_pharmacy_staff_by_owner('),
      true
    );

    // Zero hardcoded secrets or service-role keys in code/SQL
    for (const content of [sql0003, edgeLogic, bootFn, staffFn]) {
      assert.equal(/sb_secret_[A-Za-z0-9_]+/.test(content), false);
      assert.equal(/eyJhbGciOiJIUzI1Ni/.test(content), false);
    }

    // Connected Mode remains disabled by default in .env.example
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert.equal(envExample.includes('VITE_ENABLE_SUPABASE_CRM="false"'), true);

    passed++;
    console.log('✓ Suite 5: Migration 0003 SQL provenance, search_path & secret-hygiene checks passed');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.2A OFFLINE/MOCKED SUITES PASSED`);
  console.log('NOT EXECUTED (Awaiting Stage 2B.2 Approval):');
  console.log('  - Live PostgreSQL execution of 0003_stage2b_atomic_crm_and_bootstrap.sql');
  console.log('  - Live Edge Function deployment (bootstrap-first-owner / owner-provision-staff)');
  console.log('  - Live multi-pharmacy authenticated RLS & audit trigger verification');
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.2A preparation verification suite failed:', err);
  process.exit(1);
});
