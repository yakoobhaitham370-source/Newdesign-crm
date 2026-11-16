# MASAR Care — Stage 2B.2A.3 Final Targeted Release Readiness Report

**Version:** V1.5.5-Stage2B.2A.3  
**Review Baseline Addressed:** V1.5.5-Stage2B.2A.2 (`docs/MASAR_CARE_STAGE2B2A2_INDEPENDENT_REVIEW.md`)  
**Target Development Supabase Project:** `bkidngfzsubmyunacnju` (PostgreSQL 17.11 — untouched; Option B `pharmacy_id` tenant RLS isolation)  
**Operating Boundary:** Offline code, SQL drafts, mocked/HTTP unit tests, and documentation only. `VITE_ENABLE_SUPABASE_CRM="false"` preserved (Demo Mode default ON). No SQL executed, no Edge Functions deployed, no Auth users or secrets created.

---

## 1. Targeted Corrections Implemented (Offline)

### Issue A — Block Forged Pharmacist Approval on `consultation_messages`
- **Database (`0003` Section 1C, preserving `0001`/`0002` untouched):**
  - Executed `REVOKE UPDATE, DELETE ON TABLE public.consultation_messages FROM authenticated;`.
  - Tightened `AS RESTRICTIVE` policy `consultation_messages_patient_only_direct_insert` to require `sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false`.
  - Added table invariant constraint `chk_consultation_messages_patient_unapproved` requiring either `(sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false)` or `(sender_type = 'pharmacist' AND sender_staff_id IS NOT NULL AND approved_by_pharmacist = true)`.
  - Preserved `public.send_consultation_reply(uuid, text, text)` as the authoritative `SECURITY DEFINER` pharmacist reply RPC.
- **Application UI & Repository Provenance (`src/services/consultationApproval.ts`, `src/types/domain.ts`, `src/services/supabaseCrmRepository.ts`, `src/views/ConsultationsView.tsx`, `src/services/crmRepository.ts`, `src/data/seedData.ts`):**
  - Added `senderStaffId?: string` to `ConsultationMessage`, selected `sender_staff_id` in `SupabaseCrmRepository.getStateAsync()`, and stripped `approvedByPharmacist` to `false` unless `senderType === 'pharmacist'` AND `senderStaffId` is non-empty AND DB `approved_by_pharmacist` is true.
  - Replaced raw `msg.approvedByPharmacist` rendering in `ConsultationsView.tsx` with `isVerifiedPharmacistApproval(msg)`.
- **Unexecuted SQL Draft Tests (`supabase/tests/stage2b_0003_negative_and_integrity.test.sql`):**
  - Added simulated `authenticated` patient-session (`v_pat_a_uid`) negative tests asserting patient `approved_by_pharmacist = true` inserts and spoofed `sender_type = 'pharmacist'` inserts fail, while legitimate unapproved patient messages and pharmacist `send_consultation_reply` succeed.

### Issue B — Immutable Staff Provisioning Idempotency & Conservative Timeout Recovery
- **Database (`0003` Section 1D & 3B):**
  - Added `request_fingerprint text NOT NULL` to `public.staff_provisioning_requests` and `app_security.compute_staff_provisioning_fingerprint(...)` (`IMMUTABLE`, `SET search_path = pg_catalog, pg_temp`, `service_role` only).
  - Updated `claim_staff_provisioning_request` (7-argument canonical signature) to remove `ON CONFLICT ... DO UPDATE` target overwrites: reusing `(pharmacy_id, idempotency_key)` with any differing `owner_user_id`, `target_email`, `target_phone`, or `target_role` returns `STAFF_IDEMPOTENCY_KEY_CONFLICT` without mutating the claim.
  - Replaced TTL overwrite with conservative escalation: expired `claimed` rows transition to `failed_needs_reconciliation` (`STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED`) so an in-flight Auth `createUser` call cannot be overlapped. Added `public.reconcile_expired_staff_provisioning_claim(...)` (`service_role` only) to release to `rolled_back` strictly after verifying no `pharmacy_staff` row exists AND `p_auth_user_exists = false`.
  - Updated `provision_pharmacy_staff_by_owner` to reject claimless (`p_request_id IS NULL`) normal provisioning (`SQLSTATE 23514`) and enforce matching `status = 'claimed'`, `target_phone`, and `target_role`.
  - Migration `0003` totals: **24 protected `public` tables**, **19 `SECURITY DEFINER`** functions + **3 `IMMUTABLE`** helpers (**22** pinning `SET search_path = pg_catalog, pg_temp`), and **9 `service_role`-only** `public.*` provisioning RPCs plus `app_security.compute_staff_provisioning_fingerprint`.

### Concern C — Edge Gateway Authentication (`supabase/config.toml`) & Strict CORS Allowlist
- **Gateway Configuration (`supabase/config.toml` & `supabase/.env.example`):**
  - Documented `verify_jwt = false` on `[functions.bootstrap-first-owner]` (CLI/operator-only, dual `>= 32`-char platform secret verification via constant-time SHA-256) and `[functions.owner-provision-staff]` (required so anonymous browser `OPTIONS` preflight reaches the strict origin allowlist handler and supports modern Supabase Auth signing keys; every non-`OPTIONS` request still mandates `adminClient.auth.getUser(jwt)` + active `pharmacy_owner` DB checks).
- **Strict Non-Wildcard CORS (`supabase/functions/_shared/adminProvisioningLogic.ts` & `owner-provision-staff/index.ts`):**
  - Removed wildcard `*` default completely: `buildStaffProvisioningCorsHeaders` defaults to `'null'` with `Vary: Origin` and echoes only exact origins listed in `MASAR_CORS_ALLOWED_ORIGINS`.
  - `owner-provision-staff` delegates to `handleOwnerProvisionStaffHttpRequest(..., { allowedOrigins, requireAllowlist: true })`, failing closed (`500 CORS_ALLOWLIST_NOT_CONFIGURED`) if unset or `*`, returning `403 CORS_ORIGIN_FORBIDDEN` for unlisted `Origin`, returning `400 INVALID_JSON` on malformed payloads, and testing anonymous `OPTIONS`, unauthorized `POST`, valid `pharmacy_owner` `POST`, disallowed `Origin`, and malformed JSON offline.
  - **Runtime caveat:** Live Supabase Edge gateway CORS/preflight behavior remains **unverified** until authorized Stage 2B.2B deployment.

### Public Deployment Asset Cleanup
- Moved all 4 internal audit/review Markdown files from `public/assets/aistudio/` to `docs/` and deleted `public/assets` so internal review documents cannot ship in Vite `dist/` bundles.

---

## 2. Offline Verified vs. Unexecuted Live Checks

| Verification Check | Status | Coverage & Limitations |
| --- | --- | --- |
| `npm test` (10 suites including `stage2b2a3Hardening.test.ts`) | **Verified Offline** | In-memory CRM/provenance tests, mocked `SupabaseClient`/`AdminSupabaseLike`, HTTP `Request`/`Response` Edge handler tests, and static SQL/doc invariant checks |
| `npm run lint` (`tsc --noEmit`) & `npm run build` | **Verified Offline** | Clean TypeScript compilation and Vite production bundle build (without `public/assets/`) |
| Apply `0003_stage2b_atomic_crm_and_bootstrap.sql` on `bkidngfzsubmyunacnju` | **Not Executed** | Draft migration awaiting Checkpoint 1 approval |
| Execute `stage2b_0003_bootstrap_clean_state.test.sql` & `stage2b_0003_negative_and_integrity.test.sql` | **Not Executed** | Draft SQL suites; live PostgreSQL 17 RLS, CHECK, and simulated patient-session checks unexecuted |
| Deploy Edge Functions & verify live gateway `OPTIONS`/CORS/Auth | **Not Executed** | Awaiting Checkpoint 2 approval; Supabase Edge gateway behavior unverified at runtime |

---

## 3. Open Blockers Before Live Pilot / Stage 2C Mobile
1. **Unapplied `0003` Migration & Draft SQL Tests:** PostgreSQL 17 runtime execution of `0003` and both draft SQL test suites on `bkidngfzsubmyunacnju` has not occurred yet.
2. **Unverified Live Edge Gateway CORS/Auth:** `bootstrap-first-owner` and `owner-provision-staff` gateway `OPTIONS` + `verify_jwt = false` behavior is verified only against `handleOwnerProvisionStaffHttpRequest` locally, not through Supabase's hosted Edge gateway.
3. **Pre-Android `public.scheduled_doses` Materialization (`D1`/`H7`):** Server-side generation of concrete `scheduled_doses` rows on plan creation/regimen updates/pauses remains an explicit pre-Android prerequisite before launching the native Kotlin Jetpack Compose APK.
4. **Provisional Refill Calculations:** Refill estimates remain tagged `provisional_client_unverified` / `provisional_unverified` with server unit/rate/cumulative checks until a server-side schedule/refill engine is implemented.

---

## 4. Two Separate Stage 2B.2B Approval Checkpoints

1. **Checkpoint 1 — Database Migration `0003` Alone (`bkidngfzsubmyunacnju`, No Edge Deployment or Live Accounts Yet):**
   - Verify Stage 2A clean baseline (`22` tables, `0` rows, `0` `auth.users`).
   - Apply `supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql` atomically (`BEGIN; ... COMMIT;`).
   - Independently verify **24 / 24** RLS-forced `public` tables, `0` client grants on `bootstrap_state` & `staff_provisioning_requests`, closed direct-write bypasses, `chk_consultation_messages_patient_unapproved`, `9` `service_role`-only functions + `compute_staff_provisioning_fingerprint`, and **19 `SECURITY DEFINER`** functions pinning `SET search_path = pg_catalog, pg_temp`.
   - Execute `supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql` (`BEGIN; ... ROLLBACK;`) while the database is still empty, confirming clean rollback back to `0` rows.

2. **Checkpoint 2 — Edge Function Deployment, Initial Fictional Accounts & Live Gateway Tests (Separate Explicit Approval After Checkpoint 1):**
   - Configure dedicated Edge secrets (`MASAR_BOOTSTRAP_TOKEN`, `MASAR_PLATFORM_ADMIN_TOKEN`, explicit `MASAR_CORS_ALLOWED_ORIGINS` allowlist — never `*`).
   - Deploy `bootstrap-first-owner` and `owner-provision-staff` honoring `supabase/config.toml`.
   - Execute one-time fictional bootstrap, verify `409 BOOTSTRAP_ALREADY_COMPLETED` replay lockout, then **immediately delete `bootstrap-first-owner` and unset both bootstrap/platform-admin secrets**.
   - Run live gateway CORS/Auth tests on `owner-provision-staff` (anonymous `OPTIONS`, disallowed `Origin`, missing/bad JWT `POST`, malformed JSON `POST`, valid `pharmacy_owner` `POST`) and execute `supabase/tests/stage2b_0003_negative_and_integrity.test.sql` (`BEGIN; ... ROLLBACK;`).
