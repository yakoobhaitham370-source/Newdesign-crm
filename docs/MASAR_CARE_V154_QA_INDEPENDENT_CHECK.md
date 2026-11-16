# MASAR Care — Independent review of `masar-care (6).zip`

**Review date:** 2026-11-13  
**Reported project version:** V1.5.4-QA (handoff file)  
**Scope:** Static source/SQL review of uploaded ZIP; **no database changes**.

## Verified fixes

- `supabase/migrations/0001_stage2a_core_schema.sql:933–946`: the unscheduled/PRN intake trigger now explicitly rejects `is_verified_schedule != false` using SQLSTATE `23514`, rather than silently overriding `true`.
- `supabase/tests/stage2a_negative_security_and_integrity.test.sql:880–922`: the corresponding negative test expects `check_violation` and uses three separate `client_event_uuid` fixtures.
- `supabase/migrations/0002_stage2a_rls_and_security.sql:613–869`: the scheduled-dose confirmation RPC includes transaction-scoped advisory locks and handling for unique-constraint races; these are **design changes, not independently proven in PostgreSQL**.
- `src/services/clockService.ts:24–46`: fixed demo-clock mode is disabled when Vite reports a production build.
- `package.json`: the direct `esbuild` devDependency is absent, aligning with the updated dependency plan.
- `docs/MASAR_CARE_HANDOFF.md`: explicitly distinguishes application/static tests from pending live RLS, OTP, Auth and concurrency testing.

## Confirmed blocker: the concurrency harness is not yet runnable/valid

File: `supabase/tests/stage2a_concurrency_and_retry.test.sql`.

1. **Fixture does not match current tables:** at lines ~59–90 the `pharmacies` insert supplies `status` instead of `is_active` and omits required `license_number`; `pharmacy_staff` uses `license_number` and `status` instead of `syndicate_license` and `is_active`; `patients` supplies nonexistent `account_status` and `account_activated_at` fields. These statements cannot load against `0001` as written.
2. **Concurrent workers are only commented examples:** the Case A and Case B SQL is in `/*...*/` blocks, and Case C is a placeholder. Running the file with `psql -f` does **not** create simultaneous sessions or verify the claimed retry outcomes.
3. **Cleanup conflicts with audit-history immutability:** the script deletes from `regimen_versions`, but `0001` installs `trg_regimen_versions_no_delete`, which blocks deletion (`0001:746–748`). Cleanup should instead happen by dropping the dedicated disposable database, or by using a fixture strategy compatible with immutable ledgers.
4. **Assertions are too weak:** the post-race check only verifies `count <= 1` for selected dose slots, which also passes if no race actually ran. It does not assert that exactly one event exists, that winner/loser responses have the required codes, or that no unhandled errors occurred.

**Severity:** High, because this file cannot support the claimed Stage 2B readiness gate as written. The application itself is not shown to be faulty by this test-harness defect.

## Verification limits

- ZIP integrity test: **PASS**.
- Source presence: existing React/TypeScript modules and the migration/test files are present.
- Independent `npm ci --offline`: **NOT RUN SUCCESSFULLY** (`ENOTCACHED` for `ws`; missing packages in local npm cache). Therefore TypeScript/build/28 reported tests are **not independently reproduced** here.
- Migrations, real Supabase RLS, OTP/Edge Functions, concurrent race tests: **NOT EXECUTED**.
- No deployment or database writes were performed.

## Next action

Fix the concurrency test harness in the *existing* Google AI Studio project as a narrowly scoped task. Keep migrations review-only and do not change production SQL merely to make the tests pass. Then perform one final review of the corrected SQL test suite. After explicit approval, run the migrations and negative/concurrency tests against a disposable Supabase development project, with fictional records only. **Do not advance to real patient data until real Auth and RLS testing passes.**
