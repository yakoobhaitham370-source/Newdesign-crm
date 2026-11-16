import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AuthenticatedPharmacistContext,
  resolveAndEnforceAuthoritativePharmacistSession,
  restorePharmacistSession,
  SupabaseAuthLike,
} from '../services/authService';
import {
  ConnectedAuthStatus,
  ConnectedSessionController,
} from '../services/connectedSessionController';
import { CrmState, IAsyncCrmRepository } from '../services/crmRepository';
import { getSupabaseClient, resetSupabaseClientForTests } from '../services/supabaseClient';
import {
  createEmptyConnectedCrmState,
  Stage2bSqlDependencyError,
  SupabaseCrmRepository,
} from '../services/supabaseCrmRepository';

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TEST_PHARMACY_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  name_ar: 'صيدلية الاختبار',
  name_en: 'Test Pharmacy',
  city: 'بغداد',
  governorate: 'بغداد',
  license_number: 'IQ-TEST-01',
  phone: '07700000001',
  timezone: 'Asia/Baghdad',
  is_active: true,
};

function makeAuthContext(userId: string, fullName: string): AuthenticatedPharmacistContext {
  return {
    userId,
    email: `${userId}@test.iq`,
    pharmacyId: TEST_PHARMACY_ROW.id,
    role: 'pharmacy_owner',
    staff: {
      id: userId,
      pharmacyId: TEST_PHARMACY_ROW.id,
      fullName,
      role: 'pharmacy_owner',
      phone: '07700000002',
      isActive: true,
    },
    pharmacy: {
      id: TEST_PHARMACY_ROW.id,
      nameAr: TEST_PHARMACY_ROW.name_ar,
      nameEn: TEST_PHARMACY_ROW.name_en,
      city: TEST_PHARMACY_ROW.city,
      governorate: TEST_PHARMACY_ROW.governorate,
      licenseNumber: TEST_PHARMACY_ROW.license_number,
      phone: TEST_PHARMACY_ROW.phone,
      timezone: 'Asia/Baghdad',
    },
  };
}

function buildPaginatedMockClient(options?: {
  tableData?: Record<string, unknown[]>;
  errorOnOp?: (table: string, op: string) => { code?: string; message: string } | null;
  rpcHandler?: (fn: string, args: unknown) => { data: unknown; error: { code?: string; message: string } | null };
}) {
  const calls: Array<{
    table: string;
    op: string;
    range?: [number, number];
    payload?: unknown;
  }> = [];

  const defaultRows: Record<string, unknown[]> = {
    pharmacies: [TEST_PHARMACY_ROW],
    pharmacy_staff: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        pharmacy_id: TEST_PHARMACY_ROW.id,
        full_name: 'د. المالك',
        role: 'pharmacy_owner',
        syndicate_license: 'SYN-1',
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
    ...(options?.tableData ?? {}),
  };

  function makeBuilder(table: string, op: string, payload?: unknown) {
    let rangeBounds: [number, number] | undefined;
    let isSingle = false;
    let isMaybeSingle = false;

    const execute = () => {
      calls.push({ table, op, range: rangeBounds, payload });
      const forcedError = options?.errorOnOp?.(table, op);
      if (forcedError) {
        return { data: null, error: forcedError };
      }
      if (op === 'select') {
        const rows = defaultRows[table] ?? [];
        if (isSingle || isMaybeSingle) {
          return { data: rows[0] ?? null, error: null };
        }
        if (rangeBounds) {
          return { data: rows.slice(rangeBounds[0], rangeBounds[1] + 1), error: null };
        }
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      in() {
        return builder;
      },
      is() {
        return builder;
      },
      order() {
        return builder;
      },
      range(from: number, to: number) {
        rangeBounds = [from, to];
        return builder;
      },
      single() {
        isSingle = true;
        return Promise.resolve(execute());
      },
      maybeSingle() {
        isMaybeSingle = true;
        return Promise.resolve(execute());
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select: () => makeBuilder(table, 'select'),
        insert: (payload: unknown) => makeBuilder(table, 'insert', payload),
        update: (payload: unknown) => makeBuilder(table, 'update', payload),
        upsert: (payload: unknown) => makeBuilder(table, 'upsert', payload),
        delete: () => makeBuilder(table, 'delete'),
      };
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ table: fn, op: 'rpc', payload: args });
      if (options?.rpcHandler) {
        return options.rpcHandler(fn, args);
      }
      return { data: null, error: { code: 'PGRST202', message: `Missing ${fn}` } };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

async function main() {
  console.log('===================================================================');
  console.log('MASAR Care — Stage 2B.1.1 Hardening Verification Suite');
  console.log('===================================================================');
  let passed = 0;

  // --------------------------------------------------------------------------
  // TEST 1: Exact publishable-key rotation (beyond first 14 chars)
  // --------------------------------------------------------------------------
  {
    resetSupabaseClientForTests();
    const sharedPrefix = 'sb_publishable_identical_prefix_1234567890_';
    const envA = {
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: `${sharedPrefix}KEY_A`,
    };
    const envB = {
      VITE_ENABLE_SUPABASE_CRM: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: `${sharedPrefix}KEY_B`,
    };

    const clientA1 = getSupabaseClient(envA, { useCache: true });
    const clientA2 = getSupabaseClient(envA, { useCache: true });
    const clientB = getSupabaseClient(envB, { useCache: true });

    assert.equal(clientA1, clientA2, 'Identical (url, key) must reuse cached Supabase client');
    assert.notEqual(
      clientA1,
      clientB,
      'Rotating publishable key with identical first 40+ chars must invalidate cache'
    );
    resetSupabaseClientForTests();

    passed++;
    console.log('✓ Test 1: Exact URL + publishable-key cache rotation verified');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Deterministic unauthorized restored session sign-out vs DB_ERROR
  // --------------------------------------------------------------------------
  {
    const makeRestoreClient = (scenario: {
      staffRow?: Record<string, unknown> | null;
      staffError?: { message: string } | null;
      pharmacyRow?: Record<string, unknown> | null;
    }) => {
      let signOutCalls = 0;
      const client: SupabaseAuthLike = {
        auth: {
          async getSession() {
            return {
              data: {
                session: { user: { id: 'u-restore', email: 'restore@test.iq' } } as never,
              },
              error: null,
            };
          },
          async signInWithPassword() {
            return { data: { user: null, session: null }, error: null };
          },
          async signOut() {
            signOutCalls += 1;
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
                          data: scenario.staffRow ?? null,
                          error: scenario.staffError ?? null,
                        };
                      }
                      return { data: scenario.pharmacyRow ?? TEST_PHARMACY_ROW, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
      return { client, getSignOutCalls: () => signOutCalls };
    };

    for (const [label, scenario, expectedCode] of [
      ['missing staff', { staffRow: null }, 'UNAUTHORIZED_STAFF_NOT_FOUND'],
      [
        'inactive staff',
        {
          staffRow: {
            id: 'u-restore',
            pharmacy_id: TEST_PHARMACY_ROW.id,
            full_name: 'معطل',
            role: 'authorized_pharmacist',
            syndicate_license: null,
            phone: '07700000000',
            is_active: false,
          },
        },
        'STAFF_INACTIVE',
      ],
      [
        'inactive pharmacy',
        {
          staffRow: {
            id: 'u-restore',
            pharmacy_id: TEST_PHARMACY_ROW.id,
            full_name: 'صيدلي',
            role: 'authorized_pharmacist',
            syndicate_license: null,
            phone: '07700000000',
            is_active: true,
          },
          pharmacyRow: { ...TEST_PHARMACY_ROW, is_active: false },
        },
        'PHARMACY_INACTIVE',
      ],
      [
        'bad role',
        {
          staffRow: {
            id: 'u-restore',
            pharmacy_id: TEST_PHARMACY_ROW.id,
            full_name: 'مراجع',
            role: 'patient',
            syndicate_license: null,
            phone: '07700000000',
            is_active: true,
          },
        },
        'ROLE_NOT_AUTHORIZED',
      ],
    ] as const) {
      const { client, getSignOutCalls } = makeRestoreClient(scenario);
      const res = await restorePharmacistSession(client);
      assert.equal(res.ok, false, `Expected failure for ${label}`);
      if (!res.ok) {
        assert.equal(res.errorCode, expectedCode);
        assert.equal(
          res.hasAuthSession,
          false,
          `${label} must clear hasAuthSession after deterministic signOut`
        );
      }
      assert.equal(getSignOutCalls(), 1, `${label} must trigger auth.signOut()`);
    }

    // Transient DB_ERROR preserves hasAuthSession so retry remains possible
    const dbErrMock = makeRestoreClient({ staffError: { message: 'network timeout' } });
    const dbErrRes = await resolveAndEnforceAuthoritativePharmacistSession(dbErrMock.client, {
      id: 'u-restore',
      email: 'restore@test.iq',
    });
    assert.equal(dbErrRes.ok, false);
    if (!dbErrRes.ok) {
      assert.equal(dbErrRes.errorCode, 'DB_ERROR');
      assert.equal(dbErrRes.hasAuthSession, true);
    }
    assert.equal(dbErrMock.getSignOutCalls(), 0, 'Transient DB_ERROR must not sign out');

    passed++;
    console.log('✓ Test 2: Deterministic unauthorized signOut vs DB_ERROR preservation verified');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Async authentication, account-switch, hydration, and disposal races
  // --------------------------------------------------------------------------
  {
    const makeRaceHarness = () => {
      let currentSessionUser: { id: string; email: string } | null = null;
      let signOutCalls = 0;
      const restoreGate = createDeferred<{ id: string; email: string } | null>();
      const hydrationDeferreds = new Map<string, ReturnType<typeof createDeferred<CrmState>>>();
      const signInDeferreds = new Map<string, ReturnType<typeof createDeferred<void>>>();

      let authStatus: ConnectedAuthStatus = 'checking';
      let authError: string | null = null;
      let asyncError: string | null = null;
      let hasUnauthorizedSession = false;
      let authenticatedPharmacist: AuthenticatedPharmacistContext | null = null;
      let repo: IAsyncCrmRepository | null = null;
      let state: CrmState = createEmptyConnectedCrmState();
      let isLoading = false;
      let navResets = 0;

      const client: SupabaseAuthLike = {
        auth: {
          async getSession() {
            return {
              data: {
                session: currentSessionUser ? ({ user: currentSessionUser } as never) : null,
              },
              error: null,
            };
          },
          async signInWithPassword({ email }) {
            const userId = email.startsWith('a@') ? 'user-a' : 'user-b';
            const gate = signInDeferreds.get(userId);
            if (gate) await gate.promise;
            currentSessionUser = { id: userId, email };
            return {
              data: {
                user: currentSessionUser as never,
                session: { user: currentSessionUser } as never,
              },
              error: null,
            };
          },
          async signOut() {
            signOutCalls += 1;
            currentSessionUser = null;
            return { error: null };
          },
        },
        from(table: string) {
          return {
            select() {
              return {
                eq(_col: string, val: string) {
                  return {
                    async maybeSingle() {
                      if (table === 'pharmacy_staff') {
                        if (val === 'slow-restore') {
                          const awaited = await restoreGate.promise;
                          if (!awaited) return { data: null, error: null };
                        }
                        return {
                          data: {
                            id: val,
                            pharmacy_id: TEST_PHARMACY_ROW.id,
                            full_name: val === 'user-a' ? 'User A' : 'User B',
                            role: 'pharmacy_owner',
                            syndicate_license: null,
                            phone: '07700000001',
                            is_active: true,
                          },
                          error: null,
                        };
                      }
                      return { data: TEST_PHARMACY_ROW, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };

      const controller = new ConnectedSessionController({
        client,
        createRepository: (_c, ctx) => {
          return {
            async getStateAsync() {
              const def = hydrationDeferreds.get(ctx.userId);
              if (def) return def.promise;
              const s = createEmptyConnectedCrmState();
              s.pharmacy = ctx.pharmacy;
              s.activeStaffId = ctx.userId;
              return s;
            },
          } as unknown as IAsyncCrmRepository;
        },
        callbacks: {
          getLang: () => 'en',
          setRepo: (r) => {
            repo = r;
          },
          getRepo: () => repo,
          setState: (s) => {
            state = s;
          },
          setAuthStatus: (st) => {
            authStatus = st;
          },
          setAuthError: (e) => {
            authError = e;
          },
          setHasUnauthorizedSession: (b) => {
            hasUnauthorizedSession = b;
          },
          setAuthenticatedPharmacist: (ctx) => {
            authenticatedPharmacist = ctx;
          },
          setIsLoading: (l) => {
            isLoading = l;
          },
          setAsyncError: (e) => {
            asyncError = e;
          },
          resetNavigation: () => {
            navResets += 1;
          },
        },
      });

      return {
        controller,
        restoreGate,
        hydrationDeferreds,
        signInDeferreds,
        setCurrentSessionUser: (u: { id: string; email: string } | null) => {
          currentSessionUser = u;
        },
        getSnapshot: () => ({
          authStatus,
          authError,
          asyncError,
          hasUnauthorizedSession,
          authenticatedPharmacist,
          repo,
          state,
          isLoading,
          navResets,
          signOutCalls,
        }),
      };
    };

    // Race A: Delayed restore resolving after signOut must never restore workspace
    {
      const h = makeRaceHarness();
      h.setCurrentSessionUser({ id: 'slow-restore', email: 'slow@test.iq' });
      const restorePromise = h.controller.restoreInitialSession();
      await h.controller.signOut();
      h.restoreGate.resolve({ id: 'slow-restore', email: 'slow@test.iq' });
      const restored = await restorePromise;
      assert.equal(restored, false);
      const snap = h.getSnapshot();
      assert.equal(snap.authStatus, 'unauthenticated');
      assert.equal(snap.repo, null);
      assert.equal(snap.authenticatedPharmacist, null);
      assert.equal(snap.state.patients.length, 0);
    }

    // Race B: Slow sign-in for User A overtaken by User B must keep User B only
    {
      const h = makeRaceHarness();
      const gateA = createDeferred<void>();
      const gateB = createDeferred<void>();
      h.signInDeferreds.set('user-a', gateA);
      h.signInDeferreds.set('user-b', gateB);

      const signInA = h.controller.signIn('a@test.iq', 'pass123');
      const signInB = h.controller.signIn('b@test.iq', 'pass123');
      gateB.resolve();
      await signInB;
      gateA.resolve();
      await signInA;

      const snap = h.getSnapshot();
      assert.equal(snap.authStatus, 'authenticated');
      assert.equal(snap.authenticatedPharmacist?.userId, 'user-b');
      assert.equal(snap.state.activeStaffId, 'user-b');
    }

    // Race C: Delayed getStateAsync hydration resolving after signOut & after dispose must be discarded
    {
      const h = makeRaceHarness();
      const hydA = createDeferred<CrmState>();
      h.hydrationDeferreds.set('user-a', hydA);

      const signInPromise = h.controller.signIn('a@test.iq', 'pass123');
      // Wait a microtask until signIn reaches hydrateRepoState
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, 'user-a');

      // User signs out while hydration is in flight
      await h.controller.signOut();
      assert.equal(h.getSnapshot().repo, null);
      assert.equal(h.getSnapshot().authenticatedPharmacist, null);
      assert.equal(h.getSnapshot().state.patients.length, 0);

      // Delayed state finally resolves with stale patient data
      const staleState = createEmptyConnectedCrmState();
      staleState.patients = [
        {
          id: 'p-stale',
          patientCode: 'PAT-STALE',
          pharmacyId: TEST_PHARMACY_ROW.id,
          fullName: 'Stale Patient',
          phone: '07700000000',
          phoneOwnerType: 'self',
          dateOfBirth: '1980-01-01',
          sex: 'male',
          chronicConditions: [],
          allergies: [],
          contactPreference: 'whatsapp',
          clinicalNotes: '',
          registrationDate: '2026-11-12',
          status: 'active',
        },
      ];
      hydA.resolve(staleState);
      await signInPromise;

      assert.equal(
        h.getSnapshot().state.patients.length,
        0,
        'Stale hydration resolved after signOut must be discarded'
      );

      // Also verify dispose() rejects subsequent refreshState hydration
      const hydB = createDeferred<CrmState>();
      h.hydrationDeferreds.delete('user-b');
      await h.controller.signIn('b@test.iq', 'pass123');
      h.hydrationDeferreds.set('user-b', hydB);
      const refreshPromise = h.controller.refreshState();
      h.controller.dispose();
      hydB.resolve(staleState);
      await refreshPromise;
      assert.equal(
        h.getSnapshot().state.patients.length,
        0,
        'Delayed refreshState resolved after unmount dispose() must not overwrite state'
      );
    }

    passed++;
    console.log('✓ Test 3: Async auth, account switch, hydration & unmount race protections verified');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Pagination >1,000 rows + dataset completeness safety guard
  // --------------------------------------------------------------------------
  {
    const authCtx = makeAuthContext('22222222-2222-4222-8222-222222222222', 'د. المالك');
    const manyPatients = Array.from({ length: 1250 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      pharmacy_id: authCtx.pharmacyId,
      patient_code: `PAT-${idx + 1}`,
      full_name: `Patient ${idx + 1}`,
      phone: '07700000000',
      phone_owner_type: 'self',
      caregiver_name: null,
      date_of_birth: '1980-01-01',
      sex: 'male',
      contact_preference: 'whatsapp',
      clinical_notes: '',
      registration_date: '2026-11-12',
      status: 'active',
      archived_at: null,
      archived_reason: null,
    }));

    const { client, calls } = buildPaginatedMockClient({
      tableData: { patients: manyPatients },
    });

    const repo = new SupabaseCrmRepository(client, authCtx);
    const loaded = await repo.getStateAsync();
    assert.equal(loaded.patients.length, 1250, 'All 1,250 patients must be fetched via pagination');

    const patientSelectCalls = calls.filter((c) => c.table === 'patients' && c.op === 'select');
    assert.equal(patientSelectCalls.length, 3, 'Expected 3 pages of size 500 for 1,250 rows');
    assert.deepEqual(
      patientSelectCalls.map((c) => c.range),
      [
        [0, 499],
        [500, 999],
        [1000, 1499],
      ]
    );

    // Lower maxRows ceiling triggers explicit truncation/completeness guard instead of partial state
    const cappedRepo = new SupabaseCrmRepository(client, authCtx, { pageSize: 500, maxRows: 1000 });
    await assert.rejects(() => cappedRepo.getStateAsync(), /Dataset completeness guard triggered/i);

    passed++;
    console.log('✓ Test 4: >1,000-row PostgREST pagination & completeness ceiling verified');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Missing Migration 0003 RPCs map to Stage2bSqlDependencyError with zero direct table writes
  // --------------------------------------------------------------------------
  {
    const authCtx = makeAuthContext('22222222-2222-4222-8222-222222222222', 'د. المالك');
    const { client, calls } = buildPaginatedMockClient({
      tableData: {
        patients: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            pharmacy_id: TEST_PHARMACY_ROW.id,
            patient_code: 'PAT-TEST-01',
            full_name: 'مريض اختبار',
            phone: '07701112233',
            phone_owner_type: 'self',
            caregiver_name: null,
            date_of_birth: '1980-01-01',
            sex: 'male',
            contact_preference: 'whatsapp',
            clinical_notes: '',
            registration_date: '2026-11-12',
            status: 'active',
            archived_at: null,
            archived_reason: null,
          },
        ],
        patient_medication_plans: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            pharmacy_id: TEST_PHARMACY_ROW.id,
            patient_id: '44444444-4444-4444-8444-444444444444',
            catalog_id: null,
            brand_name: 'Glucophage',
            generic_name: 'Metformin',
            strength: '500 mg',
            dosage_form: 'tablet',
            route: 'oral',
            dose_amount: 1,
            dose_unit: 'قرص',
            food_relation: 'after_food',
            verified_instructions: 'قرص يومياً',
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
            created_at: '2026-11-12T08:00:00Z',
            updated_at: '2026-11-12T08:00:00Z',
          },
        ],
      },
    });
    const repo = new SupabaseCrmRepository(client, authCtx);

    const guards: Array<() => Promise<unknown>> = [
      () =>
        repo.addPatientAsync({
          patientCode: 'PAT-TEST-01',
          registrationDate: '2026-11-12',
          fullName: 'مريض اختبار',
          phone: '07701112233',
          phoneOwnerType: 'self',
          dateOfBirth: '1980-01-01',
          sex: 'male',
          chronicConditions: ['Type 2 Diabetes'],
          allergies: [],
          contactPreference: 'whatsapp',
          clinicalNotes: '',
        }),
      () => repo.updatePatientAsync('44444444-4444-4444-8444-444444444444', { fullName: 'اسم محدث' }),
      () =>
        repo.addMedicationPlanAsync({
          patientId: '44444444-4444-4444-8444-444444444444',
          brandName: 'Glucophage',
          genericName: 'Metformin',
          strength: '500 mg',
          dosageForm: 'tablet',
          route: 'oral',
          doseAmount: 1,
          doseUnit: 'قرص',
          foodRelation: 'after_food',
          verifiedInstructions: 'قرص يومياً',
          startDate: '2026-11-12',
          isOngoing: true,
          schedule: {
            frequencyType: 'daily',
            timesPerDay: 1,
            doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 1 }],
            timezone: 'Asia/Baghdad',
          },
        }),
      () =>
        repo.updateMedicationPlanAsync(
          '33333333-3333-4333-8333-333333333333',
          {
            patientId: '44444444-4444-4444-8444-444444444444',
            brandName: 'Glucophage',
            genericName: 'Metformin',
            strength: '500 mg',
            dosageForm: 'tablet',
            route: 'oral',
            doseAmount: 2,
            doseUnit: 'قرص',
            foodRelation: 'after_food',
            verifiedInstructions: 'قرصان يومياً',
            startDate: '2026-11-12',
            isOngoing: true,
            schedule: {
              frequencyType: 'daily',
              timesPerDay: 1,
              doseSlots: [{ id: 's1', time24: '20:00', doseAmount: 2 }],
              timezone: 'Asia/Baghdad',
            },
          },
          'Titration'
        ),
      () =>
        repo.changeMedicationStatusAsync(
          '33333333-3333-4333-8333-333333333333',
          'paused',
          'Clinical pause'
        ),
      () =>
        repo.recordDispensingAsync(
          {
            patientId: '44444444-4444-4444-8444-444444444444',
            medicationPlanId: '33333333-3333-4333-8333-333333333333',
            dispensedQuantity: 30,
            quantityUnit: 'قرص',
            dispensingDate: '2026-11-12',
            isPartialFill: false,
          },
          'en'
        ),
      () => repo.sendConsultationReplyAsync('77777777-7777-4777-8777-777777777777', 'Reply text'),
      () => repo.issueInvitationAsync('44444444-4444-4444-8444-444444444444', 'dob_and_phone_otp'),
    ];

    for (const runGuard of guards) {
      await assert.rejects(() => runGuard(), (err: unknown) => err instanceof Stage2bSqlDependencyError);
    }
    const directTableWrites = calls.filter(
      (c) => c.op === 'insert' || c.op === 'update' || c.op === 'upsert' || c.op === 'delete'
    );
    assert.equal(
      directTableWrites.length,
      0,
      'Multi-table methods must never issue direct partial table writes'
    );
    const allRpcNames = calls.filter((c) => c.op === 'rpc').map((c) => c.table);
    assert.equal(
      allRpcNames.filter((name) => name === 'get_clinical_safety_capabilities').length <= 1,
      true,
      'Capability probe must be cached per repository instance'
    );
    const rpcNames = allRpcNames.filter((name) => name !== 'get_clinical_safety_capabilities');
    assert.deepEqual(rpcNames, [
      'create_patient_with_clinical_tags',
      'update_patient_with_clinical_tags',
      'create_medication_plan_with_version',
      'update_medication_plan_version',
      'change_medication_plan_status',
      'record_dispensing_with_refill',
      'send_consultation_reply',
    ]);

    passed++;
    console.log('✓ Test 5: Missing-RPC Stage2bSqlDependencyError guards & zero partial writes verified');
  }

  // --------------------------------------------------------------------------
  // TEST 6: 42501 / 23514 SQL error propagation & revocation reason alignment
  // --------------------------------------------------------------------------
  {
    const authCtx = makeAuthContext('22222222-2222-4222-8222-222222222222', 'د. المالك');

    const { client: chkClient } = buildPaginatedMockClient({
      errorOnOp: (table) =>
        table === 'lab_results'
          ? { code: '23514', message: 'new row violates check constraint lab_results_test_name_check' }
          : { code: '42501', message: `permission denied for table ${table}` },
    });
    const errRepo = new SupabaseCrmRepository(chkClient, authCtx);

    await assert.rejects(
      () =>
        errRepo.addLabResultAsync({
          patientId: '44444444-4444-4444-8444-444444444444',
          testName: 'X',
          value: '7.1',
          unit: '%',
          referenceRange: '<7%',
          isAbnormal: true,
          testDate: '2026-11-12',
        }),
      /Clinical integrity check failed/i
    );
    await assert.rejects(
      () => errRepo.archivePatientAsync('44444444-4444-4444-8444-444444444444', 'Transferred'),
      /Permission or tenant RLS policy denied/i
    );

    const { client: revClient, calls: revCalls } = buildPaginatedMockClient({
      rpcHandler: () => ({ data: { ok: true }, error: null }),
    });
    const revRepo = new SupabaseCrmRepository(revClient, authCtx);
    await revRepo.revokeInvitationAsync(
      '44444444-4444-4444-8444-444444444444',
      'Lost phone replacement'
    );
    const rpcCall = revCalls.find((c) => c.op === 'rpc');
    assert.deepEqual(rpcCall?.payload, {
      p_patient_id: '44444444-4444-4444-8444-444444444444',
      p_reason: 'Lost phone replacement',
    });

    passed++;
    console.log('✓ Test 6: SQL 23514/42501 propagation & revocation signature alignment verified');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Static activation containment & redundant asset removal invariants
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    const modalSrc = fs.readFileSync(
      path.join(root, 'src/components/modals/InvitationModal.tsx'),
      'utf8'
    );
    const viewSrc = fs.readFileSync(path.join(root, 'src/views/InvitationsView.tsx'), 'utf8');
    const detailSrc = fs.readFileSync(
      path.join(root, 'src/views/PatientDetailView.tsx'),
      'utf8'
    );

    assert.equal(
      modalSrc.includes('{!isConnectedMode && (\n                  <QrPreview') ||
        (modalSrc.includes('!isConnectedMode') && modalSrc.includes('Stage 2C')),
      true,
      'InvitationModal.tsx must guard QrPreview and actions when isConnectedMode is true'
    );
    assert.equal(
      modalSrc.includes('pharmacistHandoverPinOnce') || modalSrc.includes('singleUseTokenOnce'),
      false,
      'InvitationModal.tsx must not render unimplemented Connected Mode secret handover fields'
    );
    assert.equal(
      viewSrc.includes('disabled={isConnectedMode}') && viewSrc.includes('Stage 2C'),
      true,
      'InvitationsView.tsx must disable Resend/Revoke in Connected Mode with Stage 2C notice'
    );
    assert.equal(
      detailSrc.includes('isConnectedMode') && detailSrc.includes('Stage 2C'),
      true,
      'PatientDetailView.tsx must clearly gate Connected Mode APK onboarding pending Stage 2C'
    );

    assert.equal(
      fs.existsSync(path.join(root, 'public/assets/aistudio/MASAR_Security_Test_V2_0c73a195.txt')),
      false,
      'Duplicate MASAR_Security_Test_V2 artifact must be removed from public/assets'
    );
    assert.equal(
      fs.existsSync(path.join(root, 'exports/MASAR_CARE_V1.5.4.zip')),
      false,
      'Redundant MASAR_CARE_V1.5.4.zip archive must be removed'
    );
    assert.equal(
      fs.existsSync(path.join(root, 'supabase/tests/stage2a_negative_security_and_integrity.test.sql')),
      true,
      'Canonical Stage 2A negative security test must be preserved'
    );

    passed++;
    console.log('✓ Test 7: UI activation containment & asset cleanup invariants verified');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.1.1 HARDENING TESTS PASSED CLEANLY`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.1.1 hardening test suite failed:', err);
  process.exit(1);
});
