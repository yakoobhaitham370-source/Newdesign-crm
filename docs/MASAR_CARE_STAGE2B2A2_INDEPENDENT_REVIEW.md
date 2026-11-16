# MASAR Care — Independent Stage 2B.2A.2 Pre-Deployment Review

**Source reviewed:** User-uploaded `masar-care (10).zip` (109 archive entries; ZIP integrity check passed).  
**Version:** V1.5.5-Stage2B.2A.2  
**Scope:** Offline inspection of migration 0003, migration 0002 baseline, Edge Functions, SQL tests, CRM code, and deployment plan.  
**Execution:** **No SQL executed; no Supabase project contacted, modified, or deployed to during this review.**  
**Verdict:** **Hold migration 0003 and Edge deployment pending targeted corrections and independent execution testing.** The existing React CRM and Stage 2A baseline should be preserved.

## Confirmed improvements

1. `0003_stage2b_atomic_crm_and_bootstrap.sql:124–148` revokes broad authenticated writes on seven RPC-managed clinical tables and narrows direct updates on `patients`; legacy direct-write policies are dropped. PostgreSQL documentation confirms table-level `REVOKE` also revokes corresponding column privileges. Thus the old narrow column grants in 0002 do **not** by themselves remain an active bypass after these REVOKEs.
2. `0003:153–156` adds a restrictive patient-only consultation-message insert policy; `0003:2218–2300` reserves pharmacist replies for a server-authorized RPC.
3. `0003:161–185, 732–1119` introduces durable staff-provisioning claims and response reconciliation, and `adminProvisioningLogic.ts:838–1050` claims before creating Auth users and checks state before compensating deletion.
4. SQL tests were split into a clean-state suite to run before bootstrap and a post-bootstrap suite, both transaction-wrapped in source. The old nonexistent `reset_config` call has been removed.
5. `owner-provision-staff/index.ts:25–37` handles `OPTIONS`; the Edge handler validates the JWT with `auth.getUser` and checks the currently active owner in the DB.
6. `0003:2218–2300, 2386–2541` removes the client-configurable audit-suppression flag from consultation writes and audit trigger logic.

## Confirmed issue A — Patient-authored consultation can claim pharmacist approval (High)

- `0001_stage2a_core_schema.sql:589–604` allows a `sender_type = 'patient'` message to have `approved_by_pharmacist = true`: its CHECK condition is `sender_type = 'patient' OR (...)`.
- `0002_stage2a_rls_and_security.sql:567–587` allows patient-owned threads to receive direct patient INSERTs without checking `approved_by_pharmacist = false`.
- `0003_stage2b_atomic_crm_and_bootstrap.sql:153–156` adds only `sender_type = 'patient'` to the restrictive INSERT policy, not an approval-field guard.
- `src/views/ConsultationsView.tsx:250–252` renders a green approval/check indicator whenever `approvedByPharmacist` is true, regardless of sender type.

**Effect:** Once patient sessions are introduced, a patient with legitimate access to their own thread can insert a patient-origin message falsely marked as pharmacist-approved. This does **not** give them a pharmacist role, but it contaminates clinical message provenance and may mislead the UI. **Fix:** Add an additive restrictive predicate `sender_type = 'patient' AND sender_staff_id IS NULL AND approved_by_pharmacist = false` or an equivalent trusted server invariant. Consider enforcing the provenance rule at DB level and changing the UI so the approval badge requires an actual pharmacist sender/record. Add patient-JWT negative tests proving approval spoofing is blocked.

## Confirmed issue B — Idempotency key can be reused for a different staff request after TTL (High design/implementation gap)

- `0003:796–833` finds the existing row by `(pharmacy_id, idempotency_key)` and blocks completed/reconciliation/in-progress requests.
- `0003:835–865` uses `ON CONFLICT (...) DO UPDATE` to **overwrite** `request_id`, `target_email`, `target_phone`, owner, and claim state once the prior claim's TTL expires, even when these attributes have changed.
- `adminProvisioningLogic.ts:838–934` acquires a claim, then separately calls Supabase Auth Admin `createUser`, then finalizes a DB row. Those are not one transaction. A slow/ambiguous call can survive the TTL.

**Effect:** Reusing a key with different payload can erase original claim provenance and potentially overlap with an in-flight Auth creation. This is a specific idempotency/reconciliation risk, not evidence of exploitation. **Fix:** Bind each idempotency key to an immutable canonical request fingerprint (pharmacy, owner, target email/phone/role), refuse conflicting retries, and permit expired-claim recovery only after verifying Auth and DB state. Add overlap/replay/race tests. In addition, `0003:1001–1008` allows `p_request_id = NULL` when calling `provision_pharmacy_staff_by_owner`; require a valid claim for all normal provisioning to prevent claimless privileged writes.

## Deployment concern C — Browser OPTIONS and platform JWT verification need an explicit plan (Medium, live verification required)

- The ZIP has **no `supabase/config.toml`**.
- `docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md:35` specifically deploys `bootstrap-first-owner` with `--no-verify-jwt`, but does not specify whether `owner-provision-staff` uses the platform default `verify_jwt = true`.
- `owner-provision-staff/index.ts:25–37` implements OPTIONS inside the function. The Supabase gateway's platform JWT check runs **before** function code, so an unauthenticated browser preflight may fail before reaching that handler. Newer Supabase wrappers offer automatic CORS and user-auth verification; manual handling needs documented gateway behavior.

**Fix:** Record per-function `verify_jwt` settings and test anonymous OPTIONS, missing/bad JWT POST, valid owner JWT POST, disallowed Origin, and malformed requests through the *actual* deployed gateway. If disabling platform verification for the owner function to make preflight work, ensure the handler's `auth.getUser(jwt)` and DB owner checks remain mandatory for every non-OPTIONS action; use a strict origin allowlist in connected development/production.

## Testing and reporting limitations

- The supplied code reports nine passing offline suites, TypeScript checks and a Vite build. **These were not independently executed here**; npm packages are not installed in the review environment, and its npm cache is empty.
- `stage2b_0003_bootstrap_clean_state.test.sql` and `stage2b_0003_negative_and_integrity.test.sql` are *drafts*. They have not been executed against PostgreSQL 17, so claims of atomic rollback and RLS success for 0003 remain unverified.
- The planned post-bootstrap test inserts fictitious `auth.users` rows directly inside a rollback transaction. This can verify some database policy behavior, but it is not a substitute for full Supabase Auth/Edge end-to-end tests.
- `public.scheduled_doses` server-side materialization remains unimplemented and must be planned before the native Kotlin patient APK needs real scheduled confirmations.
- Three old audit Markdown copies remain in `public/assets/aistudio/`. They are unnecessary public assets; remove them from a deployable build if they contain internal project details.

## Next approval gate

**Do not execute 0003 or deploy either Edge Function yet.** Apply one targeted *offline* Stage 2B.2A.3 patch addressing issues A and B and documenting/testing concern C. Review the resulting SQL diff and tests. Then approve migration 0003 alone on the disposable dev project, independently verify the 24-table/RLS/grants state and clean-state SQL suite, and separately approve any privileged Edge deployment and initial fictional accounts.

## External technical references

- PostgreSQL REVOKE semantics: https://www.postgresql.org/docs/18/sql-revoke.html
- Supabase Edge Function CORS: https://supabase.com/docs/guides/functions/cors
- Supabase Edge Function authorization/verify_jwt: https://supabase.com/docs/guides/functions/auth-headers
