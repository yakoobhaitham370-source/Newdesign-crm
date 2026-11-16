# MASAR Care — V1.5.4 Security, Provenance & Readiness Fix Report

**Baseline:** V1.5.3 (Approved Option B — Single Shared Supabase Project with Pharmacy-Level RLS)  
**Input Audit:** `docs/MASAR_CARE_V153_INDEPENDENT_AUDIT.md`  
**Execution Constraints:** Review-only SQL/code hardening. **No SQL executed against PostgreSQL, no live Supabase connection, no deployment, fictional data only.**

---

## 1. Audit Verification & Remediation Summary

| ID | Audit Finding | Verification Result | V1.5.4 Resolution | Status |
| :--- | :--- | :--- | :--- | :--- |
| **H1** | `dose_events` allowed patient direct `INSERT` with `scheduled_dose_id = NULL` and client-supplied schedule/regimen/dose amounts | **CONFIRMED** (`0001:324`, `0001:749–761`, `0002:211`, `0002:399–421`) | Revoked direct patient `INSERT`/`UPDATE` RLS policies on `dose_events`; created least-privilege `public.confirm_scheduled_dose(uuid, text, uuid, text)` RPC deriving all schedule fields from `scheduled_doses`, checking `patient_medication_plans.status = 'active'` and pause windows, enforcing `client_event_uuid` idempotency and duplicate blocking (`UNIQUE (scheduled_dose_id)`); hardened `enforce_dose_event_provenance()` trigger to require non-null `scheduled_dose_id` on `INSERT` and overwrite schedule/dose fields from `scheduled_doses` while permitting FK `ON DELETE SET NULL (scheduled_dose_id)` cleanup; added explicit `public.unscheduled_dose_reports` (Table #22) with `is_verified_schedule = false` constrained permanently. | **SQL/TS Remediated — Live PostgreSQL Execution Pending** |
| **H2** | Broad `REVOKE ALL ON ALL TABLES/SEQUENCES IN SCHEMA public` in `0002:189–190` | **CONFIRMED** | Replaced schema-wide wildcard revocations with explicit per-table `REVOKE ALL ON TABLE public.<masar_table> FROM PUBLIC, anon, authenticated;` statements across the 22 enumerated MASAR tables only. Documented that MASAR uses UUID primary keys (`gen_random_uuid()`) and creates zero sequences. | **SQL Remediated — Live PostgreSQL Execution Pending** |
| **H3** | `pgcrypto` (`crypt`, `gen_salt`, `digest`, `gen_random_bytes`), `pg_trgm`, and `btree_gist` resolved unqualified inside `SECURITY DEFINER` functions without `extensions` in `search_path` | **CONFIRMED** (`0001:10–12`, `0002:23–103`, `0002:560–941`) | Explicitly created/isolated extensions in `extensions` schema (`CREATE EXTENSION ... WITH SCHEMA extensions;`), qualified `extensions.gin_trgm_ops` and `extensions.gist_uuid_ops`, schema-qualified every `pgcrypto` call (`extensions.gen_random_bytes`, `extensions.digest`, `extensions.crypt`, `extensions.gen_salt`) across `0002` and SQL tests, kept safe pinned `SET search_path = pg_catalog, public, app_security, pg_temp` (no user-writable schemas), and added target-Postgres pre-flight discovery SQL. | **SQL Remediated — Live PostgreSQL Execution Pending** |
| **H4** | Device recovery allowed any `authorized_pharmacist` with a 5-character `recovery_reason` | **CONFIRMED** (`0002:599–614`) | Strengthened `patient_apk_invitations` and `issue_patient_apk_invitation` / `redeem_patient_apk_invitation`: recovery now requires `pharmacy_owner` approval (`approved_by_owner_id`), independent identity verification attestation (`recovery_identity_verified = true`), `verified_account_phone IS NOT NULL`, `>= 10`-char reason, 24h rate limit (max 2), matching `superseded_auth_user_id` check, fresh `p_bootstrap_auth_user_id`, atomic unlink/rebind, and audit flag `requiresPriorSessionRevocation = true`. | **SQL Ceremony Hardened — SMS/Auth Edge Functions NOT IMPLEMENTED** |
| **M1** | `fixed_fixture` demo clock toggle exposed unconditionally in CRM UI | **CONFIRMED** (`CrmContext.tsx:125–150`, `AppShell.tsx:184–209`) | Added `isDemoClockModeEnabled()` and `resolveRuntimeClockMode()` in `src/services/clockService.ts` gating `fixed_fixture` strictly to `import.meta.env.DEV` or explicit `VITE_ENABLE_DEMO_CLOCK=true`. Production builds force `live_baghdad` and hide the toggle while preserving `FixedBaghdadClock` for unit tests. Removed unused `GEMINI_API_KEY` prompt placeholder from `.env.example` and documented MASAR env setup in `README.md`. | **Implemented & Unit-Tested** |
| **M2** | `CrmContext.tsx` runs on synchronous `InMemoryCrmAdapter` (`isLoading` inert) | **CONFIRMED (Roadmap)** | Preserved `IAsyncCrmRepository` / `AsyncInMemoryCrmRepository` boundary; live `SupabaseCrmRepository` intentionally deferred to Stage 2B after isolated dev SQL approval. | **Deferred to Stage 2B** |
| **M3** | Mobile/tablet viewport automation & native Android QR/notification verification incomplete | **CONFIRMED (QA Gate)** | Preserved responsive layout; real-device/browser E2E matrix and native Android APK remain pending Stage 2B/Stage 3. | **Deferred QA Gate** |

---

## 2. Detailed Technical Controls Added

### 2.1 `pgcrypto` & Extension Schema Inspection (`H3`)
Before executing `0001_stage2a_core_schema.sql` against an isolated Supabase/PostgreSQL development database, inspect where extensions are currently installed:

```sql
SELECT e.extname, n.nspname AS installed_schema, e.extversion
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('pgcrypto', 'pg_trgm', 'btree_gist')
ORDER BY e.extname;
```

- If a target Supabase project already installed `pgcrypto`, `pg_trgm`, or `btree_gist` in `extensions`, `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA extensions;` is a no-op and all `extensions.*` qualified calls resolve cleanly.
- If an existing database previously installed an extension into `public`, move it once before applying `0001`/`0002` (or verify schema):
  ```sql
  ALTER EXTENSION pgcrypto SET SCHEMA extensions;
  ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  ALTER EXTENSION btree_gist SET SCHEMA extensions;
  ```
- Every `SECURITY DEFINER` helper and RPC in `0002` pins `SET search_path = pg_catalog, public, app_security, pg_temp` (never adding `public`-writable or untrusted schemas).

### 2.2 Scoped `GRANT` / `REVOKE` Behavior with Unrelated Tables in `public` (`H2`)
- `0002` no longer issues `REVOKE ALL ON ALL TABLES IN SCHEMA public` or `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public`.
- Only the **22 explicitly enumerated MASAR tables** (`pharmacies` through `audit_logs`, including `unscheduled_dose_reports`) receive per-table `REVOKE ALL ON TABLE public.<name> FROM PUBLIC, anon, authenticated;`, followed by least-privilege column/table `GRANT`s for `authenticated` and `ENABLE`/`FORCE ROW LEVEL SECURITY`.
- Any pre-existing non-MASAR tables or sequences in `public` keep their original privileges and PostgREST exposure untouched. (Recommended best practice remains deploying into a dedicated Supabase project or verifying `pg_tables` + `information_schema.role_table_grants` post-migration.)

### 2.3 Scheduled-Dose Provenance vs Unscheduled PRN Intakes (`H1`)
1. **Verified Scheduled Occurrences (`public.dose_events`):**
   - Patients have **zero** direct `INSERT` or `UPDATE` RLS policies on `dose_events`.
   - `public.confirm_scheduled_dose(p_scheduled_dose_id, p_status, p_client_event_uuid, p_patient_note)` validates `app_security.current_patient_id()`, confirms ownership on `scheduled_doses`, enforces `patient_medication_plans.status = 'active'` and absence of active pause periods covering `scheduled_date`, supports offline `client_event_uuid` idempotent replay, rejects duplicate confirmations (`DUPLICATE_DOSE_CONFIRMATION_BLOCKED`), and derives `regimen_version_number`, `scheduled_date`, `scheduled_time24`, `planned_dose_amount`, and `dose_unit` strictly from `scheduled_doses`.
   - `enforce_dose_event_provenance()` provides defense-in-depth at the trigger layer (`BEFORE INSERT OR UPDATE`), rejecting `NULL` `scheduled_dose_id` on `INSERT` while allowing parent deletion archival cleanup (`ON DELETE SET NULL (scheduled_dose_id)`).
2. **Unscheduled / PRN Patient-Reported Intakes (`public.unscheduled_dose_reports`):**
   - Separate table #22 with `report_type IN ('prn_intake', 'unscheduled_extra')` and permanent constraint `is_verified_schedule boolean NOT NULL DEFAULT false CHECK (is_verified_schedule = false)`.
   - `enforce_unscheduled_dose_report_provenance()` verifies active plan ownership, requires `(schedule->>'frequencyType') = 'prn'` when `report_type = 'prn_intake'`, stamps `server_recorded_at`, and locks patient intake columns against mutation while letting pharmacists record `reviewed_by_staff_id` and `reviewed_at`.

### 2.4 Strengthened Recovery Controls & Unimplemented Stage 2B Components (`H4`)
- SQL-layer recovery safeguards implemented: `pharmacy_owner`-only issuance (`RECOVERY_REQUIRES_PHARMACY_OWNER_APPROVAL`), mandatory `p_recovery_identity_verified = true`, `verified_account_phone IS NOT NULL`, `>= 10`-char `recovery_reason`, 24h cap (max 2 recovery invitations/patient), `superseded_auth_user_id` race guard, mandatory fresh `p_bootstrap_auth_user_id`, and immutable `audit_logs` entry flagging `requiresPriorSessionRevocation = true`.
- **Honest Unimplemented Status:** Real SMS OTP gateway delivery, Supabase Admin Auth user provisioning (`auth.admin.createUser`), Edge Function orchestration for `request_invitation_sms_otp` / `redeem_patient_apk_invitation`, and prior session revocation (`auth.admin.signOut` / user ban) are **NOT IMPLEMENTED** in Stage 1 / V1.5.4.

---

## 3. Isolated Development PostgreSQL Verification Plan (NOT EXECUTED)

Do **not** run against production. After explicit owner approval to provision a disposable development Supabase/PostgreSQL 15+ instance:

1. **Extension Pre-Flight Check:**
   - Run the `pg_extension` discovery query above to confirm `pgcrypto`, `pg_trgm`, `btree_gist` schema placement (`extensions`).
2. **Apply Stage 2A Migrations in Transaction-Safe Dev Instance:**
   - Execute `supabase/migrations/0001_stage2a_core_schema.sql`.
   - Execute `supabase/migrations/0002_stage2a_rls_and_security.sql`.
3. **Verify Exposure, Grants & RLS Matrix:**
   - Assert every one of the 22 MASAR tables has `relrowsecurity = true` AND `relforcerowsecurity = true` in `pg_class`.
   - Assert `anon` has **0** privileges across all 22 MASAR tables and functions (`has_table_privilege` / `has_function_privilege`).
   - Create a sentinel unrelated table `public._non_masar_probe` prior to `0002` and verify its pre-existing `GRANT`s survive `0002` (`H2`).
4. **Execute Negative Security, RLS & Provenance Suite:**
   - Run `psql -v ON_ERROR_STOP=1 -f supabase/tests/stage2a_negative_security_and_integrity.test.sql` (wrapped in `BEGIN; ... ROLLBACK;` with fictional fixtures):
     - Section 2 (`C4`): cross-patient `medication_plan_id` rejection.
     - Section 3 (`H6`): column-specific `ON DELETE SET NULL (scheduled_dose_id)`.
     - Section 4 (`M6`/`F2`): `btree_gist` `exclusion_violation` (`23P01`) + dose amount immutability.
     - Section 5 (`C1`/`C3`/`H3`/`H4`/`H8`/`F9`): CSPRNG OTP, non-rollback lockouts, bootstrap binding, owner-only recovery, identity attestation failure.
     - Section 6 (`F8`/`C2`/`M7`): `anon`, Pharmacy A staff/owner, inactive staff, Pharmacy B cross-tenant isolation, `patient_apk_invitations` column secret protection, direct `dose_events` insert denial for patients.
     - Section 7 (`H1`): `NULL` `scheduled_dose_id` rejection, cross-patient `scheduled_dose_id` rejection, discontinued plan rejection, `client_event_uuid` idempotent replay, duplicate confirmation blocking, and `unscheduled_dose_reports` (`is_verified_schedule = false`) enforcement.
5. **Independent Runtime Smoke Tests (`M3`):**
   - Execute headless/device RTL Arabic & LTR English responsive tests (375px mobile, 768px tablet, 1280px desktop) before Stage 2B sign-off.

---

## 4. Verification Results Executed Locally (V1.5.4)

- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 errors)
- `npm run build` (`vite build`): **PASS** (clean `dist/` with no `.zip` or third-party screenshots)
- `npm test`: **28/28 PASS** (`8/8` Stage 1 + `7/7` V1.5 + `8/8` V1.5.1 + `5/5` Audit Remediation using in-memory repository, injected Baghdad clocks, and static SQL inspection)
- **PostgreSQL Live Migrations & RLS Execution:** **NOT RUN** (per hard constraint)
- **Edge Functions / SMS OTP / Supabase Auth Bootstrap:** **NOT IMPLEMENTED**
