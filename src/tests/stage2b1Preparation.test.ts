import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AuthenticatedPharmacistContext,
  getBilingualAuthErrorMessage,
  resolveAuthoritativePharmacistSession,
  signInPharmacistWithPassword,
  SupabaseAuthLike,
} from '../services/authService';
import {
  getSupabaseClient,
  getSupabaseConfigStatus,
  isConnectedModeEnabled,
  isForbiddenSecretKey,
  resetSupabaseClientForTests,
} from '../services/supabaseClient';
import {
  buildSafePatientUpdatePatch,
  createEmptyConnectedCrmState,
  PATIENT_APK_INVITATION_SELECT_COLUMNS,
  STAGE2B_SQL_DEPENDENCIES,
  Stage2bSqlDependencyError,
  SupabaseCrmRepository,
  toOptionalUuid,
} from '../services/supabaseCrmRepository';

function makeFakeJwtWithRole(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase', ref: 'test' })).toString(
    'base64url'
  );
  return `${header}.${payload}.fakesig`;
}

function buildMockAuthClient(options: {
  staffRow?: Record<string, unknown> | null;
  staffError?: { message: string } | null;
  pharmacyRow?: Record<string, unknown> | null;
  pharmacyError?: { message: string } | null;
  signInUser?: { id: string; email?: string } | null;
  signInError?: { message: string } | null;
  onSignOut?: () => void;
}): SupabaseAuthLike {
  return {
    auth: {
      async getSession() {
        return { data: { session: null }, error: null };
      },
      async signInWithPassword() {
        if (options.signInError || !options.signInUser) {
          return {
            data: { user: null, session: null },
            error: options.signInError ?? { message: 'Invalid login credentials' },
          };
        }
        return {
          data: {
            user: options.signInUser as never,
            session: { user: options.signInUser } as never,
          },
          error: null,
        };
      },
      async signOut() {
        options.onSignOut?.();
        return { error: null };
      },
    },
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (table === 'pharmacy_staff') {
                    return {
                      data: options.staffRow ?? null,
                      error: options.staffError ?? null,
                    };
                  }
                  if (table === 'pharmacies') {
                    return {
                      data: options.pharmacyRow ?? null,
                      error: options.pharmacyError ?? null,
                    };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
  selectColumns?: string;
  payload?: unknown;
  filters?: Array<{ type: string; col: string; val: unknown }>;
}

function buildMockDbClient(handlers?: {
  onCall?: (call: RecordedCall) => void;
  tableData?: Record<string, unknown[]>;
  rpcResponder?: (fn: string, args: unknown) => { data: unknown; error: unknown };
  errorOnOp?: (call: RecordedCall) => { message: string; code?: string } | null;
}): { client: SupabaseClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const defaultRows: Record<string, unknown[]> = {
    pharmacies: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name_ar: 'صيدلية الاختبار',
        name_en: 'Test Pharmacy',
        city: 'بغداد',
        governorate: 'بغداد',
        license_number: 'IQ-TEST-01',
        phone: '07700000001',
        timezone: 'Asia/Baghdad',
        is_active: true,
      },
    ],
    pharmacy_staff: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        pharmacy_id: '11111111-1111-4111-8111-111111111111',
        full_name: 'د. صيدلي اختبار',
        role: 'pharmacy_owner',
        syndicate_license: 'SYN-99',
        phone: '07700000002',
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
    dose_events: [],
    lab_results: [],
    follow_up_tasks: [],
    follow_up_contact_logs: [],
    consultation_threads: [],
    consultation_messages: [],
    patient_apk_invitations: [],
    audit_logs: [],
    ...(handlers?.tableData ?? {}),
  };

  function makeQueryBuilder(
    table: string,
    op: RecordedCall['op'],
    selectColumns?: string,
    payload?: unknown
  ) {
    const filters: Array<{ type: string; col: string; val: unknown }> = [];
    let isSingle = false;
    let isMaybeSingle = false;
    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;

    const finalize = (): { data: unknown; error: { message: string; code?: string } | null } => {
      const call: RecordedCall = { table, op, selectColumns, payload, filters };
      calls.push(call);
      handlers?.onCall?.(call);
      const forcedErr = handlers?.errorOnOp?.(call);
      if (forcedErr) {
        return { data: null, error: forcedErr };
      }

      if (op === 'select') {
        const rows = defaultRows[table] ?? [];
        if (isSingle || isMaybeSingle) {
          return { data: rows[0] ?? null, error: null };
        }
        const sliced =
          rangeStart !== null && rangeEnd !== null ? rows.slice(rangeStart, rangeEnd + 1) : rows;
        return { data: sliced, error: null };
      }
      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select(cols: string) {
        selectColumns = cols;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ type: 'eq', col, val });
        return builder;
      },
      in(col: string, val: unknown) {
        filters.push({ type: 'in', col, val });
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push({ type: 'is', col, val });
        return builder;
      },
      order() {
        return builder;
      },
      range(from: number, to: number) {
        rangeStart = from;
        rangeEnd = to;
        return builder;
      },
      single() {
        isSingle = true;
        return Promise.resolve(finalize());
      },
      maybeSingle() {
        isMaybeSingle = true;
        return Promise.resolve(finalize());
      },
      then(onFulfilled: (val: unknown) => unknown, onRejected?: (err: unknown) => unknown) {
        return Promise.resolve(finalize()).then(onFulfilled, onRejected);
      },
    };

    return builder;
  }

  const fakeClient = {
    from(table: string) {
      return {
        select(cols: string) {
          return makeQueryBuilder(table, 'select', cols);
        },
        insert(payload: unknown) {
          return makeQueryBuilder(table, 'insert', undefined, payload);
        },
        update(payload: unknown) {
          return makeQueryBuilder(table, 'update', undefined, payload);
        },
        upsert(payload: unknown) {
          return makeQueryBuilder(table, 'upsert', undefined, payload);
        },
        delete() {
          return makeQueryBuilder(table, 'delete');
        },
      };
    },
    async rpc(fn: string, args: unknown) {
      const call: RecordedCall = { table: fn, op: 'rpc', payload: args };
      calls.push(call);
      handlers?.onCall?.(call);
      if (handlers?.rpcResponder) {
        return handlers.rpcResponder(fn, args);
      }
      return { data: null, error: { code: 'PGRST202', message: `Could not find ${fn}` } };
    },
  };

  return { client: fakeClient as unknown as SupabaseClient, calls };
}

async function main() {
  console.log('===================================================================');
  console.log('MASAR Care — Stage 2B.1 Preparation & Security Boundary Unit Suite');
  console.log('===================================================================');

  let passed = 0;

  // --------------------------------------------------------------------------
  // SUITE 1: supabaseClient config defaults & browser secret-key blocker
  // --------------------------------------------------------------------------
  {
    resetSupabaseClientForTests();

    assert.equal(isConnectedModeEnabled({}), false, 'Default Connected Mode must be OFF');
    assert.equal(
      isConnectedModeEnabled({ VITE_ENABLE_SUPABASE_CRM: 'false' }),
      false,
      'Explicit false must keep Demo Mode active'
    );
    assert.equal(
      isConnectedModeEnabled({ VITE_ENABLE_SUPABASE_CRM: 'true' }),
      true,
      'Explicit true enables Connected Mode'
    );

    const disabledStatus = getSupabaseConfigStatus({});
    assert.equal(disabledStatus.connectedModeEnabled, false);
    assert.equal(disabledStatus.isConfigured, false);
    assert.equal(disabledStatus.errorCode, 'CONNECTED_MODE_DISABLED');
    assert.throws(() => getSupabaseClient({}), /disabled/i);

    const missingUrlStatus = getSupabaseConfigStatus({
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe_key',
    });
    assert.equal(missingUrlStatus.errorCode, 'MISSING_SUPABASE_URL');
    assert.equal(missingUrlStatus.isConfigured, false);

    const invalidUrlStatus = getSupabaseConfigStatus({
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'http://remote-insecure.example.com',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_safe_key',
    });
    assert.equal(invalidUrlStatus.errorCode, 'INVALID_SUPABASE_URL');

    const secretKeyStatus = getSupabaseConfigStatus({
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_MUST_BE_BLOCKED_IN_BROWSER',
    });
    assert.equal(secretKeyStatus.errorCode, 'FORBIDDEN_SECRET_KEY');
    assert.equal(secretKeyStatus.isConfigured, false);
    assert.equal(
      secretKeyStatus.errorMessage?.includes('MUST_BE_BLOCKED'),
      false,
      'Error message must never echo secret key content'
    );

    const serviceRoleJwt = makeFakeJwtWithRole('service_role');
    assert.equal(isForbiddenSecretKey(serviceRoleJwt), true);
    const serviceJwtStatus = getSupabaseConfigStatus({
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt,
    });
    assert.equal(serviceJwtStatus.errorCode, 'FORBIDDEN_SECRET_KEY');

    const anonJwt = makeFakeJwtWithRole('anon');
    assert.equal(isForbiddenSecretKey(anonJwt), false);
    assert.equal(isForbiddenSecretKey('sb_publishable_demo123'), false);

    const validStatus = getSupabaseConfigStatus({
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo123',
    });
    assert.equal(validStatus.isConfigured, true);
    assert.equal(validStatus.urlHost, 'example.supabase.co');
    assert.equal(validStatus.errorCode, null);

    passed++;
    console.log('✓ Suite 1: supabaseClient default-OFF guard & secret-key blocker verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 2: Authoritative Pharmacist Session Resolution (Zero Metadata Trust)
  // --------------------------------------------------------------------------
  {
    const pharmacyRow = {
      id: '11111111-1111-4111-8111-111111111111',
      name_ar: 'صيدلية الشفاء',
      name_en: 'Al-Shifa Pharmacy',
      city: 'بغداد',
      governorate: 'بغداد',
      license_number: 'LIC-01',
      phone: '07701112233',
      timezone: 'Asia/Baghdad',
      is_active: true,
    };

    const ownerClient = buildMockAuthClient({
      staffRow: {
        id: 'u-owner',
        pharmacy_id: pharmacyRow.id,
        full_name: 'د. نور المالك',
        role: 'pharmacy_owner',
        syndicate_license: 'SY-10',
        phone: '07701234567',
        is_active: true,
      },
      pharmacyRow,
    });

    // Even if user object carries spoofed metadata claims, resolution uses DB rows only
    const spoofedUser = {
      id: 'u-owner',
      email: 'owner@example.com',
      user_metadata: { pharmacy_id: '99999999-9999-4999-8999-999999999999', role: 'admin' },
      app_metadata: { pharmacy_id: '99999999-9999-4999-8999-999999999999' },
    } as never;

    const okOwner = await resolveAuthoritativePharmacistSession(ownerClient, spoofedUser);
    assert.equal(okOwner.ok, true);
    if (okOwner.ok) {
      assert.equal(okOwner.context.pharmacyId, pharmacyRow.id);
      assert.equal(okOwner.context.role, 'pharmacy_owner');
    }

    // Active authorized_pharmacist succeeds
    const pharmClient = buildMockAuthClient({
      staffRow: {
        id: 'u-pharm',
        pharmacy_id: pharmacyRow.id,
        full_name: 'د. علي الصيدلي',
        role: 'authorized_pharmacist',
        syndicate_license: null,
        phone: '07709998877',
        is_active: true,
      },
      pharmacyRow,
    });
    const okPharm = await resolveAuthoritativePharmacistSession(pharmClient, {
      id: 'u-pharm',
      email: 'pharm@example.com',
    });
    assert.equal(okPharm.ok, true);

    // Unlinked / patient account (missing pharmacy_staff row) rejected and signed out on login
    let signedOutCount = 0;
    const patientClient = buildMockAuthClient({
      staffRow: null,
      signInUser: { id: 'u-patient', email: 'patient@example.com' },
      onSignOut: () => {
        signedOutCount++;
      },
    });
    const patientLoginRes = await signInPharmacistWithPassword(
      patientClient,
      'patient@example.com',
      'Secret123!'
    );
    assert.equal(patientLoginRes.ok, false);
    if (!patientLoginRes.ok) {
      assert.equal(patientLoginRes.errorCode, 'UNAUTHORIZED_STAFF_NOT_FOUND');
      assert.equal(patientLoginRes.hasAuthSession, false);
    }
    assert.equal(signedOutCount, 1, 'Unauthorized user session must be immediately signed out');

    // Inactive staff rejected
    const inactiveStaffRes = await resolveAuthoritativePharmacistSession(
      buildMockAuthClient({
        staffRow: {
          id: 'u-off',
          pharmacy_id: pharmacyRow.id,
          full_name: 'معطل',
          role: 'authorized_pharmacist',
          syndicate_license: null,
          phone: '07700000000',
          is_active: false,
        },
        pharmacyRow,
      }),
      { id: 'u-off', email: 'off@example.com' }
    );
    assert.equal(inactiveStaffRes.ok, false);
    if (!inactiveStaffRes.ok) assert.equal(inactiveStaffRes.errorCode, 'STAFF_INACTIVE');

    // Inactive pharmacy rejected
    const inactivePharmRes = await resolveAuthoritativePharmacistSession(
      buildMockAuthClient({
        staffRow: {
          id: 'u-owner',
          pharmacy_id: pharmacyRow.id,
          full_name: 'د. نور',
          role: 'pharmacy_owner',
          syndicate_license: null,
          phone: '07700000000',
          is_active: true,
        },
        pharmacyRow: { ...pharmacyRow, is_active: false },
      }),
      { id: 'u-owner', email: 'owner@example.com' }
    );
    assert.equal(inactivePharmRes.ok, false);
    if (!inactivePharmRes.ok) assert.equal(inactivePharmRes.errorCode, 'PHARMACY_INACTIVE');

    // Unexpected role rejected
    const badRoleRes = await resolveAuthoritativePharmacistSession(
      buildMockAuthClient({
        staffRow: {
          id: 'u-badrole',
          pharmacy_id: pharmacyRow.id,
          full_name: 'دور غير مخول',
          role: 'patient',
          syndicate_license: null,
          phone: '07700000000',
          is_active: true,
        },
        pharmacyRow,
      }),
      { id: 'u-badrole', email: 'bad@example.com' }
    );
    assert.equal(badRoleRes.ok, false);
    if (!badRoleRes.ok) assert.equal(badRoleRes.errorCode, 'ROLE_NOT_AUTHORIZED');

    // Invalid login credentials
    const badLoginRes = await signInPharmacistWithPassword(
      buildMockAuthClient({ signInError: { message: 'Invalid login credentials' } }),
      'wrong@example.com',
      'badpass'
    );
    assert.equal(badLoginRes.ok, false);
    if (!badLoginRes.ok) assert.equal(badLoginRes.errorCode, 'INVALID_CREDENTIALS');

    assert.ok(getBilingualAuthErrorMessage('UNAUTHORIZED_STAFF_NOT_FOUND', 'ar').length > 10);
    assert.ok(getBilingualAuthErrorMessage('STAFF_INACTIVE', 'en').length > 10);

    passed++;
    console.log('✓ Suite 2: Authoritative pharmacist session resolution & denial paths verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 3: SupabaseCrmRepository 0002 Grant Compliance & Dependency Boundaries
  // --------------------------------------------------------------------------
  {
    const authContext: AuthenticatedPharmacistContext = {
      userId: '22222222-2222-4222-8222-222222222222',
      email: 'owner@testpharmacy.iq',
      pharmacyId: '11111111-1111-4111-8111-111111111111',
      role: 'pharmacy_owner',
      staff: {
        id: '22222222-2222-4222-8222-222222222222',
        pharmacyId: '11111111-1111-4111-8111-111111111111',
        fullName: 'د. صيدلي اختبار',
        role: 'pharmacy_owner',
        phone: '07700000002',
        isActive: true,
      },
      pharmacy: {
        id: '11111111-1111-4111-8111-111111111111',
        nameAr: 'صيدلية الاختبار',
        nameEn: 'Test Pharmacy',
        city: 'بغداد',
        governorate: 'بغداد',
        licenseNumber: 'IQ-TEST-01',
        phone: '07700000001',
        timezone: 'Asia/Baghdad',
      },
    };

    const { client, calls } = buildMockDbClient({
      tableData: {
        patient_medication_plans: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            pharmacy_id: authContext.pharmacyId,
            patient_id: '44444444-4444-4444-8444-444444444444',
            catalog_id: null,
            brand_name: 'Glucophage',
            generic_name: 'Metformin HCl',
            strength: '500 mg',
            dosage_form: 'tablet',
            route: 'oral',
            dose_amount: 1,
            dose_unit: 'قرص',
            food_relation: 'after_food',
            verified_instructions: 'قرص واحد بعد العشاء',
            prescriber_name: null,
            prescriber_specialty: null,
            start_date: '2026-11-12',
            end_date: null,
            is_ongoing: true,
            duration_days: null,
            status: 'active',
            status_changed_at: null,
            status_change_reason: null,
            current_version_number: 1,
            schedule: {
              frequencyType: 'daily',
              timesPerDay: 1,
              doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 1 }],
              timezone: 'Asia/Baghdad',
            },
            created_at: '2026-11-12T10:00:00Z',
            updated_at: '2026-11-12T10:00:00Z',
          },
        ],
        regimen_versions: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            pharmacy_id: authContext.pharmacyId,
            medication_plan_id: '33333333-3333-4333-8333-333333333333',
            version_number: 1,
            effective_from: '2026-11-12',
            effective_to: null,
            dose_amount: 1,
            dose_unit: 'قرص',
            food_relation: 'after_food',
            verified_instructions: 'قرص واحد بعد العشاء',
            schedule: {
              frequencyType: 'daily',
              timesPerDay: 1,
              doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 1 }],
              timezone: 'Asia/Baghdad',
            },
            changed_by_staff_name: 'د. صيدلي اختبار',
            change_reason: 'Initial',
            created_at: '2026-11-12T10:00:00Z',
          },
        ],
      },
    });

    const repo = new SupabaseCrmRepository(client, authContext);

    // 1. Forbidden Demo actions throw explicitly
    await assert.rejects(() => repo.resetAsync(), /forbidden/i);
    await assert.rejects(() => repo.setActiveStaffAsync('any'), /forbidden/i);

    // 2. getStateAsync queries patient_apk_invitations using non-secret column projection
    const loadedState = await repo.getStateAsync();
    assert.equal(loadedState.pharmacy.id, authContext.pharmacyId);
    assert.equal(loadedState.activeStaffId, authContext.userId);
    const invSelectCall = calls.find(
      (c) => c.table === 'patient_apk_invitations' && c.op === 'select'
    );
    assert.ok(invSelectCall, 'patient_apk_invitations must be queried');
    assert.equal(invSelectCall.selectColumns, PATIENT_APK_INVITATION_SELECT_COLUMNS);
    assert.equal(invSelectCall.selectColumns?.includes('*'), false);
    assert.equal(invSelectCall.selectColumns?.includes('token_hash'), false);
    assert.equal(invSelectCall.selectColumns?.includes('pharmacist_pin_hash'), false);
    assert.equal(invSelectCall.selectColumns?.includes('sms_otp_hash'), false);

    // 3. buildSafePatientUpdatePatch respects 0002 column-level UPDATE restrictions
    //    and updatePatientAsync rejects before issuing any partial DB write
    const patPatch = buildSafePatientUpdatePatch({
      patientCode: 'SHOULD_NOT_BE_SENT',
      registrationDate: '2020-01-01',
      fullName: 'اسم محدث',
      phone: '07701234567',
    });
    assert.equal('patient_code' in patPatch, false, 'Must never update restricted patient_code');
    assert.equal(
      'registration_date' in patPatch,
      false,
      'Must never update restricted registration_date'
    );
    assert.equal('pharmacy_id' in patPatch, false, 'Must never update pharmacy_id');
    assert.equal('auth_user_id' in patPatch, false, 'Must never update auth_user_id');
    assert.equal(patPatch.full_name, 'اسم محدث');

    calls.length = 0;
    await assert.rejects(
      () =>
        repo.updatePatientAsync('44444444-4444-4444-8444-444444444444', {
          fullName: 'اسم محدث',
          phone: '07701234567',
        }),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError && err.dependencyKey === 'atomicPatientWriteRpc'
    );
    assert.equal(
      calls.filter((c) => c.op !== 'rpc' && c.op !== 'select').length,
      0,
      'Guarded updatePatientAsync must issue zero direct partial table writes'
    );
    assert.equal(
      calls.some((c) => c.op === 'rpc' && c.table === 'update_patient_with_clinical_tags'),
      true,
      'updatePatientAsync must invoke update_patient_with_clinical_tags RPC'
    );

    // 4. toOptionalUuid sanitizes non-UUID catalogId ('med-cat-1' -> null), while multi-table
    //    medication/dispensing/consultation/activation writes reject atomically with 0 partial writes
    assert.equal(toOptionalUuid('med-cat-1'), null);
    assert.equal(
      toOptionalUuid('33333333-3333-4333-8333-333333333333'),
      '33333333-3333-4333-8333-333333333333'
    );

    calls.length = 0;
    await assert.rejects(
      () =>
        repo.addMedicationPlanAsync({
          patientId: '44444444-4444-4444-8444-444444444444',
          catalogId: 'med-cat-1',
          brandName: 'Glucophage',
          genericName: 'Metformin HCl',
          strength: '500 mg',
          dosageForm: 'tablet',
          route: 'oral',
          doseAmount: 1,
          doseUnit: 'قرص',
          foodRelation: 'after_food',
          verifiedInstructions: 'قرص بعد العشاء يومياً',
          startDate: '2026-11-13',
          isOngoing: true,
          schedule: {
            frequencyType: 'daily',
            timesPerDay: 1,
            doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 1 }],
            timezone: 'Asia/Baghdad',
          },
        }),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError && err.dependencyKey === 'atomicMedicationPlanRpc'
    );
    await assert.rejects(
      () =>
        repo.updateMedicationPlanAsync(
          '33333333-3333-4333-8333-333333333333',
          {
            patientId: '44444444-4444-4444-8444-444444444444',
            brandName: 'Glucophage',
            genericName: 'Metformin HCl',
            strength: '500 mg',
            dosageForm: 'tablet',
            route: 'oral',
            doseAmount: 2,
            doseUnit: 'قرص',
            foodRelation: 'after_food',
            verifiedInstructions: 'قرصان يومياً بعد العشاء',
            startDate: '2026-11-12',
            isOngoing: true,
            schedule: {
              frequencyType: 'daily',
              timesPerDay: 1,
              doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 2 }],
              timezone: 'Asia/Baghdad',
            },
          },
          'Dose titration'
        ),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError &&
        err.dependencyKey === 'atomicRegimenVersionUpdateRpc'
    );
    await assert.rejects(
      () => repo.issueInvitationAsync('44444444-4444-4444-8444-444444444444', 'dob_and_phone_otp'),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError &&
        err.dependencyKey === 'patientActivationStage2c'
    );
    assert.equal(
      calls.filter((c) => c.op !== 'rpc' && c.op !== 'select').length,
      0,
      'Multi-table/Stage2C methods must issue zero direct partial table writes'
    );
    assert.equal(
      calls.some((c) => c.op === 'rpc' && c.table === 'create_medication_plan_with_version'),
      true
    );
    assert.equal(
      calls.some((c) => c.op === 'rpc' && c.table === 'update_medication_plan_version'),
      true
    );

    // 5. Missing Stage 2B SQL RPC (revoke_patient_apk_invitation) sends p_patient_id & p_reason
    //    and maps PGRST202 to explicit Stage2bSqlDependencyError
    calls.length = 0;
    await assert.rejects(
      () =>
        repo.revokeInvitationAsync(
          '44444444-4444-4444-8444-444444444444',
          'Pharmacist manual revoke'
        ),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError && err.dependencyKey === 'revokeInvitationRpc'
    );
    const revokeRpcCall = calls.find(
      (c) => c.op === 'rpc' && c.table === 'revoke_patient_apk_invitation'
    );
    assert.ok(revokeRpcCall);
    assert.deepEqual(revokeRpcCall.payload, {
      p_patient_id: '44444444-4444-4444-8444-444444444444',
      p_reason: 'Pharmacist manual revoke',
    });

    // 6. Database permission errors propagate loudly instead of silently succeeding or falling back
    const { client: errClient } = buildMockDbClient({
      errorOnOp: (call) =>
        call.table === 'dose_events' && call.op === 'update'
          ? { code: '42501', message: 'permission denied for table dose_events' }
          : null,
    });
    const errRepo = new SupabaseCrmRepository(errClient, authContext);
    await assert.rejects(
      () => errRepo.updateDoseEventStatusAsync('66666666-6666-4666-8666-666666666666', 'taken'),
      /Permission or tenant RLS policy denied/i
    );

    // 7. Empty state factory returns valid clean structure with no demo patients
    const emptyState = createEmptyConnectedCrmState();
    assert.equal(emptyState.patients.length, 0);
    assert.equal(emptyState.staff.length, 0);
    assert.ok(STAGE2B_SQL_DEPENDENCIES.revokeInvitationRpc.stageRequired.includes('0003'));

    passed++;
    console.log('✓ Suite 3: SupabaseCrmRepository grants, UUID normalization & error boundaries verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 4: Static Architecture & Demo Mode Safety Invariants
  // --------------------------------------------------------------------------
  {
    const rootDir = process.cwd();
    const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
    const crmContextSrc = fs.readFileSync(path.join(rootDir, 'src/context/CrmContext.tsx'), 'utf8');
    const appShellSrc = fs.readFileSync(
      path.join(rootDir, 'src/components/layout/AppShell.tsx'),
      'utf8'
    );
    const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');

    const nonCommentEnvLines = envExample
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
      .join('\n');
    assert.equal(
      envExample.includes('VITE_ENABLE_SUPABASE_CRM="false"'),
      true,
      '.env.example must keep Connected Mode disabled by default'
    );
    assert.equal(
      /service_role|sb_secret_|db_password/i.test(nonCommentEnvLines),
      false,
      '.env.example must never define service_role or secret env vars'
    );

    assert.equal(
      crmContextSrc.includes('createEmptyConnectedCrmState()'),
      true,
      'Connected Mode must initialize from clean empty state rather than demo data'
    );
    assert.equal(
      appSrc.includes('PharmacistLoginScreen'),
      true,
      'App.tsx must gate Connected Mode behind PharmacistLoginScreen'
    );
    assert.equal(
      appShellSrc.includes('isConnectedMode ?') &&
        appShellSrc.includes('resetDemoData') &&
        appShellSrc.includes('signOut'),
      true,
      'AppShell.tsx must branch on isConnectedMode to hide Demo controls and expose Sign Out when Connected Mode is active'
    );

    passed++;
    console.log('✓ Suite 4: Demo Mode preservation & Connected Mode gating invariants verified');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.1 PREPARATION SUITES PASSED CLEANLY`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.1 preparation test suite failed:', err);
  process.exit(1);
});
