# MASAR Care — Stage 2A Development Database Execution Runbook

**Target Development Project:** `bkidngfzsubmyunacnju` (`https://bkidngfzsubmyunacnju.supabase.co`)  
**Scope:** Authorized Stage 2A preparation & verification instructions (fictional data only).  
**Security Rule:** Never paste your PostgreSQL database password, `DEV_DATABASE_URL`, or `service_role` key into chat, Git, or tracked files. Set connection variables locally in your terminal session only.

---

## 1. Static Schema & Test-Harness Verification Summary

Static inspection and Stage 2A execution against disposable dev project `bkidngfzsubmyunacnju` (PostgreSQL 17.11, fictional data only; see `docs/STAGE2A_DATABASE_TEST_RESULTS.md`) confirm full DDL and constraint alignment across:
- `supabase/migrations/0001_stage2a_core_schema.sql` (22 tables, `extensions` schema isolation for `pgcrypto` / `pg_trgm` / `btree_gist`, composite patient+plan FKs, immutable ledger triggers, explicit `SQLSTATE 23514` rejection on `unscheduled_dose_reports.is_verified_schedule != false`).
- `supabase/migrations/0002_stage2a_rls_and_security.sql` (`app_security.*` helpers, `FORCE ROW LEVEL SECURITY` + scoped `REVOKE`/`GRANT` across all 22 tables, `confirm_scheduled_dose` advisory-lock + `unique_violation` recovery, `issue_patient_apk_invitation`, `request_invitation_sms_otp`, `redeem_patient_apk_invitation`).
- `supabase/tests/stage2a_negative_security_and_integrity.test.sql` (**Corrected V2 synchronized with verified PostgreSQL 17.11 run**: matches `0001`/`0002` DDL; runs inside `BEGIN; ... ROLLBACK;`; covers `C1`–`C4`, `F2`, `F8`, `F9`, `H1`, `H3`–`H8`, `M6`, `M7`; Section 6E seeds genuine `2026-11-14` `scheduled_doses` rows `v_sd_own_guard` / `v_sd_other_guard` and separates `H1-A` trigger provenance rejection [`23514`] from `H1-B` RLS direct-insert denial [`42501`] and `F8` cross-patient guard [`42501` or `23514`]).
- `supabase/tests/stage2a_concurrency_and_retry.test.sql` + `supabase/tests/run_stage2a_concurrency_and_retry.sh` (matches `0001` exact columns on `pharmacies`, `pharmacy_staff`, `patients`, `patient_medication_plans`, `regimen_versions`, 4 `scheduled_doses`; omits illegal `DELETE FROM public.regimen_versions`; executes parallel Case A/B/C workers).

---

## 2. Database Connection Configuration (Local Terminal Only)

In the Supabase Dashboard for project **`bkidngfzsubmyunacnju`**:
1. Open **Project Settings -> Database -> Connection string**.
2. Choose **URI** using either:
   - **Direct connection** (`db.bkidngfzsubmyunacnju.supabase.co`, port `5432`) if your network supports IPv6, OR
   - **Session pooler** (`aws-0-<region>.pooler.supabase.com`, port `5432`) if your network requires IPv4.
   - **Do NOT use Transaction Pooler (port `6543`)** for Stage 2A tests (`SET LOCAL ROLE` and multi-statement transactions require direct or session-mode Postgres connections).
3. URL-encode any special characters (`@`, `#`, `?`, `/`) in your password inside the URI.
4. Export these variables **only in your local shell** (never commit or paste them):

```bash
export DEV_DATABASE_URL="postgresql://postgres.<ref>:<URL_ENCODED_PASSWORD>@<HOST>:5432/postgres?sslmode=require"
export MASAR_DISPOSABLE_DEV_APPROVED="I_CONFIRM_DISPOSABLE_DEV_DB_NO_REAL_PATIENT_DATA"
export MASAR_EXPECTED_DB_NAME="postgres"
export MASAR_EXPECTED_DB_HOST="<HOST>"   # e.g. db.bkidngfzsubmyunacnju.supabase.co or aws-0-...pooler.supabase.com
```

> Note: Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` unused until **Stage 2B** is explicitly authorized. Stage 1 continues running in Demo Mode (`InMemoryCrmAdapter`).

---

## 3. Exact Execution Order (Once SQL Execution Is Explicitly Approved)

### Step 1 — Pre-Flight Inspection (Read-Only)
Verify database identity, confirm `public.pharmacies` does not yet exist (clean project), and inspect where extensions (`pgcrypto`, `pg_trgm`, `btree_gist`) currently live:

```bash
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
SELECT current_database() AS db, current_user AS role, version();
SELECT e.extname, n.nspname AS installed_schema, e.extversion
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('pgcrypto', 'pg_trgm', 'btree_gist')
ORDER BY e.extname;
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
"
```

- If `pgcrypto` or `pg_trgm` is already installed in `public` instead of `extensions`, run:
  ```sql
  CREATE SCHEMA IF NOT EXISTS extensions;
  ALTER EXTENSION pgcrypto SET SCHEMA extensions;
  ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  ```

### Step 2 — Apply Migration 0001 (Core Schema, Constraints & Triggers)
```bash
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/0001_stage2a_core_schema.sql
```

### Step 3 — Apply Migration 0002 (Private `app_security`, RLS, Grants & RPCs)
```bash
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/0002_stage2a_rls_and_security.sql
```

### Step 4 — Verify RLS & Extension Matrix (Read-Only Check)
Confirm all 22 MASAR tables have both `relrowsecurity = true` and `relforcerowsecurity = true`, and `anon` has zero table privileges:

```bash
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
"
```

### Step 5 — Run Corrected Negative Security, RLS & Provenance Suite (`BEGIN ... ROLLBACK`)
Runs the synchronized V2 test suite (`supabase/tests/stage2a_negative_security_and_integrity.test.sql`) with fictional records inside a single transaction that rolls back cleanly at the end:

```bash
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/stage2a_negative_security_and_integrity.test.sql
```
- Confirm `COMMIT`/`ROLLBACK` completes with **0 uncaught exceptions** (proves `SET LOCAL ROLE anon/authenticated`, cross-tenant denial, column secret protection, `H1-A` provenance trigger `23514` vs `H1-B` RLS direct-insert `42501` denial, `F8` cross-patient denial, `23P01` pause overlap, `23514` unscheduled report rejection, and `confirm_scheduled_dose` provenance).

### Step 6 — Run Two-Session Concurrency & Retry Harness (Cases A, B, C)
Executes parallel `psql` workers with committed fictional test rows (`Concurrency QA Pharmacy`):

```bash
./supabase/tests/run_stage2a_concurrency_and_retry.sh
```
- Verify output prints:
  - `[case_a]` -> 1 fresh write (`idempotentReplay=false`) + 1 replay (`idempotentReplay=true`), same `doseEventId`
  - `[case_b]` -> 1 winner + 1 `DUPLICATE_DOSE_CONFIRMATION_BLOCKED`
  - `[case_c]` -> 1 winner + 1 `CLIENT_EVENT_UUID_CONFLICT`
  - `PASS: Two-session concurrency harness succeeded for Cases A, B, and C.`

### Step 7 — Post-Test Cleanup of Concurrency Fixture (Disposable Dev DB)
Because `trg_regimen_versions_no_delete` forbids `DELETE` on `regimen_versions`, clean up after Step 6 only after explicit approval via **Supabase Dashboard -> Reset Database** (or destroying/re-creating the dev schema/project) before applying clean migrations for Stage 2B.
