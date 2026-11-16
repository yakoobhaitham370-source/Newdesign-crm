# MASAR Care — Independent Stage 2B.2A Static Source Review

**Reviewed:** 2026-11-14; uploaded `masar-care (1).zip` (101 ZIP entries; integrity check passed).  
**Scope:** Static review of SQL migration 0003, Edge Functions, repository mappings, Stage 2A schema, tests, and Stage 2B.2A report.  
**Environment:** Offline source inspection only. **No Supabase access, SQL execution, Edge deployment, account creation, or patient records.**

## Executive decision

**HOLD approval for executing migration 0003 and deploying privileged Edge Functions.** The draft constitutes meaningful progress and should be preserved, but the points below must be resolved or explicitly accepted before Stage 2B.2B. The previously executed Stage 2A 0001/0002 tests do not test this new migration.

## Confirmed source facts and implementation strengths

- `supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql` has ~1,532 lines and defines the bootstrap sentinel, staff-context helper, provisioning RPCs, eight authenticated clinical/revocation RPCs, and audit triggers. SQL source is marked review only.
- `supabase/functions/bootstrap-first-owner/index.ts`, `owner-provision-staff/index.ts`, and `_shared/adminProvisioningLogic.ts` exist and contain Auth Admin + database provisioning orchestration.
- The TypeScript repository calls all seven multi-table RPCs and blocks connected-mode invitation issuance pending Stage 2C (`src/services/supabaseCrmRepository.ts:871–1176, 1277–1348`).
- Active staff lookup in `app_security.require_active_pharmacist_context()` derives identity from `auth.uid()` and joins active staff/pharmacy rows (`0003:32–68`). Clinical RPCs derive `pharmacy_id` from that context; important defense in depth.
- The `bootstrap_state` table is RLS-protected and client grants are revoked; account provisioning functions explicitly revoke public client EXECUTE grants. This is static inspection, **not live RLS testing**.

## Findings requiring resolution or explicit design acceptance

### H1 — Trusted refill calculations are not independently verified in PostgreSQL (HIGH, clinical integrity)

`src/services/supabaseCrmRepository.ts:1095–1173` computes forecast/refill values in browser code and passes `p_estimated_daily_consumption`, `p_estimated_remaining_units`, `p_refill_status`, dates and other values to the RPC. `0003:965–1135` validates plan/patient ownership and dispensed quantity, but **does not recompute or substantively validate the supplied forecast**. It even defaults the assumptions note to `'Server-verified refill assessment'` (`0003:1066,1092`) although the estimate comes from the client. A stale/malicious client can submit misleading refill assessments under an otherwise authorized session.

**Fix:** Keep browser calculations as provisional UI estimates and validate clinically material data server-side (or use a versioned, independently tested server-side projection service). Persist provenance, algorithm version, input snapshot, and an explicit `calculation_source`/verification status. At minimum enforce numeric bounds, units, and consistency with authoritative dispensing rows; never imply server verification without it. Add negative tests for tampered forecasts and concurrent fills.

### H2 — Historical patient allergy/condition rows are deleted on ordinary profile updates (HIGH, clinical-history design)

`0003:520–564` removes `patient_conditions` and `patient_allergies` rows absent from the submitted lists. The `PATIENT_UPDATED` audit at `0003:566–580` does not retain the deleted clinical details or before/after values. This can erase allergy history, despite the project's emphasis on preserving clinical records.

**Fix:** Require an explicit clinical-history policy; prefer soft-removal/status + effective date and detailed audit versions, or an append-only change record. Do not silently delete clinically relevant history. Exercise rollback tests for partial allergy updates.

### H3 — First-owner bootstrap's initial advisory lock does not cover Auth creation (HIGH, concurrency/reconciliation)

`0003:80–103` acquires a **transaction-scoped** advisory lock in one RPC, which is released when that RPC returns. The Edge handler then separately invokes `auth.admin.createUser` and finally another locked RPC (`_shared/adminProvisioningLogic.ts:258–320`; `0003:105–212`). The finalizer's lock and emptiness check protect the database from two finalized first owners, but **do not serialize the whole cross-service ceremony**. Both competing requests may create Auth users, and one must be safely reconciled. Unknown-outcome network errors can require investigation before an Auth deletion.

**Fix:** Document exact limits; introduce an explicit durable reserved/claimed state with idempotency key and recovery procedure, or perform trusted one-time administrative bootstrap. Verify actual post-error database state before deleting an Auth user when the RPC outcome is ambiguous. Test simultaneous requests and timeout/retry paths against a disposable development environment.

### H4 — Do not accept `SUPABASE_SERVICE_ROLE_KEY` as an HTTP admin credential (HIGH, secret-handling architecture)

`_shared/adminProvisioningLogic.ts:163–175` accepts either `MASAR_PLATFORM_ADMIN_TOKEN` or the Supabase service-role key as the bootstrap `Authorization: Bearer` value. `docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md` recommends this optional fallback. The service-role key is exceptionally privileged and should never need to travel as a caller-supplied request token to a publicly reachable endpoint (`bootstrap-first-owner`, proposed with JWT gateway verification disabled).

**Fix:** Remove that fallback; prefer a one-time restricted administrator/CLI workflow or separately scoped administrative mechanism, rate-limit and restrict network access where practical, and disable/delete the bootstrap endpoint once complete. Keep service-role/secret keys only in trusted server configuration.

### H5 — Staff-provisioning may grant additional `pharmacy_owner` accounts (MEDIUM/HIGH policy decision)

`0003:255–259` and `_shared/adminProvisioningLogic.ts:505–512` permit both `authorized_pharmacist` and `pharmacy_owner`. Earlier approved policy described the pharmacy owner adding pharmacist staff. If owner creation/delegation is intended, define authorization and audit approval separately; otherwise restrict the normal staff provisioning function to `authorized_pharmacist`.

### H6 — RPC success and failure handling should fail closed (MEDIUM)

`_shared/adminProvisioningLogic.ts:613–667` treats `provision_pharmacy_staff_by_owner` as success whenever `provRes.error` is absent, without validating an explicit `{ok:true, staffId, pharmacyId}` payload. The SQL function currently returns `ok:true` or raises, so this is a robustness gap rather than a demonstrated current bypass. `handleBootstrapFirstOwner` likewise treats any payload other than `ok:false` as success (`:319–365`). **Fix:** Require a valid, schema-checked success payload, expected user ID and pharmacy ID; treat malformed/empty responses as reconciliation-required rather than reporting 201.

### H7 — Dose schedule persistence is still a separate missing backend workflow (HIGH, Stage 2C prerequisite)

`0003:592–703` creates a plan and regimen version but does not materialize `public.scheduled_doses`. `src/services/supabaseCrmRepository.ts` loads `dose_events`, but has no `scheduled_doses` fetch/write path. Prior Stage 2A `confirm_scheduled_dose` requires an existing authorized scheduled occurrence. Stage 2B can proceed with pharmacist CRUD, but the future native Android reminder/confirmation app cannot rely on this alone.

**Fix:** Design server-authorized occurrence generation/materialization, regimen-version re-generation without modifying completed historical occurrences, unique keys, cross-device sync, offline retries and PRN separation. Track explicitly as a pre-APK gate; do not pretend Stage 2B.2A implements it.

### M1 — Harden privileged function deployment and tests (MEDIUM)

- `0003` SECURITY DEFINER functions use `SET search_path = pg_catalog, public, app_security, pg_temp`. All currently inspected sensitive table references are qualified; nevertheless prefer a minimal safe search path and continue schema-qualifying every object.
- New functions in an exposed schema can have default public EXECUTE before the later REVOKEs. Execute migration as one reviewed atomic transaction and verify actual grants afterward; do not run partial statements piecemeal.
- `0003` adds a **23rd** public table (`bootstrap_state`), so monitoring and security checks must change from 22 to 23 after migration, while confirming tenant-data policy on the new table.
- Create **real PostgreSQL 0003 test fixtures** in a transaction/isolated environment, including authenticated pharmacy A/B, both allowed and denied RPC calls, trigger audit records, immutable ledger invariants, rollback, bootstrap concurrent entry, and privilege checks. Static regex/mocked tests alone are not enough.

### M2 — User-approved mobile strategy should be saved in handoff (LOW)

The handoff still refers to an APK-focused Stage 2C, but the agreed staged platform strategy is **native Android patient APK (Kotlin + Jetpack Compose) first**, then **iPhone patient PWA**, then evaluate a native iOS app. APKs do **not** run on iPhone. Preserve separate pharmacist React CRM and shared backend.

## Test limitations

- ZIP file integrity: **PASS**.
- Offline `npm ci --offline --ignore-scripts`: **FAILED ENOTCACHED** because `@supabase/supabase-js` is not in this container's npm cache. Therefore `npm test`, TypeScript, build and Deno Edge deployment tests **were not independently reproduced** in this review.
- Google AI Studio reports seven offline test suites, tsc and Vite build passing; results are **reported, not independently re-executed here**.
- **No SQL 0003 or Edge code executed against the user's Supabase project**, and no Auth users or patient records created during this review.

## Recommended gates

1. Stage 2B.2A.1 (code-only): resolve H1–H6, make H7 an explicit pre-Android prerequisite, add integration test fixtures and update handoff. Re-run tests and provide a code diff.
2. Stage 2B.2B (separately approved): dry-run/review migration 0003 then execute on disposable dev; verify 23/23 tables with RLS, function ACLs and negative tests, without turning connected mode on yet.
3. Stage 2B.2C (separately approved): restricted admin bootstrap, create only fictional dev accounts and verify actual JWT/owner/staff/cross-tenant operations.
4. Stage 2B.3: authorize connected-dev CRM and test full persistence with fictional patients. Only then design patient activation and native Android application flows.
