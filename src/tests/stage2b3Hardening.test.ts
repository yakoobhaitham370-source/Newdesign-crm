import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AuthenticatedPharmacistContext,
  resolveAuthoritativePharmacistSession,
  SupabaseAuthLike,
  verifyActiveSessionMatchesUser,
} from '../services/authService';
import {
  ConnectedAuthStatus,
  ConnectedSessionController,
} from '../services/connectedSessionController';
import { CrmState, IAsyncCrmRepository, InMemoryCrmAdapter } from '../services/crmRepository';
import {
  ConnectedAuthorizationError,
  createEmptyConnectedCrmState,
  isConnectedAuthorizationError,
  isSupabaseRlsPermissionError,
  Stage2bSqlDependencyError,
  SupabaseCrmRepository,
} from '../services/supabaseCrmRepository';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const USER_A_ID = '22222222-2222-4222-8222-222222222222';
const USER_B_ID = '33333333-3333-4333-8333-333333333333';

function makeAuthContext(
  userId = USER_A_ID,
  pharmacyId = PHARMACY_ID,
  fullName = 'د. الصيدلي الموثق'
): AuthenticatedPharmacistContext {
  return {
    userId,
    email: 'pharmacist@masar.example',
    pharmacyId,
    role: 'pharmacy_owner',
    staff: {
      id: userId,
      pharmacyId,
      fullName,
      role: 'pharmacy_owner',
      phone: '07701234567',
      isActive: true,
    },
    pharmacy: {
      id: pharmacyId,
      nameAr: 'صيدلية مسار التطويرية',
      nameEn: 'MASAR Dev Pharmacy',
      city: 'بغداد',
      governorate: 'بغداد',
      licenseNumber: 'IQ-DEV-101',
      phone: '07701234567',
      timezone: 'Asia/Baghdad',
    },
  };
}

function makePharmacyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PHARMACY_ID,
    name_ar: 'صيدلية مسار التطويرية',
    name_en: 'MASAR Dev Pharmacy',
    city: 'بغداد',
    governorate: 'بغداد',
    license_number: 'IQ-DEV-101',
    phone: '07701234567',
    timezone: 'Asia/Baghdad',
    is_active: true,
    ...overrides,
  };
}

function makeStaffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_A_ID,
    pharmacy_id: PHARMACY_ID,
    full_name: 'د. الصيدلي الموثق',
    role: 'pharmacy_owner',
    syndicate_license: 'SYND-101',
    phone: '07701234567',
    is_active: true,
    ...overrides,
  };
}

function makeRepoMockClient(options: {
  pharmacyRow?: Record<string, unknown> | null;
  staffRows?: Array<Record<string, unknown>>;
  patientRows?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    pharmacy_staff: options.staffRows ?? [makeStaffRow()],
    patients: options.patientRows ?? [],
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
  };

  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              const chain = {
                order() {
                  return chain;
                },
                range(from: number, to: number) {
                  const rows = tables[table] ?? [];
                  return Promise.resolve({
                    data: rows.slice(from, to + 1),
                    error: null,
                  });
                },
                maybeSingle() {
                  if (table === 'pharmacies') {
                    return Promise.resolve({
                      data: options.pharmacyRow === undefined ? makePharmacyRow() : options.pharmacyRow,
                      error: null,
                    });
                  }
                  const rows = tables[table] ?? [];
                  return Promise.resolve({ data: rows[0] ?? null, error: null });
                },
              };
              return chain;
            },
          };
        },
      };
    },
    async rpc() {
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function runTests() {
  console.log('=== MASAR Care Stage 2B.3 Connected Mode Hardening Suite ===');

  // --------------------------------------------------------------------------
  // 1. SQL Test Compatibility Fix
  // --------------------------------------------------------------------------
  {
    const sqlTest = fs.readFileSync(
      path.join(process.cwd(), 'supabase/tests/stage2b_0003_negative_and_integrity.test.sql'),
      'utf8'
    );
    assert.equal(
      sqlTest.includes('pg_catalog.coalesce('),
      false,
      'stage2b_0003_negative_and_integrity.test.sql must not call pg_catalog.coalesce('
    );
    assert.equal(
      sqlTest.includes("COALESCE(pg_catalog.current_setting('request.jwt.claims', true), '')"),
      true,
      'Standard SQL COALESCE must be used for request.jwt.claims check'
    );
    assert.equal(
      sqlTest.includes("COALESCE(pg_catalog.current_setting('request.jwt.claim.sub', true), '')"),
      true,
      'Standard SQL COALESCE must be used for request.jwt.claim.sub check'
    );
    console.log('✓ 1. SQL test file uses PostgreSQL-compatible COALESCE(...)');
  }

  // --------------------------------------------------------------------------
  // 2. SupabaseCrmRepository.getStateAsync() Fail-Closed Membership & Pharmacy Checks
  // --------------------------------------------------------------------------
  {
    const authCtx = makeAuthContext();

    // 2a. Missing pharmacy row must NOT fall back to this.authContext.pharmacy
    const missingPharmacyRepo = new SupabaseCrmRepository(
      makeRepoMockClient({ pharmacyRow: null }),
      authCtx
    );
    await assert.rejects(
      () => missingPharmacyRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'PHARMACY_INACTIVE'
    );

    // 2b. Inactive pharmacy row must fail closed
    const inactivePharmacyRepo = new SupabaseCrmRepository(
      makeRepoMockClient({ pharmacyRow: makePharmacyRow({ is_active: false }) }),
      authCtx
    );
    await assert.rejects(
      () => inactivePharmacyRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'PHARMACY_INACTIVE'
    );

    // 2c. Mismatched pharmacy ID must fail closed
    const mismatchedPharmacyRepo = new SupabaseCrmRepository(
      makeRepoMockClient({
        pharmacyRow: makePharmacyRow({ id: '99999999-9999-4999-8999-999999999999' }),
      }),
      authCtx
    );
    await assert.rejects(
      () => mismatchedPharmacyRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'PHARMACY_INACTIVE'
    );

    // 2d. Missing current staff row must NOT fall back to [this.authContext.staff]
    const emptyStaffRepo = new SupabaseCrmRepository(
      makeRepoMockClient({ staffRows: [] }),
      authCtx
    );
    await assert.rejects(
      () => emptyStaffRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'UNAUTHORIZED_STAFF_NOT_FOUND'
    );

    // 2e. Deactivated current staff row must fail closed
    const inactiveStaffRepo = new SupabaseCrmRepository(
      makeRepoMockClient({ staffRows: [makeStaffRow({ is_active: false })] }),
      authCtx
    );
    await assert.rejects(
      () => inactiveStaffRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'STAFF_INACTIVE'
    );

    // 2f. Non-pharmacist role must fail closed
    const badRoleRepo = new SupabaseCrmRepository(
      makeRepoMockClient({ staffRows: [makeStaffRow({ role: 'patient_apk_user' })] }),
      authCtx
    );
    await assert.rejects(
      () => badRoleRepo.getStateAsync(),
      (err: unknown) =>
        isConnectedAuthorizationError(err) && err.errorCode === 'ROLE_NOT_AUTHORIZED'
    );

    // 2g. Valid active pharmacy + active pharmacist succeeds with authoritative state
    const validRepo = new SupabaseCrmRepository(makeRepoMockClient({}), authCtx);
    const validState = await validRepo.getStateAsync();
    assert.equal(validState.pharmacy.id, PHARMACY_ID);
    assert.equal(validState.staff.length, 1);
    assert.equal(validState.activeStaffId, USER_A_ID);

    console.log('✓ 2. SupabaseCrmRepository.getStateAsync() fails closed without stale fallbacks');
  }

  // --------------------------------------------------------------------------
  // 3. authService.ts Strict Row Identity Verification
  // --------------------------------------------------------------------------
  {
    const mismatchStaffClient: SupabaseAuthLike = {
      auth: {
        async getSession() {
          return { data: { session: null }, error: null };
        },
        async signInWithPassword() {
          return { data: { user: null, session: null }, error: null };
        },
        async signOut() {
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
                      return { data: makeStaffRow({ id: 'different-user-id' }), error: null };
                    }
                    return { data: makePharmacyRow(), error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    const res = await resolveAuthoritativePharmacistSession(mismatchStaffClient, {
      id: USER_A_ID,
      email: 'a@test.iq',
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorCode, 'UNAUTHORIZED_STAFF_NOT_FOUND');
    }

    const mismatchPharmacyClient: SupabaseAuthLike = {
      ...mismatchStaffClient,
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    if (table === 'pharmacy_staff') {
                      return { data: makeStaffRow({ id: USER_A_ID }), error: null };
                    }
                    return {
                      data: makePharmacyRow({ id: '99999999-9999-4999-8999-999999999999' }),
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    const res2 = await resolveAuthoritativePharmacistSession(mismatchPharmacyClient, {
      id: USER_A_ID,
      email: 'a@test.iq',
    });
    assert.equal(res2.ok, false);
    if (!res2.ok) {
      assert.equal(res2.errorCode, 'PHARMACY_INACTIVE');
    }

    console.log('✓ 3. authService.ts rejects mismatched staff_id and pharmacy_id rows');
  }

  // --------------------------------------------------------------------------
  // 4. ConnectedSessionController: Mid-Session Revocation, Account Switch, & Transient DB_ERROR
  // --------------------------------------------------------------------------
  {
    const makeControllerHarness = () => {
      let currentSessionUser: { id: string; email: string } | null = null;
      let staffActiveByUser: Record<string, boolean> = {
        [USER_A_ID]: true,
        [USER_B_ID]: true,
      };
      let pharmacyActive = true;
      let dbQueryError: string | null = null;
      let throwAuthErrorInGetState: ConnectedAuthorizationError | null = null;
      let signOutCalls = 0;
      let navResets = 0;

      let authStatus: ConnectedAuthStatus = 'checking';
      let authError: string | null = null;
      let asyncError: string | null = null;
      let hasUnauthorizedSession = false;
      let authenticatedPharmacist: AuthenticatedPharmacistContext | null = null;
      let repo: IAsyncCrmRepository | null = null;
      let state: CrmState = createEmptyConnectedCrmState();
      let isLoading = false;

      const hydrationGates = new Map<string, ReturnType<typeof createDeferred<CrmState>>>();

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
            const uid = email.startsWith('b@') ? USER_B_ID : USER_A_ID;
            currentSessionUser = { id: uid, email };
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
                      if (dbQueryError) {
                        return { data: null, error: { message: dbQueryError } };
                      }
                      if (table === 'pharmacy_staff') {
                        return {
                          data: makeStaffRow({
                            id: val,
                            full_name: val === USER_B_ID ? 'User B' : 'User A',
                            is_active: staffActiveByUser[val] ?? false,
                          }),
                          error: null,
                        };
                      }
                      return {
                        data: makePharmacyRow({ is_active: pharmacyActive }),
                        error: null,
                      };
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
              if (throwAuthErrorInGetState) {
                throw throwAuthErrorInGetState;
              }
              const gate = hydrationGates.get(ctx.userId);
              if (gate) {
                return gate.promise;
              }
              const nextState = createEmptyConnectedCrmState();
              nextState.pharmacy = ctx.pharmacy;
              nextState.staff = [ctx.staff];
              nextState.activeStaffId = ctx.userId;
              nextState.patients = [
                {
                  id: `patient-of-${ctx.userId}`,
                  patientCode: ctx.userId === USER_B_ID ? 'PAT-B1' : 'PAT-A1',
                  pharmacyId: ctx.pharmacyId,
                  fullName: ctx.userId === USER_B_ID ? 'Patient B' : 'Patient A',
                  phone: '07701112233',
                  phoneOwnerType: 'self',
                  dateOfBirth: '1980-01-01',
                  sex: 'female',
                  chronicConditions: [],
                  allergies: [],
                  contactPreference: 'whatsapp',
                  clinicalNotes: '',
                  registrationDate: '2026-11-12',
                  status: 'active',
                },
              ];
              return nextState;
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
        hydrationGates,
        setCurrentSessionUser: (u: { id: string; email: string } | null) => {
          currentSessionUser = u;
        },
        setStaffActive: (uid: string, active: boolean) => {
          staffActiveByUser[uid] = active;
        },
        setPharmacyActive: (active: boolean) => {
          pharmacyActive = active;
        },
        setDbQueryError: (err: string | null) => {
          dbQueryError = err;
        },
        setThrowAuthErrorInGetState: (err: ConnectedAuthorizationError | null) => {
          throwAuthErrorInGetState = err;
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

    // 4a. Mid-session deactivation caught on refreshState() -> wipes state, signs out, locks out
    {
      const h = makeControllerHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-A1');

      h.setStaffActive(USER_A_ID, false);
      await h.controller.refreshState();

      const snap = h.getSnapshot();
      assert.equal(snap.authStatus, 'unauthorized');
      assert.equal(snap.repo, null);
      assert.equal(snap.authenticatedPharmacist, null);
      assert.equal(snap.state.patients.length, 0);
      assert.equal(snap.state.pharmacy.id, '');
      assert.equal(snap.signOutCalls, 1);
    }

    // 4b. Hydration throwing ConnectedAuthorizationError (inactive pharmacy) fails closed & wipes
    {
      const h = makeControllerHarness();
      h.setThrowAuthErrorInGetState(
        new ConnectedAuthorizationError('PHARMACY_INACTIVE', 'Pharmacy inactive')
      );
      await h.controller.signIn('a@test.iq', 'secret');

      const snap = h.getSnapshot();
      assert.equal(snap.authStatus, 'unauthorized');
      assert.equal(snap.repo, null);
      assert.equal(snap.authenticatedPharmacist, null);
      assert.equal(snap.state.patients.length, 0);
      assert.equal(snap.signOutCalls, 1);
    }

    // 4c. Account switching wipes User A's records immediately before User B finishes hydrating
    {
      const h = makeControllerHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-A1');

      const gateB = createDeferred<CrmState>();
      h.hydrationGates.set(USER_B_ID, gateB);
      const switchPromise = h.controller.signIn('b@test.iq', 'secret');

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, USER_B_ID);
      assert.equal(
        h.getSnapshot().state.patients.length,
        0,
        'User A patients must be cleared immediately when switching to User B'
      );

      const stateB = createEmptyConnectedCrmState();
      stateB.pharmacy = makeAuthContext(USER_B_ID).pharmacy;
      stateB.activeStaffId = USER_B_ID;
      stateB.patients = [
        {
          id: 'patient-b',
          patientCode: 'PAT-B1',
          pharmacyId: PHARMACY_ID,
          fullName: 'Patient B',
          phone: '07701112233',
          phoneOwnerType: 'self',
          dateOfBirth: '1980-01-01',
          sex: 'female',
          chronicConditions: [],
          allergies: [],
          contactPreference: 'whatsapp',
          clinicalNotes: '',
          registrationDate: '2026-11-12',
          status: 'active',
        },
      ];
      gateB.resolve(stateB);
      await switchPromise;
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-B1');
    }

    // 4d. Transient DB_ERROR -> 'connection_error' (NOT 'unauthorized'), clears stale workspace,
    //     preserves auth session for retrySessionCheck()
    {
      const h = makeControllerHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      assert.equal(h.getSnapshot().state.patients.length, 1);

      h.setDbQueryError('network timeout');
      await h.controller.refreshState();

      const snapWhileDown = h.getSnapshot();
      assert.equal(
        snapWhileDown.authStatus,
        'connection_error',
        'Transient DB error must map to connection_error instead of unauthorized'
      );
      assert.equal(snapWhileDown.state.patients.length, 0, 'Stale private state must be cleared');
      assert.equal(snapWhileDown.repo, null);
      assert.equal(snapWhileDown.signOutCalls, 0, 'Transient DB error must not sign out');
      assert.equal(snapWhileDown.hasUnauthorizedSession, true);

      // Recover via retrySessionCheck() once DB is healthy again
      h.setDbQueryError(null);
      const recovered = await h.controller.retrySessionCheck();
      assert.equal(recovered, true);
      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-A1');
    }

    // 4e. handleRuntimeError locks out on 42501 when staff is deactivated, preserves when still active
    {
      const h = makeControllerHarness();
      await h.controller.signIn('a@test.iq', 'secret');

      const rlsErr = Object.assign(
        new Error('Permission or tenant RLS policy denied (update): denied'),
        { pgCode: '42501' }
      );
      assert.equal(isSupabaseRlsPermissionError(rlsErr), true);

      // Still active in DB -> stays authenticated
      const lockedActive = await h.controller.handleRuntimeError(rlsErr);
      assert.equal(lockedActive, false);
      assert.equal(h.getSnapshot().authStatus, 'authenticated');

      // Staff deactivated in DB -> runtime 42501 locks out immediately
      h.setStaffActive(USER_A_ID, false);
      const lockedRevoked = await h.controller.handleRuntimeError(rlsErr);
      assert.equal(lockedRevoked, true);
      assert.equal(h.getSnapshot().authStatus, 'unauthorized');
      assert.equal(h.getSnapshot().state.patients.length, 0);
    }

    console.log(
      '✓ 4. ConnectedSessionController: revocation, account switch, connection_error retry & runtime 42501 lockout verified'
    );
  }

  // --------------------------------------------------------------------------
  // 5. Connected Mode Disabled Features & DB-Aligned UI Guards
  // --------------------------------------------------------------------------
  {
    const authCtx = makeAuthContext();
    const repo = new SupabaseCrmRepository(makeRepoMockClient({}), authCtx);
    await assert.rejects(
      () => repo.issueInvitationAsync('patient-1', 'dob_and_phone_otp', '2026-11-12'),
      (err: unknown) =>
        err instanceof Stage2bSqlDependencyError && err.dependencyKey === 'patientActivationStage2c'
    );

    const patientDetailSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/views/PatientDetailView.tsx'),
      'utf8'
    );
    assert.equal(
      patientDetailSrc.includes('{!isConnectedMode && matchingEvent && ('),
      true,
      'PatientDetailView must gate Simulate Patient Confirm behind !isConnectedMode'
    );
    assert.equal(
      patientDetailSrc.includes('labTestName.trim().length < 2'),
      true,
      'PatientDetailView must enforce >= 2 character lab test name'
    );

    const patientModalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/modals/PatientFormModal.tsx'),
      'utf8'
    );
    assert.equal(
      patientModalSrc.includes('lockImmutableFields = Boolean(isConnectedMode && existingPatient)'),
      true,
      'PatientFormModal must lock immutable fields when editing in Connected Mode'
    );
    assert.equal(
      patientModalSrc.includes('effectivePatientCode.length < 3'),
      true,
      'PatientFormModal must enforce >= 3 character patientCode'
    );

    const wizardSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/modals/MedicationWizardModal.tsx'),
      'utf8'
    );
    assert.equal(
      wizardSrc.includes('changeReason.trim().length < 3'),
      true,
      'MedicationWizardModal must enforce >= 3 character regimen changeReason'
    );

    const followUpsSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/views/FollowUpsView.tsx'),
      'utf8'
    );
    assert.equal(
      followUpsSrc.includes('logSummary.trim().length < 2'),
      true,
      'FollowUpsView must enforce >= 2 character contact log summary'
    );

    console.log('✓ 5. Connected Mode disabled Stage 2C/simulation & DB-aligned UI guards verified');
  }

  // --------------------------------------------------------------------------
  // 6. Demo Mode Still Works & Environment Config Remains Safe
  // --------------------------------------------------------------------------
  {
    const adapter = new InMemoryCrmAdapter();
    const initial = adapter.getState();
    assert.equal(initial.patients.length > 0, true, 'Demo Mode seeded patients must remain intact');

    const created = adapter.addPatient({
      patientCode: 'MC-DEMO-900',
      fullName: 'مراجع تجريبي اختباري',
      phone: '07705556677',
      dateOfBirth: '1982-05-10',
      sex: 'male',
      chronicConditions: ['Type 2 Diabetes'],
      allergies: [],
      contactPreference: 'whatsapp',
      clinicalNotes: 'Demo verification',
      registrationDate: '2026-11-12',
    });
    assert.equal(created.patient.patientCode, 'MC-DEMO-900');

    const inv = adapter.issueInvitation(created.patient.id, 'dob_and_phone_otp', '2026-11-12');
    assert.ok(inv.invitation, 'Demo Mode issueInvitation must return an invitation');
    assert.equal(inv.invitation.status, 'pending');

    const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
    assert.equal(
      envExample.includes('VITE_ENABLE_SUPABASE_CRM="false"'),
      true,
      '.env.example must keep VITE_ENABLE_SUPABASE_CRM="false" by default'
    );
    assert.equal(
      envExample.includes('VITE_SUPABASE_URL="https://bkidngfzsubmyunacnju.supabase.co"'),
      true,
      '.env.example must point VITE_SUPABASE_URL to the disposable dev project'
    );
    assert.equal(
      envExample.includes('VITE_SUPABASE_PUBLISHABLE_KEY=""'),
      true,
      '.env.example must keep VITE_SUPABASE_PUBLISHABLE_KEY empty'
    );
    const nonCommentLines = envExample
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .join('\n');
    assert.equal(
      /service_role|sb_secret_|db_password|anon_secret/i.test(nonCommentLines),
      false,
      '.env.example non-comment lines must never expose secret variables'
    );

    console.log('✓ 6. Demo Mode workflows & .env.example safety verified');
  }

  // --------------------------------------------------------------------------
  // 7. Stage 2B.3A Final Session Safety Patch Regression Suite
  // --------------------------------------------------------------------------
  {
    const makeSafetyHarness = () => {
      let currentSessionUser: { id: string; email: string } | null = null;
      let getSessionError: { message: string } | null = null;
      let staffActiveByUser: Record<string, boolean> = {
        [USER_A_ID]: true,
        [USER_B_ID]: true,
      };
      let signOutCalls = 0;
      let signOutGate: ReturnType<typeof createDeferred<{ error: { message: string } | null }>> | null =
        null;
      let staffLookupGate: ReturnType<typeof createDeferred<void>> | null = null;
      const hydrationGates = new Map<string, ReturnType<typeof createDeferred<CrmState>>>();

      let authStatus: ConnectedAuthStatus = 'checking';
      let authError: string | null = null;
      let asyncError: string | null = null;
      let hasUnauthorizedSession = false;
      let authenticatedPharmacist: AuthenticatedPharmacistContext | null = null;
      let repo: IAsyncCrmRepository | null = null;
      let state: CrmState = createEmptyConnectedCrmState();
      let isLoading = true;
      let activeNav = 'dashboard';
      let selectedPatientId: string | null = null;

      const buildPatientState = (userId: string): CrmState => {
        const ctx = makeAuthContext(userId);
        const s = createEmptyConnectedCrmState();
        s.pharmacy = ctx.pharmacy;
        s.staff = [ctx.staff];
        s.activeStaffId = userId;
        s.patients = [
          {
            id: `patient-of-${userId}`,
            patientCode: userId === USER_B_ID ? 'PAT-B1' : 'PAT-A1',
            pharmacyId: ctx.pharmacyId,
            fullName: userId === USER_B_ID ? 'Patient B' : 'Patient A',
            phone: '07701112233',
            phoneOwnerType: 'self',
            dateOfBirth: '1980-01-01',
            sex: 'female',
            chronicConditions: [],
            allergies: [],
            contactPreference: 'whatsapp',
            clinicalNotes: '',
            registrationDate: '2026-11-12',
            status: 'active',
          },
        ];
        return s;
      };

      const client: SupabaseAuthLike = {
        auth: {
          async getSession() {
            if (getSessionError) {
              return { data: { session: null }, error: getSessionError };
            }
            return {
              data: {
                session: currentSessionUser ? ({ user: currentSessionUser } as never) : null,
              },
              error: null,
            };
          },
          async signInWithPassword({ email }) {
            const uid = email.startsWith('b@') ? USER_B_ID : USER_A_ID;
            currentSessionUser = { id: uid, email };
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
            if (signOutGate) {
              const res = await signOutGate.promise;
              currentSessionUser = null;
              return res;
            }
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
                        if (staffLookupGate) {
                          await staffLookupGate.promise;
                        }
                        return {
                          data: makeStaffRow({
                            id: val,
                            full_name: val === USER_B_ID ? 'User B' : 'User A',
                            is_active: staffActiveByUser[val] ?? false,
                          }),
                          error: null,
                        };
                      }
                      return {
                        data: makePharmacyRow({ is_active: true }),
                        error: null,
                      };
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
        createRepository: (_c, ctx) =>
          ({
            async getStateAsync() {
              const gate = hydrationGates.get(ctx.userId);
              if (gate) {
                return gate.promise;
              }
              return buildPatientState(ctx.userId);
            },
          }) as unknown as IAsyncCrmRepository,
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
            activeNav = 'dashboard';
            selectedPatientId = null;
          },
        },
      });

      return {
        client,
        controller,
        hydrationGates,
        buildPatientState,
        setCurrentSessionUser: (u: { id: string; email: string } | null) => {
          currentSessionUser = u;
        },
        setGetSessionError: (err: { message: string } | null) => {
          getSessionError = err;
        },
        setStaffActive: (uid: string, active: boolean) => {
          staffActiveByUser[uid] = active;
        },
        setSignOutGate: (
          gate: ReturnType<typeof createDeferred<{ error: { message: string } | null }>> | null
        ) => {
          signOutGate = gate;
        },
        setStaffLookupGate: (gate: ReturnType<typeof createDeferred<void>> | null) => {
          staffLookupGate = gate;
        },
        openPatientDetails: (patientId: string) => {
          activeNav = 'patient-detail';
          selectedPatientId = patientId;
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
          activeNav,
          selectedPatientId,
          signOutCalls,
        }),
      };
    };

    // 7a. Typed verifyActiveSessionMatchesUser distinguishes verified, missing, mismatched, error
    {
      const h = makeSafetyHarness();
      assert.equal((await verifyActiveSessionMatchesUser(h.client, USER_A_ID)).status, 'missing');

      h.setCurrentSessionUser({ id: USER_B_ID, email: 'b@test.iq' });
      const mismatched = await verifyActiveSessionMatchesUser(h.client, USER_A_ID);
      assert.equal(mismatched.status, 'mismatched');
      if (mismatched.status === 'mismatched') {
        assert.equal(mismatched.actualUserId, USER_B_ID);
      }

      h.setGetSessionError({ message: 'auth 503' });
      assert.equal((await verifyActiveSessionMatchesUser(h.client, USER_A_ID)).status, 'error');

      h.setGetSessionError(null);
      h.setCurrentSessionUser({ id: USER_A_ID, email: 'a@test.iq' });
      assert.equal((await verifyActiveSessionMatchesUser(h.client, USER_A_ID)).status, 'verified');
    }

    // 7b. Delayed sign-out request after authorization revocation + revocation while patient details visible
    {
      const h = makeSafetyHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      h.openPatientDetails(`patient-of-${USER_A_ID}`);
      assert.equal(h.getSnapshot().selectedPatientId, `patient-of-${USER_A_ID}`);
      assert.equal(h.getSnapshot().state.patients.length, 1);

      const signOutGate = createDeferred<{ error: { message: string } | null }>();
      let signOutResolved = false;
      void signOutGate.promise.then(() => {
        signOutResolved = true;
      });
      h.setSignOutGate(signOutGate);

      const runtimeRevokePromise = h.controller.handleRuntimeError(
        new ConnectedAuthorizationError('STAFF_INACTIVE', 'Staff disabled')
      );
      await Promise.resolve();

      // While signOut network request is STILL pending, sensitive data & navigation MUST already be cleared
      const snapWhileSignOutPending = h.getSnapshot();
      assert.equal(signOutResolved, false);
      assert.equal(snapWhileSignOutPending.signOutCalls, 1);
      assert.equal(snapWhileSignOutPending.authStatus, 'unauthorized');
      assert.equal(snapWhileSignOutPending.repo, null);
      assert.equal(snapWhileSignOutPending.authenticatedPharmacist, null);
      assert.equal(snapWhileSignOutPending.state.patients.length, 0);
      assert.equal(snapWhileSignOutPending.state.pharmacy.id, '');
      assert.equal(snapWhileSignOutPending.selectedPatientId, null);
      assert.equal(snapWhileSignOutPending.activeNav, 'dashboard');

      // Simulate Supabase emitting SIGNED_OUT during revocation sign-out: must NOT erase unauthorized banner
      await h.controller.handleAuthStateChange('SIGNED_OUT', null);
      assert.equal(h.getSnapshot().authStatus, 'unauthorized');

      signOutGate.resolve({ error: null });
      const handled = await runtimeRevokePromise;
      assert.equal(handled, true);
      assert.equal(h.getSnapshot().authStatus, 'unauthorized');

      // Also verify refreshState() revocation with delayed signOut while patient details are visible
      h.setSignOutGate(null);
      await h.controller.signIn('a@test.iq', 'secret');
      h.openPatientDetails(`patient-of-${USER_A_ID}`);
      h.setStaffActive(USER_A_ID, false);

      const signOutGate2 = createDeferred<{ error: { message: string } | null }>();
      let signOut2Resolved = false;
      void signOutGate2.promise.then(() => {
        signOut2Resolved = true;
      });
      h.setSignOutGate(signOutGate2);

      const refreshRevokePromise = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      const snapRefreshPending = h.getSnapshot();
      assert.equal(signOut2Resolved, false);
      assert.equal(snapRefreshPending.authStatus, 'unauthorized');
      assert.equal(snapRefreshPending.repo, null);
      assert.equal(snapRefreshPending.authenticatedPharmacist, null);
      assert.equal(snapRefreshPending.state.patients.length, 0);
      assert.equal(snapRefreshPending.selectedPatientId, null);
      assert.equal(snapRefreshPending.activeNav, 'dashboard');

      signOutGate2.resolve({ error: null });
      await refreshRevokePromise;
    }

    // 7c. Session mismatch & permanent session loss after successful database hydration
    {
      const h = makeSafetyHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      h.openPatientDetails(`patient-of-${USER_A_ID}`);

      const gateA = createDeferred<CrmState>();
      h.hydrationGates.set(USER_A_ID, gateA);
      const refreshPromise = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      // Session switches externally without matching expectedUserId before post-hydration check
      h.setCurrentSessionUser({ id: USER_B_ID, email: 'b@test.iq' });
      gateA.resolve(h.buildPatientState(USER_A_ID));
      await refreshPromise;

      const snapMismatch = h.getSnapshot();
      assert.equal(snapMismatch.authStatus, 'unauthenticated');
      assert.equal(snapMismatch.repo, null);
      assert.equal(snapMismatch.authenticatedPharmacist, null);
      assert.equal(snapMismatch.state.patients.length, 0);
      assert.equal(snapMismatch.state.pharmacy.id, '');
      assert.equal(snapMismatch.selectedPatientId, null);
      assert.equal(snapMismatch.activeNav, 'dashboard');

      // Also test permanent session loss (session becomes null during hydration)
      h.hydrationGates.delete(USER_A_ID);
      await h.controller.signIn('a@test.iq', 'secret');
      h.openPatientDetails(`patient-of-${USER_A_ID}`);
      const gateLoss = createDeferred<CrmState>();
      h.hydrationGates.set(USER_A_ID, gateLoss);
      const refreshLoss = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      h.setCurrentSessionUser(null);
      gateLoss.resolve(h.buildPatientState(USER_A_ID));
      await refreshLoss;

      assert.equal(h.getSnapshot().authStatus, 'unauthenticated');
      assert.equal(h.getSnapshot().state.patients.length, 0);
      assert.equal(h.getSnapshot().selectedPatientId, null);
    }

    // 7d. Temporary session verification failure & successful recovery after temporary failure
    {
      const h = makeSafetyHarness();
      await h.controller.signIn('a@test.iq', 'secret');
      h.openPatientDetails(`patient-of-${USER_A_ID}`);

      const gateA = createDeferred<CrmState>();
      h.hydrationGates.set(USER_A_ID, gateA);
      const refreshPromise = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      // Temporary auth service failure on post-hydration getSession()
      h.setGetSessionError({ message: 'temporary auth timeout' });
      gateA.resolve(h.buildPatientState(USER_A_ID));
      await refreshPromise;

      const snapError = h.getSnapshot();
      assert.equal(snapError.authStatus, 'connection_error');
      assert.ok(snapError.authError);
      assert.equal(snapError.repo, null);
      assert.equal(snapError.authenticatedPharmacist, null);
      assert.equal(snapError.state.patients.length, 0);
      assert.equal(snapError.selectedPatientId, null);
      assert.equal(snapError.signOutCalls, 0);

      // Failed retry still keeps workspace empty
      const failedRetry = await h.controller.retrySessionCheck();
      assert.equal(failedRetry, false);
      assert.equal(h.getSnapshot().authStatus, 'connection_error');
      assert.equal(h.getSnapshot().state.patients.length, 0);

      // Recovery only restores workspace once auth service recovers & verifies session
      h.hydrationGates.delete(USER_A_ID);
      h.setGetSessionError(null);
      const recovered = await h.controller.retrySessionCheck();
      assert.equal(recovered, true);
      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, USER_A_ID);
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-A1');
    }

    // 7e. Delayed requests completing after account switching (both state resolution & error)
    {
      const h = makeSafetyHarness();
      await h.controller.signIn('a@test.iq', 'secret');

      const slowGateA = createDeferred<CrmState>();
      h.hydrationGates.set(USER_A_ID, slowGateA);
      const slowRefreshA = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      // Account switches to User B via auth event while User A's refresh is still in flight
      h.setCurrentSessionUser({ id: USER_B_ID, email: 'b@test.iq' });
      await h.controller.handleAuthStateChange('SIGNED_IN', {
        user: { id: USER_B_ID, email: 'b@test.iq' },
      } as never);

      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, USER_B_ID);
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-B1');

      // Delayed User A response arrives after User B is active -> must be ignored
      slowGateA.resolve(h.buildPatientState(USER_A_ID));
      await slowRefreshA;

      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, USER_B_ID);
      assert.equal(h.getSnapshot().state.patients.length, 1);
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-B1');

      // Delayed User A error after another switch must also not disrupt active User B
      const slowErrGateA = createDeferred<CrmState>();
      h.setCurrentSessionUser({ id: USER_A_ID, email: 'a@test.iq' });
      h.hydrationGates.delete(USER_A_ID);
      await h.controller.signIn('a@test.iq', 'secret');
      h.hydrationGates.set(USER_A_ID, slowErrGateA);
      const slowErrRefreshA = h.controller.refreshState();
      await new Promise((r) => setTimeout(r, 10));

      h.setCurrentSessionUser({ id: USER_B_ID, email: 'b@test.iq' });
      await h.controller.handleAuthStateChange('SIGNED_IN', {
        user: { id: USER_B_ID, email: 'b@test.iq' },
      } as never);
      slowErrGateA.reject(new ConnectedAuthorizationError('STAFF_INACTIVE', 'Stale user A revoked'));
      await slowErrRefreshA;

      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().authenticatedPharmacist?.userId, USER_B_ID);
      assert.equal(h.getSnapshot().state.patients[0]?.patientCode, 'PAT-B1');
    }

    // 7f. No private workspace exposure while authorization is unresolved
    {
      const h = makeSafetyHarness();
      h.setCurrentSessionUser({ id: USER_A_ID, email: 'a@test.iq' });
      const staffGate = createDeferred<void>();
      h.setStaffLookupGate(staffGate);

      const restorePromise = h.controller.restoreInitialSession();
      await Promise.resolve();

      const snapPending = h.getSnapshot();
      assert.equal(snapPending.authStatus, 'checking');
      assert.equal(snapPending.repo, null);
      assert.equal(snapPending.authenticatedPharmacist, null);
      assert.equal(snapPending.state.patients.length, 0);
      assert.equal(snapPending.state.pharmacy.id, '');

      // Verify App.tsx ConnectedModeGate requires both authStatus === 'authenticated' and state.pharmacy.id
      const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
      assert.equal(
        appSrc.includes("if (authStatus === 'checking')") && appSrc.includes('if (!state.pharmacy.id)'),
        true,
        'App.tsx must block AppShell rendering until authStatus is authenticated and state.pharmacy.id is hydrated'
      );

      staffGate.resolve();
      const restored = await restorePromise;
      assert.equal(restored, true);
      assert.equal(h.getSnapshot().authStatus, 'authenticated');
      assert.equal(h.getSnapshot().state.pharmacy.id, PHARMACY_ID);
    }

    console.log('✓ 7. Stage 2B.3A session safety regression scenarios verified');
  }

  console.log('ALL STAGE 2B.3 CONNECTED MODE HARDENING CHECKS PASSED.');
}

void runTests().catch((err) => {
  console.error('Stage 2B.3 test failure:', err);
  process.exit(1);
});
