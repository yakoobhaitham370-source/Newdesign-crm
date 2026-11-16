# MASAR Care — Stage 2B.2A.1 Pre-Deployment Hardening Review

**Version:** V1.5.5-Stage2B.2A.1  
**Baseline Reviewed:** `V1.5.5-Stage2B.2A` (Independent Review Findings H1–H7, M1–M2)  
**Target Disposable Dev Project:** `bkidngfzsubmyunacnju` (PostgreSQL 17.11 — **untouched**, `0003` unexecuted)  
**Runtime Default:** Demo Mode (`VITE_ENABLE_SUPABASE_CRM="false"`)  

---

## 1. Executive Summary

Before executing Migration `0003` or deploying Edge Functions to `bkidngfzsubmyunacnju`, Stage 2B.2A.1 resolves all confirmed pre-deployment security, clinical-safety, and operational integrity gaps identified in the independent Stage 2B.2A review—without changing the approved Option B multi-tenant architecture, UI design, or Demo Mode default.

---

## 2. Finding-by-Finding Remediation Matrix (H1–H7, M1–M2)

| ID | Finding Summary | Confirmed Defect / Architectural Remediation | Primary Artifacts Changed |
| :--- | :--- | :--- | :--- |
| **H1** | Client-computed refill projections mislabeled as server-verified and accepted without server checks | Added `calculation_source`, `verification_status`, `algorithm_version`, and `calculation_inputs` to `dispensing_events` and `refill_assessments`; removed `'Server-verified refill assessment'`; locked `patient_medication_plans FOR UPDATE`; added `app_security.normalize_clinical_unit_category` & `app_security.compute_plan_daily_rate` to enforce unit compatibility, rate consistency, non-negative bounds, and authoritative cumulative dispensed sums (rejecting tampering with SQLSTATE `23514`) while labeling client forecasts `provisional_client_unverified` / `provisional_unverified`. | `0003_stage2b_atomic_crm_and_bootstrap.sql`, `src/types/domain.ts`, `src/services/supabaseCrmRepository.ts` |
| **H2** | Partial patient updates permanently deleted omitted `patient_conditions` & `patient_allergies` rows | Added `status` (`active` / `inactive`), `removed_at`, `removed_by_staff_id`, and `removal_reason` columns with composite pharmacy-staff foreign keys; revoked `DELETE` on both tables from `authenticated`; rewrote `update_patient_with_clinical_tags` to soft-deactivate omitted rows and log `previousConditions`, `currentConditions`, `previousAllergies`, `currentAllergies` in `audit_logs.metadata`. Active CRM hydration filters out non-`active` rows cleanly. | `0003_stage2b_atomic_crm_and_bootstrap.sql`, `src/services/supabaseCrmRepository.ts` |
| **H3** | Non-atomic Auth + DB bootstrap risked deleting a committed Auth user on ambiguous/timeout `finalize` failure | Expanded `public.bootstrap_state` into a durable claim/reconciliation state machine (`pending`, `claimed`, `completed`, `failed_needs_reconciliation`) with `idempotency_key`, `claimed_by_request_id`, `claim_expires_at`, `orphan_auth_user_id`, and `last_error`. Added `claim_first_owner_bootstrap`, `inspect_first_owner_bootstrap_state`, and `mark_first_owner_bootstrap_reconciliation`. Edge handler requires `Idempotency-Key` (`16..128` chars) and inspects durable DB state before ever deleting an Auth user—preserving live Auth users if DB committed or if inspection is inconclusive (`500 RECONCILIATION_REQUIRED`). | `0003_stage2b_atomic_crm_and_bootstrap.sql`, `supabase/functions/_shared/adminProvisioningLogic.ts` |
| **H4** | `bootstrap-first-owner` accepted `SUPABASE_SERVICE_ROLE_KEY` as an HTTP bearer fallback | Removed `serviceRoleKey` fallback completely from `ProvisioningEnv` and `bootstrap-first-owner/index.ts`. Endpoint fails closed (`503 BOOTSTRAP_DISABLED`) unless both `MASAR_BOOTSTRAP_TOKEN` (>= 32 chars) and dedicated `MASAR_PLATFORM_ADMIN_TOKEN` (>= 32 chars) are set, and enforces post-bootstrap retirement. | `supabase/functions/_shared/adminProvisioningLogic.ts`, `supabase/functions/bootstrap-first-owner/index.ts` |
| **H5** | `owner-provision-staff` allowed creating additional `pharmacy_owner` accounts | Restricted both `handleOwnerProvisionStaff` (`403 OWNER_DELEGATION_NOT_ENABLED`) and `provision_pharmacy_staff_by_owner` (`23514` check violation) strictly to `role = 'authorized_pharmacist'` until explicit owner-delegation governance is designed. | `supabase/functions/_shared/adminProvisioningLogic.ts`, `0003_stage2b_atomic_crm_and_bootstrap.sql` |
| **H6** | Edge handlers trusted malformed or incomplete RPC success payloads | Added strict schema and ID matching on `finalize_first_owner_bootstrap` and `provision_pharmacy_staff_by_owner` responses; malformed/mismatched payloads fail closed (`500 RECONCILIATION_REQUIRED`) and safely reconcile/roll back. | `supabase/functions/_shared/adminProvisioningLogic.ts` |
| **H7** | `public.scheduled_doses` lacked a server-side occurrence materialization contract prior to Android APK | Documented the mandatory pre-Android `public.scheduled_doses` materialization design gate below and registered `scheduledDoseMaterializationPreAndroid` in `STAGE2B_SQL_DEPENDENCIES`. (Implementation remains scoped prior to Stage 2C/Android launch.) | `src/services/supabaseCrmRepository.ts`, `docs/STAGE2B2A1_PRE_DEPLOYMENT_REVIEW.md`, `docs/MASAR_CARE_HANDOFF.md` |
| **M1 & M2** | Unwrapped `0003` transaction, broad `search_path`, stale 22-table post-`0003` references, and missing `0003` SQL test draft | Wrapped `0003` in `BEGIN; ... COMMIT;`; pinned `SET search_path = pg_catalog, pg_temp` across all 15 `SECURITY DEFINER` functions with 100% schema qualification; updated post-`0003` protected table baseline to **23** (`bootstrap_state` added); created unexecuted `supabase/tests/stage2b_0003_negative_and_integrity.test.sql`; documented agreed mobile rollout order (Android Kotlin APK -> iPhone PWA -> optional native iOS). | `0003_stage2b_atomic_crm_and_bootstrap.sql`, `supabase/tests/stage2b_0003_negative_and_integrity.test.sql`, `docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md`, `docs/MASAR_CARE_HANDOFF.md` |

---

## 3. H7 Pre-Android `public.scheduled_doses` Materialization Architecture Gate

Stage 2B.2A.1 intentionally **does not** implement Stage 2C patient Android workflows yet, but establishes the required database contract that **must** be built and verified before the native Android Kotlin + Jetpack Compose APK enters beta/production:

1. **Server-Authorized Occurrence Generation:**
   - Triggered inside `create_medication_plan_with_version`, `update_medication_plan_version`, and `change_medication_plan_status` (using the pharmacy's `Asia/Baghdad` timezone and a rolling horizon, e.g., 14–30 days ahead, plus background replenishment).
   - Evaluates daily, multi-dose, selected-weekday, interval, cyclic, variable-dose, and paused/discontinued rules from the single shared MASAR scheduling specification.
2. **Deterministic Uniqueness Key:**
   - Each generated row in `public.scheduled_doses` is uniquely keyed by `(medication_plan_id, regimen_version_number, scheduled_date, scheduled_time24)` so re-materialization is idempotent and never duplicates reminders.
3. **Immutable Historical Dose Preservation:**
   - When a regimen version closes or a medication plan is paused/discontinued, previously confirmed `dose_events` (`taken`, `skipped_by_patient`, `delayed`) and past occurrences remain immutable for clinical audit and adherence calculation. Only **future unconfirmed** occurrences after the effective boundary are superseded or cancelled.
4. **Offline Retry & PRN Separation:**
   - Android patient confirmations attach an app-generated `client_event_uuid` and reference a materialized `scheduled_doses.id` (enforcing concurrency & idempotency via the existing Stage 2A `dose_events` unique index and replay logic).
   - Unscheduled / as-needed (PRN) doses recorded by the patient write exclusively to `public.unscheduled_dose_reports` with `is_verified_schedule = false` so they never corrupt scheduled adherence denominators.

---

## 4. Bootstrap Endpoint Retirement Procedure (`bootstrap-first-owner`)

Because `bootstrap-first-owner` creates the initial pharmacy and owner account, it must not remain callable or deployed after initial provisioning:

1. Verify `public.bootstrap_state.status = 'completed'`, `public.pharmacies` count >= `1`, and replay call returns `409 BOOTSTRAP_ALREADY_COMPLETED`.
2. Delete the deployed function from Supabase Edge Runtime:
   ```bash
   supabase functions delete bootstrap-first-owner --project-ref bkidngfzsubmyunacnju
   ```
3. Unset both bootstrap secrets immediately:
   - `MASAR_BOOTSTRAP_TOKEN`
   - `MASAR_PLATFORM_ADMIN_TOKEN`
4. Confirm `public.bootstrap_state` retains `0` privileges for `PUBLIC`, `anon`, and `authenticated`.

---

## 5. Post-0003 23-Table Verification Checklist & Draft SQL Test Matrix

After Migration `0003` is authorized and executed in Stage 2B.2B, verification against `bkidngfzsubmyunacnju` must confirm:

- **23 / 23 `public` tables** exist with `relrowsecurity = true` AND `relforcerowsecurity = true` (`22` Stage 2A tables + `public.bootstrap_state`).
- **`anon` holds `0` table privileges** across all 23 tables.
- **`public.bootstrap_state`** exposes `0` privileges to `PUBLIC`, `anon`, and `authenticated`.
- **`authenticated` lacks `DELETE`** on `public.patient_conditions` and `public.patient_allergies`.
- **5 `service_role`-only RPCs** (`claim_first_owner_bootstrap`, `inspect_first_owner_bootstrap_state`, `mark_first_owner_bootstrap_reconciliation`, `finalize_first_owner_bootstrap`, `provision_pharmacy_staff_by_owner`) are non-executable by `anon`/`authenticated`.
- **15 `SECURITY DEFINER` functions** introduced/updated in `0003` pin `SET search_path = pg_catalog, pg_temp`.
- Execute the non-persisting draft suite `supabase/tests/stage2b_0003_negative_and_integrity.test.sql` (`BEGIN; ... ROLLBACK;`) to verify H1, H2, H3, H5, inactive staff `42501`, and cross-pharmacy `42501` directly inside PostgreSQL 17.11.
