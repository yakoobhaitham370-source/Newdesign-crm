# MASAR Care — Chronic Patient Pharmacy CRM (Stage 1 Prototype + Stage 2A/2B SQL & Edge Design)

MASAR Care is an Arabic-first (RTL) and English-second (LTR) chronic patient management and medication adherence platform designed for community pharmacies in Iraq (`Asia/Baghdad`, UTC+3).

## Current Scope (V1.5.5-Stage2B.2A.3)
- **Stage 1 Pharmacist CRM Prototype (Demo Mode — Default Active)**: Working, navigable React + TypeScript application backed by an in-memory repository (`InMemoryCrmAdapter`) and fictional demonstration records. **`VITE_ENABLE_SUPABASE_CRM` defaults to `"false"` so Demo Mode remains active with zero live Supabase network activity.**
- **Stage 2A PostgreSQL/Supabase Schema & Verification (Clean Dev DB Ready)**: Normalized multi-tenant Option B database design (`supabase/migrations/0001_stage2a_core_schema.sql`, `0002_stage2a_rls_and_security.sql`), role-switched negative security tests, and two-session concurrency tests were executed and cleaned on disposable development project `bkidngfzsubmyunacnju` (PostgreSQL 17.11); see `docs/STAGE2A_DATABASE_TEST_RESULTS.md`.
- **Stage 2B.2A – 2B.2A.3 Backend Release Patch (Completed Offline, Connected Mode OFF)**: Hardened review-only Migration `0003` (`supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql` — bringing protected `public` tables to **24**, locking `consultation_messages` approval provenance with `chk_consultation_messages_patient_unapproved`, binding staff provisioning `Idempotency-Key`s to immutable canonical fingerprints with conservative TTL recovery & mandatory claim IDs, closing direct-write bypasses while keeping `0001`/`0002` untouched, and eliminating the `skip_thread_audit_trigger` GUC bypass), `supabase/config.toml` + `supabase/.env.example` + strict `MASAR_CORS_ALLOWED_ORIGINS` allowlist on `owner-provision-staff`, PG17-compatible clean-state & post-bootstrap SQL test drafts (`supabase/tests/stage2b_0003_bootstrap_clean_state.test.sql`, `supabase/tests/stage2b_0003_negative_and_integrity.test.sql`), and 10 offline verification suites (`npm test`). Connected Mode remains **OFF** and `bkidngfzsubmyunacnju` untouched pending two-checkpoint Stage 2B.2B approval; see `docs/STAGE2B2A3_RELEASE_READINESS.md` and `docs/STAGE2B2A_DATABASE_APPROVAL_PLAN.md`.

## Planned Mobile Rollout Order (Shared Supabase Backend)
1. **Pharmacist Web CRM** (React + TypeScript — active).
2. **Patient Android App** (native Kotlin + Jetpack Compose APK — gated on pre-Android `public.scheduled_doses` server materialization).
3. **Patient iPhone Experience** (Progressive Web App / PWA).
4. **Optional Native iOS App** (evaluated later).

## Local Development & Verification

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## Environment Variables & Production Boundary
- No AI/LLM API keys (such as `GEMINI_API_KEY`) are required or used by MASAR Care.
- **Demo Mode vs. Connected Mode:** `VITE_ENABLE_SUPABASE_CRM="false"` keeps the CRM in Stage 1 Demo Mode. Setting `"true"` activates `PharmacistLoginScreen` and `SupabaseCrmRepository`, requiring `VITE_SUPABASE_URL` and a browser-safe `VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_secret_*` and `service_role` JWTs are actively blocked).
- **Clock Mode:** Fixed demonstration fixture date mode (`2026-11-12`) is strictly restricted to local `vite dev` (`import.meta.env.DEV === true`) in Demo Mode. Production builds (`vite build`) and Connected Mode enforce live `Asia/Baghdad` time unconditionally. (`VITE_DISABLE_DEMO_CLOCK="true"` optionally disables the toggle even in `vite dev`.)
- **Connected Mode Boundary:** When `VITE_ENABLE_SUPABASE_CRM="true"`, Demo controls (`setActiveStaffId` switcher, `Reset Demo Data`, fixture clock toggle) are removed from `AppShell.tsx` and operator identity derives strictly from `auth.uid()` -> `public.pharmacy_staff`.
