# MASAR Care — Stage 2A Concurrency Test-Harness Correction

**Baseline:** V1.5.4-QA (`docs/MASAR_CARE_V154_QA_INDEPENDENT_CHECK.md`)  
**Scope:** Test-harness correction only (`supabase/tests/` and static verification). **No React CRM edits, no production SQL/RLS schema changes, no Supabase connection, no SQL execution, and no deployment.**

---

## 1. Confirmed Defects Repaired

| Blocker Finding (`MASAR_CARE_V154_QA_INDEPENDENT_CHECK.md`) | Confirmed Cause | Resolution |
| :--- | :--- | :--- |
| **1. Fixture columns did not match `0001_stage2a_core_schema.sql`** | `stage2a_concurrency_and_retry.test.sql` used nonexistent `pharmacies.status` (omitting required `license_number`), `pharmacy_staff.license_number`/`status` (instead of `syndicate_license`, `phone`, `is_active`, `created_by_user_id`), and nonexistent `patients.account_status`/`account_activated_at` (omitting `created_by_staff_id` and `auth_linked_at`). | Aligned every seed column and FK in `supabase/tests/stage2a_concurrency_and_retry.test.sql` to `0001_stage2a_core_schema.sql` (`pharmacies`, `pharmacy_staff`, `patients`, `patient_medication_plans`, `regimen_versions`, plus 4 `scheduled_doses` covering Cases A, B, and two doses `c`/`d` for Case C). |
| **2. Workers were commented placeholders** | Case A/B SQL sat inside `/* ... */` blocks and Case C was a stub; `psql -f` did not spawn parallel sessions. | Replaced placeholders with executable two-session runner `supabase/tests/run_stage2a_concurrency_and_retry.sh`, launching two separate synchronized `psql` processes (`clock_timestamp()` `pg_sleep` barrier) for Cases A, B, and C, capturing exit codes/stdout/stderr, and asserting JSONB winner/loser payloads. |
| **3. Illegal `DELETE FROM public.regimen_versions` cleanup** | `0001:746-748` attaches `trg_regimen_versions_no_delete` (`prevent_ledger_mutation()`), rejecting `DELETE` on `regimen_versions`. | Removed all `DELETE` cleanup statements. Adopted a **disposable-database reset/destroy strategy** with a pre-seed clean-slate guard that fails loudly if prior fixture rows or non-test pharmacies exist. |
| **4. Weak `<= 1` post-race assertions could false-pass** | Post-race block checked `v_count_a > 1` / `v_count_b > 1` (passing when `0` rows existed) and omitted Case C or response-code assertions. | Updated Phase 2 in `stage2a_concurrency_and_retry.test.sql` to assert `v_cnt_a = 1`, `v_cnt_b = 1`, and `v_cnt_c_total = 1` with expected UUIDs/statuses. Standalone `psql -f` invocation without `-v run_seed=1` or `-v run_verify=1` now fails loudly (`HARNESS USAGE ERROR`). |

---

## 2. Production-Refusal Guard & Non-Database Safety Notice

`supabase/tests/run_stage2a_concurrency_and_retry.sh` **does not assume a database name or hostname alone proves non-production safety.** Execution requires all of:

1. `psql` present on `PATH`.
2. `NODE_ENV`, `SUPABASE_ENV`, and `MASAR_ENV` NOT equal to `production`.
3. `DEV_DATABASE_URL` set and distinct from `PRODUCTION_DATABASE_URL` and ambient `DATABASE_URL`.
4. Explicit approval flag:
   `MASAR_DISPOSABLE_DEV_APPROVED="I_CONFIRM_DISPOSABLE_DEV_DB_NO_REAL_PATIENT_DATA"`
5. Explicit target database identity verification (`MASAR_EXPECTED_DB_NAME` matched against `SELECT current_database()`, and `MASAR_EXPECTED_DB_HOST` matched against the URI host).
6. In-database isolation check refusing to seed if any non-test `public.pharmacies` rows exist (`WHERE id <> 'c1111111-1111-4111-8111-111111111111'`).

---

## 3. Negative RLS Harness Cross-Check (`stage2a_negative_security_and_integrity.test.sql`)

- Verified all table inserts/columns against `0001_stage2a_core_schema.sql` (`pharmacies`, `pharmacy_staff`, `patients`, `patient_medication_plans`, `regimen_versions`, `follow_up_tasks`, `dispensing_events`, `scheduled_doses`, `dose_events`, `medication_pause_periods`, `patient_apk_invitations`, `unscheduled_dose_reports`).
- Wrapped Section 5 `issue_patient_apk_invitation` checks in `SET LOCAL ROLE authenticated` with `RESET ROLE` cleanup, and added an explicit header documenting **unverified runtime assumptions pending real PostgreSQL validation**:
  - Availability and role membership of Supabase `anon` and `authenticated` roles under `SET LOCAL ROLE`.
  - Exact evaluation of `auth.uid()` against `request.jwt.claim.sub` / `request.jwt.claims` session GUCs.
  - Runtime `insufficient_privilege` (`42501`) behavior, `auth.users` column compatibility, and `extensions.*` resolution.

---

## 4. Remaining Authorization Prerequisites Before Live Execution

1. **Owner Approval for Disposable Dev DB:** Separate explicit approval to provision an isolated disposable Supabase/PostgreSQL 15+ development project (fictional data only, no production or real patient data).
2. **Apply Stage 2A Migrations & Run Tests in Order:**
   - Apply `supabase/migrations/0001_stage2a_core_schema.sql` and `0002_stage2a_rls_and_security.sql`.
   - Execute `psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/stage2a_negative_security_and_integrity.test.sql`.
   - Execute `./supabase/tests/run_stage2a_concurrency_and_retry.sh` with all required approval and identity environment variables set.
   - Destroy/reset the disposable development database after verification.
3. **Stage 2B Gate:** Do not start Stage 2B (`SupabaseCrmRepository`, Auth, Edge Functions, SMS OTP, removal of Stage 1 demo controls) until real PostgreSQL RLS and concurrency tests pass.
