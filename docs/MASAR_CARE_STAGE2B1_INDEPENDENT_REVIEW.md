# MASAR Care — Independent Stage 2B.1 Source Review

**Reviewed upload:** `masar-care(1).zip` (88 ZIP entries; integrity confirmed).  **Scope:** Static source review only. No Supabase connection, SQL execution, Auth account creation, or application deployment.

## Verdict

The code preparation is real: the ZIP contains `@supabase/supabase-js`, `supabaseClient.ts`, `authService.ts`, `PharmacistLoginScreen.tsx`, `supabaseCrmRepository.ts`, the Connected-Mode gate, and `stage2b1Preparation.test.ts`. The configured demo/connected boundary is sensible. Do **not** enable connected mode or provision accounts until the high-priority issues below are addressed and actual authenticated integration tests are planned.

## Verified positive findings

- `src/services/supabaseClient.ts:99-104, 109-149, 154-189` — Connected Mode requires explicit flag and valid URL/key configuration; browser secret/service-role checks are implemented. `.env.example` defaults to disabled.
- `src/services/authService.ts:124-234` — Staff and pharmacy membership is resolved from database rows rather than user-editable metadata. `src/App.tsx:51-141` gates the CRM workspace.
- `src/services/supabaseCrmRepository.ts:45-69` — Explicit invitation SELECT projection omits credential hashes; `:223-233` forbids demo reset/staff switching; `:778-804` avoids protected patient UPDATE columns.
- `src/context/CrmContext.tsx:252-310, 337-410, 494-526` — No automatic fallback from failed Connected Mode to demo records, and demo-only mutation controls are blocked.
- The two existing SQL migrations are present; `docs/STAGE2B1_IMPLEMENTATION_REPORT.md` and `docs/MASAR_CARE_HANDOFF.md` record the stage boundary.

## Confirmed issues requiring correction or containment

### High — Clinical writes can partially commit

Several logically single operations use independent PostgREST requests with no encompassing transaction:
- `supabaseCrmRepository.ts:705-775`: patient creation, conditions, and allergies;
- `:935-984`: medication plan plus initial regimen version;
- `:1029-1081`: close old regimen, insert new version, update plan (already documented as a future dependency but **currently performs writes**);
- `:1095-1152`: pause/resume record plus plan status;
- `:1182-1236`: dispensing event plus refill assessment;
- `:1339-1362`: consultation reply plus thread update.

A failure halfway can leave clinical state inconsistent. **Do not present these flows as safe for Connected Mode.** Use atomic, role-authorized server-side transactional RPCs or explicitly disable affected operations until tested. Avoid compensating deletes of immutable clinical ledgers.

### High — Asynchronous authentication can apply stale state after sign-out

`CrmContext.tsx:319-334, 351-405, 436-481`: initial restoration, auth change subscription, manual login, and `loadConnectedState` can overlap without operation-generation checks. A stale request might set `authenticated` state or restore data after logout/account switch. Cancel or discard outdated results by comparing current session/user and a monotonic generation; clear sensitive in-memory data on logout and unauthorized transitions. Add tests for delayed responses and rapid sign-out/sign-in.

### High — Unauthorized restored sessions are not consistently signed out

`authService.ts:267-272` signs out unauthorized new login attempts; `:277-300` restores a session and returns denial without sign-out. The `CrmContext.tsx:367-381` branch clears the workspace but leaves the underlying Auth session, showing an optional Sign Out button. This contradicts the handoff claim that unlinked/inactive accounts are immediately signed out. Preserve an appropriate retry path for transient DB errors, but sign out deterministically for genuine authorization rejection and test it.

### Medium — Full-state hydration has no pagination

`supabaseCrmRepository.ts:235-360` issues 17 parallel full-table queries without `.range()`/pagination, targeted filters, or a row-count check. Supabase's default API maximum rows can cause silent truncated clinical datasets as a pharmacy grows. Design paginated views and an explicit server-side query strategy before scaled use; tests should cover >1,000 records.

### Medium — Supabase client cache signature does not distinguish publishable-key rotation

`supabaseClient.ts:169-171` caches on `${url}::${key.slice(0, 14)}`. Modern publishable keys share the same first 14 characters. A rotated key can incorrectly reuse an existing client during hot reload or tests. Compare full configuration in-memory (without printing it), or reconstruct the client on a controlled config change.

### Medium — Planned revocation RPC signature and caller differ

`supabaseCrmRepository.ts:71-75` declares `revoke_patient_apk_invitation(p_patient_id uuid, p_reason text)`, but `:1434-1437` calls with only `p_patient_id`. Choose a consistent signature with a server-validated reason or a documented default before creating migration 0003.

### Medium — Patient invitation UI is not activation-ready

`src/components/ui/QrPreview.tsx:9-43` draws a deterministic visual mock, not a standards-compliant scannable QR. `supabaseCrmRepository.ts:1418-1429` stores single-use token and PIN in React state; on-screen handling should clear sensitive credentials after first handover/closure and avoid misleading previews. Keep Connected Mode patient activation controls disabled until real OTP/Edge Functions, scannable QR, and identity verification exist.

### Low — Public/redundant build assets

`public/assets/aistudio/MASAR_Security_Test_V2_0c73a195.txt` would be served publicly as a static asset, and `exports/MASAR_CARE_V1.5.4.zip` is an obsolete nested export. Keep the canonical test under `supabase/tests`; remove redundant public copies/exports after preserving external backups.

## Tests and verification limits

- The user's Google AI Studio report states `npm test`, TypeScript and Vite build **PASS**. That result was not independently reproduced here.
- Independent offline `npm ci --offline --ignore-scripts --no-audit --no-fund` **could not install dependencies**, returning `ENOTCACHED` for `@supabase/supabase-js`; consequently `npm test`, `npm run lint`, and `npm run build` could not be run in this container.
- No live Auth session, real RLS workflow, Edge Function, or connected repository operation was tested. The earlier Stage 2A SQL/RLS/concurrency tests are distinct from Stage 2B application acceptance tests.

## Next gate (recommended)

One focused **Stage 2B.1.1 QA hardening** pass, then prepare first-owner bootstrap/privileged provisioning and 0003 RPCs as **review-only designs**. No database changes, users, Edge Functions, deployment, or connected-mode activation until separately approved. Focus next live test on one initial owner in disposable development, then two-pharmacy real JWT/RLS and fictional patient create/reload workflows.
