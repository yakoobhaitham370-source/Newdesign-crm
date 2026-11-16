# MASAR Care — Stage 2A Database Test Results

**Date:** 2026-11-13  
**Project ID:** `bkidngfzsubmyunacnju` (Dedicated Disposable Supabase Development Project — Fictional Data Only)  
**PostgreSQL Version:** 17.11  
**Approved Architecture:** Option B (Single shared Supabase project with strict `pharmacy_id` RLS isolation)  
**Status:** Stage 2A Database Testing & Clean Dev DB Cleanup **COMPLETED** (Awaiting Explicit Stage 2B Approval)

---

## 1. Executed Migrations & Schema Verification

### Migration `0001_stage2a_core_schema.sql` — PASS
- Installed **22 database tables** cleanly in PostgreSQL 17.11 with `extensions` schema isolation (`pgcrypto`, `pg_trgm`, `btree_gist`), composite tenant/patient ownership constraints, immutable ledger triggers (`trg_regimen_versions_no_delete`, `prevent_ledger_mutation`), and `unscheduled_dose_reports` (`23514` provenance enforcement).

### Migration `0002_stage2a_rls_and_security.sql` — PASS
- Installed **43 security policies** across the 22 MASAR tables.
- Confirmed **RLS enabled and forced** (`relrowsecurity = true`, `relforcerowsecurity = true`) on all **22 tables**.
- Confirmed **`anon` role** holds `SELECT` privilege on **0 tables**.

---

## 2. Executed Security & Concurrency Suites

### Negative Security, RLS & Integrity Suite (`supabase/tests/stage2a_negative_security_and_integrity.test.sql`) — PASS
- Executed cleanly inside `BEGIN; ... ROLLBACK;` against PostgreSQL 17.11 (synchronized V2 test file in repo).
- Verified `SET LOCAL ROLE anon/authenticated`, cross-tenant denial, patient direct `dose_events` insert denial (`H1-A` `23514` vs `H1-B` `42501`), `confirm_scheduled_dose` provenance/idempotency/duplicate blocking, `23514` unscheduled report enforcement, `23P01` pause overlap rejection, `C1`–`C4`, `H1`–`H8`, `M6`, and `M7`.
- Post-rollback cleanliness verified:
  - Fictional test pharmacies remaining: **0**
  - Fictional test `auth.users` remaining: **0**

### Two-Session Concurrency & Retry Harness (`supabase/tests/run_stage2a_concurrency_and_retry.sh`) — PASS
- **Case A — PASS:** Two simultaneous identical dose confirmations (`same scheduled_dose_id + same client_event_uuid`) -> **1** saved dose event; second request recognized as idempotent replay (`idempotentReplay: true`) returning the same `doseEventId`.
- **Case B — PASS:** Two competing dose confirmations (`same scheduled_dose_id + different client_event_uuid`s) -> **1** accepted; second rejected with `DUPLICATE_DOSE_CONFIRMATION_BLOCKED`.
- **Case C — PASS:** Same `client_event_uuid` submitted concurrently for two different `scheduled_dose_id`s -> **1** accepted; second rejected with `CLIENT_EVENT_UUID_CONFLICT`.
- **Final Runner Output:** `PASS: Two-session concurrency harness succeeded for Cases A, B, and C.`
- **Database Invariant Verification:** Confirmed **1** committed `dose_events` row per tested scenario (`Case A`, `Case B`, `Case C`).

---

## 3. Verified Post-Test Guarded Transactional Cleanup (2026-11-13)

The fictional concurrency-test records and test `auth.users` entries on `bkidngfzsubmyunacnju` were removed cleanly via guarded transactional cleanup.

**Verified Final Database State (`bkidngfzsubmyunacnju`):**
- **22** MASAR Care tables preserved.
- **22** tables have RLS enabled and forced (`relrowsecurity = true`, `relforcerowsecurity = true`).
- **43** security policies preserved.
- **0** pharmacy, patient, staff, medication, scheduled-dose, or dose-event records.
- **0** Auth users.
- **Migrations `0001` and `0002` remain intact and do NOT need to be reapplied.**

---

## 4. Remaining Non-Implemented Scope & Stage 2B Approval Gate

- **Stage 2B Not Started:** Live CRM persistence (`SupabaseCrmRepository`), real pharmacist authentication, owner-controlled staff provisioning, Edge Functions, SMS OTP gateway dispatch, prior-session revocation, and removal/gating of Stage 1 demo controls remain **NOT IMPLEMENTED / NOT VERIFIED**.
- **Production Readiness:** **NOT ESTABLISHED.** Real patient records must not be imported or used; connected development mode must use fictional test data only until Stage 2B verification completes.
- **Separate Approvals Required Before Executing Stage 2B:**
  1. Approval to begin Stage 2B implementation (`@supabase/supabase-js`, login/session layer, `SupabaseCrmRepository`, connected-dev feature gating while preserving Demo Mode fallback).
  2. Approval for any additive Stage 2B SQL migration (`0003`: e.g., `revoke_patient_apk_invitation` RPC and server-side `audit_logs` triggers) and SQL execution on `bkidngfzsubmyunacnju`.
  3. Approval to deploy Supabase Edge Functions (owner staff-provisioning / bootstrap onboarding; OTP gateway dispatch when needed).
  4. Approval to create fictional pharmacist Auth users (`pharmacy_owner` and `authorized_pharmacist` across two test pharmacies) and seed fictional development records on `bkidngfzsubmyunacnju`.
  5. Approval to activate connected development persistence in the app runtime.
