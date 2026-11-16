# MASAR Care — Stage 2B.2 Backend & SQL Design Draft

**STATUS: REVIEW ONLY — DO NOT EXECUTE WITHOUT EXPLICIT STAGE 2B.2 APPROVAL**  
**Target Version:** V1.5.5-Stage2B.1.1 -> Stage 2B.2 Planning Draft  
**Target Architecture:** Option B — Single Shared Supabase Project (`bkidngfzsubmyunacnju`) with Strict `pharmacy_id` RLS Isolation  
**Execution Status:** **NOT EXECUTED** (No SQL migration `0003`, Edge Functions, Auth users, or live mutations have been run)

---

## 1. Purpose & Scope Separation

Stage 2B.1.1 hardened the React/TypeScript frontend so that Connected Mode:
1. Never executes partial multi-table client writes (throwing `Stage2bSqlDependencyError` before any DB call on the 7 multi-table clinical workflows).
2. Contains APK patient onboarding & QR/OTP activation UI until **Stage 2C**.
3. Loads all 16 pharmacy-scoped tables cleanly past PostgREST's 1,000-row ceiling with a dataset completeness guard.

This document specifies the **minimal, review-only backend design** required before enabling Connected Mode (`VITE_ENABLE_SUPABASE_CRM="true"`) in **Stage 2B.2**, while keeping **Stage 2C** (patient APK activation) strictly separated.

### Scope Boundary: Stage 2B.2 vs. Stage 2C

| Capability | Stage 2B.2 (Pharmacist CRM Persistence) | Stage 2C (Patient APK Onboarding) |
|---|---|---|
| First pharmacy & owner creation (`bootstrap-first-owner`) | **In Scope** | — |
| Owner-controlled staff creation (`owner-provision-staff`) | **In Scope** | — |
| Atomic CRM RPCs (`0003`) for patients, regimens, pauses, dispensing, consultations | **In Scope** | — |
| `revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)` RPC | **In Scope** | — |
| `SECURITY DEFINER` `audit_logs` triggers | **In Scope** | — |
| Scannable QR generation, SMS OTP gateway dispatch, APK activation & recovery Edge Functions | **Out of Scope** | **Stage 2C** |

---

## 2. Race- & Replay-Protected First-Owner Bootstrap (`bootstrap-first-owner`)

### Threat Model Addressed
The earlier Stage 2B.1 sketch checked `SELECT count(*) FROM public.pharmacy_staff` in an Edge Function and created an Auth user before DB writes. Without an atomic database gate, two concurrent bootstrap requests could both observe `count = 0` and create competing owners or orphaned `auth.users`.

### Hardened Architecture

1. **Database Sentinel + Advisory Lock (`0003` Review-Only SQL):**
   - Create a single-row sentinel table with no client RLS policies (`REVOKE ALL` from `anon`, `authenticated`; accessible only to `service_role` / `SECURITY DEFINER`):
     ```sql
     CREATE TABLE IF NOT EXISTS public.bootstrap_state (
       singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key = true),
       locked_at timestamptz NOT NULL DEFAULT now(),
       completed_at timestamptz,
       pharmacy_id uuid REFERENCES public.pharmacies(id),
       owner_user_id uuid,
       bootstrap_fingerprint text
     );
     REVOKE ALL ON TABLE public.bootstrap_state FROM PUBLIC, anon, authenticated;
     ```
   - Provide a `service_role`-only transactional RPC `public.finalize_first_owner_bootstrap(...)`:
     - Acquires `PERFORM pg_advisory_xact_lock(hashtext('masar_care_first_owner_bootstrap'));`.
     - Asserts `NOT EXISTS (SELECT 1 FROM public.bootstrap_state WHERE completed_at IS NOT NULL)` AND `NOT EXISTS (SELECT 1 FROM public.pharmacy_staff)` AND `NOT EXISTS (SELECT 1 FROM public.pharmacies)`. If any row exists, raises `P0001` (`BOOTSTRAP_ALREADY_COMPLETED`).
     - Inserts `public.pharmacies`, inserts `public.pharmacy_staff` (`role = 'pharmacy_owner'`, `is_active = true`), updates `public.bootstrap_state` (`completed_at = now()`), and writes an `audit_logs` entry (`BOOTSTRAP_OWNER_PROVISIONED`) inside **one atomic database transaction**.

2. **Edge Function Flow (`supabase/functions/bootstrap-first-owner/index.ts` — Review Only):**
   - **Step 1 (Constant-Time Token Verification):** Verify `X-Masar-Bootstrap-Token` against `Deno.env.get('MASAR_BOOTSTRAP_TOKEN')` using constant-time SHA-256 digest comparison (`crypto.subtle.timingSafeEqual` or equivalent fixed-length byte XOR on SHA-256 digests). Missing secret or mismatch -> `401 Unauthorized`.
   - **Step 2 (Pre-Flight DB Claim Check):** Before creating any `auth.users` record, call a lightweight `service_role` RPC `public.assert_bootstrap_available()` (acquiring transaction advisory lock or checking `bootstrap_state` + `pharmacy_staff` + `pharmacies` counts). If already bootstrapped -> `409 Conflict` (`BOOTSTRAP_ALREADY_COMPLETED`).
   - **Step 3 (Validate Input):** Validate Iraqi phone, syndicate license, governorate/city, email, and strong password (`>= 12` chars).
   - **Step 4 (Create Auth User):** Call `supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })` to obtain `userId`.
   - **Step 5 (Atomic DB Finalization):** Call `supabaseAdmin.rpc('finalize_first_owner_bootstrap', { p_owner_user_id: userId, ... })`.
     - If Step 5 fails for **any** reason (including a concurrent request winning `pg_advisory_xact_lock` -> `BOOTSTRAP_ALREADY_COMPLETED`), immediately execute compensating Auth cleanup: `await supabaseAdmin.auth.admin.deleteUser(userId)` and return `409` / `500` without leaving any partial `pharmacies` or `pharmacy_staff` rows.
   - **Step 6 (Post-Bootstrap Secret Removal):** Operator immediately removes `MASAR_BOOTSTRAP_TOKEN` from Edge Function secrets (`supabase secrets unset MASAR_BOOTSTRAP_TOKEN`) after first owner creation succeeds.

3. **Auth Admin Reconciliation Runbook (Edge Failure Case):**
   - If the Edge Function process terminates between Step 4 (`auth.admin.createUser`) and Step 5 (`finalize_first_owner_bootstrap`), no pharmacy/staff row exists in PostgreSQL, and `bootstrap_state.completed_at` remains `NULL`.
   - Operator checks `auth.users` vs `public.pharmacy_staff` via Supabase Dashboard -> Authentication -> Users, deletes the unlinked orphan `auth.users` account if present, and re-runs `bootstrap-first-owner` cleanly.

---

## 3. Owner-Controlled Staff Onboarding (`owner-provision-staff`)

- **Authorization:** Requires `Authorization: Bearer <jwt>`.
- **Identity Verification:** Calls `supabaseAdmin.auth.getUser(jwt)` to verify signature/expiry, then **authoritatively queries `public.pharmacy_staff` and `public.pharmacies`**:
  - Caller must exist in `public.pharmacy_staff` with `id = caller.id`, `is_active = true`, `role = 'pharmacy_owner'`, and linked `public.pharmacies.is_active = true`.
  - **Tenant Derivation:** `pharmacy_id` is derived strictly from the owner's `pharmacy_staff.pharmacy_id` — any `pharmacy_id` sent in the request payload is ignored/rejected.
- **Execution & Rollback:**
  - Validate new staff details (`role` restricted to `'authorized_pharmacist'` or `'pharmacy_owner'`).
  - Create `auth.users` via `auth.admin.createUser(...)`.
  - Insert `public.pharmacy_staff` + `audit_logs` (`STAFF_PROVISIONED`) via `service_role`.
  - On DB insert failure, invoke `auth.admin.deleteUser(newUserId)` so no unlinked Auth user remains.

---

## 4. Minimal Stage 2B Migration `0003` Atomic RPCs (Review Only)

All 7 multi-table CRM write paths guarded in `src/services/supabaseCrmRepository.ts` plus invitation revocation and server audit logging map to the following `SECURITY DEFINER` RPCs/triggers (`SET search_path = public, pg_temp`):

Every RPC derives caller authority strictly from `auth.uid()` -> `public.pharmacy_staff` (`is_active = true`, `role IN ('pharmacy_owner', 'authorized_pharmacist')`) and enforces `pharmacy_id` matching the caller's pharmacy. **No RPC ever performs compensating deletes on append-only clinical ledgers** (`dispensing_events`, `audit_logs`, `regimen_versions`, `consultation_messages`, `follow_up_contact_logs`).

1. **`public.create_patient_with_clinical_tags(...)`**
   - Inserts `patients`, `patient_conditions`, and `patient_allergies` in a single transaction, plus `audit_logs`.
2. **`public.update_patient_with_clinical_tags(...)`**
   - Updates whitelisted mutable `patients` columns (`full_name`, `phone`, `phone_owner_type`, `caregiver_name`, `date_of_birth`, `sex`, `contact_preference`, `clinical_notes`, `updated_at`), reconciles `patient_conditions` and `patient_allergies`, and appends `audit_logs`.
3. **`public.create_medication_plan_with_version(...)`**
   - Inserts `patient_medication_plans` (`current_version_number = 1`) and initial `regimen_versions` (`version_number = 1`) atomically, plus `audit_logs`.
4. **`public.update_medication_plan_version(...)`**
   - Locks `patient_medication_plans` `FOR UPDATE`, closes open `regimen_versions` (`effective_to = p_effective_date`), inserts `version_number = v_current + 1`, updates `patient_medication_plans`, and appends `audit_logs`.
5. **`public.change_medication_plan_status(...)`**
   - Locks `patient_medication_plans` `FOR UPDATE`, opens/closes `medication_pause_periods` on `paused`/`active` transitions (honoring `23P01` non-overlap), updates plan status, and appends `audit_logs`.
6. **`public.record_dispensing_with_refill(...)`**
   - Computes/validates immutable `dispensing_events` insert and upserts `refill_assessments` inside one transaction, plus `audit_logs`.
7. **`public.send_consultation_reply(...)`**
   - Inserts immutable `consultation_messages` row and updates `consultation_threads` (`status`, `updated_at`) atomically, plus `audit_logs`.
8. **`public.revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)`**
   - Matches `SupabaseCrmRepository.revokeInvitationAsync` contract (`{ p_patient_id, p_reason }`).
   - Validates `char_length(btrim(p_reason)) >= 3`, verifies caller belongs to the patient's `pharmacy_id`, locks pending invitation (`status = 'pending'`), sets `status = 'revoked'`, `revoked_at = now()`, records `audit_logs`, and returns `{ ok: true }` (or `{ ok: false, errorCode: 'INVITATION_NOT_PENDING' }`).
9. **`SECURITY DEFINER` Audit Triggers:**
   - Append `audit_logs` rows automatically on single-table writes (`patients` archive/restore, `lab_results`, `follow_up_tasks`, `follow_up_contact_logs`, `dose_events`, `consultation_threads`), keeping direct client `INSERT` on `audit_logs` revoked (`0002` preserved).
