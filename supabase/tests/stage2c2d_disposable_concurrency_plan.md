# MASAR Care — Stage 2C.2D Disposable-Environment Concurrency Test Plan

> **DO NOT RUN AGAINST PRODUCTION OR SHARED LIVE SUPABASE ENVIRONMENTS.**  
> Execute this multi-session concurrency runbook **only** in a disposable or staging PostgreSQL instance after applying migrations `0001`–`0004` and `supabase/drafts/stage2c2c_migration_DRAFT.sql`.

Single-transaction `BEGIN; ... ROLLBACK;` scripts (`stage2c2c_rollback_verification_DRAFT.sql`) cannot simultaneously hold uncommitted locks across two independent database connections. Therefore, multi-session lock contention, `pg_advisory_xact_lock`, and `FOR UPDATE` serialization tests are separated here as a disposable-environment two-connection `psql` test plan.

---

## Preconditions

1. Run `supabase/tests/stage2c2c_read_only_preflight_postcheck.sql` and capture baseline row counts.
2. Confirm **0** rows exist with deterministic `2c2c%` / `TST-2C2C-%` / `TST-2C2E-%` / `TEST-2C2C-%` identifiers:
   ```sql
   SELECT
     (SELECT count(*) FROM auth.users WHERE id::text LIKE '2c2c%' OR email LIKE 'stage2c2c%') AS auth_collisions,
     (SELECT count(*) FROM public.pharmacies WHERE id::text LIKE '2c2c%' OR license_number LIKE 'TEST-2C2C-%') AS pharm_collisions,
     (SELECT count(*) FROM public.medication_catalog WHERE id::text LIKE '2c2c%' OR brand_name LIKE 'TST-2C2C-%' OR brand_name LIKE 'TST-2C2E-%') AS catalog_collisions;
   ```
   Abort immediately if any count is non-zero.
3. Execute `supabase/tests/stage2c2c_rollback_verification_DRAFT.sql` in a dedicated transaction prior to Steps 1–5 so all Stage 2C.2E `service_role` constraint-permission, catalog-completeness, and combination-brand assertions are verified cleanly against live PostgreSQL.

---

## Step 1 — Committed Disposable Seed (Connection 1)

Create isolated disposable `2c2c` pharmacy, staff, patient, and an active **Glucophage 500 mg** plan (v1) in a committed transaction so Connection 2 can see the committed baseline rows:

```sql
BEGIN;
INSERT INTO auth.users (id, aud, role, email)
VALUES ('2c2c0001-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'stage2c2c-concurrency@masar.invalid');

INSERT INTO public.pharmacies (id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active)
VALUES ('2c2c0000-0000-4000-8000-000000000001', 'صيدلية تزامن ٢ج٢د', 'Stage 2C2D Concurrency Pharmacy', 'Baghdad', 'Baghdad', 'TEST-2C2C-RACE', '07700000441', 'Asia/Baghdad', true);

INSERT INTO public.pharmacy_staff (id, pharmacy_id, full_name, role, phone, syndicate_license, is_active)
VALUES ('2c2c0001-0000-4000-8000-000000000001', '2c2c0000-0000-4000-8000-000000000001', 'د. تزامن', 'pharmacy_owner', '07700000442', 'SYN-2C2C-R', true);

INSERT INTO public.patients (
  id, pharmacy_id, patient_code, full_name, phone, phone_owner_type,
  date_of_birth, sex, contact_preference, registration_date, status, created_by_staff_id
) VALUES (
  '2c2c0002-0000-4000-8000-000000000001', '2c2c0000-0000-4000-8000-000000000001',
  'TST-2C2C-RACE', 'مراجع تزامن', '07700000443', 'self',
  DATE '1980-01-01', 'male', 'whatsapp', DATE '2026-11-01', 'active', '2c2c0001-0000-4000-8000-000000000001'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '2c2c0001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT public.create_medication_plan_with_version_v2(
  '2c2c0002-0000-4000-8000-000000000001'::uuid,
  NULL,
  'Glucophage', 'Metformin HCl', '500 mg', 'tablet', 'oral',
  1, 'tablet', 'after_food', 'Take 1 tablet twice daily after meals',
  NULL, NULL, DATE '2026-11-15', NULL, true, NULL,
  '{"frequencyType":"daily","timesPerDay":2,"doseSlots":[{"id":"s1","time24":"08:00","doseAmount":1},{"id":"s2","time24":"20:00","doseAmount":1}],"timezone":"Asia/Baghdad"}'::jsonb,
  NULL
);
COMMIT;
```

Capture the returned `planId` (`<PLAN_UUID>`).

---

## Step 2 — Same-UUID Concurrent Advisory Lock Serialization

Goal: Verify two simultaneous requests sharing `(pharmacy_id, client_event_uuid)` serialize via `pg_advisory_xact_lock` and produce **exactly 1 row** plus `{"idempotentReplay": true}` for the second connection.

### Connection 1 (open & pause BEFORE `COMMIT`)
```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '2c2c0001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT public.record_dispensing_with_refill_v2(
  '2c2c0002-0000-4000-8000-000000000001'::uuid,
  '<PLAN_UUID>'::uuid,
  30, 'tablet', 1, 30, 'B-RACE', DATE '2027-06-01',
  DATE '2026-11-16', false, 'Concurrency test fill', 2, 15, DATE '2026-12-01', 'test',
  30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
  'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
  1, '2c2c8888-0000-4000-8000-000000000001'::uuid, NULL, NULL
);
-- PAUSE HERE before running COMMIT; launch Connection 2 now.
```

### Connection 2 (run while Connection 1 holds the uncommitted transaction)
```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '2c2c0001-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT public.record_dispensing_with_refill_v2(
  '2c2c0002-0000-4000-8000-000000000001'::uuid,
  '<PLAN_UUID>'::uuid,
  30, 'tablet', 1, 30, 'B-RACE', DATE '2027-06-01',
  DATE '2026-11-16', false, 'Concurrency test fill', 2, 15, DATE '2026-12-01', 'test',
  30, 30, 15, 'on_track', DATE '2026-12-01', 'test',
  'provisional_client_unverified', 'masar_refill_v1', '{}'::jsonb,
  1, '2c2c8888-0000-4000-8000-000000000001'::uuid, NULL, NULL
);
```

### Verification
1. Connection 2 blocks waiting on `pg_advisory_xact_lock`.
2. Run `COMMIT;` in Connection 1.
3. Connection 2 immediately resumes and returns:
   - `"ok": true`
   - `"idempotentReplay": true`
   - Identical `"dispensingEventId"` as Connection 1.
4. Commit Connection 2 and assert `SELECT count(*) FROM public.dispensing_events WHERE client_event_uuid = '2c2c8888-0000-4000-8000-000000000001'` equals `1`.

---

## Step 3 — Same-UUID Concurrent Conflicting Payload Race (`23514`)

Repeat Step 2 with a **new** `client_event_uuid` (`2c2c8888-0000-4000-8000-000000000002`), where Connection 2 sends altered `batch_number = 'B-MODIFIED'`:
1. Connection 2 blocks cleanly behind Connection 1's advisory lock.
2. When Connection 1 commits, Connection 2 unblocks, detects payload hash mismatch, and aborts cleanly with **SQLSTATE `23514`** (`Idempotency conflict: client_event_uuid ... was reused with modified dispensing details.`).

---

## Step 4 — Regimen Edit vs Dispensing Row-Lock Race (`40001`)

Goal: Verify `patient_medication_plans ... FOR UPDATE` serializes concurrent dose modifications and dispensing attempts.

1. **Connection 1** opens `BEGIN;`, acquires `authenticated` role, calls `public.update_medication_plan_version_v2(<PLAN_UUID>, ..., p_expected_version_number => 1)` (bumping plan to v2), and pauses **before `COMMIT`**.
2. **Connection 2** calls `public.record_dispensing_with_refill_v2(..., p_expected_regimen_version_number => 1, p_client_event_uuid => '2c2c8888-0000-4000-8000-000000000003', ...)`. Connection 2 blocks on `FOR UPDATE`.
3. **Connection 1** executes `COMMIT;`.
4. **Expected Result**: Connection 2 immediately resumes and fails cleanly with **SQLSTATE `40001`** (`Regimen version mismatch: expected v1, current v2.`), writing zero dispensing rows for the stale version.

---

## Step 5 — Safe Disposable-Database Teardown & Reset (Immutable Ledgers Preserved)

**CRITICAL SECURITY RULE:**
Because Steps 1–4 commit real rows into append-only clinical and security ledgers (`public.audit_logs`, `public.dispensing_events`, and `public.regimen_versions`), row-level `DELETE` cleanup is **architecturally impossible and strictly prohibited**:
- `trg_audit_logs_immutable`, `trg_dispensing_events_immutable`, and `trg_regimen_versions_no_delete` invoke `public.prevent_ledger_mutation()` (`DELETE forbidden`).
- **NEVER** disable, bypass, drop, or weaken immutable-ledger security triggers or `prevent_ledger_mutation()` to simplify test cleanup.
- **NEVER** run this committed concurrency test against production or any shared persistent environment (only disposable local/ephemeral instances).

Instead of row-level `DELETE`, tear down or reset the entire disposable environment after verifying invariants:

### Option A — Disposable Local PostgreSQL (`psql` / Containerized PG)
1. Optionally confirm ledger immutability triggers remain intact and active (`O` / `A` in `pg_trigger.tgenabled`, never disabled) before teardown:
   ```sql
   SELECT tgrelid::regclass AS table_name, tgname, tgenabled
   FROM pg_trigger
   WHERE tgname IN (
     'trg_audit_logs_immutable',
     'trg_dispensing_events_immutable',
     'trg_regimen_versions_no_delete'
   );
   ```
2. Terminate connections and drop the disposable database (or delete the ephemeral container/PGDATA directory):
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE datname = 'masar_staging_2d' AND pid <> pg_backend_pid();

   DROP DATABASE IF EXISTS masar_staging_2d;
   CREATE DATABASE masar_staging_2d;
   ```
3. Re-apply baseline migrations `0001`–`0004` (plus `supabase/drafts/stage2c2c_migration_DRAFT.sql` when re-testing Stage 2C.2C/2E) onto the fresh database.

### Option B — Disposable Local Supabase CLI Stack / Ephemeral Branch
1. Reset the local Docker-backed Supabase instance cleanly:
   ```bash
   supabase db reset --local
   ```
   *(Or delete the disposable Supabase preview branch if executed on an isolated branch.)*

### Option C — Post-Reset Cleanliness Verification
Run `supabase/tests/stage2c2c_read_only_preflight_postcheck.sql` on the newly reset disposable database and confirm:
- All `leftover_*` counts = `0`
- All 24 `public` tables exist with forced RLS and expected clean baseline state
- Immutable ledger triggers remain enabled with zero bypasses.
