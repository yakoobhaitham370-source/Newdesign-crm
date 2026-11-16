# MASAR Care V1.5.3 — Independent Re-Audit Fix Report

**Version:** V1.5.3 (Targeted Corrections Before Stage 2B)  
**Date:** 2026-11-13  
**Input Audit:** `docs/MASAR_CARE_V152_INDEPENDENT_REAUDIT.md` (`F1`–`F9`)  
**Approved Architecture:** Option B — One shared Supabase project with strict `pharmacy_id` isolation  
**SQL / DB Execution Status:** **NOT RUN** (Review-only; no Supabase connection, no SQL executed, no deployment)

---

## 1. Confirmed Defects & Remediation Matrix (`F1`–`F9`)

| ID | Severity | Verified Defect in V1.5.2 | V1.5.3 Resolution & Exact File Evidence | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **F1** | BLOCKER | `supabase/tests/stage2a_negative_security_and_integrity.test.sql` referenced nonexistent columns (`code`, `district`, `owner_Display_name`, `full_name_ar`, `gender`, `custom_name_ar`, `frequency_type`, `times_of_day`, `scheduled_time`, `scheduled_at`, `dose_amount`, `pause_start_date`, `pause_end_date`, `patient_id` on pauses) and lacked required `auth.users` / `pharmacy_staff` / `license_number` / `verified_instructions` / `schedule` fixtures. | Completely rewrote `supabase/tests/stage2a_negative_security_and_integrity.test.sql` against exact `0001_stage2a_core_schema.sql` and `0002_stage2a_rls_and_security.sql` DDL, including a transactional fictional `auth.users` + `pharmacy_staff` harness (`BEGIN; ... ROLLBACK;`). | Static TS check PASS; **PostgreSQL execution NOT RUN** |
| **F2** | BLOCKER | `stage2a_negative_security_and_integrity.test.sql` caught `exclusion_violation` (`23P01`), while `enforce_non_overlapping_pause_periods()` in `0001` raised generic `P0001` and relied on a lookup trigger without concurrency safety. | Added `CREATE EXTENSION IF NOT EXISTS "btree_gist";`, concurrency-safe `CONSTRAINT ex_medication_pause_periods_no_overlap EXCLUDE USING gist (medication_plan_id WITH =, daterange(paused_from, COALESCE(resumed_at, 'infinity'::date), '[)') WITH &&)` on `public.medication_pause_periods`, and `USING ERRCODE = '23P01'` on the trigger in `supabase/migrations/0001_stage2a_core_schema.sql`. | Static TS check PASS; **PostgreSQL execution NOT RUN** |
| **F3** | HIGH | `APP_REFERENCE_DATE = '2026-11-12'` remained in `src/i18n/translations.ts`, `DashboardView.tsx`, `RefillsView.tsx`, `DispensingView.tsx`, `crmRepository.ts` (`computeAllRefillProjections`, `computeDashboardKpis`, `buildUpdatedMedicationPlanVersion`, `buildMockInvitation`, `archivePatient`, `updateMedicationPlan`, `changeMedicationStatus`), and `scheduleEngine.ts`. | Removed `APP_REFERENCE_DATE` from `src/i18n/translations.ts` completely. Replaced all runtime defaults with `getActiveBaghdadDateStr()` / `getActiveClock()` (`clockService.ts`) or `todayStr` from `useCrm()`. Fixed `'2026-11-12'` now exists only as `DEMO_FIXTURE_DATE` and explicit test/seed fixtures. | Automated TS checks PASS (`Suite 1` & `Suite 5` in `auditRemediation.test.ts`) |
| **F4** | HIGH | `CrmContext.tsx` defaulted `initialClockMode = 'fixed_fixture'` and computed `todayStr` via `useMemo(..., [clockMode])`, leaving runtime frozen on `'2026-11-12'` across midnight and tab resume. | Changed `CrmContext.tsx` default `initialClockMode` to `'live_baghdad'`. Added `msUntilNextBaghdadMidnight()` in `clockService.ts` and automatic `todayStr` refresh via midnight `setTimeout`, 60s fallback poll, `window` `focus`, and `document` `visibilitychange`. Added explicit **Clock: Live Baghdad / Demo Fixture: Nov 12** indicator & toggle in `AppShell.tsx`. | Automated TS checks PASS (`Suite 1` midnight/birthday/invitation/refill tests) |
| **F5** | HIGH | `public/MASAR_CARE_V1.5.2.zip` and 29 third-party mobile screenshots (`public/assets/aistudio/Screenshot_*.jpg`) existed under `public/` and would be copied into Vite production `dist/`. | Deleted `public/MASAR_CARE_V1.5.2.zip`, root `MASAR_CARE_V1.5.2.zip`, and `public/assets/` (copied `MASAR_CARE_V152_INDEPENDENT_REAUDIT.md` into `docs/`). New V1.5.3 export archive is saved outside `public/` at `exports/MASAR_CARE_V1.5.3.zip` and excludes third-party screenshots, `node_modules`, `dist`, `.env*`, and secrets. | Verified `public/` and `dist/` asset listing |
| **F6** | HIGH (Stage 2B) | Patient activation backend (`p_bootstrap_auth_user_id` provisioning, SMS OTP gateway dispatch, Edge Functions, orphaned-user compensation, device recovery flow) is not implemented. | Documented accurately as **unimplemented Stage 2B backend work**; no false claims of production readiness remain in handoff docs. | Documentation updated |
| **F7** | MEDIUM | `IAsyncCrmRepository` / `AsyncInMemoryCrmRepository` exists, while `CrmContext` still calls `InMemoryCrmAdapter` synchronously (`isLoading` is constant `false`). | Documented honestly as a **Stage 2B design scaffold only** (`CrmContext` remains synchronous in-memory for Stage 1 prototype). | Documentation updated |
| **F8** | MEDIUM | Negative SQL suite lacked live role-switched RLS tests (`anon`, owner, pharmacist, inactive staff, cross-tenant, patient self-read vs cross-patient). | Added role-switched `SET LOCAL ROLE anon` and `SET LOCAL ROLE authenticated` + `request.jwt.claim.sub` / `request.jwt.claims` test blocks (`6A`–`6F`) in `supabase/tests/stage2a_negative_security_and_integrity.test.sql`. | Static TS check PASS; **PostgreSQL execution NOT RUN** |
| **F9** | LOW | `app_security.generate_csprng_6digit_code()` used `% 900000 + 100000` modulo mapping rather than rejection sampling. | Replaced with PL/pgSQL unbiased rejection sampling loop discarding 31-bit values `>= 2147400000` (`2386 * 900000`) in `supabase/migrations/0002_stage2a_rls_and_security.sql`. | Static TS check PASS; **PostgreSQL execution NOT RUN** |

---

## 2. Files Modified / Added / Removed in V1.5.3

### Modified Source & SQL Files
- `supabase/migrations/0001_stage2a_core_schema.sql` — Added `btree_gist`, `ex_medication_pause_periods_no_overlap`, and `ERRCODE = '23P01'`.
- `supabase/migrations/0002_stage2a_rls_and_security.sql` — Implemented unbiased PL/pgSQL rejection sampling in `app_security.generate_csprng_6digit_code()`.
- `supabase/tests/stage2a_negative_security_and_integrity.test.sql` — Rewrote schema-exact DDL fixtures, `auth.users`/`pharmacy_staff` test harness, `23P01` check, and role-switched RLS tests (`6A`–`6F`).
- `src/services/clockService.ts` — Added `msUntilNextBaghdadMidnight()`.
- `src/i18n/translations.ts` — Removed `APP_REFERENCE_DATE`; defaulted `calculateAge` to `getActiveBaghdadDateStr()`.
- `src/services/scheduleEngine.ts` — Defaulted `computeRefillProjection` to `getActiveBaghdadDateStr()`.
- `src/services/crmRepository.ts` — Replaced all runtime `APP_REFERENCE_DATE` usages with `getActiveBaghdadDateStr()` / `getActiveClock()`.
- `src/context/CrmContext.tsx` — Defaulted `initialClockMode = 'live_baghdad'`; added midnight timer, `focus`, and `visibilitychange` `todayStr` refresh.
- `src/components/layout/AppShell.tsx` — Added Live Baghdad vs Demo Fixture clock indicator & toggle.
- `src/views/DashboardView.tsx`, `src/views/RefillsView.tsx`, `src/views/DispensingView.tsx`, `src/views/FollowUpsView.tsx`, `src/views/PatientsView.tsx`, `src/views/PatientDetailView.tsx`, `src/views/AnalyticsView.tsx` — Replaced `APP_REFERENCE_DATE` and implicit age defaults with reactive `todayStr`.
- `src/components/modals/DispenseModal.tsx`, `src/components/modals/PatientFormModal.tsx` — Synced default dispensing date and age calculation with `todayStr`.
- `src/tests/stage1WorkflowAudit.ts`, `src/tests/v15Hardening.test.ts`, `src/tests/auditRemediation.test.ts` — Explicit fixture dates in legacy tests + expanded pre/post-Baghdad midnight, age, invitation, refill, and static SQL tests.

### Documentation & Cleanups
- `docs/MASAR_CARE_V152_INDEPENDENT_REAUDIT.md` — Preserved copy of V1.5.2 re-audit report.
- `docs/MASAR_CARE_V153_FIX_REPORT.md` — This report.
- `docs/MASAR_CARE_HANDOFF.md` — Updated for V1.5.3.
- Deleted `public/MASAR_CARE_V1.5.2.zip`, root `MASAR_CARE_V1.5.2.zip`, and `public/assets/` (29 third-party reference screenshots excluded from web deployment).
- Exported clean archive outside `public/` at `exports/MASAR_CARE_V1.5.3.zip`.

---

## 3. Verification Results (Actual Commands & Scope)

| Check | Command | Result | Notes |
| :--- | :--- | :--- | :--- |
| TypeScript check | `npm run typecheck` (`tsc --noEmit`) | **PASS** (0 errors) | Executed locally in workspace |
| Production build | `npm run build` (`vite build`) | **PASS** | Verified `dist/` contains no ZIPs or third-party screenshots |
| Automated unit/workflow tests | `npm test` (`stage1WorkflowAudit.ts`, `v15Hardening.test.ts`, `v151FinalGaps.test.ts`, `auditRemediation.test.ts`) | **PASS** (28/28 suites) | In-memory adapter + mocked/injected Baghdad clocks + static file assertions |
| PostgreSQL migrations & RLS SQL suite | `0001`, `0002`, `stage2a_negative_security_and_integrity.test.sql` | **NOT RUN** | By project constraint: no Supabase connection or SQL execution approved |
| Edge Functions / Auth Bootstrap / SMS OTP | Stage 2B integration | **NOT IMPLEMENTED** | Unverified until Stage 2B |

---

## 4. Explicit Backend Readiness & Stage 2B Blockers

1. **PostgreSQL SQL & RLS Execution (NOT RUN):** Migrations `0001`, `0002`, and `stage2a_negative_security_and_integrity.test.sql` have only been statically inspected. They must be executed against an isolated PostgreSQL/Supabase **development** instance (with fictional test data only) before Stage 2B UI/backend cutover.
2. **Patient APK Activation Backend (`F6` — NOT IMPLEMENTED):** No Supabase Edge Function exists yet to provision `p_bootstrap_auth_user_id` via Supabase Admin Auth API, dispatch real Iraqi SMS OTPs, reconcile orphaned `auth.users` on partial failure, or enforce production device replacement recovery end-to-end.
3. **Async Repository Wiring (`F7` — SCAFFOLD ONLY):** `IAsyncCrmRepository` and `AsyncInMemoryCrmRepository` define the target async contract, while `CrmContext.tsx` still mutates `InMemoryCrmAdapter` synchronously (`isLoading` stays `false`) without remote Supabase persistence.
