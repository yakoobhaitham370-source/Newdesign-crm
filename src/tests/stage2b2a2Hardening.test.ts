// ============================================================================
// MASAR Care — Stage 2B.2A.2 Final Pre-Deployment Hardening Tests (OFFLINE)
// Covers Independent Audit Findings H1–H5, M1, and D1:
//   - H1: Direct-write bypass removal in Migration 0003 (preserving 0001/0002)
//   - H2: PostgreSQL 17 `RESET ROLE;` fix & zero `reset_config` in SQL tests
//   - H3: Clean-state bootstrap SQL test split from post-bootstrap SQL suite
//   - H4: Durable `owner-provision-staff` claim, DB inspection & reconciliation
//   - H5: Browser-callable CORS + OPTIONS preflight on `owner-provision-staff`
//   - M1: Non-bypassable `consultation_threads` audit trigger (no GUC skip)
//   - D1 & Approval Plan: Stage 2B.2B gate sequence, 24 tables & mobile order
// NO live database, Edge runtime, or Auth endpoint is contacted.
// ============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AdminSupabaseLike,
  buildStaffProvisioningCorsHeaders,
  handleOwnerProvisionStaff,
} from '../../supabase/functions/_shared/adminProvisioningLogic';
import { STAGE2B_SQL_DEPENDENCIES } from '../services/supabaseCrmRepository';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function makeStage2b2a2AdminSupabase(options: {
  claimResult?: { data: unknown; error: { message: string; code?: string } | null };
  provisionResult?: (uid: string) => { data: unknown; error: { message: string; code?: string } | null };
  inspectResult?: (uid: string) => { data: unknown; error: { message: string; code?: string } | null };
  deleteUserFails?: boolean;
}) {
  const createdUsers: string[] = [];
  const deletedUsers: string[] = [];
  const reconciliationUpdates: Array<Record<string, unknown>> = [];
  let seq = 1;

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
          const uid = `dddddddd-dddd-4ddd-8ddd-${String(seq++).padStart(12, '0')}`;
          createdUsers.push(uid);
          return { data: { user: { id: uid, email } }, error: null };
        },
        async deleteUser(userId: string) {
          if (options.deleteUserFails) {
            return { data: null, error: { message: 'Auth admin service timeout' } };
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
                const isOwner = filters.some(([c, v]) => c === 'id' && v === OWNER_ID);
                if (isOwner) {
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
      if (fn === 'claim_staff_provisioning_request') {
        if (options.claimResult) return options.claimResult;
        return { data: { ok: true, claimId: args.p_request_id, status: 'claimed' }, error: null };
      }
      if (fn === 'inspect_staff_provisioning_state') {
        const lastUid = createdUsers[createdUsers.length - 1] ?? '';
        if (options.inspectResult) return options.inspectResult(lastUid);
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
  console.log('MASAR Care — Stage 2B.2A.2 Final Pre-Deployment Hardening Tests');
  console.log('MODE: OFFLINE MOCKED & STATIC VERIFICATION ONLY (NO LIVE DB)');
  console.log('===================================================================');

  let passed = 0;

  const baseStaffPayload = {
    email: 'staff.2a2@alshifa.iq',
    password: 'StrongStaffPassword2026!',
    fullName: 'د. ريم الحسيني',
    phone: '07705556677',
    role: 'authorized_pharmacist',
    syndicateLicense: 'SYN-IQ-2A2-1',
  };

  // --------------------------------------------------------------------------
  // SUITE 1 (Audit H4): Durable Staff Provisioning Claim & Safe Reconciliation
  // --------------------------------------------------------------------------
  {
    // 1. Missing/too-short Idempotency-Key returns 400 before Auth user creation
    const missingIdemMock = makeStage2b2a2AdminSupabase({});
    const missingIdemRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer owner-jwt', 'idempotency-key': 'too-short' }),
      rawBody: baseStaffPayload,
      adminClient: missingIdemMock.client,
    });
    assert.equal(missingIdemRes.status, 400);
    assert.equal(missingIdemRes.body.errorCode, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(missingIdemMock.createdUsers.length, 0);

    // 2. Concurrent retry conflict (STAFF_PROVISIONING_IN_PROGRESS / ALREADY_COMPLETED) returns 409 without duplicate Auth user
    for (const errCode of [
      'STAFF_PROVISIONING_IN_PROGRESS',
      'STAFF_PROVISIONING_ALREADY_COMPLETED',
    ]) {
      const conflictMock = makeStage2b2a2AdminSupabase({
        claimResult: { data: { ok: false, errorCode: errCode }, error: null },
      });
      const conflictRes = await handleOwnerProvisionStaff({
        method: 'POST',
        headers: new Headers({
          authorization: 'Bearer owner-jwt',
          'idempotency-key': 'idem-key-h4-staff-conflict-0001',
        }),
        rawBody: baseStaffPayload,
        adminClient: conflictMock.client,
      });
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.body.errorCode, errCode);
      assert.equal(conflictMock.createdUsers.length, 0);
    }

    // 3. Ambiguous/lost RPC response where inspect proves `pharmacy_staff` COMMITTED
    //    MUST preserve Auth user (`deletedUsers.length === 0`) and return reconciled 201!
    const committedLostMock = makeStage2b2a2AdminSupabase({
      provisionResult: () => ({
        data: null,
        error: { message: 'Gateway 504 timeout after DB commit' },
      }),
      inspectResult: (uid) => ({
        data: {
          status: 'completed',
          pharmacyId: PHARMACY_ID,
          staffExistsInDb: true,
          staffId: uid,
          staffRole: 'authorized_pharmacist',
        },
        error: null,
      }),
    });
    const committedLostRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h4-staff-committed-lost-0002',
      }),
      rawBody: baseStaffPayload,
      adminClient: committedLostMock.client,
    });
    assert.equal(committedLostRes.status, 201);
    assert.equal(committedLostRes.body.ok, true);
    assert.equal(committedLostRes.body.reconciledFromAmbiguousProvisioning, true);
    assert.equal(committedLostRes.body.staffId, committedLostMock.createdUsers[0]);
    assert.equal(
      committedLostMock.deletedUsers.length,
      0,
      'Must NEVER delete Auth user when inspect_staff_provisioning_state confirms DB committed'
    );

    // 4. Ambiguous RPC + inspect failure preserves Auth user & logs RECONCILIATION_REQUIRED
    const inspectFailMock = makeStage2b2a2AdminSupabase({
      provisionResult: () => ({ data: null, error: { message: 'Transient socket reset' } }),
      inspectResult: () => ({ data: null, error: { message: 'Inspect RPC timed out' } }),
    });
    const inspectFailRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h4-staff-inspect-fail-0003',
      }),
      rawBody: baseStaffPayload,
      adminClient: inspectFailMock.client,
    });
    assert.equal(inspectFailRes.status, 500);
    assert.equal(inspectFailRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.equal(inspectFailMock.deletedUsers.length, 0);
    assert.equal(
      inspectFailMock.reconciliationUpdates[0]?.p_new_status,
      'failed_needs_reconciliation'
    );

    // 5. DB confirmed untouched + Auth deleteUser failure -> marks reconciliation & returns orphanAuthUserId
    const deleteFailMock = makeStage2b2a2AdminSupabase({
      provisionResult: () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }),
      inspectResult: () => ({
        data: { status: 'claimed', pharmacyId: null, staffExistsInDb: false, staffId: null },
        error: null,
      }),
      deleteUserFails: true,
    });
    const deleteFailRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': 'idem-key-h4-staff-delete-fail-0004',
      }),
      rawBody: baseStaffPayload,
      adminClient: deleteFailMock.client,
    });
    assert.equal(deleteFailRes.status, 500);
    assert.equal(deleteFailRes.body.errorCode, 'RECONCILIATION_REQUIRED');
    assert.equal(deleteFailRes.body.orphanAuthUserId, deleteFailMock.createdUsers[0]);
    assert.equal(
      deleteFailMock.reconciliationUpdates[0]?.p_new_status,
      'failed_needs_reconciliation'
    );

    passed++;
    console.log('✓ Suite 1 (H4): Durable staff provisioning claim, lost-commit recovery & reconciliation verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 2 (Audit H5): Browser-Callable CORS & OPTIONS Preflight Behavior
  // --------------------------------------------------------------------------
  {
    const defaultCors = buildStaffProvisioningCorsHeaders('https://crm.masar.iq');
    assert.equal(defaultCors['Access-Control-Allow-Origin'], 'null');
    assert.equal(defaultCors['Access-Control-Allow-Methods'], 'POST, OPTIONS');
    assert.equal(
      defaultCors['Access-Control-Allow-Headers'].includes('idempotency-key'),
      true
    );

    const allowedCors = buildStaffProvisioningCorsHeaders(
      'https://crm.masar.iq',
      'https://crm.masar.iq, http://localhost:3000'
    );
    assert.equal(allowedCors['Access-Control-Allow-Origin'], 'https://crm.masar.iq');
    assert.equal(allowedCors.Vary, 'Origin');

    const deniedCors = buildStaffProvisioningCorsHeaders(
      'https://evil.example.com',
      'https://crm.masar.iq'
    );
    assert.equal(deniedCors['Access-Control-Allow-Origin'], 'null');
    assert.equal(deniedCors.Vary, 'Origin');

    const corsMock = makeStage2b2a2AdminSupabase({});
    const preflightRes = await handleOwnerProvisionStaff({
      method: 'OPTIONS',
      headers: new Headers({ origin: 'https://crm.masar.iq' }),
      rawBody: null,
      adminClient: corsMock.client,
      allowedOrigins: 'https://crm.masar.iq',
    });
    assert.equal(preflightRes.status, 200);
    assert.equal(preflightRes.headers?.['Access-Control-Allow-Origin'], 'https://crm.masar.iq');
    assert.equal(preflightRes.headers?.['Access-Control-Allow-Methods'], 'POST, OPTIONS');

    const unauthErrRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({ origin: 'https://crm.masar.iq' }),
      rawBody: baseStaffPayload,
      adminClient: corsMock.client,
      allowedOrigins: 'https://crm.masar.iq',
    });
    assert.equal(unauthErrRes.status, 401);
    assert.equal(
      unauthErrRes.headers?.['Access-Control-Allow-Origin'],
      'https://crm.masar.iq',
      'Error responses must carry CORS headers so browser CRM sees 401/403/500 JSON'
    );

    const staffEntry = fs.readFileSync(
      path.join(process.cwd(), 'supabase/functions/owner-provision-staff/index.ts'),
      'utf8'
    );
    assert.equal(staffEntry.includes('handleOwnerProvisionStaffHttpRequest'), true);
    assert.equal(staffEntry.includes('MASAR_CORS_ALLOWED_ORIGINS'), true);
    assert.equal(staffEntry.includes('requireAllowlist: true'), true);

    passed++;
    console.log('✓ Suite 2 (H5): owner-provision-staff CORS preflight & error-header behavior verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 3 (Audit H1 & M1): Static Migration 0003 Bypass Closure & Trigger Lock
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    const sql0001 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0001_stage2a_core_schema.sql'),
      'utf8'
    );
    const sql0002 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0002_stage2a_rls_and_security.sql'),
      'utf8'
    );
    const sql0003 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );

    // 0001 & 0002 remain Stage 2A historical baselines (zero Stage 2B table leakage)
    assert.equal(sql0001.includes('bootstrap_state'), false);
    assert.equal(sql0002.includes('staff_provisioning_requests'), false);

    // H1: Additive direct-write revocation on all 7 RPC-governed tables + narrowed patients UPDATE
    for (const tbl of [
      'patient_conditions',
      'patient_allergies',
      'patient_medication_plans',
      'regimen_versions',
      'medication_pause_periods',
      'dispensing_events',
      'refill_assessments',
    ]) {
      assert.equal(
        sql0003.includes(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${tbl} FROM authenticated;`),
        true,
        `0003 must revoke direct writes on ${tbl}`
      );
    }

    assert.equal(
      sql0003.includes('REVOKE INSERT, UPDATE, DELETE ON TABLE public.patients FROM authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes(
        'GRANT UPDATE (status, archived_at, archived_reason, updated_at) ON public.patients TO authenticated;'
      ),
      true
    );
    assert.equal(
      sql0003.includes('DROP POLICY IF EXISTS conditions_pharmacist_write ON public.patient_conditions;'),
      true
    );
    assert.equal(
      sql0003.includes('DROP POLICY IF EXISTS patients_pharmacist_insert ON public.patients;'),
      true
    );
    assert.equal(
      sql0003.includes('CREATE POLICY consultation_messages_patient_only_direct_insert ON public.consultation_messages'),
      true
    );
    assert.equal(sql0003.includes('AS RESTRICTIVE'), true);

    // H4: Durable staff_provisioning_requests table locked down (service_role only, forced RLS)
    assert.equal(sql0003.includes('CREATE TABLE IF NOT EXISTS public.staff_provisioning_requests'), true);
    assert.equal(
      sql0003.includes('REVOKE ALL ON TABLE public.staff_provisioning_requests FROM PUBLIC, anon, authenticated;'),
      true
    );
    assert.equal(
      sql0003.includes('ALTER TABLE public.staff_provisioning_requests FORCE ROW LEVEL SECURITY;'),
      true
    );

    // M1: Completely eliminate caller-controllable session GUC bypass
    assert.equal(
      sql0003.includes('skip_thread_audit_trigger'),
      false,
      '0003 must completely remove masar.skip_thread_audit_trigger session GUC bypass'
    );

    passed++;
    console.log('✓ Suite 3 (H1/M1): Migration 0003 direct-write bypass closure & trigger integrity verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 4 (Audit H2 & H3): SQL Test PG17 Compatibility & Clean/Post Split
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    const postSql = fs.readFileSync(
      path.join(root, 'supabase/tests/stage2b_0003_negative_and_integrity.test.sql'),
      'utf8'
    );
    const cleanSql = fs.readFileSync(
      path.join(root, 'supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql'),
      'utf8'
    );

    // H2: No nonexistent `reset_config(...)` calls; uses PG17 `RESET ROLE;` + restored verification
    assert.equal(/\breset_config\s*\(/i.test(postSql), false);
    assert.equal(postSql.includes('RESET ROLE;'), true);
    assert.equal(postSql.includes('current_user IS DISTINCT FROM v_orig_user'), true);

    // H3: Clean-state preconditions checked before bootstrap, post-bootstrap runs inside ROLLBACK
    assert.equal(cleanSql.includes('CLEAN-STATE PRECONDITION FAILED'), true);
    assert.equal(cleanSql.includes('ROLLBACK;'), true);
    assert.equal(postSql.includes('v_table_count <> 24'), true);
    assert.equal(postSql.includes('v_bypass_write_privs <> 0'), true);
    assert.equal(postSql.includes("masar.skip_thread_audit_trigger', '1'"), true);
    assert.equal(postSql.includes('ROLLBACK;'), true);

    passed++;
    console.log('✓ Suite 4 (H2/H3): PG17 RESET ROLE & clean-state/post-bootstrap SQL split verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 5 (Docs & Approval Plan): Stage 2B.2A.2 Consistency & Rollout Gate
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    const reportDoc = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A2_PRE_DEPLOYMENT_REPORT.md'),
      'utf8'
    );
    const approvalPlan = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md'),
      'utf8'
    );
    const handoff = fs.readFileSync(path.join(root, 'docs/MASAR_CARE_HANDOFF.md'), 'utf8');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

    assert.ok(
      STAGE2B_SQL_DEPENDENCIES.scheduledDoseMaterializationPreAndroid.objectName.includes(
        'scheduled_doses'
      )
    );
    assert.equal(envExample.includes('VITE_ENABLE_SUPABASE_CRM="false"'), true);

    assert.equal(reportDoc.includes('Confirmed Code/SQL Defects') && reportDoc.includes('Design Risks'), true);
    assert.equal(approvalPlan.includes('stage2b_0003_bootstrap_clean_state.test.sql'), true);
    assert.equal(approvalPlan.includes('24 / 24'), true);
    assert.equal(approvalPlan.includes('supabase functions delete bootstrap-first-owner'), true);
    assert.equal(handoff.includes('V1.5.5-Stage2B.2A.3'), true);
    assert.equal(handoff.includes('Kotlin') && handoff.includes('PWA') && handoff.includes('scheduled_doses'), true);
    assert.equal(readme.includes('V1.5.5-Stage2B.2A.3'), true);

    passed++;
    console.log('✓ Suite 5: Stage 2B.2A.2 docs, 24-table gate sequence & rollout order verified');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.2A.2 FINAL HARDENING SUITES PASSED`);
  console.log('MODE: OFFLINE MOCKED & STATIC CHECKS ONLY (bkidngfzsubmyunacnju UNTOUCHED)');
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.2A.2 hardening test suite failed:', err);
  process.exit(1);
});
