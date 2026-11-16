# MASAR Care — Pre-Stage 2B QA Patch & Readiness Report

**Version:** V1.5.4-QA (Focused QA Patch Before Stage 2B)  
**Baseline:** V1.5.4 (Approved **Option B** — Single Shared Supabase Project with Strict `pharmacy_id` RLS Isolation)  
**Input Review:** `docs/MASAR_CARE_V154_INDEPENDENT_REVIEW.md`  
**Execution Constraints:** Review-only QA patch inside the existing MASAR Care codebase. **No Supabase connection, no SQL execution (including local PostgreSQL migrations), no deployment, no real patient data, and no real auth/SMS implementation.**

---

## 1. Minimal Diff Summary

| Area | Files Modified / Added | Purpose |
| :--- | :--- | :--- |
| **1. Unscheduled-Dose Provenance Trigger & Test Reconciliation** | `supabase/migrations/0001_stage2a_core_schema.sql`<br>`supabase/tests/stage2a_negative_security_and_integrity.test.sql` | Reconciled contradictory `BEFORE INSERT` normalization vs negative SQL test under **Option A**; eliminated `client_event_uuid` reuse across intended-success test inserts. |
| **2. Concurrent `confirm_scheduled_dose` Retries** | `supabase/migrations/0002_stage2a_rls_and_security.sql`<br>`supabase/tests/stage2a_concurrency_and_retry.test.sql` (new) | Preserved all `UNIQUE` constraints; added deadlock-free `pg_advisory_xact_lock` serialization + `EXCEPTION WHEN unique_violation` handler for deterministic idempotency/conflict JSONB; added review-only concurrency harness. |
| **3. Dependency Alignment** | `package.json`<br>`package-lock.json` | Removed unused direct `esbuild@^0.25.0` `devDependency` that conflicted with Vite `8.3.8` (`^0.27.0 \|\| ^0.28.0`) and duplicated `tsx`'s `esbuild@0.28.2`; regenerated lockfile and verified clean `npm ci` + `npm ls esbuild`. |
| **4. Production Boundary & Clock Hardening** | `src/services/clockService.ts`<br>`src/components/layout/AppShell.tsx`<br>`src/context/CrmContext.tsx`<br>`.env.example`, `README.md` | Hardened `isDemoClockModeEnabled()` so `DEV !== true` or `PROD === true` unconditionally disables `fixed_fixture` clock mode (even if `VITE_ENABLE_DEMO_CLOCK=true` is set in deployment config); marked Stage 1 demo staff switcher and `Reset Demo Data` controls for mandatory Stage 2B removal. |
| **5. Static Verification & Docs Cleanup** | `src/tests/auditRemediation.test.ts`<br>`docs/MASAR_CARE_V154_INDEPENDENT_REVIEW.md`<br>`docs/MASAR_CARE_PRE_STAGE2B_QA.md`<br>`docs/MASAR_CARE_HANDOFF.md` | Added assertions for stricter clock gate, `23514` trigger check, distinct unscheduled UUID fixtures, concurrency lock/exception patterns, and `package.json`; moved review attachment out of `public/assets/`. |

---

## 2. Technical Details & Design Choices

### 2.1 Unscheduled-Dose Trigger vs Test Contradiction (Item 1 — Option A)
- **Previous contradiction:** `0001_stage2a_core_schema.sql` unconditionally set `NEW.is_verified_schedule := false` in `BEFORE INSERT` trigger `enforce_unscheduled_dose_report_provenance()`, masking caller-supplied `true` before RLS `WITH CHECK` (`0002:463`) or table `CHECK (is_verified_schedule = false)`. Meanwhile `stage2a_negative_security_and_integrity.test.sql` inserted `is_verified_schedule = true` expecting an exception, then reused `v_ev_uuid_unsched` on the subsequent `INSERT`.
- **Chosen Resolution (Option A):**
  - `enforce_unscheduled_dose_report_provenance()` now explicitly rejects `NEW.is_verified_schedule IS DISTINCT FROM false` with predictable `SQLSTATE '23514'` (`check_violation`) while still allowing omitted columns (via schema `DEFAULT false`) and explicit `false`.
  - Section 7 of `stage2a_negative_security_and_integrity.test.sql` now uses three distinct UUIDs:
    1. `v_ev_uuid_unsched_bad`: asserts `is_verified_schedule = true` throws `check_violation` (`23514`).
    2. `v_ev_uuid_unsched_ok1`: omits `is_verified_schedule` and verifies stored `false`.
    3. `v_ev_uuid_unsched_ok2`: supplies explicit `is_verified_schedule = false` and verifies stored `false`.

### 2.2 Concurrent `confirm_scheduled_dose` Retries (Item 2)
- **Race analyzed:** Under PostgreSQL Read Committed concurrency, pre-insert `SELECT` checks on `client_event_uuid` and `scheduled_dose_id` could both return 0 rows for two parallel requests, causing the losing caller to hit an unhandled `unique_violation` (`23505`).
- **Resolution (Preserving All `UNIQUE` Constraints):**
  1. Kept `UNIQUE (scheduled_dose_id)`, `UNIQUE (client_event_uuid)`, and `UNIQUE (medication_plan_id, scheduled_date, scheduled_time24)` intact on `public.dose_events`.
  2. Added ordered transaction-scoped advisory locks inside `confirm_scheduled_dose` after auth/input checks:
     - `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('masar_confirm_sd:' || p_scheduled_dose_id::text, 0))`
     - `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('masar_confirm_ev:' || p_client_event_uuid::text, 0))`
     Consistent namespace ordering prevents deadlocks while serializing parallel retries targeting the same dose or UUID.
  3. Wrapped both the `pending_unconfirmed` `UPDATE` and the `INSERT INTO public.dose_events` in subtransaction `BEGIN ... EXCEPTION WHEN unique_violation THEN ... END;` blocks so even if a concurrent pharmacist write or Serializable conflict races, the function settles deterministically:
     - Same `patient_id` + same `scheduled_dose_id` + same `client_event_uuid` -> `{"ok": true, "idempotentReplay": true, ...}`
     - Same `client_event_uuid` across different `scheduled_dose_id` or `patient_id` -> `{"ok": false, "errorCode": "CLIENT_EVENT_UUID_CONFLICT"}`
     - Different `client_event_uuid` targeting already-confirmed `scheduled_dose_id` -> `{"ok": false, "errorCode": "DUPLICATE_DOSE_CONFIRMATION_BLOCKED", ...}`
- **Concurrency Test Harness (Review-Only):** Created `supabase/tests/stage2a_concurrency_and_retry.test.sql` documenting two-session `psql` execution steps for **Case A** (same `client_event_uuid` race), **Case B** (different `client_event_uuid` race on same `scheduled_dose_id`), and **Case C** (same UUID across different doses).

### 2.3 Dependency Version Alignment (Item 3)
- Removed unused direct `"esbuild": "^0.25.0"` from `package.json` `devDependencies` (no source/config file imports `esbuild` directly; Vite 8 uses Rolldown and `tsx@4.23.15` brings `esbuild@0.28.2`, satisfying Vite `8.3.8`'s optional peer `"esbuild": "^0.27.0 || ^0.28.0"`).
- Regenerated `package-lock.json` via `npm install`, then verified clean `npm ci` and `npm ls esbuild` (zero peer/invalid dependency errors).

### 2.4 Production Boundary & Clock Mode Enforcement (Item 4)
- **Fixed Clock Mode Enforcement (Implemented Now):** `isDemoClockModeEnabled()` in `src/services/clockService.ts` now checks `if (env.PROD === true || env.DEV !== true) return false;`. Clinical production builds (`vite build`) **cannot** enable `fixed_fixture` clock mode through deployment environment variables (even if `VITE_ENABLE_DEMO_CLOCK=true` is mistakenly configured). Unit tests continue injecting `FixedBaghdadClock` directly via DI.
- **Stage 2B Production Boundary Checklist (Before Live CRM Integration):**
  1. **Remove Demo Staff Switcher (`setActiveStaffId`):** Remove the active pharmacist `<select>` in `src/components/layout/AppShell.tsx` (both desktop sidebar and mobile slide-over drawer) and `setActiveStaffId` in `src/context/CrmContext.tsx`. Bind operator identity strictly to authenticated Supabase session (`auth.uid()` -> `public.pharmacy_staff`).
  2. **Remove `Reset Demo Data` (`resetDemoData` / `InMemoryCrmAdapter.reset()`):** Remove the sidebar/drawer reset controls and prototype fixture seeding before connecting live pharmacy records.
  3. **Replace `InMemoryCrmAdapter` with Async `SupabaseCrmRepository`:** Wire authenticated Supabase calls through `IAsyncCrmRepository`, surfacing real loading and error states (`isLoading`, `asyncError`).
  4. **Implement Server-Side Auth/OTP Orchestration:** Add Edge Functions + SMS gateway dispatch + `auth.admin` provisioning/revocation (`redeem_patient_apk_invitation` and prior-session revocation on device replacement).

---

## 3. Verification Status: Reproduced Locally vs Not Executed

Static TypeScript and Node.js tests prove application domain calculations, clock gating, and static SQL text invariants only — they do **not** prove live PostgreSQL execution, RLS isolation, or multi-session concurrency.

### Independently Reproduced Locally in This Workspace
- `npm install` + `npm ci`: **PASS** (`added 178 packages`, `0 vulnerabilities`)
- `npm ls esbuild`: **PASS** (`tsx@4.23.15 -> esbuild@0.28.2`, `vite@8.3.8 -> esbuild@0.28.2 deduped`, 0 errors)
- `npm run typecheck` (`tsc --noEmit`): **PASS** (0 errors)
- `npm test` (`stage1WorkflowAudit` + `v15Hardening` + `v151FinalGaps` + `auditRemediation`): **28/28 PASS** (uses in-memory repository, injected clocks, and static SQL inspection)
- `npm run build` (`vite build`): **PASS** (`dist/` clean; contains only `index.html` and `assets/*`, zero `.zip` or attachment artifacts)

### Explicitly NOT Executed
- **PostgreSQL Migration Execution (`0001`, `0002`):** **NOT RUN**
- **SQL Negative Security & RLS Test (`stage2a_negative_security_and_integrity.test.sql`):** **NOT RUN**
- **Multi-Session Concurrency Race Test (`stage2a_concurrency_and_retry.test.sql`):** **NOT RUN**
- **Real Supabase Auth, Edge Functions, SMS OTP Dispatch, Session Revocation:** **NOT IMPLEMENTED / NOT RUN**
- **Headless Browser / Mobile / Arabic RTL Viewport E2E Suite:** **NOT RUN**

---

## 4. Remaining Risks
1. **Unverified Live PostgreSQL Behavior:** Extension placement (`extensions` schema for `pgcrypto`, `pg_trgm`, `btree_gist`), helper function privileges (`app_security.*`), `SET LOCAL ROLE` test blocks, and `pg_advisory_xact_lock` + `unique_violation` behavior remain unverified until executed on a real PostgreSQL 15+ instance.
2. **Stage 1 Prototype Remains Unauthenticated Until Stage 2B:** By design for Stage 1, `CrmContext` uses `InMemoryCrmAdapter` with demo staff switching and `Reset Demo Data` enabled until Stage 2B connects Supabase Auth.
3. **Device / RTL Browser QA Pending:** Mobile (`375px`), tablet (`768px`), and Arabic RTL visual/keyboard checks have not yet been automated against a live browser.

---

## 5. Disposable Development PostgreSQL Execution Plan (Pending Owner Approval)

Do **not** execute against production or real patient data. After explicit owner approval to provision a disposable development Supabase / PostgreSQL 15+ instance:

1. **Extension Pre-Flight Check:** Verify `pg_extension` schema placement for `pgcrypto`, `pg_trgm`, and `btree_gist` (`extensions`).
2. **Apply Stage 2A Schema & RLS Migrations:**
   - Run `supabase/migrations/0001_stage2a_core_schema.sql`
   - Run `supabase/migrations/0002_stage2a_rls_and_security.sql`
3. **Run Negative Security, RLS & Unscheduled Provenance Suite:**
   - Execute `psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/stage2a_negative_security_and_integrity.test.sql`
   - Confirm Section 7 (`H1`) rejects `is_verified_schedule = true` with `23514`, defaults omitted rows to `false`, and accepts explicit `false` with distinct UUIDs.
4. **Run Multi-Session Concurrency & Retry Harness:**
   - Follow the two-process `psql` harness documented in `supabase/tests/stage2a_concurrency_and_retry.test.sql`:
     - **Case A:** Two parallel callers with the **same `client_event_uuid`** -> 1 row inserted, winner `idempotentReplay=false`, loser `idempotentReplay=true`, 0 unhandled `23505` errors.
     - **Case B:** Two parallel callers with **different `client_event_uuid`s** for the **same `scheduled_dose_id`** -> 1 row inserted, loser `errorCode='DUPLICATE_DOSE_CONFIRMATION_BLOCKED'`, 0 unhandled `23505` errors.
     - **Case C:** Same `client_event_uuid` across different `scheduled_dose_id`s -> loser `errorCode='CLIENT_EVENT_UUID_CONFLICT'`.
5. **Gate Stage 2B Implementation:** Proceed to Stage 2B Edge Functions, SMS OTP, `SupabaseCrmRepository`, and removal of Stage 1 demo controls only after Steps 1–4 pass on the disposable dev database.
