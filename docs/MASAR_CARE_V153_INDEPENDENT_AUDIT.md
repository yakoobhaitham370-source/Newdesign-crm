# MASAR Care V1.5.3 — Independent ZIP Re-Audit

**Source:** user-supplied `masar-care (3).zip` (67 ZIP entries; 21 proposed database tables).  
**Architecture:** approved Option B — shared Supabase project, tenant-isolated by `pharmacy_id`.  
**Execution scope:** static source and migration inspection, direct file-hash comparison with V1.5.2, and attempted offline dependency installation. No Supabase connection, SQL execution, production deployment, or source-code modification.

## Executive decision

**Conditional progress, but NOT approval for migrations or live patient data.** The V1.5.3 export contains the advertised improvements. Important authorization/data-provenance issues and real PostgreSQL execution tests are still outstanding.

## Verified corrections (compared directly with previous ZIP)

1. The former `APP_REFERENCE_DATE` runtime constant is removed. `CrmContext.tsx` defaults to `live_baghdad`; `clockService.ts` and context implement midnight timers, periodic polling, and focus/visibility resync. The November 12 date now serves demo fixtures and seeded records.
2. `0001_stage2a_core_schema.sql` declares `btree_gist` and a `gist` exclusion constraint for overlapping medication pauses (`medication_pause_periods`, around lines 254–272), supplementing a trigger that signals SQLSTATE `23P01` (around 723–746).
3. `0002_stage2a_rls_and_security.sql` updates the six-digit generator to rejection sampling (around lines 82–103).
4. The SQL security test script is rewritten with the actual 21-table data model and now includes role-switched RLS checks (about lines 427–702). It is more useful than the previous script, but still **not executed**.
5. The previous exported ZIP and screenshot references have been removed from the Vite `public/` directory. The new export is kept in `exports/`, not public assets.

## Confirmed or strongly indicated issues

### H1 — Patient-confirmed dose records can be fabricated without a real scheduled occurrence (HIGH; confirmed from SQL)

- `0001_stage2a_core_schema.sql:319–345`: `dose_events.scheduled_dose_id` is nullable. The row's date/time, planned amount, dose unit, regimen version, and status can be supplied by the inserting client.
- `0002_stage2a_rls_and_security.sql:399–421`: a patient may `INSERT` an event for their own patient row with `taken`, `skipped_by_patient`, or `delayed` status. The predicate does not require a matching authorized scheduled occurrence.
- `0001:748–787`: the provenance trigger stamps timestamps and restricts identity changes on `UPDATE`, but does not validate the new event's correspondence to the authoritative schedule on `INSERT`.

**Impact:** a patient client (or modified APK) can submit a fictitious own-patient scheduled date/dose; this may contaminate refill/adherence analytics. It does not directly show cross-patient access, but it undermines clinical-data integrity. **Fix:** authenticated patient clients should only confirm an existing schedule occurrence via a narrowly scoped RPC or server-enforced validation. Keep a separate and explicitly modeled pathway for PRN/unscheduled patient-reported doses, if needed. Add negative tests for phantom dates, inflated quantities, cancelled plans, duplicate actions, and cross-patient schedule IDs.

### H2 — Broad schema-wide GRANT revocation can disrupt unrelated public tables (HIGH architectural risk)

- `0002_stage2a_rls_and_security.sql:189–190` revokes access on **ALL** tables and sequences in `public` instead of precisely the MASAR tables.

**Impact:** if applied in a pre-existing Supabase project, this can break unrelated applications or tables, and may override privileges they rely on. **Fix:** run only in a dedicated new MASAR development project and preferably enumerate the intended MASAR tables/sequences in grants. Validate all tables exposed via the Data API and their GRANT + RLS combinations.

### H3 — SQL function cryptographic dependencies may be schema-location sensitive (HIGH; must verify in target Postgres)

- `0002:23,39,55,73,90,560,683,849` sets `search_path` without an `extensions` schema.
- The functions refer to unqualified `crypt`, `gen_salt`, `digest`, and `gen_random_bytes` (for example around `0002:97,624–628,715,806–809`).

**Impact:** Supabase installations may have `pgcrypto` functions in a dedicated `extensions` schema. Functions can then fail at runtime despite static tests passing. **Fix:** determine the installed extension location in the isolated dev instance; schema-qualify extension function calls where applicable; test issuance, OTP, redemption, and code generation using real PostgreSQL.

### H4 — Device recovery requires stronger identity workflow than a reason string (HIGH design gate)

- `0002:599–614` allows an authorized pharmacist to issue `device_replacement_recovery` for a linked patient when a nontrivial text reason is entered.
- The separate OTP/PIN checks exist in draft SQL, but real phone verification, independent recovery authorization, and Admin Auth user provisioning are still **not implemented**.

**Fix:** define and implement an independently verifiable recovery ceremony with audited approvals, secure challenge delivery and explicit restrictions on assigning a new `auth_user_id`. Do not allow an arbitrary pharmacist reason field to substitute for identity verification.

### M1 — Demonstration time mode must be removed or restricted before production (MEDIUM)

- `CrmContext.tsx:125–150` and `AppShell.tsx` retain a `fixed_fixture` clock toggle. It is appropriate for demo/testing, but must not be available in the live clinical CRM, where it could distort refill alerts or dates.

### M2 — Async persistence remains unimplemented (KNOWN ROADMAP ITEM)

- `CrmContext.tsx:194–207` still runs through `InMemoryCrmAdapter` and has an inert `isLoading` state. `IAsyncCrmRepository` is preparation, not a working Supabase persistence integration.

### M3 — Accessibility/UI verification is incomplete (KNOWN QA GATE)

- No real mobile/tablet viewport automation or device-based tests were provided. Static Tailwind checks and TypeScript compilation cannot validate layout, keyboard behavior, QR scanning, or notification delivery.

## Verification limitations

- **File comparison:** performed against the earlier user ZIP. The listed fixes really appear in the source.
- **SQL:** NOT executed against PostgreSQL; no schema creation, constraints or RLS policies were verified by a live database.
- **Node/TypeScript tests:** NOT independently rerun. `npm ci --offline --ignore-scripts` failed with `ENOTCACHED` because package dependencies are unavailable in the environment. Thus the earlier project's "28 passed" is a **reported** result, not an independently reproduced one here.
- **Supabase Auth and SMS OTP:** Edge Functions and end-to-end recovery logic are not present in this export.
- **No secrets** were supplied in source; `.env.example` is a placeholder. The README's Gemini-key setup text looks like a generic AI Studio template and should be corrected when creating the project's own deployment instructions.

## Required tests before Stage 2B authorization

1. Review the corrected SQL in a true diff, without executing on any production instance.
2. Run the two migrations only on a newly created, isolated, disposable **development** Supabase project, after separate owner approval.
3. Execute `supabase/tests/stage2a_negative_security_and_integrity.test.sql` with role switching and real policies, ensuring the transaction rolls back correctly; handle Supabase Auth fixture behavior carefully.
4. Add tests for dose-event provenance and tampered patient reports, including phantom dates/amounts.
5. Confirm extension location and `SECURITY DEFINER` search path; confirm `GRANT` and RLS policies on all intended schemas and tables.
6. Test staff suspension, shared family phones, account recovery, cross-tenant joins and request replay under actual signed-in roles.
7. Retest medication/refill calculation boundaries and mobile usability with fictional records.

## Recommended next action

One focused V1.5.4 static-security/data-integrity correction in Google AI Studio, not a broad rewrite, then an independent review of the actual changes. Do **not** execute migrations or connect a live Supabase instance until approval.
