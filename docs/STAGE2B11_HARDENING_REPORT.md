# MASAR Care — Stage 2B.1.1 Targeted Hardening Report (Code Only)

**Version:** V1.5.5-Stage2B.1.1  
**Date:** 2026-11-13  
**Approved Architecture:** Option B — Single Shared Supabase Project (`bkidngfzsubmyunacnju`) with Strict `pharmacy_id` RLS Isolation  
**Runtime Default:** **Demo Mode ON (`VITE_ENABLE_SUPABASE_CRM="false"`)**  
**Scope Guarantee:** Code, tests, and documentation only — no live Supabase connection, no SQL Migration `0003` execution, no Auth user creation, no Edge Function deployment, and no UI redesign.

---

## 1. Independent Review Findings: Confirmed Defects vs. Future Design Requirements

### 1.1 Confirmed Code Defects Fixed in V1.5.5-Stage2B.1.1
1. **Asynchronous Auth / Session / Hydration Race Conditions (`CrmContext.tsx`, `connectedSessionController.ts`):**
   - `getSession()`, `onAuthStateChange` staff lookups, `signInWithPassword()`, `getStateAsync()`, and mutations lacked monotonic generation/disposal checks and active-session user verification before committing React state.
2. **Unauthorized Restored Session Cleanup Gap (`authService.ts`):**
   - `restorePharmacistSession()` left an unauthorized `hasAuthSession: true` session signed in when `UNAUTHORIZED_STAFF_NOT_FOUND`, `STAFF_INACTIVE`, `PHARMACY_INACTIVE`, or `ROLE_NOT_AUTHORIZED` occurred, unlike `signInPharmacistWithPassword()`.
3. **Publishable-Key Prefix Collision in Client Cache (`supabaseClient.ts`):**
   - `cachedSignature` hashed only `${url}::${key.slice(0, 14)}`, allowing key rotation sharing a prefix (`sb_publishable_...`) to reuse a stale client instance.
4. **Unpaginated PostgREST 1,000-Row Truncation Risk (`supabaseCrmRepository.ts`):**
   - `getStateAsync()` issued single unpaginated `.select(...)` queries across all 16 list tables without `.range()` pagination or a completeness guard.
5. **Non-Atomic Multi-Table Client Writes Risking Partial Data & Orphaned Ledger Rows (`supabaseCrmRepository.ts`):**
   - Seven multi-table CRM write paths (`addPatientAsync`, `updatePatientAsync`, `addMedicationPlanAsync`, `updateMedicationPlanAsync`, `changeMedicationStatusAsync`, `recordDispensingAsync`, `sendConsultationReplyAsync`) executed sequential PostgREST calls without DB transactions, and `addPatientAsync` attempted rollback cleanup on error.
6. **Invitation Revocation RPC Parameter Mismatch & Uncontained Connected-Mode Activation UI (`supabaseCrmRepository.ts`, `crmRepository.ts`, `InvitationModal.tsx`, `InvitationsView.tsx`, `PatientDetailView.tsx`):**
   - `revokeInvitationAsync(patientId)` omitted `p_reason`, while Connected Mode UI still exposed `QrPreview`, handover credential slots, and clickable invite/re-issue/revoke buttons before Stage 2C.
7. **Redundant Publicly Served Build/Test Artifacts (`public/assets/aistudio/`, `exports/`):**
   - `public/assets/aistudio/MASAR_Security_Test_V2_0c73a195.txt` (byte-for-byte duplicate of `supabase/tests/stage2a_negative_security_and_integrity.test.sql`) and `exports/MASAR_CARE_V1.5.4.zip` existed outside canonical directories.
8. **Calendar-Rollover Determinism in V1.5 Test (`src/tests/v15Hardening.test.ts`):**
   - `v15Hardening.test.ts:317` omitted explicit `'2026-11-12'` `effectiveDate` when testing paused occurrence generation starting `'2026-11-12'`, causing sensitivity when `Asia/Baghdad` crossed past `'2026-11-13'`.

### 1.2 Future Backend Design Requirements (Deferred to Stage 2B.2 & Stage 2C)
- **Stage 2B.2 (Review Only — Requires Explicit Approval):** Atomic SQL Migration `0003` RPCs for the 7 guarded multi-table CRM mutations + `revoke_patient_apk_invitation(p_patient_id, p_reason)`, `SECURITY DEFINER` `audit_logs` triggers, race- & replay-protected `bootstrap-first-owner` Edge Function (advisory lock + `bootstrap_state` sentinel), and `owner-provision-staff` Edge Function. See `docs/STAGE2B2_BACKEND_DESIGN_DRAFT.md`.
- **Stage 2C (Deferred):** Scannable QR rendering, SMS OTP gateway dispatch, and patient APK activation / recovery Edge Functions.

---

## 2. Implemented Changes

- **`src/services/supabaseClient.ts`:** Replaced prefix signature check with exact in-memory `(url, key)` equality (`cachedUrl === url && cachedKey === key`) and added optional `{ useCache?: boolean }` parameter for controlled rotation testing.
- **`src/services/authService.ts`:** Added `enforceUnauthorizedSessionSignOut()`, `resolveAndEnforceAuthoritativePharmacistSession()`, and `verifyActiveSessionMatchesUser()`. Both sign-in and restored/auth-event lookups deterministically sign out unauthorized sessions and set `hasAuthSession: false`, while preserving `hasAuthSession: true` exclusively for transient `'DB_ERROR'` retries. Removed duplicate `ConnectedSessionCoordinator`.
- **`src/services/connectedSessionController.ts` *(new)*:** Framework-agnostic `ConnectedSessionCoordinator` + `ConnectedSessionController` enforcing monotonic `generation` checks, disposal guards, active session user verification before applying auth or hydrated `CrmState`, immediate workspace wipe on `signOut`, and deferred sign-out cleanup if a login resolves after `signOut`.
- **`src/context/CrmContext.tsx` & `src/services/crmRepository.ts`:** Integrated `ConnectedSessionController`, guarded `runMutation` against stale generation/user commits, and added optional `reason?: string` parameter to `revokeInvitation` / `revokeInvitationAsync`.
- **`src/services/supabaseCrmRepository.ts`:**
  - Implemented `fetchAllPaginatedRows` (`pageSize = 500`, `maxRows = 25_000` configurable via optional constructor options) with deterministic `.order('id', { ascending: true })` tie-breakers and explicit completeness guard error if `maxRows` is exceeded.
  - Guarded all 7 multi-table clinical writes + `issueInvitationAsync` to throw `Stage2bSqlDependencyError` **before** issuing any DB write (zero partial writes, zero compensating deletes on immutable clinical ledgers).
  - Kept single-table `0001`/`0002`-compliant operations active (`archivePatientAsync`, `restorePatientAsync`, `updateDoseEventStatusAsync`, `addLabResultAsync`, `addFollowUpAsync`, `updateFollowUpStatusAsync`, `addFollowUpContactLogAsync`, `updateConsultationStatusAsync`).
  - Aligned `revokeInvitationAsync(patientId, reason = 'Pharmacist revoked pending invitation')` to send `{ p_patient_id: patientId, p_reason: cleanReason }`.
- **UI Containment (`InvitationModal.tsx`, `InvitationsView.tsx`, `PatientDetailView.tsx`):**
  - When `isConnectedMode === true`, renders bilingual Stage 2C Readiness banners, omits `<QrPreview />` and handover credential outputs, and disables verification-method select, device-replacement confirmation, and invite/resend/revoke buttons. Demo Mode (`!isConnectedMode`) remains 100% intact.
- **Asset Cleanup:** Removed `public/assets/aistudio/MASAR_Security_Test_V2_0c73a195.txt` and `exports/MASAR_CARE_V1.5.4.zip`, preserving `supabase/tests/stage2a_negative_security_and_integrity.test.sql`.
- **Tests (`src/tests/stage2b11Hardening.test.ts` *(new)*, `src/tests/stage2b1Preparation.test.ts`, `src/tests/v15Hardening.test.ts`):** Added 7 dedicated hardening tests covering key rotation, unauthorized session cleanup vs `DB_ERROR`, async auth/hydration/unmount races, `1,250`-row pagination & completeness guard, zero-partial-write guards, `42501`/`23514` + revocation signature checks, and UI/asset containment invariants.

---

## 3. Verification Executed & Unexecuted Gates

### Executed Offline
- `npm test` (6 suites: `stage1WorkflowAudit`, `v15Hardening`, `v151FinalGaps`, `auditRemediation`, `stage2b1Preparation`, `stage2b11Hardening`): **PASS**
- `npm run typecheck` (`tsc --noEmit`): **PASS (`0` errors)**
- `npm run build` (`vite build`): **PASS**

### NOT Executed (Strict Authorization Boundary)
- Live Supabase authentication, `SupabaseCrmRepository` queries against `bkidngfzsubmyunacnju`, Stage 2B Migration `0003`, Edge Functions (`bootstrap-first-owner`, `owner-provision-staff`), and Stage 2C QR/SMS OTP/APK activation flows: **NOT EXECUTED**.

---

## 4. Stage 2B.2 Approval Gate Checklist

Before setting `VITE_ENABLE_SUPABASE_CRM="true"` on disposable project `bkidngfzsubmyunacnju`, explicit approval is required for:
1. Reviewing and approving `docs/STAGE2B2_BACKEND_DESIGN_DRAFT.md`.
2. Executing Stage 2B Migration `0003` (atomic CRM RPCs + `revoke_patient_apk_invitation` + `audit_logs` triggers + `bootstrap_state` sentinel).
3. Deploying Edge Functions `bootstrap-first-owner` and `owner-provision-staff`.
4. Provisioning fictional test pharmacy & staff accounts on `bkidngfzsubmyunacnju` and executing authenticated multi-pharmacy RLS + E2E verification.
