# MASAR Care — Stage 2B.2A Implementation Report

**Version:** `V1.5.5-Stage2B.2A` (Supersedes `V1.5.5-Stage2B.1.1`)  
**Scope:** Backend Code & Migration Preparation Only (Offline)  
**Target Development Project:** `bkidngfzsubmyunacnju` (PostgreSQL 17.11 — untouched in Stage 2B.2A)  
**Default Frontend Runtime:** Stage 1 Demo Mode (`VITE_ENABLE_SUPABASE_CRM="false"`)  

---

## 1. Objective
Prepare all backend artifacts required for Stage 2B.2 Connected Mode without executing live SQL, deploying Edge Functions, creating Auth accounts, modifying UI layout, or enabling Connected Mode:
1. Additive database migration draft `0003_stage2b_atomic_crm_and_bootstrap.sql`.
2. Admin provisioning Edge Functions (`bootstrap-first-owner`, `owner-provision-staff`) and shared pure-TypeScript handler logic.
3. Full `SupabaseCrmRepository` integration against Migration `0003` atomic RPCs while retaining `Stage2bSqlDependencyError` fail-closed guards when `0003` is absent and keeping Stage 2C APK issuance disabled.
4. Automated offline verification (`stage2b2aPreparation.test.ts` + updated Stage 2B.1 / 2B.1.1 suites).
5. Clear separation between mocked/static tests executed offline and live Supabase execution awaiting Stage 2B.2 approval.

---

## 2. Implemented Backend & Repository Components

### 2.1 Migration `0003_stage2b_atomic_crm_and_bootstrap.sql` (Draft — Not Executed)
- **Bootstrap Gate Table:** `public.bootstrap_state` (`singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key = true)`), with RLS enabled/forced and zero client privileges (`REVOKE ALL ... FROM PUBLIC, anon, authenticated`).
- **Private Active Staff Context Helper:** `app_security.require_active_pharmacist_context()` (`SECURITY DEFINER`, pinned `search_path = pg_catalog, public, app_security, pg_temp`) deriving `staff_id`, `pharmacy_id`, `full_name`, and `role` strictly from `auth.uid()` joined across active `public.pharmacy_staff` and active `public.pharmacies`.
- **`service_role`-Only Provisioning RPCs (in `public` with `REVOKE FROM PUBLIC, anon, authenticated; GRANT TO service_role`):**
  - `public.assert_first_owner_bootstrap_available()` (protected by `pg_advisory_xact_lock`, `bootstrap_state`, `pharmacy_staff`, and `pharmacies`).
  - `public.finalize_first_owner_bootstrap(...)` (advisory-locked atomic insert of initial pharmacy + `pharmacy_owner` + `bootstrap_state` completion + `BOOTSTRAP_OWNER_PROVISIONED` audit log).
  - `public.provision_pharmacy_staff_by_owner(...)` (verifies active `pharmacy_owner` in active pharmacy, derives `pharmacy_id` authoritatively from owner row, inserts `pharmacy_staff` + `STAFF_PROVISIONED` audit log atomically).
- **8 `SECURITY DEFINER` Authenticated Clinical RPCs (`GRANT EXECUTE ... TO authenticated` only):**
  1. `public.create_patient_with_clinical_tags(...)` — inserts `patients`, `patient_conditions`, `patient_allergies`, and `PATIENT_REGISTERED` audit log atomically.
  2. `public.update_patient_with_clinical_tags(...)` — locks patient row for active pharmacy, applies safe patch fields (never touching `patient_code`, `registration_date`, `pharmacy_id`, `auth_user_id`), syncs conditions & allergies, and logs `PATIENT_UPDATED`.
  3. `public.create_medication_plan_with_version(...)` — validates `Asia/Baghdad` schedule structure, inserts `patient_medication_plans`, initial `regimen_versions` (`v1`), and `MEDICATION_PLAN_ADDED` audit log.
  4. `public.update_medication_plan_version(...)` — closes open `regimen_versions` row (`effective_to = v_eff_date`), preserves closed versions immutably, inserts `v+1`, updates `patient_medication_plans`, and logs `REGIMEN_VERSION_CREATED`.
  5. `public.change_medication_plan_status(...)` — manages non-overlapping `medication_pause_periods` rows, updates `patient_medication_plans.status`, and logs `MEDICATION_STATUS_CHANGED`.
  6. `public.record_dispensing_with_refill(...)` — verifies authoritative `patient_id`, `medication_plan_id`, `current_version_number`, positive quantity, non-null date/unit, and valid `refill_status`; appends `dispensing_events`, upserts `refill_assessments`, and logs `DISPENSE_RECORDED`.
  7. `public.send_consultation_reply(...)` — inserts pharmacist-approved `consultation_messages` row, updates `consultation_threads` (with `masar.skip_thread_audit_trigger` transaction setting to prevent duplicate thread-update audit rows), and logs `CONSULTATION_REPLIED`.
  8. `public.revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)` — revokes pending invitation and logs `INVITATION_REVOKED`.
- **Server-Side Clinical Audit Triggers:** `app_security.write_clinical_audit_log()` attached to `patients` (archive/restore status changes), `lab_results`, `follow_up_tasks`, `follow_up_contact_logs`, `dose_events`, and `consultation_threads`, preserving `0002` `SELECT`-only client restrictions on `public.audit_logs`.

### 2.2 Edge Functions (Draft — Not Deployed)
- **`supabase/functions/_shared/adminProvisioningLogic.ts`**:
  - Pure TypeScript shared handler (Deno & Node `tsx` compatible; SHA-256 constant-time secret comparison; zero hardcoded secrets).
  - `handleBootstrapFirstOwner(...)`: requires `MASAR_BOOTSTRAP_TOKEN` (`>= 32` chars; `503 BOOTSTRAP_DISABLED` otherwise), constant-time verification of `X-Masar-Bootstrap-Token` + `Authorization: Bearer <admin-token>`, strict Iraqi phone & strong password (`>= 12` chars + upper/lower/digit) checks, pre-flight `assert_first_owner_bootstrap_available`, Auth user creation, atomic `finalize_first_owner_bootstrap`, and compensating `auth.admin.deleteUser` rollback on failure or race loss (or `500 RECONCILIATION_REQUIRED` with `orphanAuthUserId` if cleanup fails).
  - `handleOwnerProvisionStaff(...)`: requires caller Bearer JWT verified via `auth.getUser`, authoritative `pharmacy_staff` (`is_active = true`, `role = 'pharmacy_owner'`) and active `pharmacies` checks, explicit `403 CROSS_PHARMACY_FORBIDDEN` if caller sends conflicting `pharmacyId`, duplicate `phone`/`syndicate_license` pre-check, Auth creation, atomic `provision_pharmacy_staff_by_owner` RPC, and compensating `auth.admin.deleteUser` rollback on failure.
- **`supabase/functions/bootstrap-first-owner/index.ts`** and **`supabase/functions/owner-provision-staff/index.ts`**: thin Deno runtime wrappers.

### 2.3 `SupabaseCrmRepository` Integration (`src/services/supabaseCrmRepository.ts`)
- Wired `addPatientAsync`, `updatePatientAsync`, `addMedicationPlanAsync`, `updateMedicationPlanAsync`, `changeMedicationStatusAsync`, `recordDispensingAsync`, and `sendConsultationReplyAsync` to Migration `0003` RPCs.
- Reused `scheduleEngine.ts` (`calculateDispensingForecast` and `computeRefillProjection`) in `recordDispensingAsync` across existing fills + pending fill before calling `record_dispensing_with_refill`.
- Mapped missing/ungranted RPC responses (`PGRST202`, `42883`, `permission denied for function`) cleanly to `Stage2bSqlDependencyError` while propagating active-RPC `42501`/`23505`/`23514`/`23P01` rejections explicitly.
- Preserved `issueInvitationAsync` disabled (`Stage2bSqlDependencyError('patientActivationStage2c', ...)`) and Demo Mode default (`VITE_ENABLE_SUPABASE_CRM="false"`).

---

## 3. Verification Matrix — Offline Mocked vs. Live Execution

| Verification Item | Execution Mode | Status |
| :--- | :--- | :--- |
| TypeScript typecheck (`npm run lint` / `tsc --noEmit`) | Local static check | Verified in Stage 2B.2A |
| Production build (`npm run build`) | Local Vite build | Verified in Stage 2B.2A |
| Stage 1 + V1.5 + V1.5.1 + Audit Remediation tests | Local offline suites | Verified in Stage 2B.2A |
| Stage 2B.1 & 2B.1.1 auth/session/pagination/guard suites | Local offline mocked | Verified in Stage 2B.2A |
| Stage 2B.2A 7-RPC integration & rollback checks | Local offline mocked | Verified in Stage 2B.2A |
| Stage 2B.2A `bootstrap-first-owner` replay, race & Auth rollback checks | Local offline mocked | Verified in Stage 2B.2A |
| Stage 2B.2A `owner-provision-staff` RBAC, tenant isolation & rollback checks | Local offline mocked | Verified in Stage 2B.2A |
| Static SQL check (`0003` functions, `search_path`, grants, secret hygiene) | Local static inspection | Verified in Stage 2B.2A |
| Applying `0003_stage2b_atomic_crm_and_bootstrap.sql` on PostgreSQL 17.11 | **Live Supabase (`bkidngfzsubmyunacnju`)** | **NOT EXECUTED (Awaiting Stage 2B.2 approval)** |
| Deploying `bootstrap-first-owner` & `owner-provision-staff` Edge Functions | **Live Supabase Edge Runtime** | **NOT EXECUTED (Awaiting Stage 2B.2 approval)** |
| Live multi-pharmacy RLS, trigger `audit_logs`, & concurrent bootstrap E2E | **Live Supabase Integration** | **NOT EXECUTED (Awaiting Stage 2B.2 approval)** |

---

## 4. Remaining Limitations & Blockers Before Live Connected Mode
1. Migration `0003` has not yet been reviewed/applied to `bkidngfzsubmyunacnju`.
2. Edge Functions have not yet been deployed and Edge secrets (`MASAR_BOOTSTRAP_TOKEN`, optional `MASAR_PLATFORM_ADMIN_TOKEN`) have not yet been configured.
3. No real or test pharmacist accounts exist in `bkidngfzsubmyunacnju` (`0` `auth.users`).
4. `VITE_ENABLE_SUPABASE_CRM` remains `"false"`; Connected Mode E2E remains unverified against live PostgreSQL until Stage 2B.2 approval.
5. Patient APK QR issuance, SMS OTP dispatch, and device recovery remain intentionally deferred to Stage 2C.
