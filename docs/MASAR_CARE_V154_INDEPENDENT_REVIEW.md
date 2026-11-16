# MASAR Care V1.5.4 — Independent ZIP Inspection

**Source:** `masar-care (5)(1).zip` (1,158,966 bytes; 69 ZIP entries, 52 extracted files; ZIP integrity test passed).  
**Review type:** source/static review only. No Supabase connection, SQL execution, or deployment.  
**Decision:** keep the project; make a narrowly scoped QA correction before requesting owner approval to test migrations on a disposable development database.

## Confirmed fixes present in the ZIP

- `0001_stage2a_core_schema.sql` creates separate `unscheduled_dose_reports`, adds uniqueness for `scheduled_dose_id`, and uses the `enforce_dose_event_provenance` trigger for source-of-schedule data (lines 324–402, 811–964).
- `0002_stage2a_rls_and_security.sql` enumerates 22 MASAR tables in scoped REVOKE statements (lines 197–218), restricts patient direct `dose_events` insert/update using staff-only RLS (lines 424–446), and adds the patient-specific `confirm_scheduled_dose` RPC (lines 613–798).
- Calls to pgcrypto are schema-qualified as `extensions.*` and an extension preflight is documented. Actual extension placement remains unverified in PostgreSQL.
- The application uses a live Baghdad clock with the fixed fixture mode subject to a build flag (`src/services/clockService.ts`, lines 17–35).
- `docs/MASAR_CARE_V154_FIX_REPORT.md`, current migrations, SQL test script, handoff, and application tests are present.

## Confirmed issue — contradictory PRN/unscheduled security test (HIGH: test readiness)

- `0001_stage2a_core_schema.sql`, line 933: `BEFORE INSERT` trigger **sets** `NEW.is_verified_schedule := false` even if a caller supplies `true`.
- `0002_stage2a_rls_and_security.sql`, line 467: patient's INSERT RLS requires `is_verified_schedule = false`, but this check sees the row *after* the BEFORE trigger has modified it.
- `supabase/tests/stage2a_negative_security_and_integrity.test.sql`, lines 876–899: submits `is_verified_schedule=true`, expects an `insufficient_privilege` or `check_violation`, and reuses the **same** `client_event_uuid` in the next INSERT.
- Therefore, under the intended trigger behavior, the first INSERT may succeed as a normalized false-valued record, making the test fail; if test code continues, the second INSERT would also conflict on the UUID. These expectations must be reconciled before execution.

**Fix choice:** (A) explicitly reject attempted `true` in the BEFORE trigger (then the existing negative test should expect the chosen SQLSTATE); or (B) accept normalization and rewrite the test to assert the stored value is false and use distinct client UUIDs. A is easier to audit. Preserve the invariant that no unscheduled record can be stored with `is_verified_schedule=true`.

## Further reviews and risks (not established runtime failures)

1. **Concurrent confirmation/idempotency:** `0002`, lines 667–689 and 735–783, checks for an existing event before inserting. Two concurrent requests can race; unique constraints should prevent duplicates, but the losing caller may see an unhandled `unique_violation` rather than an idempotent JSON response. Add a targeted concurrent-retry test in a real database and decide on proper conflict handling.
2. **Production demo controls:** `AppShell.tsx`, lines 159–228, still exposes the staff-switcher and `Reset Demo Data` controls without the clock toggle's gating. This is acceptable for the Stage 1 demo but those controls must not survive unmodified in an authenticated production CRM. `isDemoClockModeEnabled` also permits an explicitly flagged production bundle (`clockService.ts`, line 27); ensure deployment configurations never set this for clinical environments.
3. **Dependency alignment:** `package.json` declares `esbuild:^0.25.0`, while its locked Vite 8.3.8 declares optional peer `esbuild:^0.27.0 || ^0.28.0`. Avoid the direct incompatible development dependency if unused, or align and regenerate lockfile.
4. **Actual SQL and integration tests:** Nothing in the ZIP proves SQL migrations apply, helper-function grants work, RLS isolates pharmacies, or invitation recovery works under actual Supabase Auth/Edge Function traffic. Service-side SMS and Admin Auth orchestration are not implemented.
5. **Role switching in SQL tests:** The script uses `SET LOCAL ROLE` within DO blocks (for example lines 447–463 and 468–486). PostgreSQL supports `SET LOCAL ROLE` syntax; do **not** reject this on syntax alone. Verify its behavior and privileges in the disposable PostgreSQL test environment.

## Independent verification limitations

- ZIP integrity: **passed**.
- File presence and source locations: **verified**.
- Independent `npm ci --offline`: **failed**, because required npm artifacts are not cached (`ENOTCACHED` for esbuild). Therefore the reported 28/28 application tests, TypeScript checks and Vite build were **not independently reproduced** in this environment.
- SQL migrations, PostgreSQL tests, RLS, OTP services and real-device UI: **not executed**.

## Recommended next step

1. Make one targeted QA-only correction to the unscheduled-dose trigger/test discrepancy, and align `package.json`/lockfile if tests reveal install trouble. Avoid unrelated rewrites.
2. Keep `docs/MASAR_CARE_HANDOFF.md` updated with **reported** versus **independently verified** test status.
3. After source revision is reviewed, ask the owner for **separate explicit approval** to apply only the reviewed migrations to a new, disposable development Supabase project with **fictional** data and execute the negative RLS/security test script. Do not use production or real patient records.
