# MASAR Care — Independent Source Audit Verification & Security Fix Review (V1.5.2)

**Date:** 2026-11-12  
**Approved Architecture:** **Option B** — One shared Supabase project with strict multi-tenant pharmacy isolation (`pharmacy_id` + Row-Level Security).  
**Database Execution Status:** **REVIEW-ONLY** — No SQL migration has been executed and no live Supabase instance has been connected.

---

## 1. Independent Audit Finding Verification Matrix (Codebase vs. Audit Report)

Every finding in `docs/MASAR_CARE_INDEPENDENT_SOURCE_AUDIT.md` was independently verified against the V1.5.1 source tree prior to modification:

| ID | Audit Finding Summary | Verification Status | V1.5.1 File & Line Evidence | Remediation Implemented |
|---|---|---|---|---|
| **C1** | `RAISE EXCEPTION` after `UPDATE`/`INSERT` in `redeem_patient_apk_invitation` rolls back failed attempt counters, lockouts, and expiry transitions | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:630–673` | Replaced post-write `RAISE EXCEPTION` in `issue_patient_apk_invitation`, `request_invitation_sms_otp`, and `redeem_patient_apk_invitation` with structured `JSONB` return payloads (`{ "ok": false, "errorCode": "...", "failedAttempts": ..., "lockedOut": ... }`) so PostgreSQL commits all failure counters, lockouts (`status = 'revoked'`), and `invitation_redemption_attempts` audit rows. |
| **C2** | `redeem_patient_apk_invitation` trusts caller-supplied `p_client_ip_hash` and grants `EXECUTE` to `authenticated` | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:591–597, 717` | Revoked `EXECUTE` on `request_invitation_sms_otp` and `redeem_patient_apk_invitation` from `PUBLIC, anon, authenticated` and granted `EXECUTE` strictly to `service_role` (`0002:1040–1044`). Rate limiting uses Edge-computed `p_network_ip_hmac` and `p_device_fingerprint_hash`. |
| **C3** | `redeem_patient_apk_invitation` requires `sms_otp_hash`, but no OTP generation/issuance RPC exists (`sms_otp_hash` remains `NULL`) | **CONFIRMED** | `supabase/migrations/0001_stage2a_core_schema.sql:505–506`; `0002:653–659` | Added `public.request_invitation_sms_otp(...)` (`0002:669–826`) which validates the pending token and Pharmacist Handover PIN, enforces a 60-second cooldown and 5-send cap (`otp_send_count`, `otp_last_sent_at`), generates a 6-digit CSPRNG OTP (`app_security.generate_csprng_6digit_code()`), stores `crypt(v_sms_otp, gen_salt('bf', 10))` with a 5-minute TTL, and returns the raw OTP exclusively to the `service_role` Edge Function for SMS gateway dispatch. |
| **C4** | Composite FKs validate `(patient_id, pharmacy_id)` and `(medication_plan_id, pharmacy_id)` separately without proving `medication_plan_id` belongs to `patient_id` | **CONFIRMED** | `supabase/migrations/0001_stage2a_core_schema.sql:183, 257–372` | Added `UNIQUE (id, patient_id, pharmacy_id)` on `patient_medication_plans` (`0001:199`), `UNIQUE (medication_plan_id, version_number, pharmacy_id)` on `regimen_versions` (`0001:231`), `UNIQUE (id, medication_plan_id, patient_id, pharmacy_id)` on `scheduled_doses` (`0001:282`) and `dispensing_events` (`0001:360`), and updated child FKs across `medication_pause_periods`, `scheduled_doses`, `dose_events`, `dispensing_events`, `refill_assessments`, and `follow_up_tasks` to bind `(medication_plan_id, patient_id, pharmacy_id)` together. |
| **H1** | Hardcoded `APP_REFERENCE_DATE = '2026-11-12'` across runtime views, forms, and context | **CONFIRMED** | `src/i18n/translations.ts:19`; `src/context/CrmContext.tsx:2,165,168`; `AppShell.tsx:161`; modals/views | Created `src/services/clockService.ts` (`IBaghdadClock`, `LiveBaghdadClock`, `FixedBaghdadClock`) anchored to `Asia/Baghdad` (`UTC+3`). Wired `todayStr`, `clockMode`, and `setClockMode` into `CrmContext` and replaced hardcoded `APP_REFERENCE_DATE` across UI views and modals while preserving deterministic fixture dates for unit tests. |
| **H2** | Synchronous `ICrmDataAdapter` and non-UUID synthetic IDs (`pat-${Date.now()}`) | **CONFIRMED** | `src/services/crmRepository.ts:94–134, 311, 340, 405, 441, 495` | Added `generateEntityUuid()` using `crypto.randomUUID()` for all newly created entities, added `IAsyncCrmRepository` and `AsyncInMemoryCrmRepository` in `src/services/crmRepository.ts`, and exposed `asyncRepository`, `isLoading`, `asyncError`, and `clearAsyncError` in `CrmContext.tsx`. |
| **H3** | Handover PIN generated with PostgreSQL `random()` instead of CSPRNG | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:553` | Created `app_security.generate_csprng_6digit_code()` (`0002:102–123`) using `gen_random_bytes(4)` (`pgcrypto`) with rejection sampling to eliminate modulo bias. |
| **H4** | Patient APK bootstrap authentication gap (`auth.uid()` required before account link exists) | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:608–609` | Designed a 2-step Edge Function bootstrap ceremony: (1) Edge Function calls `request_invitation_sms_otp`; (2) upon OTP submission, Edge Function creates/retrieves the patient's Supabase Auth user via Admin API and passes `p_bootstrap_auth_user_id` to `redeem_patient_apk_invitation` (`0002:832–840`). |
| **H5** | `UNIQUE (pharmacy_id, phone)` on `patients` blocks shared family/caregiver phones common in Iraq | **CONFIRMED** | `supabase/migrations/0001_stage2a_core_schema.sql:76` | Removed `UNIQUE (pharmacy_id, phone)` from `patients` (`0001:64–92`), retained `idx_patients_pharmacy_phone` for duplicate warning lookup, and added `phone_owner_type` (`'self' | 'caregiver' | 'family_shared'`), `caregiver_name`, and `verified_account_phone` in SQL and TypeScript domain models. |
| **H6** | Composite `ON DELETE SET NULL` on `(related_medication_plan_id, pharmacy_id)` attempts to null `NOT NULL` `pharmacy_id` | **CONFIRMED** | `supabase/migrations/0001_stage2a_core_schema.sql:371–372, 425–426` | Changed composite FKs to PostgreSQL 15+ column-specific `ON DELETE SET NULL (scheduled_dose_id)`, `ON DELETE SET NULL (last_dispensing_event_id)`, and `ON DELETE SET NULL (related_medication_plan_id)` (`0001:320, 391, 449`), and changed clinical history FKs from `ON DELETE CASCADE` to `ON DELETE RESTRICT`. |
| **H7** | `simulateSupplyDepletionFromOccurrences` ignores finite `plan.endDate` and invents a `lastDate + 1` refill date when stock never depletes | **CONFIRMED** | `src/services/scheduleEngine.ts:454–466, 520–526` | Updated `generateSupplyOccurrences` to clamp at `plan.endDate` when `!plan.isOngoing`, updated `simulateSupplyDepletionFromOccurrences` to return `{ estimatedSupplyDays: null, estimatedSupplyEndDate: null, noDepletionWithinPlan: true }` when stock covers the full finite course or 3,650-day horizon, and added `areUnitsCompatibleForRefill` to flag incompatible dose/dispensing units as `unable_to_estimate`. |
| **H8** | Issuing a new invitation can silently overwrite `patients.auth_user_id` on an already-activated patient | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:535–540, 684–688` | Added `invitation_purpose` (`'initial_activation' | 'device_replacement_recovery'`) and `recovery_reason` (`0001:514–518`). Both `issue_patient_apk_invitation` (`0002:595–609`) and `redeem_patient_apk_invitation` (`0002:969–984`) reject overwriting an existing `auth_user_id` unless `invitation_purpose = 'device_replacement_recovery'` with a documented reason and audit trail. |
| **M3** | Missing `package-lock.json` and missing `test` / `typecheck` scripts in `package.json` | **CONFIRMED** | `package.json:6–12` | Added `"test"`, `"test:unit"`, and `"typecheck"` scripts in `package.json` and generated `package-lock.json`. |
| **M6** | Missing non-overlap constraint on `medication_pause_periods` and provenance enforcement on `dose_events` | **CONFIRMED** | `supabase/migrations/0001_stage2a_core_schema.sql:233–249, 280–311` | Added `trg_pause_periods_no_overlap` (`0001:643–677`), `trg_dose_events_provenance` (`0001:679–717`), and `trg_regimen_versions_controlled_update` (`0001:615–641`). |
| **M7** | `SECURITY DEFINER` helper functions exposed in `public` schema | **CONFIRMED** | `supabase/migrations/0002_stage2a_rls_and_security.sql:24–112, 709–717` | Created private `app_security` schema (`0002:19–134`), moved all RLS helper functions and CSPRNG generator into `app_security`, and revoked `PUBLIC`/`anon` execution privileges on internal helpers. |
| **M8** | Handoff report overstated readiness before independent review | **CONFIRMED** | `docs/MASAR_CARE_HANDOFF.md` | Updated `docs/MASAR_CARE_HANDOFF.md` to record all verified findings, completed Stage A & Stage B remediations, and remaining Stage 2B prerequisites. |

---

## 2. Stage A — Security & Database Architecture Summary (Review-Only)

### 2.1 Multi-Step Patient APK Onboarding & Bootstrap Flow (`C1`, `C2`, `C3`, `H3`, `H4`, `H8`)
1. **Pharmacist Issuance (`public.issue_patient_apk_invitation`)**:
   - Callable only by an active authenticated pharmacist (`app_security.is_active_pharmacist()`).
   - If the patient already has a linked `auth_user_id`, requires `p_invitation_purpose = 'device_replacement_recovery'` and a non-empty `p_recovery_reason` (`H8`).
   - Generates a 256-bit CSPRNG token (`gen_random_bytes(32)`) and a 6-digit CSPRNG handover PIN (`app_security.generate_csprng_6digit_code()`), storing only `sha256(token)` and `crypt(pin, gen_salt('bf', 10))`.
2. **Edge Function Step 1 — Request SMS OTP (`public.request_invitation_sms_otp`)**:
   - Restricted strictly to `service_role`.
   - Computes `p_network_ip_hmac` from the trusted reverse-proxy IP and `p_device_fingerprint_hash` in the Edge Function.
   - Verifies the token hash and Pharmacist Handover PIN. On mismatch, increments `failed_attempts`, revokes the invitation at `max_attempts`, inserts an audit row in `invitation_redemption_attempts`, and **returns a JSONB error object without raising an exception** so the transaction commits (`C1`).
   - On success, generates a 6-digit CSPRNG SMS OTP with a 5-minute TTL, stores its `bcrypt` hash, and returns the raw OTP to the Edge Function to dispatch via Iraq SMS/WhatsApp gateway (`C3`).
3. **Edge Function Step 2 — Bootstrap Auth User & Redeem (`public.redeem_patient_apk_invitation`)**:
   - Restricted strictly to `service_role`.
   - Verifies token hash, Pharmacist Handover PIN, and non-expired SMS OTP hash.
   - Binds `patients.auth_user_id = p_bootstrap_auth_user_id` (provisioned by the Edge Function via Supabase Admin Auth API) and consumes the invitation (`status = 'activated'`, `sms_otp_hash = NULL`).

---

## 3. Automated Verification Results

- **TypeScript (`npm run typecheck` / `npm run lint`)**: **PASS** (0 errors)
- **Production Build (`npm run build`)**: **PASS**
- **Automated Test Suites (`npm test`)**: **28 / 28 suites passed**:
  - `src/tests/stage1WorkflowAudit.ts`: **8 / 8 passed**
  - `src/tests/v15Hardening.test.ts`: **7 / 7 passed**
  - `src/tests/v151FinalGaps.test.ts`: **8 / 8 passed**
  - `src/tests/auditRemediation.test.ts`: **5 / 5 passed** (`H1` Baghdad clock & midnight rollover, `H2` async repository & RFC 4122 UUIDs, `H7` finite courses/surplus stock/unit mismatch guards, `H5` shared family phones, and Stage A SQL static verification).
- **SQL Negative Test Suite (`supabase/tests/stage2a_negative_security_and_integrity.test.sql`)**: Drafted and statically verified (ready to run against a local/staging PostgreSQL 15+ instance once SQL execution is approved).
