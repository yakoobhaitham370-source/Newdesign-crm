# MASAR Care — Stage 2B.2A.2 Pre-Deployment Hardening & Audit Verification Report

**Version:** V1.5.5-Stage2B.2A.2  
**Audit Baseline Reviewed:** V1.5.5-Stage2B.2A.1 (`MASAR_CARE_STAGE2B2A1_INDEPENDENT_AUDIT.md`)  
**Target Development Supabase Project:** `bkidngfzsubmyunacnju` (PostgreSQL 17.11 — untouched; Option B `pharmacy_id` RLS isolation)  
**Mode & Boundary:** Code, SQL drafts, offline tests, and documentation only (`VITE_ENABLE_SUPABASE_CRM="false"` preserved; no live SQL executed, no Edge Functions deployed, no Auth users or real patient data created).

---

## 1. Confirmed Code/SQL Defects vs. Architectural Design Risks

### Confirmed Code/SQL Defects (Verified Against Source & Resolved in Stage 2B.2A.2)
1. **H1 — Direct-Write Bypasses on RPC-Governed Clinical Tables (`0002` grants/policies not narrowed by `0003`):**
   - **Verified Defect:** Migration `0002` granted `INSERT, UPDATE` (and some `DELETE`) directly to `authenticated` on `patient_conditions`, `patient_allergies`, `patient_medication_plans`, `regimen_versions`, `medication_pause_periods`, `dispensing_events`, `refill_assessments`, `patients`, and `consultation_messages`, enabling direct PostgREST calls to bypass soft-deactivation history, regimen versioning, pause intervals, provenance checks (`server_verified`), or RPC audit logs.
   - **Resolution (`0003` Section 1C, preserving `0001`/`0002` untouched):** Additively executed `REVOKE INSERT, UPDATE, DELETE` from `authenticated` on all 7 RPC-governed tables; narrowed `public.patients` to `GRANT UPDATE (status, archived_at, archived_reason, updated_at) TO authenticated;` (preserving `archivePatientAsync` / `restorePatientAsync` while blocking direct patient creation and demographic edits); dropped the 10 legacy permissive direct-write policies; and added `AS RESTRICTIVE` policy `consultation_messages_patient_only_direct_insert` restricting direct inserts to `sender_type = 'patient'`.
2. **H2 — Nonexistent `reset_config('role')` in PostgreSQL 17 SQL Test Harness:**
   - **Verified Defect:** `supabase/tests/stage2b_0003_negative_and_integrity.test.sql` called `PERFORM reset_config('role');`, which does not exist in PostgreSQL 17 and would fail execution.
   - **Resolution:** Replaced with standard PostgreSQL 17 `RESET ROLE;` + `pg_catalog.set_config(...)` in both normal and `EXCEPTION WHEN OTHERS` paths, plus explicit verification asserting `current_user`, `request.jwt.claims`, and `request.jwt.claim.sub` return cleanly to the original session state.
3. **H3 — Clean-State Bootstrap Test Mixed Into Post-Bootstrap Regression Suite:**
   - **Verified Defect:** Running `claim_first_owner_bootstrap` / `finalize_first_owner_bootstrap` cleanup verification inside a single script with post-bootstrap clinical tests risked false failures or confusion when executed after live bootstrap.
   - **Resolution:** Split clean-state bootstrap & claim tests into `supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql` (asserts empty `pharmacies`, `pharmacy_staff`, `bootstrap_state` preconditions BEFORE initial owner bootstrap, inside `BEGIN; ... ROLLBACK;`) and kept `supabase/tests/stage2b_0003_negative_and_integrity.test.sql` safe to run post-bootstrap via isolated fictional pharmacies inside `BEGIN; ... ROLLBACK;`.
4. **H4 — Non-Idempotent Staff Provisioning & Blind Auth Rollback on Ambiguous RPC Outcomes:**
   - **Verified Defect:** `owner-provision-staff` created an Auth user before acquiring a durable DB claim and called `deleteUser` on any RPC error/malformed response without checking whether `provision_pharmacy_staff_by_owner` had actually committed.
   - **Resolution (`0003` Section 1D & 3B + `handleOwnerProvisionStaff`):** Added `public.staff_provisioning_requests` (24th protected `public` table, `service_role` only, forced RLS), three `service_role`-only RPCs (`claim_staff_provisioning_request`, `inspect_staff_provisioning_state`, `mark_staff_provisioning_reconciliation`), and `p_request_id` linking inside `provision_pharmacy_staff_by_owner` (bringing `0003` to **18 `SECURITY DEFINER`** functions + **2 `IMMUTABLE`** helpers = **20** functions pinning `SET search_path = pg_catalog, pg_temp`). `handleOwnerProvisionStaff` now requires `Idempotency-Key` (`16..128` chars), claims before `createUser`, and inspects durable DB state before deleting an Auth user (returning reconciled `201` if committed, preserving Auth user with `500 RECONCILIATION_REQUIRED` if inspection fails, and only rolling back when DB is confirmed untouched).
5. **H5 — Missing CORS Headers & `OPTIONS` Preflight on `owner-provision-staff`:**
   - **Verified Defect:** `owner-provision-staff/index.ts` lacked `OPTIONS` handling and `Access-Control-*` headers, preventing legitimate browser-based pharmacist CRM calls.
   - **Resolution:** Added `buildStaffProvisioningCorsHeaders(requestOrigin, allowedOriginsEnv)` supporting optional `MASAR_CORS_ALLOWED_ORIGINS` allowlisting (`*` default for local dev), `OPTIONS` preflight `200 ok`, and consistent CORS headers across every success and error response (including `500 SERVER_MISCONFIGURED` and `400 INVALID_JSON`), while preserving mandatory JWT verification and server-side `pharmacy_owner` enforcement.
6. **M1 — Caller-Controllable `masar.skip_thread_audit_trigger` Audit Suppression GUC:**
   - **Verified Defect:** `send_consultation_reply` set `masar.skip_thread_audit_trigger = '1'` and `app_security.write_clinical_audit_log()` skipped logging when set, allowing an `authenticated` session calling `set_config` directly to suppress `CONSULTATION_STATUS_UPDATED`.
   - **Resolution:** Completely eliminated `masar.skip_thread_audit_trigger` from both `send_consultation_reply` and `app_security.write_clinical_audit_log()`; added an explicit negative SQL test proving `set_config('masar.skip_thread_audit_trigger', '1', true)` cannot suppress `CONSULTATION_STATUS_UPDATED`.

### Design Risks (Managed Operational Policies & Forward Milestones — Not Code Bugs)
- **D1 / H7 — Pre-Android `public.scheduled_doses` Materialization Gate:** `patient_medication_plans` and `regimen_versions` store schedule JSON definitions, while Stage 2C patient adherence notifications and `confirm_scheduled_dose(...)` rely on concrete occurrence rows in `public.scheduled_doses`. Server-side materialization (`scheduled_doses` generation on plan creation/version change/pause/resume) remains an explicit pre-Android prerequisite (`STAGE2B_SQL_DEPENDENCIES.scheduledDoseMaterializationPreAndroid`).
- **Bootstrap Operational Window & Secret Hygiene:** `bootstrap-first-owner` must remain gated by dual `>= 32`-char secrets (`MASAR_BOOTSTRAP_TOKEN` + `MASAR_PLATFORM_ADMIN_TOKEN`), invoked once, tested for `409` replay, and immediately deleted via `supabase functions delete bootstrap-first-owner` with both secrets unset.
- **Refill Provenance Scope:** Client-computed refill forecasts remain explicitly tagged `provisional_client_unverified` / `provisional_unverified` with server unit/rate/cumulative guards until a dedicated server-side schedule/refill engine is built.

---

## 2. Offline Verification Scope vs. Unexecuted Live Gates

| Check | Execution Status | Notes |
| --- | --- | --- |
| `npm test` (9 suites including `stage2b2a2Hardening.test.ts`) | Verified Offline | Mocked Edge/RPC handlers & static SQL/doc invariant checks |
| `npm run lint` (`tsc --noEmit`) & `npm run build` | Verified Offline | Clean TypeScript & Vite bundle checks |
| Apply `0003_stage2b_atomic_crm_and_bootstrap.sql` (`bkidngfzsubmyunacnju`) | **Not Executed** | Pending explicit Stage 2B.2B approval |
| Run `stage2b_0003_bootstrap_clean_state.test.sql` & `stage2b_0003_negative_and_integrity.test.sql` | **Not Executed** | Draft SQL suites pending Stage 2B.2B PostgreSQL 17 execution |
| Deploy Edge Functions & verify live Auth/CORS/RLS E2E | **Not Executed** | Pending explicit Stage 2B.2B approval |
