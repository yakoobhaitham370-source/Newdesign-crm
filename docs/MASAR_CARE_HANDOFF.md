# MASAR Care — Development Handoff

**Version:** V1.5.5-Stage2B.2A.3 (Stage 2B.2A.3 Final Targeted Release Patch Complete; Demo Mode Preserved ON)  
**Last Updated:** 2026-11-14  
**Current Stage:** Stage 1 Demo Mode Default ON + Stage 2A Clean Dev DB Verified + Stage 2B.2A.3 Hardened Release Candidate Ready for Two-Gate Stage 2B.2B Approval  
**Status:** Stage 2B.2A.3 Completed Offline (`bkidngfzsubmyunacnju` untouched; `VITE_ENABLE_SUPABASE_CRM="false"`; awaiting Checkpoint 1 DB `0003` approval and separate Checkpoint 2 Edge/account approval)

## 1. Completed Work
- **Stage 2A Verification & Guarded Cleanup (Preserved):**
  - Migrations `0001` (22 tables) and `0002` (43 RLS policies, forced RLS, 0 `anon` table `SELECT`s), negative security SQL suite (`V2`), and two-session concurrency tests (Cases A–C) verified on disposable project `bkidngfzsubmyunacnju` (PostgreSQL 17.11) and cleaned back to `0` rows and `0` `auth.users`; see `docs/STAGE2A_DATABASE_TEST_RESULTS.md`.
- **Stage 2B.1 & 2B.1.1 Foundations (Preserved):**
  - Browser-safe client & exact key-rotation cache (`src/services/supabaseClient.ts`), authoritative `pharmacy_staff` Auth resolution & monotonic session/hydration race controller (`src/services/authService.ts`, `src/services/connectedSessionController.ts`), paginated read hydration, and Stage 2C APK activation containment in UI/modals.
- **Stage 2B.2A – 2B.2A.3 Backend & Consultation Hardening (Completed Offline, Connected Mode Default OFF):**
  - **Consultation Approval Provenance Lock (`0003` Section 1C + UI/Repo — Issue A):** Revoked `UPDATE, DELETE` on `consultation_messages` from `authenticated`, tightened `consultation_messages_patient_only_direct_insert` (`AS RESTRICTIVE`) to `sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false`, added table CHECK `chk_consultation_messages_patient_unapproved`, and enforced `isVerifiedPharmacistApproval(msg)` (`senderType === 'pharmacist'` + non-empty `senderStaffId` + `approvedByPharmacist === true`) across `SupabaseCrmRepository` and `ConsultationsView.tsx`. Added simulated patient-session SQL negative/positive draft tests.
  - **Immutable Staff Provisioning Idempotency & Conservative Timeout Recovery (`0003` Section 1D & 3B — Issue B):** Bound `(pharmacy_id, idempotency_key)` to canonical `request_fingerprint` (`app_security.compute_staff_provisioning_fingerprint`), rejected mismatched retries (`STAFF_IDEMPOTENCY_KEY_CONFLICT`) without mutating claims, escalated expired `claimed` rows to `failed_needs_reconciliation` (`STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED`) with Auth-verified `reconcile_expired_staff_provisioning_claim`, and blocked claimless `provision_pharmacy_staff_by_owner(..., NULL)` (`23514`). Migration `0003` now has **24 protected `public` tables**, **19 `SECURITY DEFINER`** functions + **3 `IMMUTABLE`** helpers (**22** pinning `SET search_path = pg_catalog, pg_temp`), and **9 `service_role`-only** provisioning RPCs plus fingerprint helper.
  - **Edge Gateway Config & Strict Non-Wildcard CORS (`supabase/config.toml`, `supabase/.env.example`, `adminProvisioningLogic.ts`, `owner-provision-staff/index.ts` — Concern C):** Added `supabase/config.toml` documenting `verify_jwt = false` on both functions with mandatory in-handler Auth/owner enforcement, removed wildcard `*` CORS fallback (`'null'` default + `MASAR_CORS_ALLOWED_ORIGINS` allowlist required), and tested anonymous `OPTIONS`, disallowed `Origin`, missing/bad JWT `POST`, malformed JSON `POST`, and valid owner `POST` offline.
  - **Public Asset Cleanup:** Moved all 4 internal review Markdown files from `public/assets/aistudio/` to `docs/` and removed `public/assets`.

## 2. Agreed Multi-Platform Rollout Architecture
- **Shared Secure Backend:** One Supabase PostgreSQL + Auth + RLS backend (Option B `pharmacy_id` tenant isolation).
- **1. Pharmacist Web CRM (Active):** React + TypeScript web interface (remains separate from patient apps, sharing the same backend).
- **2. Patient Android App (First Mobile Launch):** Native **Kotlin** + **Jetpack Compose** APK (Stage 2C, gated behind pre-Android `public.scheduled_doses` server materialization).
- **3. Patient iPhone App (Second Mobile Launch):** Progressive Web App (**PWA**), because Android APKs cannot run on iPhone.
- **4. Optional Native iOS App:** Evaluated later after Android APK and iPhone PWA validation.

## 3. Files Changed (Stage 2B.2A.3)
- `src/types/domain.ts`, `src/services/consultationApproval.ts` *(new)*, `src/data/seedData.ts`, `src/services/crmRepository.ts`, `src/services/supabaseCrmRepository.ts`, `src/views/ConsultationsView.tsx`
- `supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql` *(review-only draft — not executed)*
- `supabase/config.toml` *(new)*, `supabase/.env.example` *(new)*, `supabase/functions/_shared/adminProvisioningLogic.ts`, `supabase/functions/owner-provision-staff/index.ts` *(not deployed)*
- `supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql` & `supabase/tests/stage2b_0003_negative_and_integrity.test.sql` *(unexecuted SQL drafts)*
- `src/tests/stage2b2a3Hardening.test.ts` *(new)*, `src/tests/stage2b2a2Hardening.test.ts`, `src/tests/stage2b2aPreparation.test.ts`, `package.json`
- Moved 4 review docs from `public/assets/aistudio/` into `docs/` and removed `public/assets/`
- `docs/STAGE2B2A3_RELEASE_READINESS.md` *(new)*, `docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md`, `docs/MASAR_CARE_HANDOFF.md`, `README.md`

## 4. Verification Results
- **Live Disposable Development PostgreSQL (`bkidngfzsubmyunacnju`, PostgreSQL 17.11):**
  - Stage 2A baseline preserved untouched (`0` business rows, `0` `auth.users`).
- **Offline Application, Mocked/HTTP Edge & Static Checks (Stage 2B.2A.3):**
  - `npm test` (10 offline suites), `npm run lint` (`tsc --noEmit`), and `npm run build` verified clean after edits (see turn report).
- **NOT EXECUTED (By Stage 2B.2A.3 Offline Code-Only Authorization Boundary):**
  - Executing `0003_stage2b_atomic_crm_and_bootstrap.sql`, `stage2b_0003_bootstrap_clean_state.test.sql`, or `stage2b_0003_negative_and_integrity.test.sql` against PostgreSQL 17.11 on `bkidngfzsubmyunacnju`
  - Deploying Edge Functions, configuring `MASAR_CORS_ALLOWED_ORIGINS` / bootstrap secrets, or verifying live Supabase Edge gateway `OPTIONS`/CORS behavior
  - Pre-Android `public.scheduled_doses` materialization implementation and Stage 2C patient Kotlin APK / PWA onboarding

## 5. Open Blockers & Limitations
- **Live DB Migration & SQL Execution Pending Checkpoint 1:** Migration `0003` and both draft SQL test suites are unexecuted against PostgreSQL 17.11.
- **Live Edge Gateway CORS/Auth Pending Checkpoint 2:** Hosted Supabase Edge gateway preflight/JWT behavior remains unverified until deployment.
- **Pre-Android Gate Open (`D1` / `H7`):** `public.scheduled_doses` occurrence materialization must be implemented before Stage 2C native Kotlin Android APK launch.
- **Refill Forecasts Provisional Until Server-Side Engine:** Dispensing refill calculations remain `provisional_client_unverified` / `provisional_unverified` with server unit/rate/cumulative guards.
- **Connected Mode Off by Default:** `VITE_ENABLE_SUPABASE_CRM` remains `"false"`.

## 6. Two-Checkpoint Next Approval Gate (Stage 2B.2B)
1. **Checkpoint 1 (DB `0003` Only):** Authorize applying `0003` atomically on `bkidngfzsubmyunacnju`, verifying the 24-table/RLS/grants/CHECK state, and running `stage2b_0003_bootstrap_clean_state.test.sql` BEFORE any owner account creation.
2. **Checkpoint 2 (Edge & Initial Fictional Accounts):** Separately authorize setting secrets (`MASAR_CORS_ALLOWED_ORIGINS` + one-time bootstrap secrets), deploying Edge Functions, running + retiring `bootstrap-first-owner`, verifying live gateway CORS/Auth, and running `stage2b_0003_negative_and_integrity.test.sql`.
