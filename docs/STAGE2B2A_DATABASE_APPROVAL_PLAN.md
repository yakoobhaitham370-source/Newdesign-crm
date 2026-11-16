# MASAR Care — Stage 2B.2 Database & Edge Deployment Approval Plan

**Target Environment:** Disposable Development Supabase Project `bkidngfzsubmyunacnju` (PostgreSQL 17.11, Fictional Data Only)  
**Prerequisites Completed:** Stage 2A verified & cleaned (`0` rows, `0` `auth.users`), Stage 2B.1.1 hardened, and Stage 2B.2A – Stage 2B.2A.3 offline release-patch checks verified (`V1.5.5-Stage2B.2A.3`).  
**Safety Policy:** **DO NOT** run any checkpoint below until explicit authorization is granted for that checkpoint. Never use real patient records. Never paste `service_role` keys, database passwords, `MASAR_BOOTSTRAP_TOKEN`, or `MASAR_PLATFORM_ADMIN_TOKEN` values into chat or source files.

---

## Checkpoint 1 — Database Migration `0003` Alone & Clean-State SQL Verification (Approve Independently First)

### Gate 1 — Pre-Flight Clean Baseline Inspection on `bkidngfzsubmyunacnju`
Before running Migration `0003`, confirm the Stage 2A baseline is intact:
1. Verify all **22 Stage 2A tables** exist in `public` with RLS enabled and forced.
2. Verify `pharmacies`, `pharmacy_staff`, `patients`, and `auth.users` all have `0` rows.

### Gate 2 — Apply Migration `0003` Atomically (`BEGIN; ... COMMIT;`)
Review and apply as **one atomic transaction** (`BEGIN; ... COMMIT;`) via Supabase SQL Editor (or approved CLI migration workflow):
- `supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql` (preserving `0001` and `0002` untouched).

Post-migration verification queries (read-only):
1. Confirm **24 / 24 `public` tables** exist (`22` Stage 2A tables + `public.bootstrap_state` + `public.staff_provisioning_requests`) with RLS enabled AND forced (`relrowsecurity = true` and `relforcerowsecurity = true`), and `0` grants for `anon`.
2. Confirm `public.bootstrap_state` and `public.staff_provisioning_requests` (including `request_fingerprint`) have `0` grants for `PUBLIC`, `anon`, and `authenticated`.
3. Confirm **direct-write bypass closure & consultation provenance lock:**
   - `authenticated` has **0 `INSERT`/`UPDATE`/`DELETE` privileges** on all 7 RPC-governed tables (`patient_conditions`, `patient_allergies`, `patient_medication_plans`, `regimen_versions`, `medication_pause_periods`, `dispensing_events`, `refill_assessments`);
   - `public.patients` allows `authenticated` `UPDATE` **only** on `(status, archived_at, archived_reason, updated_at)`; legacy bypass policies are dropped;
   - `public.consultation_messages` revokes `UPDATE, DELETE` from `authenticated`, enforces `AS RESTRICTIVE` policy `consultation_messages_patient_only_direct_insert` (`sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false`), and enforces table constraint `chk_consultation_messages_patient_unapproved`.
4. Confirm all **8 clinical `public.*` RPCs** (`create_patient_with_clinical_tags`, `update_patient_with_clinical_tags`, `create_medication_plan_with_version`, `update_medication_plan_version`, `change_medication_plan_status`, `record_dispensing_with_refill`, `send_consultation_reply`, `revoke_patient_apk_invitation`) grant `EXECUTE` only to `authenticated` (revoked from `PUBLIC` and `anon`).
5. Confirm all **9 `service_role`-only provisioning/reconciliation RPCs** (`claim_first_owner_bootstrap`, `inspect_first_owner_bootstrap_state`, `mark_first_owner_bootstrap_reconciliation`, `finalize_first_owner_bootstrap`, `claim_staff_provisioning_request`, `inspect_staff_provisioning_state`, `mark_staff_provisioning_reconciliation`, `reconcile_expired_staff_provisioning_claim`, `provision_pharmacy_staff_by_owner`) plus `app_security.compute_staff_provisioning_fingerprint` grant `EXECUTE` only to `service_role` (revoked from `PUBLIC`, `anon`, and `authenticated`).
6. Confirm all **19 `SECURITY DEFINER` functions** (and **3 `IMMUTABLE`** helpers = **22** total) in `0003` pin `SET search_path = pg_catalog, pg_temp`, and confirm `masar.skip_thread_audit_trigger` is absent from trigger/RPC definitions.

### Gate 3 — Execute Clean-State Bootstrap & Staff Claim SQL Test **BEFORE** Initial Owner Creation
1. **Must run BEFORE creating any live dev pharmacy/owner:** execute `supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql` (`BEGIN; ... ROLLBACK;`).
2. Confirms clean-state precondition, durable bootstrap claim/mismatch/finalize/replay lockout (`H3`), H5 `pharmacy_owner` role block (`23514`), immutable `(pharmacy_id, idempotency_key)` conflict rejection (`STAFF_IDEMPOTENCY_KEY_CONFLICT`), conservative TTL expiration escalation (`STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED`), `reconcile_expired_staff_provisioning_claim`, and claimless `provision_pharmacy_staff_by_owner(..., NULL)` `23514` rejection before rolling back cleanly to `0` rows.

---

## Checkpoint 2 — Privileged Edge Deployment, Initial Fictional Accounts & Live Gateway Tests (Separate Approval After Checkpoint 1)

### Gate 4 — Configure Explicit Secrets, Deploy Edge Functions (Using `supabase/config.toml`), Bootstrap & Immediately Retire Bootstrap Endpoint
1. Generate two independent high-entropy bootstrap credentials locally (`>= 32` characters each, e.g., `openssl rand -hex 32`) — never commit them to files or chat:
   - `MASAR_BOOTSTRAP_TOKEN` (`X-Masar-Bootstrap-Token` header)
   - `MASAR_PLATFORM_ADMIN_TOKEN` (`Authorization: Bearer` header — `SUPABASE_SERVICE_ROLE_KEY` is **never** accepted as an HTTP bearer fallback)
2. Set mandatory explicit CORS allowlist secret (see `supabase/.env.example`):
   - `MASAR_CORS_ALLOWED_ORIGINS` (comma-separated explicit CRM origins, e.g., `http://localhost:3000`; wildcard `*` is rejected with `500 CORS_ALLOWLIST_NOT_CONFIGURED`).
3. Deploy `bootstrap-first-owner` and `owner-provision-staff` respecting `supabase/config.toml` (`verify_jwt = false` on both functions with mandatory in-handler Auth/secret/owner verification).
4. Invoke `bootstrap-first-owner` once with a unique `Idempotency-Key` header (`16..128` chars) and fictional pharmacy/owner data (`201 Created` + `BOOTSTRAP_OWNER_PROVISIONED` audit log).
5. Invoke `bootstrap-first-owner` a second time with a new `Idempotency-Key` -> confirm `409 BOOTSTRAP_ALREADY_COMPLETED` and zero extra `auth.users`.
6. **Immediately retire the bootstrap endpoint and secrets:**
   - Run `supabase functions delete bootstrap-first-owner` against `bkidngfzsubmyunacnju`.
   - Unset both `MASAR_BOOTSTRAP_TOKEN` and `MASAR_PLATFORM_ADMIN_TOKEN` from Supabase Edge secrets.

### Gate 5 — Execute Post-Bootstrap SQL Suite, Live Gateway CORS/Auth Tests & Fictional CRM Verification
1. Execute the non-persisting post-bootstrap SQL suite (`BEGIN; ... ROLLBACK;`):
   - `supabase/tests/stage2b_0003_negative_and_integrity.test.sql`
   - Verifies **24 / 24** RLS-forced tables, `0` client grants on `bootstrap_state` & `staff_provisioning_requests`, `0` direct write privileges on the 7 RPC-governed tables (`42501`), narrowed `patients` archive-only updates, `chk_consultation_messages_patient_unapproved` + simulated patient-session forged-approval denial, non-bypassable `CONSULTATION_STATUS_UPDATED` audit logging even when `masar.skip_thread_audit_trigger='1'` is set (`M1`), H1 tampered forecast rejection (`23514`), H2 soft-deactivation + `audit_logs`, inactive staff `42501`, cross-pharmacy `42501`, and PG17 `RESET ROLE;`.
2. Verify `owner-provision-staff` **live through the actual deployed Supabase Edge gateway**:
   - **Anonymous `OPTIONS` preflight (no `Authorization` header)** with allowed `Origin` -> `200`, echoes exact `Origin`, `Vary: Origin`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `idempotency-key` in `Access-Control-Allow-Headers`.
   - **Disallowed `Origin`** on both `OPTIONS` and `POST` -> `403 CORS_ORIGIN_FORBIDDEN`, `Access-Control-Allow-Origin: null`.
   - **Missing / invalid JWT `POST`** with allowed `Origin` -> `401` with allowed CORS headers.
   - **Malformed JSON `POST`** with allowed `Origin` + valid JWT -> `400 INVALID_JSON` with allowed CORS headers.
   - **Valid `pharmacy_owner` `POST`** with allowed `Origin` + `Idempotency-Key` -> creates fictional `authorized_pharmacist` (`201 Created`), while `role: "pharmacy_owner"` returns `403 OWNER_DELEGATION_NOT_ENABLED`, `authorized_pharmacist` caller returns `403 OWNER_ROLE_REQUIRED`, and spoofed `pharmacyId` returns `403 CROSS_PHARMACY_FORBIDDEN`.
3. Temporarily test Connected Mode locally (`VITE_ENABLE_SUPABASE_CRM="true"` in `.env.local` only, never committed) against the fictional dev pharmacy + a second fictional tenant pharmacy to verify patient archive/restore, consultation approval provenance, RPCs, provisional refill provenance, and cross-pharmacy isolation, then run guarded cleanup if resetting dev data and keep `.env.example` at `VITE_ENABLE_SUPABASE_CRM="false"`.

---

## Planned Mobile Rollout Order & Pre-Android Gate
1. **Pharmacist Web CRM** (React + TypeScript — active).
2. **Patient Android App** (native **Kotlin** + Jetpack Compose APK — **gated behind pre-Android `public.scheduled_doses` server materialization**).
3. **Patient iPhone Experience** (**PWA**, since Android APKs cannot run on iPhone).
4. **Optional Native iOS App** (evaluated later).
