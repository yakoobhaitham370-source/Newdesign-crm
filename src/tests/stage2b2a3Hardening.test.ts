// ============================================================================
// MASAR Care — Stage 2B.2A.3 Final Targeted Release Patch Tests (OFFLINE)
// Covers Independent Stage 2B.2A.2 Review Findings:
//   - Issue A: Block forged pharmacist approval on `consultation_messages`
//              (provenance helper + repository projection + 0003 CHECK/RLS + SQL draft tests)
//   - Issue B: Immutable `(pharmacy_id, idempotency_key)` canonical fingerprint,
//              conservative TTL expiration escalation & claimless provisioning block
//   - Concern C: `supabase/config.toml` (`verify_jwt = false` + rationale), strict
//                `MASAR_CORS_ALLOWED_ORIGINS` allowlist (never `*`), anonymous OPTIONS,
//                unauthorized POST, valid owner POST, disallowed Origin & malformed JSON
//   - Asset Cleanup & Release Readiness Docs: internal audits moved out of `public/`
//     into `docs/`, separate Gate A (`0003` alone) vs Gate B (Edge + fictional setup)
// NO live database, Edge runtime, or Auth endpoint is contacted.
// ============================================================================

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AdminSupabaseLike,
  handleOwnerProvisionStaff,
  handleOwnerProvisionStaffHttpRequest,
} from '../../supabase/functions/_shared/adminProvisioningLogic';
import { AuthenticatedPharmacistContext } from '../services/authService';
import { isVerifiedPharmacistApproval } from '../services/consultationApproval';
import { SupabaseCrmRepository } from '../services/supabaseCrmRepository';
import { ConsultationMessage } from '../types/domain';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ALLOWED_ORIGIN = 'https://crm.masar.iq';
const EVIL_ORIGIN = 'https://evil.example.com';

function makeAuthContext(): AuthenticatedPharmacistContext {
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
      phone: '07701234567',
      isActive: true,
    },
    pharmacy: {
      id: PHARMACY_ID,
      nameAr: 'صيدلية الشفاء',
      nameEn: 'Al-Shifa Pharmacy',
      city: 'بغداد',
      governorate: 'بغداد',
      licenseNumber: 'IQ-TEST-01',
      phone: '07701234567',
      timezone: 'Asia/Baghdad',
    },
  };
}

function makeConsultationProvenanceMockClient(): SupabaseClient {
  const threadId = '33333333-3333-4333-8333-333333333333';
  const tables: Record<string, Array<Record<string, unknown>>> = {
    pharmacy_staff: [
      {
        id: OWNER_ID,
        pharmacy_id: PHARMACY_ID,
        full_name: 'د. نور المالك',
        role: 'pharmacy_owner',
        syndicate_license: 'SYN-1',
        phone: '07701234567',
        is_active: true,
      },
    ],
    consultation_threads: [
      {
        id: threadId,
        pharmacy_id: PHARMACY_ID,
        patient_id: '44444444-4444-4444-8444-444444444444',
        subject: 'استشارة جرعة',
        status: 'open',
        updated_at: '2026-11-14T10:00:00Z',
      },
    ],
    consultation_messages: [
      {
        id: 'msg-forged-patient',
        pharmacy_id: PHARMACY_ID,
        thread_id: threadId,
        sender_type: 'patient',
        sender_staff_id: null,
        sender_name: 'مريض',
        body: 'Forged approval flag on patient message',
        approved_by_pharmacist: true,
        sent_at: '2026-11-14T10:01:00Z',
      },
      {
        id: 'msg-malformed-pharmacist-no-staff-id',
        pharmacy_id: PHARMACY_ID,
        thread_id: threadId,
        sender_type: 'pharmacist',
        sender_staff_id: null,
        sender_name: 'مجهول',
        body: 'Pharmacist message missing sender_staff_id',
        approved_by_pharmacist: true,
        sent_at: '2026-11-14T10:02:00Z',
      },
      {
        id: 'msg-valid-pharmacist',
        pharmacy_id: PHARMACY_ID,
        thread_id: threadId,
        sender_type: 'pharmacist',
        sender_staff_id: OWNER_ID,
        sender_name: 'د. نور المالك',
        body: 'الرد المعتمد من الصيدلي',
        approved_by_pharmacist: true,
        sent_at: '2026-11-14T10:03:00Z',
      },
    ],
  };

  return {
    from(table: string) {
      return {
        select() {
          const chain = {
            eq() {
              return chain;
            },
            order() {
              return chain;
            },
            maybeSingle: async () => {
              if (table === 'pharmacies') {
                return {
                  data: {
                    id: PHARMACY_ID,
                    name_ar: 'صيدلية الشفاء',
                    name_en: 'Al-Shifa Pharmacy',
                    city: 'بغداد',
                    governorate: 'بغداد',
                    license_number: 'IQ-TEST-01',
                    phone: '07701234567',
                    timezone: 'Asia/Baghdad',
                    is_active: true,
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
            range: async () => ({
              data: tables[table] ?? [],
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
}

interface ClaimRow {
  pharmacyId: string;
  ownerUserId: string;
  idempotencyKey: string;
  requestId: string;
  targetEmail: string;
  targetPhone: string;
  targetRole: string;
  requestFingerprint: string;
  status: 'claimed' | 'completed' | 'rolled_back' | 'failed_needs_reconciliation';
  claimExpiresAtMs: number | null;
  staffUserId: string | null;
  lastError: string | null;
}

function computeCanonicalFingerprint(params: {
  pharmacyId: string;
  ownerUserId: string;
  email: string;
  phone: string;
  role: string;
}): string {
  const payload = JSON.stringify([
    params.pharmacyId,
    params.ownerUserId,
    params.email.trim().toLowerCase(),
    params.phone.trim(),
    params.role.trim(),
  ]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function makeStatefulStaffProvisioningAdminMock() {
  const createdUsers: Array<{ id: string; email: string }> = [];
  const deletedUsers: string[] = [];
  const staffTable: Array<Record<string, unknown>> = [
    {
      id: OWNER_ID,
      pharmacy_id: PHARMACY_ID,
      full_name: 'د. نور المالك',
      role: 'pharmacy_owner',
      phone: '07701234567',
      syndicate_license: 'SYN-OWNER-1',
      is_active: true,
    },
  ];
  const claims = new Map<string, ClaimRow>();
  let nowMs = 1_700_000_000_000;
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
          const id = `eeeeeeee-eeee-4eee-8eee-${String(seq++).padStart(12, '0')}`;
          createdUsers.push({ id, email });
          return { data: { user: { id, email } }, error: null };
        },
        async deleteUser(userId: string) {
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
                const match =
                  staffTable.find((row) => filters.every(([col, val]) => row[col] === val)) ?? null;
                return { data: match, error: null };
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
        const ownerId = String(args.p_owner_user_id ?? '');
        const key = String(args.p_idempotency_key ?? '').trim();
        const requestId = String(args.p_request_id ?? '');
        const email = String(args.p_target_email ?? '').trim().toLowerCase();
        const phone = String(args.p_target_phone ?? '').trim();
        const role = String(args.p_target_role ?? 'authorized_pharmacist').trim();
        const ttlSec = Number(args.p_claim_ttl_seconds ?? 120);

        const fp = computeCanonicalFingerprint({
          pharmacyId: PHARMACY_ID,
          ownerUserId: ownerId,
          email,
          phone,
          role,
        });

        const existing = claims.get(`${PHARMACY_ID}:${key}`);
        if (existing) {
          if (
            existing.requestFingerprint !== fp ||
            existing.ownerUserId !== ownerId ||
            existing.targetEmail !== email ||
            existing.targetPhone !== phone ||
            existing.targetRole !== role
          ) {
            return {
              data: {
                ok: false,
                errorCode: 'STAFF_IDEMPOTENCY_KEY_CONFLICT',
                existingStatus: existing.status,
                requestId: existing.requestId,
                staffId: existing.staffUserId,
              },
              error: null,
            };
          }

          if (existing.status === 'completed') {
            return {
              data: {
                ok: false,
                errorCode: 'STAFF_PROVISIONING_ALREADY_COMPLETED',
                staffId: existing.staffUserId,
                pharmacyId: existing.pharmacyId,
                role: existing.targetRole,
              },
              error: null,
            };
          }

          if (existing.status === 'failed_needs_reconciliation') {
            return {
              data: {
                ok: false,
                errorCode: 'STAFF_PROVISIONING_NEEDS_RECONCILIATION',
                requestId: existing.requestId,
                lastError: existing.lastError,
              },
              error: null,
            };
          }

          if (existing.status === 'claimed') {
            if (existing.claimExpiresAtMs !== null && existing.claimExpiresAtMs > nowMs) {
              return {
                data: {
                  ok: false,
                  errorCode: 'STAFF_PROVISIONING_IN_PROGRESS',
                  claimedByRequestId: existing.requestId,
                },
                error: null,
              };
            }
            existing.status = 'failed_needs_reconciliation';
            existing.claimExpiresAtMs = null;
            existing.lastError =
              'Staff provisioning claim TTL expired before completion or rollback; Auth/DB reconciliation required.';
            return {
              data: {
                ok: false,
                errorCode: 'STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED',
                expiredRequestId: existing.requestId,
                status: 'failed_needs_reconciliation',
              },
              error: null,
            };
          }

          existing.requestId = requestId;
          existing.status = 'claimed';
          existing.claimExpiresAtMs = nowMs + ttlSec * 1000;
          existing.lastError = null;
          return {
            data: {
              ok: true,
              claimId: requestId,
              pharmacyId: PHARMACY_ID,
              requestFingerprint: fp,
              status: 'claimed',
            },
            error: null,
          };
        }

        claims.set(`${PHARMACY_ID}:${key}`, {
          pharmacyId: PHARMACY_ID,
          ownerUserId: ownerId,
          idempotencyKey: key,
          requestId,
          targetEmail: email,
          targetPhone: phone,
          targetRole: role,
          requestFingerprint: fp,
          status: 'claimed',
          claimExpiresAtMs: nowMs + ttlSec * 1000,
          staffUserId: null,
          lastError: null,
        });

        return {
          data: {
            ok: true,
            claimId: requestId,
            pharmacyId: PHARMACY_ID,
            requestFingerprint: fp,
            status: 'claimed',
          },
          error: null,
        };
      }

      if (fn === 'reconcile_expired_staff_provisioning_claim') {
        const reqId = String(args.p_request_id ?? '');
        const authUserExists = Boolean(args.p_auth_user_exists);
        const match = Array.from(claims.values()).find((c) => c.requestId === reqId);
        if (!match) {
          return { data: { ok: false, errorCode: 'STAFF_REQUEST_NOT_FOUND' }, error: null };
        }
        if (authUserExists) {
          match.status = 'failed_needs_reconciliation';
          return {
            data: {
              ok: false,
              errorCode: 'STAFF_PROVISIONING_NEEDS_RECONCILIATION',
              status: 'failed_needs_reconciliation',
            },
            error: null,
          };
        }
        match.status = 'rolled_back';
        match.claimExpiresAtMs = null;
        match.lastError = null;
        return { data: { ok: true, status: 'rolled_back' }, error: null };
      }

      if (fn === 'provision_pharmacy_staff_by_owner') {
        const reqId = args.p_request_id ? String(args.p_request_id) : null;
        if (!reqId) {
          return {
            data: null,
            error: {
              code: '23514',
              message:
                'Owner, new staff user id, and valid claim request_id are required; claimless provisioning is disabled.',
            },
          };
        }
        const match = Array.from(claims.values()).find((c) => c.requestId === reqId);
        if (!match || match.status !== 'claimed') {
          return {
            data: null,
            error: {
              code: '23514',
              message: `Staff provisioning claim ${reqId} is missing or not in claimed state.`,
            },
          };
        }
        const uid = String(args.p_new_user_id ?? '');
        staffTable.push({
          id: uid,
          pharmacy_id: PHARMACY_ID,
          full_name: String(args.p_full_name ?? ''),
          role: 'authorized_pharmacist',
          phone: String(args.p_phone ?? ''),
          syndicate_license: args.p_syndicate_license ?? null,
          is_active: true,
        });
        match.status = 'completed';
        match.staffUserId = uid;
        match.claimExpiresAtMs = null;
        return {
          data: { ok: true, staffId: uid, pharmacyId: PHARMACY_ID, role: 'authorized_pharmacist' },
          error: null,
        };
      }

      if (fn === 'mark_staff_provisioning_reconciliation') {
        const reqId = String(args.p_request_id ?? '');
        const match = Array.from(claims.values()).find((c) => c.requestId === reqId);
        if (match && match.status !== 'completed') {
          match.status = args.p_new_status as ClaimRow['status'];
          match.lastError = (args.p_error as string | null) ?? null;
        }
        return { data: { ok: true, status: args.p_new_status }, error: null };
      }

      if (fn === 'inspect_staff_provisioning_state') {
        return {
          data: { status: 'claimed', pharmacyId: PHARMACY_ID, staffExistsInDb: false, staffId: null },
          error: null,
        };
      }

      return { data: null, error: { code: 'PGRST202', message: `Unknown ${fn}` } };
    },
  };

  return {
    client,
    claims,
    createdUsers,
    deletedUsers,
    advanceTimeMs(delta: number) {
      nowMs += delta;
    },
  };
}

async function main() {
  console.log('===================================================================');
  console.log('MASAR Care — Stage 2B.2A.3 Final Targeted Release Patch Tests');
  console.log('MODE: OFFLINE MOCKED & STATIC VERIFICATION ONLY (NO LIVE DB)');
  console.log('===================================================================');

  let passed = 0;

  // --------------------------------------------------------------------------
  // SUITE 1 (Issue A): Consultation Approval Provenance & Forged Flag Block
  // --------------------------------------------------------------------------
  {
    const forgedPatientMsg: ConsultationMessage = {
      id: 'm-forged',
      senderType: 'patient',
      senderName: 'مريض',
      body: 'Forged pharmacist approval',
      sentAt: '2026-11-14T10:00:00Z',
      approvedByPharmacist: true,
    };
    const missingStaffIdMsg: ConsultationMessage = {
      id: 'm-missing-staff',
      senderType: 'pharmacist',
      senderName: 'صيدلي',
      body: 'Missing staff id',
      sentAt: '2026-11-14T10:01:00Z',
      approvedByPharmacist: true,
    };
    const validPharmacistMsg: ConsultationMessage = {
      id: 'm-valid',
      senderType: 'pharmacist',
      senderStaffId: OWNER_ID,
      senderName: 'د. نور المالك',
      body: 'تأكيد الجرعة',
      sentAt: '2026-11-14T10:02:00Z',
      approvedByPharmacist: true,
    };

    assert.equal(isVerifiedPharmacistApproval(forgedPatientMsg), false);
    assert.equal(isVerifiedPharmacistApproval(missingStaffIdMsg), false);
    assert.equal(isVerifiedPharmacistApproval(validPharmacistMsg), true);

    const repo = new SupabaseCrmRepository(
      makeConsultationProvenanceMockClient(),
      makeAuthContext()
    );
    const state = await repo.getStateAsync();
    assert.equal(state.consultations.length, 1);
    const msgs = state.consultations[0].messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].approvedByPharmacist, false);
    assert.equal(isVerifiedPharmacistApproval(msgs[0]), false);
    assert.equal(msgs[1].approvedByPharmacist, false);
    assert.equal(isVerifiedPharmacistApproval(msgs[1]), false);
    assert.equal(msgs[2].approvedByPharmacist, true);
    assert.equal(msgs[2].senderStaffId, OWNER_ID);
    assert.equal(isVerifiedPharmacistApproval(msgs[2]), true);

    const root = process.cwd();
    const consultationsUi = fs.readFileSync(
      path.join(root, 'src/views/ConsultationsView.tsx'),
      'utf8'
    );
    assert.equal(consultationsUi.includes('isVerifiedPharmacistApproval(msg)'), true);
    assert.equal(/\{\s*msg\.approvedByPharmacist\s*&&/.test(consultationsUi), false);

    const sql0003 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );
    assert.equal(sql0003.includes('chk_consultation_messages_patient_unapproved'), true);
    assert.equal(
      sql0003.includes(
        "sender_type = 'patient'\n    AND sender_staff_id IS NULL\n    AND approved_by_pharmacist = false"
      ),
      true
    );
    assert.equal(
      sql0003.includes('REVOKE UPDATE, DELETE ON TABLE public.consultation_messages FROM authenticated;'),
      true
    );

    const postSql = fs.readFileSync(
      path.join(root, 'supabase/tests/stage2b_0003_negative_and_integrity.test.sql'),
      'utf8'
    );
    assert.equal(postSql.includes('DRAFT — NOT EXECUTED AGAINST POSTGRESQL'), true);
    assert.equal(
      postSql.includes('Patient direct INSERT with approved_by_pharmacist=true succeeded.'),
      true
    );
    assert.equal(postSql.includes('Patient direct INSERT posing as pharmacist succeeded.'), true);

    passed++;
    console.log('✓ Suite 1 (Issue A): Consultation approval provenance guard & DB/SQL checks verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 2 (Issue B): Immutable Idempotency Fingerprint & Safe TTL Recovery
  // --------------------------------------------------------------------------
  {
    const stateful = makeStatefulStaffProvisioningAdminMock();
    const idemKey = 'idem-stage2b2a3-immutable-0001';

    // 1. Acquire claim for Staff A, then verify conflicting payload on SAME Idempotency-Key fails BEFORE Auth createUser
    const claimFirst = await stateful.client.rpc('claim_staff_provisioning_request', {
      p_owner_user_id: OWNER_ID,
      p_idempotency_key: idemKey,
      p_request_id: '99990001-0000-4000-8000-000000000001',
      p_target_email: 'staff.a@alshifa.iq',
      p_target_phone: '07705551001',
      p_target_role: 'authorized_pharmacist',
      p_claim_ttl_seconds: 120,
    });
    assert.equal((claimFirst.data as Record<string, unknown>)?.ok, true);

    const changedTargetRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': idemKey,
      }),
      rawBody: {
        email: 'different.staff@alshifa.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. سها كريم',
        phone: '07705559999',
        role: 'authorized_pharmacist',
      },
      adminClient: stateful.client,
    });
    assert.equal(changedTargetRes.status, 409);
    assert.equal(changedTargetRes.body.errorCode, 'STAFF_IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(stateful.createdUsers.length, 0);

    // Confirm original canonical claim row was NOT overwritten
    const preservedClaim = stateful.claims.get(`${PHARMACY_ID}:${idemKey}`);
    assert.equal(preservedClaim?.targetEmail, 'staff.a@alshifa.iq');
    assert.equal(preservedClaim?.targetPhone, '07705551001');

    // 2. Simulate TTL expiration -> canonical retry MUST escalate conservatively (`409 STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED`)
    stateful.advanceTimeMs(125_000);
    const expiredRetryRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': idemKey,
      }),
      rawBody: {
        email: 'staff.a@alshifa.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. سها كريم',
        phone: '07705551001',
        role: 'authorized_pharmacist',
      },
      adminClient: stateful.client,
    });
    assert.equal(expiredRetryRes.status, 409);
    assert.equal(expiredRetryRes.body.errorCode, 'STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED');
    assert.equal(stateful.createdUsers.length, 0);

    // Even after TTL expiration, a DIFFERENT payload on the same key is STILL rejected as conflict
    const expiredConflictRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': idemKey,
      }),
      rawBody: {
        email: 'hijacked.staff@alshifa.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. سها كريم',
        phone: '07705558888',
        role: 'authorized_pharmacist',
      },
      adminClient: stateful.client,
    });
    assert.equal(expiredConflictRes.status, 409);
    assert.equal(expiredConflictRes.body.errorCode, 'STAFF_IDEMPOTENCY_KEY_CONFLICT');

    // 3. Conservative Auth-verified reconciliation: if Auth user DOES exist, stay in reconciliation
    const authExistsReconcile = await stateful.client.rpc(
      'reconcile_expired_staff_provisioning_claim',
      {
        p_owner_user_id: OWNER_ID,
        p_request_id: '99990001-0000-4000-8000-000000000001',
        p_auth_user_exists: true,
      }
    );
    assert.equal(
      (authExistsReconcile.data as Record<string, unknown>)?.errorCode,
      'STAFF_PROVISIONING_NEEDS_RECONCILIATION'
    );

    // After verifying no Auth user exists (`p_auth_user_exists: false`), transition to `rolled_back` and canonical retry succeeds
    const clearReconcile = await stateful.client.rpc(
      'reconcile_expired_staff_provisioning_claim',
      {
        p_owner_user_id: OWNER_ID,
        p_request_id: '99990001-0000-4000-8000-000000000001',
        p_auth_user_exists: false,
      }
    );
    assert.equal((clearReconcile.data as Record<string, unknown>)?.status, 'rolled_back');

    const recoveredOkRes = await handleOwnerProvisionStaff({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer owner-jwt',
        'idempotency-key': idemKey,
      }),
      rawBody: {
        email: 'staff.a@alshifa.iq',
        password: 'StrongPassword2026!',
        fullName: 'د. سها كريم',
        phone: '07705551001',
        role: 'authorized_pharmacist',
      },
      adminClient: stateful.client,
    });
    assert.equal(recoveredOkRes.status, 201);
    assert.equal(recoveredOkRes.body.ok, true);

    // 4. Claimless provision_pharmacy_staff_by_owner (NULL p_request_id) is blocked with 23514
    const claimlessRpcRes = await stateful.client.rpc('provision_pharmacy_staff_by_owner', {
      p_owner_user_id: OWNER_ID,
      p_new_user_id: 'ffffffff-ffff-4fff-8fff-000000000099',
      p_full_name: 'د. غير مصرح',
      p_role: 'authorized_pharmacist',
      p_phone: '07705557777',
      p_syndicate_license: null,
      p_request_id: null,
    });
    assert.equal(claimlessRpcRes.error?.code, '23514');

    // Static SQL invariant check: claim_staff_provisioning_request no longer uses DO UPDATE overwrite
    const root = process.cwd();
    const sql0003 = fs.readFileSync(
      path.join(root, 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );
    assert.equal(
      sql0003.includes('ON CONFLICT (pharmacy_id, idempotency_key) DO UPDATE'),
      false,
      '0003 must never overwrite staff_provisioning_requests via ON CONFLICT DO UPDATE'
    );
    assert.equal(
      sql0003.includes('claimless provisioning is disabled'),
      true
    );

    const cleanSql = fs.readFileSync(
      path.join(root, 'supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql'),
      'utf8'
    );
    assert.equal(cleanSql.includes('STAFF_IDEMPOTENCY_KEY_CONFLICT'), true);
    assert.equal(cleanSql.includes('STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED'), true);
    assert.equal(cleanSql.includes('reconcile_expired_staff_provisioning_claim'), true);

    passed++;
    console.log('✓ Suite 2 (Issue B): Immutable staff idempotency fingerprint, TTL escalation & claimless block verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 3 (Concern C): Edge Gateway Config, Strict Allowlist & HTTP Requests
  // --------------------------------------------------------------------------
  {
    const stateful = makeStatefulStaffProvisioningAdminMock();
    const url = 'https://bkidngfzsubmyunacnju.supabase.co/functions/v1/owner-provision-staff';

    // 1. Anonymous OPTIONS preflight with allowed Origin succeeds with echoed Origin + Vary: Origin
    const optionsAllowed = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN },
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(optionsAllowed.status, 200);
    assert.equal(optionsAllowed.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    assert.equal(optionsAllowed.headers.get('Vary'), 'Origin');
    assert.equal(optionsAllowed.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');

    // 2. Disallowed Origin rejected with 403 + Access-Control-Allow-Origin: null on both OPTIONS & POST
    const optionsDisallowed = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'OPTIONS',
        headers: { origin: EVIL_ORIGIN },
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(optionsDisallowed.status, 403);
    assert.equal(optionsDisallowed.headers.get('Access-Control-Allow-Origin'), 'null');

    const postDisallowed = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'POST',
        headers: {
          origin: EVIL_ORIGIN,
          authorization: 'Bearer owner-jwt',
          'idempotency-key': 'idem-stage2b2a3-evil-origin-0001',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@b.iq' }),
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(postDisallowed.status, 403);
    assert.equal(postDisallowed.headers.get('Access-Control-Allow-Origin'), 'null');
    assert.equal(stateful.createdUsers.length, 0);

    // 3. Wildcard `*` or empty allowlist fails closed (`500 CORS_ALLOWLIST_NOT_CONFIGURED`)
    const wildcardConfigRes = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'OPTIONS',
        headers: { origin: ALLOWED_ORIGIN },
      }),
      adminClient: stateful.client,
      allowedOrigins: '*',
      requireAllowlist: true,
    });
    assert.equal(wildcardConfigRes.status, 500);
    assert.equal(wildcardConfigRes.headers.get('Access-Control-Allow-Origin'), 'null');

    // 4. Unauthorized POST (missing & invalid JWT) with allowed Origin returns 401 + allowed CORS headers
    const missingJwtPost = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'POST',
        headers: {
          origin: ALLOWED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'staff@alshifa.iq' }),
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(missingJwtPost.status, 401);
    assert.equal(missingJwtPost.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);

    const badJwtPost = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'POST',
        headers: {
          origin: ALLOWED_ORIGIN,
          authorization: 'Bearer tampered-jwt',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'staff@alshifa.iq' }),
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(badJwtPost.status, 401);
    assert.equal(badJwtPost.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);

    // 5. Malformed JSON POST with allowed Origin returns 400 INVALID_JSON + allowed CORS headers
    const malformedJsonPost = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'POST',
        headers: {
          origin: ALLOWED_ORIGIN,
          authorization: 'Bearer owner-jwt',
          'idempotency-key': 'idem-stage2b2a3-bad-json-0001',
          'content-type': 'application/json',
        },
        body: '{invalid-json',
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(malformedJsonPost.status, 400);
    const malformedBody = (await malformedJsonPost.json()) as Record<string, unknown>;
    assert.equal(malformedBody.errorCode, 'INVALID_JSON');
    assert.equal(malformedJsonPost.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);

    // 6. Valid owner POST with allowed Origin succeeds (`201`) + echoed exact Origin
    const validOwnerPost = await handleOwnerProvisionStaffHttpRequest({
      req: new Request(url, {
        method: 'POST',
        headers: {
          origin: ALLOWED_ORIGIN,
          authorization: 'Bearer owner-jwt',
          'idempotency-key': 'idem-stage2b2a3-http-valid-0001',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: 'http.staff@alshifa.iq',
          password: 'StrongPassword2026!',
          fullName: 'د. هدى علي',
          phone: '07704441122',
          role: 'authorized_pharmacist',
          syndicateLicense: 'SYN-HTTP-1',
        }),
      }),
      adminClient: stateful.client,
      allowedOrigins: ALLOWED_ORIGIN,
      requireAllowlist: true,
    });
    assert.equal(validOwnerPost.status, 201);
    assert.equal(validOwnerPost.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    const validBody = (await validOwnerPost.json()) as Record<string, unknown>;
    assert.equal(validBody.ok, true);
    assert.equal(validBody.role, 'authorized_pharmacist');

    // Static Edge configuration checks (`supabase/config.toml` & `supabase/.env.example`)
    const root = process.cwd();
    const configToml = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
    assert.equal(configToml.includes('[functions.bootstrap-first-owner]'), true);
    assert.equal(configToml.includes('[functions.owner-provision-staff]'), true);
    assert.equal((configToml.match(/^verify_jwt\s*=\s*false\s*$/gm) ?? []).length, 2);
    assert.equal(configToml.includes('verified after Stage 2B.2B deployment'), true);

    const supabaseEnvExample = fs.readFileSync(path.join(root, 'supabase/.env.example'), 'utf8');
    assert.equal(supabaseEnvExample.includes('MASAR_CORS_ALLOWED_ORIGINS='), true);
    assert.equal(supabaseEnvExample.includes('wildcard `*` is rejected'), true);

    passed++;
    console.log('✓ Suite 3 (Concern C): config.toml verify_jwt, strict CORS allowlist & HTTP handler checks verified');
  }

  // --------------------------------------------------------------------------
  // SUITE 4: Public Asset Cleanup & Stage 2B.2A.3 Release Readiness Docs
  // --------------------------------------------------------------------------
  {
    const root = process.cwd();
    assert.equal(
      fs.existsSync(path.join(root, 'public/assets')),
      false,
      'Internal audit Markdown files must NOT remain under public/assets'
    );

    for (const reviewDoc of [
      'docs/MASAR_CARE_STAGE2B1_INDEPENDENT_REVIEW.md',
      'docs/MASAR_CARE_STAGE2B2A_INDEPENDENT_REVIEW.md',
      'docs/MASAR_CARE_STAGE2B2A1_INDEPENDENT_AUDIT.md',
      'docs/MASAR_CARE_STAGE2B2A2_INDEPENDENT_REVIEW.md',
    ]) {
      assert.equal(fs.existsSync(path.join(root, reviewDoc)), true, `Missing archived review ${reviewDoc}`);
    }

    const readiness = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A3_RELEASE_READINESS.md'),
      'utf8'
    );
    const handoff = fs.readFileSync(path.join(root, 'docs/MASAR_CARE_HANDOFF.md'), 'utf8');
    const approvalPlan = fs.readFileSync(
      path.join(root, 'docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md'),
      'utf8'
    );
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

    assert.equal(envExample.includes('VITE_ENABLE_SUPABASE_CRM="false"'), true);
    assert.equal(readiness.includes('V1.5.5-Stage2B.2A.3'), true);
    assert.equal(readiness.includes('Not Executed'), true);
    assert.equal(readiness.includes('Checkpoint 1') && readiness.includes('Checkpoint 2'), true);
    assert.equal(handoff.includes('V1.5.5-Stage2B.2A.3'), true);
    assert.equal(approvalPlan.includes('Checkpoint 1') && approvalPlan.includes('Checkpoint 2'), true);
    assert.equal(approvalPlan.includes('MASAR_CORS_ALLOWED_ORIGINS'), true);
    assert.equal(readme.includes('V1.5.5-Stage2B.2A.3'), true);

    passed++;
    console.log('✓ Suite 4: Public asset cleanup & Stage 2B.2A.3 release readiness docs verified');
  }

  console.log('===================================================================');
  console.log(`ALL ${passed} STAGE 2B.2A.3 TARGETED RELEASE PATCH SUITES PASSED`);
  console.log('MODE: OFFLINE MOCKED & STATIC CHECKS ONLY (bkidngfzsubmyunacnju UNTOUCHED)');
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('Stage 2B.2A.3 hardening test suite failed:', err);
  process.exit(1);
});
