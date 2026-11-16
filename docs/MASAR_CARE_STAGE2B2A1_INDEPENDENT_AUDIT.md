# MASAR Care — Stage 2B.2A.1 Independent Pre-Deployment Source Audit

**Date:** 2026-11-14  
**Source:** user-provided `masar-care (9).zip` (105 ZIP entries; archive integrity check passed).  
**Scope:** static inspection only of migration 0003, migrations 0001/0002 baseline, Stage 2B SQL test, Edge Functions, CRM dependency plan. **No database changes, SQL execution, account provisioning, or deployment.**

## Decision

**HOLD Stage 2B.2B migration 0003 and Edge Function deployment.** The draft contains significant clinical integrity bypasses and test/runtime blockers. Keep existing Stage 2A development schema in place; do not reinstall 0001/0002 or reset the database.

## Findings, with file/line evidence

### HIGH — H1: New transactional clinical invariants can still be bypassed via prior direct grants

`supabase/migrations/0002_stage2a_rls_and_security.sql:231–249` grants authenticated clients broad direct write permissions to `patient_conditions`, `patient_allergies`, `patient_medication_plans`, `regimen_versions`, `medication_pause_periods`, `dispensing_events` and `refill_assessments`. RLS policy checks at `0002:328–343, 366–409, 486–512` confirm the *pharmacy*, but not all new clinical provenance/atomicity invariants. Migration 0003 revokes only `DELETE` for conditions and allergies (`0003:93–95`) and adds client-writeable `calculation_source` and `verification_status` fields (`0003:97–111`). A malicious or buggy authorized pharmacy client can continue to directly:

- UPDATE allergy/condition status, reason and removal metadata without calling `update_patient_with_clinical_tags` and without its before/after audit.
- INSERT or UPDATE medication plans/version and refill assessment records outside the new transactional RPCs.
- INSERT dispensing history with caller-supplied estimates, or UPDATE `refill_assessments.verification_status='server_verified'` despite the RPC enforcing `provisional_unverified` (`0003:1712–1819`).

This is **not demonstrated cross-pharmacy access**; it is a confirmed *within-pharmacy clinical integrity and provenance bypass* permitted by the existing ACL/RLS design. Review each legacy grant and revoke or narrow direct mutation permissions where the new RPC becomes the authoritative write route. Preserve legitimate permitted simple-table writes and patient dose-confirmation RPCs. Add live negative tests proving direct bypass attempts fail but authorized RPC writes succeed.

### HIGH — H2: Draft SQL test references a nonexistent PostgreSQL configuration function

`supabase/tests/stage2b_0003_negative_and_integrity.test.sql:421` invokes `PERFORM reset_config('role');`. PostgreSQL 17 documents `set_config(...)` and `current_setting(...)`, not `reset_config(text)`. Replace with a verified supported role-reset mechanism and exercise the test on disposable PostgreSQL **only after** a separate approval. The SQL file remains **unexecuted**.

### HIGH — H3: Execution runbook orders the bootstrap test after first-owner creation

`docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md`, Steps 3–5, plans to bootstrap the initial pharmacy and owner *before* running `stage2b_0003_negative_and_integrity.test.sql`. However, test lines `186–217` assert that `claim_first_owner_bootstrap` succeeds on an empty system and finalize creates the *first* pharmacy. The SQL gate (`0003:324–330`) explicitly returns `BOOTSTRAP_ALREADY_COMPLETED` once any pharmacy/staff exists. These steps are incompatible. Separate fresh-state bootstrap tests from post-provisioning tenant tests, run the empty-state test **before** real bootstrap, or use a separate isolated database/transaction as appropriate. Ensure no committed test data and no test overwrites the live bootstrap sentinel.

### HIGH — H4: Staff provisioning lacks safe reconciliation after ambiguous RPC completion

`supabase/functions/_shared/adminProvisioningLogic.ts:829–856` validates a response from `provision_pharmacy_staff_by_owner`, but on error/timeout/malformed response immediately tries `auth.admin.deleteUser(newStaffUserId)` **without first checking whether the database commit actually succeeded**. This can leave an account with a committed `pharmacy_staff` row (whose FK restricts Auth deletion; `0001:51–63`) and a misleading error, or an orphaned state. The bootstrap flow has better reconciliation logic (`adminProvisioningLogic.ts:408–542`); staff provisioning needs analogous idempotency, durable reconciliation, and explicit outcomes. Test post-commit lost-response and concurrent retry cases.

### MEDIUM/HIGH — H5: Browser Edge Function cannot handle CORS preflight

`supabase/functions/owner-provision-staff/index.ts:15–65` returns only JSON `Content-Type` / `Cache-Control` and delegates requests to `handleOwnerProvisionStaff`, which returns `405` for non-POST (`adminProvisioningLogic.ts:587–589`). There is no `OPTIONS` response or `Access-Control-Allow-*` headers. A pharmacist CRM calling this Edge Function across origins from a browser will fail its CORS preflight. Implement proper preflight and actual response headers, with appropriate origin policy. Supabase documents CORS requirements for browser Edge Function invocation: https://supabase.com/docs/guides/functions/cors .

### MEDIUM — M1: Audit skip control uses a client/session-settable custom GUC

`0003:1912–1918` sets `masar.skip_thread_audit_trigger` to suppress duplicate audit entries when the consultation reply RPC changes status, and `0003:2122–2125` trusts that session value to skip logging. Because it is a custom session configuration setting rather than a trusted internal audit source, this is fragile and can suppress status-change audit in clients with the ability to set that setting. Prefer non-bypassable audit behavior; a harmless duplicate audit is preferable to a gap, or implement a trusted server-generated correlation mechanism. Test normal/direct status changes and replies.

### DESIGN GATE — D1: Android scheduled-dose materialization still unimplemented

`docs/STAGE2B2A1_PRE_DEPLOYMENT_REVIEW.md` §3 explicitly treats server-side occurrence generation as a future requirement; the backend doesn't currently create `scheduled_doses` from plan/version updates. It is correctly marked as pending and should remain a required gate before the native Kotlin Android APK beta.

## Positive verification

- The archive has no ZIP integrity errors.
- Migration `0003` has `BEGIN;` and `COMMIT;` (`0003:14,2252`), 23-table design, explicit tenant-scoped clinical RPCs, and server-recorded provisional refill provenance.
- The current Edge bootstrap uses independent named bootstrap/admin tokens instead of the Supabase service-role key as a bearer fallback.
- The latest repository handoff reflects Android APK first, then iPhone PWA, optional native iOS.
- Existing migrations 0001/0002 and their baseline structure remain present in the ZIP.

## Testing limitations

Google AI Studio reports 8 passing mock/static suites and TypeScript/build success. Independent execution was **not** reproduced: `npm ci --offline --ignore-scripts` failed `ENOTCACHED` because `@supabase/supabase-js` wasn't locally cached. No migration, function, or test was executed in PostgreSQL during this review.

## Required release gates

1. Correct H1–H5 and M1 with minimal additive review-only changes; preserve 0001/0002 historical migration files and demonstrate complete privilege closure in 0003.
2. Fix and split SQL tests, with clean-state bootstrap/replay test preceding initial owner setup and a post-provisioning RLS suite on fictional data.
3. Add negative tests covering direct clinical writes, provenance field inflation, malformed Edge replies, post-commit timeouts, browser CORS OPTIONS, and audit trigger behavior.
4. Verify schema/RPC signatures against the deployed clean 22-table development schema *read-only* before requesting a separately scoped migration 0003 execution approval.
5. Review live test outputs before provisioning Auth users or deploying Edge Functions.

**Decision:** Not yet approved for Stage 2B.2B execution. No changes were made to any Supabase project during this audit.
