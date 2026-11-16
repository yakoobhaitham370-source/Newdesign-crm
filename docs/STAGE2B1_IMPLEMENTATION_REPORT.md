# MASAR Care — Stage 2B.1 Implementation Report (Code Preparation Only)

**Version:** V1.5.5-Stage2B.1  
**Date:** 2026-11-13  
**Approved Architecture:** Option B — Single Shared Supabase Project (`bkidngfzsubmyunacnju`) with Strict `pharmacy_id` RLS Isolation  
**Runtime Default:** **Demo Mode ON (`VITE_ENABLE_SUPABASE_CRM="false"`)**

---

## 1. Executive Summary & Strict Scope Boundaries

Stage 2B.1 implements the complete frontend client, authoritative pharmacist session verification layer, and `SupabaseCrmRepository` persistence adapter in code **without activating live database operations**.

### Verified Non-Execution Guarantees
- **Database Untouched:** No SQL migrations were executed, no tables or RLS policies were modified, and PostgreSQL project `bkidngfzsubmyunacnju` retains its clean Stage 2A state (`22` tables, `22` forced-RLS tables, `43` security policies, `0` rows, `0` Auth users).
- **No Auth Users or Edge Functions Deployed:** No Supabase Auth users, `pharmacies`, `pharmacy_staff`, or clinical records were created, and no Edge Functions were deployed.
- **Demo Mode Preserved by Default:** `.env.example` sets `VITE_ENABLE_SUPABASE_CRM="false"`. Unless explicitly switched to `"true"` with valid browser-safe config, the CRM boots directly into `AsyncInMemoryCrmRepository` / `InMemoryCrmAdapter` Demo Mode with zero network calls to Supabase.
- **No Secret Keys in Browser:** `sb_secret_*` and `service_role` JWTs are strictly prohibited and actively blocked at runtime by `src/services/supabaseClient.ts`.

---

## 2. Implemented Architecture & Modules

### 2.1 Configuration & Browser Key Security (`src/services/supabaseClient.ts`, `.env.example`)
- `isConnectedModeEnabled()` returns `false` unless `VITE_ENABLE_SUPABASE_CRM === "true"`.
- `getSupabaseConfigStatus()` validates:
  - HTTPS URL (or local `http://localhost` / `http://127.0.0.1` for local dev).
  - Non-empty `VITE_SUPABASE_PUBLISHABLE_KEY`.
  - `isForbiddenSecretKey()`: blocks any `sb_secret_*` key or JWT whose payload declares `role === 'service_role'` without echoing secret material in errors.
- `getSupabaseClient()` instantiates `@supabase/supabase-js` lazily (`persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false` for closed invite-only CRM security).

### 2.2 Authoritative Pharmacist Authentication (`src/services/authService.ts`, `src/components/auth/PharmacistLoginScreen.tsx`)
- `signInPharmacistWithPassword()` signs in with email + password only (no self-registration or public sign-up).
- `resolveAuthoritativePharmacistSession()` ignores `user_metadata` and `app_metadata` completely and queries:
  1. `public.pharmacy_staff` (`id === auth.uid()`), enforcing `is_active === true` and `role IN ('pharmacy_owner', 'authorized_pharmacist')`.
  2. `public.pharmacies` (`id === staff.pharmacy_id`), enforcing `is_active === true`.
- Unlinked, patient, inactive staff, or inactive pharmacy accounts are rejected with specific bilingual errors (`UNAUTHORIZED_STAFF_NOT_FOUND`, `STAFF_INACTIVE`, `PHARMACY_INACTIVE`, `ROLE_NOT_AUTHORIZED`) and immediately signed out (`signOut()`), except on transient `DB_ERROR` where the operator can retry or explicitly sign out.
- `PharmacistLoginScreen.tsx` renders an RTL/LTR bilingual login UI matching MASAR Care colors (`#103354`, `#008C87`, `#F5F7FA`), including clear `unauthorized` and `config_error` states.

### 2.3 Persistent Repository (`src/services/supabaseCrmRepository.ts`)
Implements `IAsyncCrmRepository` aligned directly with `0001_stage2a_core_schema.sql` and `0002_stage2a_rls_and_security.sql`:
- **Non-Secret Invitation Projection:** Uses explicit `PATIENT_APK_INVITATION_SELECT_COLUMNS` — never `select('*')` — so `token_hash`, `pharmacist_pin_hash`, and `sms_otp_hash` are never requested. Issuance calls RPC `issue_patient_apk_invitation(...)` and surfaces one-time plaintext handover credentials (`singleUseTokenOnce`, `pharmacistHandoverPinOnce`) transiently on the response object.
- **0002 Column-Level Grant Compliance:**
  - `updatePatientAsync()` omits restricted columns (`id`, `pharmacy_id`, `patient_code`, `registration_date`, `created_by_staff_id`, `auth_user_id`) and synchronizes `patient_conditions` and `patient_allergies` separately.
  - `updateDoseEventStatusAsync()` updates strictly `(status, patient_note)` per `0002` grants; server triggers maintain `confirmed_at` and `updated_at`.
- **Clinical Regimen & Dispensing Integrity:**
  - `toOptionalUuid()` normalizes non-UUID mock catalog IDs (e.g., `'med-cat-1'`) to `null` before inserting into `patient_medication_plans`.
  - `updateMedicationPlanAsync()` closes open `regimen_versions` rows (`effective_to`) before creating `version_number + 1`.
  - `changeMedicationStatusAsync()` opens and closes `medication_pause_periods` for `paused` / `active` transitions.
  - `recordDispensingAsync()` records `dispensing_events` and recalculates + upserts `refill_assessments`.
- **Forbidden Demo Operations:** `resetAsync()` and `setActiveStaffAsync()` throw explicit errors in Connected Mode.
- **Silent-Fallback Ban:** Database/RLS errors propagate cleanly with contextual Postgres SQLSTATE messages; `CrmContext` never falls back to `InMemoryCrmAdapter` in Connected Mode.

### 2.4 Context, Shell & Async UI Wiring
- `src/context/CrmContext.tsx`: Boots with `createEmptyConnectedCrmState()` when `isConnectedMode === true`; converts all CRM mutations into `Promise`-returning async methods so every view/modal can display real loading states and catch server/RLS errors without false-success toasts or closing modals prematurely. Preserves `initialClockMode = 'live_baghdad'` and `resolveRuntimeClockMode` for Demo Mode while locking Connected Mode strictly to `LiveBaghdadClock`.
- `src/App.tsx`: Wraps `<AppShell>` in `ConnectedModeGate`, blocking unauthenticated/unauthorized/misconfigured sessions before mounting CRM workspace views.
- `src/components/layout/AppShell.tsx`: In Connected Mode, removes the Demo staff `<select>` switcher, `Reset Demo Data` button, and fixed-fixture clock toggle from both desktop sidebar and mobile drawer, replacing them with the authenticated operator badge, `Connected Dev · Supabase RLS` header indicator, `Live Baghdad Time`, and `Sign Out`.
- Updated Views & Modals: `PatientFormModal.tsx`, `MedicationWizardModal.tsx`, `DispenseModal.tsx`, `InvitationModal.tsx`, `PatientsView.tsx`, `PatientDetailView.tsx`, `DispensingView.tsx`, `RefillsView.tsx`, `InvitationsView.tsx`, `FollowUpsView.tsx`, and `ConsultationsView.tsx` now properly `await` async mutations with double-submit guards and explicit error reporting.

---

## 3. Identified Stage 2B SQL & Edge Dependencies (`STAGE2B_SQL_DEPENDENCIES`)

Before enabling Connected Mode (`VITE_ENABLE_SUPABASE_CRM="true"`) against `bkidngfzsubmyunacnju`, the following Stage 2B.2 backend artifacts must be approved, implemented, and verified:

| Dependency Key | Required Object / Artifact | Stage | Reason & Current 2B.1 Behavior |
|---|---|---|---|
| `revokeInvitationRpc` | `public.revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)` | Stage 2B Migration `0003` | `0002` grants `SELECT` only on `patient_apk_invitations` for `authenticated`. Calling `revokeInvitationAsync` throws `Stage2bSqlDependencyError` cleanly rather than faking revocation. |
| `clinicalAuditLogTriggers` | `SECURITY DEFINER` triggers on clinical tables | Stage 2B Migration `0003` | `0002` restricts `audit_logs` to `SELECT` only for `authenticated` so clients cannot forge audit entries. Server triggers must append entries for patient, medication, dispensing, lab, follow-up, and consultation writes. |
| `atomicRegimenVersionUpdateRpc` | `public.update_medication_plan_version(...)` | Stage 2B Migration `0003` *(recommended)* | Replaces 3 sequential PostgREST requests in `updateMedicationPlanAsync` with a single atomic DB transaction. |
| `ownerStaffProvisioningEdgeFn` | Edge Functions `bootstrap-first-owner` & `owner-provision-staff` | Stage 2B Edge Deployment | `0002` has no client `INSERT` policy on `pharmacy_staff`; staff accounts must be provisioned server-side via `service_role`. |

---

## 4. First Owner Bootstrap Architecture (Stage 2B.2 Design Specification)

Because `0002_stage2a_rls_and_security.sql` leaves `public.pharmacy_staff` without any client `INSERT` policy and `bkidngfzsubmyunacnju` currently has `0` rows and `0` `auth.users`, onboarding the very first pharmacy and `pharmacy_owner` requires a dedicated, single-use server-side bootstrap path:

### 4.1 `bootstrap-first-owner` Edge Function (Deno / `service_role`)
1. **Trigger Condition & Authorization Gate:**
   - Executed once during initial pharmacy provisioning with a server-side secret `MASAR_BOOTSTRAP_TOKEN` passed in `X-Masar-Bootstrap-Token` (verified via constant-time comparison).
   - First database query checks `SELECT count(*) FROM public.pharmacy_staff`. If `count > 0`, the function **immediately rejects (`409 Conflict` / `BOOTSTRAP_ALREADY_COMPLETED`)**, permanently preventing re-use once any staff record exists.
2. **Compensating / Transactional Provisioning Flow:**
   - Validate request body: pharmacy metadata (`name_ar`, `name_en`, `city`, `governorate`, `license_number`, `phone`) and first owner credentials (`email`, initial `password`, `full_name`, `syndicate_license`, `phone`).
   - Step A: Create Supabase Auth account via `supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })`.
   - Step B: Insert active `public.pharmacies` row (`is_active: true`). If this fails -> execute compensating rollback `auth.admin.deleteUser(userId)`.
   - Step C: Insert active `public.pharmacy_staff` row (`id: userId`, `pharmacy_id`, `role: 'pharmacy_owner'`, `is_active: true`). If this fails -> execute compensating rollback deleting the `pharmacies` row and `auth.admin.deleteUser(userId)` so **no orphaned user or pharmacy** can remain.
3. **Post-Bootstrap Lockout & Audit:**
   - Record an initial `audit_logs` entry (`BOOTSTRAP_OWNER_PROVISIONED`).
   - Delete or unset `MASAR_BOOTSTRAP_TOKEN` from Edge Function secrets after initial owner setup completes.

### 4.2 Ongoing Owner-Controlled Staff Onboarding (`owner-provision-staff`)
- Requires a valid caller Bearer JWT verified via `auth.getUser(token)`.
- Authoritatively queries `public.pharmacy_staff` (`id === caller.id`, `role === 'pharmacy_owner'`, `is_active === true`) and `public.pharmacies` (`is_active === true`).
- Creates new `auth.users` + `public.pharmacy_staff` strictly scoped to the owner's `pharmacy_id` with compensating `deleteUser()` rollback if the `pharmacy_staff` insert fails.

---

## 5. Offline Verification Summary (Stage 2B.1)

Executed offline without any live Supabase connection:
- `npm test`: Passes all Stage 1, V1.5, V1.5.1, Audit Remediation, and Stage 2B.1 Preparation (`src/tests/stage2b1Preparation.test.ts`) suites cleanly.
- `npm run typecheck`: `0` TypeScript errors across all services, context, views, modals, and tests.
- `npm run build`: Clean Vite production bundle with Connected Mode gated OFF by default.
