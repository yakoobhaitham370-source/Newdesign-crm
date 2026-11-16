# MASAR Care V1.5.2 — Independent Re-Audit of Uploaded ZIP

**Reviewed:** 2026-11-13  
**Source:** `masar-care (2).zip` (97 archive entries; extracted locally for read-only inspection)  
**Approved architecture:** Option B — one shared Supabase project with tenant isolation  
**Decision:** **HOLD** Stage 2B SQL execution. Correct and test the defects below first.

## Executive assessment

The project contains the claimed Rev 2 SQL migrations, a 21-table schema, an in-memory React CRM, an asynchronous repository contract, and 4 TypeScript test files. Several earlier findings were addressed at the source level (structured JSONB error returns in invitation RPCs; role-restricted OTP/redemption functions; composite foreign keys; historical refill logic; a lockfile).

However, the V1.5.2 handoff's blanket claim that all issues are resolved is **not supported by the source**. The project is still a non-persistent prototype, and the database security checks are static rather than executed against PostgreSQL.

## Confirmed findings and actions

### F1 — BLOCKER: Negative SQL tests are inconsistent with the schema
- `supabase/tests/stage2a_negative_security_and_integrity.test.sql:36–63` inserts `pharmacies.code`, `district`, `owner_Display_name`, `patients.full_name_ar`, `full_name_en`, `gender`, medication plans with `custom_name_ar`, `frequency_type`, `times_of_day`, etc.
- These columns **do not exist** in the Rev 2 DDL (`0001_stage2a_core_schema.sql:16–28`, `64–92`, `165–204`, `217–240`). The test seed also fails to provision the required `auth.users`/`pharmacy_staff` references and mandatory regimen attributes.
- The same test uses `scheduled_doses.scheduled_time`, `scheduled_at`, `dose_amount` (`test.sql:119–128`) rather than `scheduled_time24`, `planned_dose_amount` (`0001:282–300`), and `medication_pause_periods.pause_start_date/pause_end_date/patient_id` rather than `paused_from/resumed_at` (`0001:253–264`).
- **Required:** Rewrite fixtures and expected assertions directly against final DDL; create necessary fictional staff/auth users using a controlled test harness; add allowed/denied role tests and transactional rollback. Do **not** execute existing test SQL as-is.

### F2 — BLOCKER: SQL trigger error contract does not match the test
- Test `stage2a_negative_security_and_integrity.test.sql:180` catches `exclusion_violation`.
- Trigger function `0001_stage2a_core_schema.sql:718–739` uses bare `RAISE EXCEPTION`, which normally signals SQLSTATE `P0001`, not `exclusion_violation` (`23P01`).
- **Required:** Use an actual exclusion constraint if suitable, or make the test assert the intentionally raised SQLSTATE. Evaluate concurrency behavior; a lookup-only overlap trigger can race on concurrent transactions.

### F3 — HIGH: Fixed demo date remains in operational code
- `src/i18n/translations.ts:19` exports `APP_REFERENCE_DATE = '2026-11-12'`.
- `src/views/DashboardView.tsx:16,86` displays it; `RefillsView.tsx:5,31` uses it to create follow-up due dates; `DispensingView.tsx:4,41` initializes dispensing dates with it.
- `src/services/crmRepository.ts:230,268,424,507–508,613,673,704` still uses the constant as defaults or event timestamps; `scheduleEngine.ts:801` uses it as a default reference date.
- **Required:** Replace runtime uses with a consistently injected Baghdad clock. Keep the fixed date only as an *explicit test/demo fixture*. Include checks on actual calendar rollover.

### F4 — HIGH: Live clock state is stale and fixture is the default
- `src/context/CrmContext.tsx:127` defaults `initialClockMode = 'fixed_fixture'`.
- `src/context/CrmContext.tsx:149` calculates `todayStr` with `useMemo(..., [clockMode])`, so a live session crossing midnight will keep yesterday's date until the mode changes or the component remounts.
- **Required:** Default to `live_baghdad` in any non-demo environment; update day-dependent state at midnight/when foregrounded and test calendar rollover. Clearly label a manually selected demo-fixture mode.

### F5 — HIGH: App source archive is in a public web asset directory
- `public/MASAR_CARE_V1.5.2.zip` is an approximately 184 KB embedded project export containing source, SQL migrations, and documentation.
- Vite normally copies `public/` assets into the web build. This can make the source ZIP publicly downloadable if the project is deployed.
- **Required:** Move the ZIP outside `public/` and exclude it from deployment artifacts. Audit `public/assets/aistudio/` reference screenshots for privacy/copyright and remove unneeded ones before publication.

### F6 — HIGH (IMPLEMENTATION BLOCKER): Patient activation backend is not implemented
- `0002_stage2a_rls_and_security.sql:669–1033` defines proposed OTP and redemption RPCs restricted to `service_role` (a valuable change), but the ZIP contains **no deployed Edge Function implementation or SMS gateway integration**.
- `p_bootstrap_auth_user_id` is accepted from the backend caller (`0002:832–859, 963–1001`). Its generation, verification, OTP dispatch, orphaned Auth-user reconciliation and account-recovery ceremony still need implementation and independent testing.
- **Required:** Mark as planned, not completed; design and later test a trusted Edge Function, phone ownership verification, failure compensation, and replay protection before patient onboarding goes live.

### F7 — MEDIUM: Async repository exists but is not wired into CRUD UI
- `src/services/crmRepository.ts:324–370` defines `IAsyncCrmRepository` and `AsyncInMemoryCrmRepository`.
- `src/context/CrmContext.tsx:151–164` still initializes `InMemoryCrmAdapter` and `isLoading` to `false` without a setter; CRUD context methods are synchronous.
- **Required:** Treat this as a design scaffold, not completed Supabase readiness. Define explicit API loading/rollback/error patterns for Stage 2B, without prematurely connecting production data.

### F8 — MEDIUM: Negative SQL tests do not constitute live RLS verification
- The provided negative-security test suite is currently incompatible with the schema. Even after its fixtures are repaired, it must test actual `anon`, patient, pharmacist, owner, and cross-pharmacy sessions, `GRANT`s, RPC execution permissions, and rejected write attempts.
- No PostgreSQL execution, RLS role tests, or real Auth/Edge integration is recorded in the ZIP.

### F9 — LOW: CSPRNG implementation is not rejection sampled as claimed
- `0002_stage2a_rls_and_security.sql:83–98` uses secure random bytes, but maps them to a six-digit range by modulo operation. The documentation claims rejection sampling / elimination of modulo bias; the implementation does not do that.
- **Required:** Correct the claim or implement unbiased rejection sampling, while preserving rate limits and keeping secrets server-side.

## Changes that appear to be present (not live-verified)

- `0002:759–784, 931–961`: failed PIN/OTP attempts use structured JSONB returns after updates, avoiding the previously identified rollback-on-exception pattern.
- `0002:1040–1044`: OTP/redemption RPCs have `EXECUTE` revoked from public/anonymous/authenticated and granted to service role.
- `0001:165–204, 282–340, 352–382`: composite plan/patient/tenant keys protect several cross-patient relationships.
- `0001:397–420`: refill assessment references last dispensing event with column-specific `ON DELETE SET NULL`.
- `src/services/clockService.ts`: contains a live Baghdad clock and deterministic fixture clock, although not yet correctly used everywhere.

## Verification actually performed here

- Read-only ZIP extraction and source inspection.
- Compared test SQL insert columns and exception handling with Rev 2 schema and triggers.
- Traced runtime date references and Context provider defaults.
- Inspected privileged invitation SQL functions, permissions, and project public assets.
- **Not run:** PostgreSQL migrations, SQL negative tests, live Supabase/RLS tests, physical UI browser tests, or deployed Edge Functions.
- **Node tests/build:** Dependency installation (`npm ci`) did not finish in this environment; therefore the reported 28 checks and build were **not independently re-run**. This is a tool/environment limitation, not a newly observed test failure.

## Recommended next sequence

1. **V1.5.3 (targeted, no DB execution):** Correct mismatched SQL test fixtures and SQL error contract, eliminate remaining runtime fixed dates, update live clock behavior, remove exported archive from `public/`, and update honest report status.
2. Re-export updated ZIP and review final SQL/test source.
3. Request explicit approval for an isolated PostgreSQL/Supabase development test environment with fictional data only.
4. Execute corrected SQL migrations **on development only**; run database-native permission, RLS, constraints, and RPC tests under actual roles. Fix any failures.
5. Implement and verify Auth/Edge functions and async CRM adapter. Only later consider production and the patient APK.

**Final recommendation:** Do not execute Rev 2 SQL as approved migrations yet. No database, deployed app, or user file was modified during this review.
