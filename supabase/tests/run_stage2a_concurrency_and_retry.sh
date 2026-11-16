#!/usr/bin/env bash
# =============================================================================
# MASAR Care Stage 2A — Executable Two-Session Concurrency & Retry Harness
# =============================================================================
# STATUS: REVIEW-ONLY RUNNER SCRIPT (NOT EXECUTED IN BUILD ENVIRONMENT).
#
# Purpose:
#   Reproducibly exercises `public.confirm_scheduled_dose(uuid, text, uuid, text)`
#   under genuine simultaneous two-session PostgreSQL Read Committed execution:
#     - Case A: Same scheduled_dose_id + SAME client_event_uuid
#     - Case B: Same scheduled_dose_id + DIFFERENT client_event_uuids
#     - Case C: Different scheduled_dose_ids + SAME client_event_uuid
#
# CRITICAL SAFETY NOTICE:
#   Database names or hostnames ALONE can NEVER prove a target is non-production.
#   Running this script requires ALL of:
#     1. Explicit owner approval to target a dedicated disposable dev database
#        containing fictional records ONLY.
#     2. DEV_DATABASE_URL set (and not matching PRODUCTION_DATABASE_URL / DATABASE_URL).
#     3. MASAR_DISPOSABLE_DEV_APPROVED="I_CONFIRM_DISPOSABLE_DEV_DB_NO_REAL_PATIENT_DATA"
#     4. MASAR_EXPECTED_DB_NAME="<verified_disposable_db_name>"
#     5. MASAR_EXPECTED_DB_HOST="<verified_disposable_db_host>"
#     6. Destroying or resetting the disposable database after the run (because
#        immutable audit/regimen_versions triggers forbid DELETE cleanup).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/stage2a_concurrency_and_retry.test.sql"

fail() {
  echo "FATAL [MASAR Concurrency Harness]: $*" >&2
  exit 1
}

# 1. Preconditions: binaries, files, and non-production guards
command -v psql >/dev/null 2>&1 || fail "'psql' CLI is required on PATH."
[ -f "$SQL_FILE" ] || fail "Missing SQL fixture/verifier file: $SQL_FILE"

if [ "${NODE_ENV:-}" = "production" ] || [ "${SUPABASE_ENV:-}" = "production" ] || [ "${MASAR_ENV:-}" = "production" ]; then
  fail "Refusing to run while NODE_ENV/SUPABASE_ENV/MASAR_ENV is set to 'production'."
fi

[ -n "${DEV_DATABASE_URL:-}" ] || fail "DEV_DATABASE_URL must be set to an authorized disposable development database URL."

if [ -n "${PRODUCTION_DATABASE_URL:-}" ] && [ "$DEV_DATABASE_URL" = "$PRODUCTION_DATABASE_URL" ]; then
  fail "DEV_DATABASE_URL matches PRODUCTION_DATABASE_URL. Aborting."
fi

if [ -n "${DATABASE_URL:-}" ] && [ "$DEV_DATABASE_URL" = "$DATABASE_URL" ]; then
  fail "DEV_DATABASE_URL matches ambient DATABASE_URL. Use a dedicated disposable test connection string."
fi

REQUIRED_APPROVAL="I_CONFIRM_DISPOSABLE_DEV_DB_NO_REAL_PATIENT_DATA"
if [ "${MASAR_DISPOSABLE_DEV_APPROVED:-}" != "$REQUIRED_APPROVAL" ]; then
  fail "Explicit disposable-dev confirmation required. Set MASAR_DISPOSABLE_DEV_APPROVED=\"$REQUIRED_APPROVAL\"."
fi

[ -n "${MASAR_EXPECTED_DB_NAME:-}" ] || fail "MASAR_EXPECTED_DB_NAME must be set to the verified target database name."
[ -n "${MASAR_EXPECTED_DB_HOST:-}" ] || fail "MASAR_EXPECTED_DB_HOST must be set to the verified target database host."

# Extract host (supports postgresql://user:pass@host:port/db or host=...) for explicit identity check
PARSED_HOST="$(printf '%s' "$DEV_DATABASE_URL" | sed -nE 's#^[a-zA-Z0-9+.-]+://([^/@]+@)?([^:/?]+).*#\2#p')"
[ -n "$PARSED_HOST" ] || fail "Could not parse database host from DEV_DATABASE_URL; supply a standard postgres:// URI."
if [ "$PARSED_HOST" != "$MASAR_EXPECTED_DB_HOST" ]; then
  fail "Parsed host '$PARSED_HOST' does not match MASAR_EXPECTED_DB_HOST='$MASAR_EXPECTED_DB_HOST'."
fi

# Verify actual connected database name and refuse if target reports unexpected DB identity
ACTUAL_DB_NAME="$(psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -t -A -c "SELECT current_database();")" \
  || fail "Failed connecting to DEV_DATABASE_URL to inspect current_database()."

if [ "$ACTUAL_DB_NAME" != "$MASAR_EXPECTED_DB_NAME" ]; then
  fail "Connected database '$ACTUAL_DB_NAME' does not match MASAR_EXPECTED_DB_NAME='$MASAR_EXPECTED_DB_NAME'."
fi

echo "==> Target disposable DB verified: host=$PARSED_HOST db=$ACTUAL_DB_NAME"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 2. Phase 1: Seed schema-aligned fictional fixture (fails loudly if dirty or unmigrated)
echo "==> Phase 1: Seeding schema-aligned fictional concurrency fixtures..."
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v run_seed=1 -f "$SQL_FILE"

PATIENT_UID="c0c00002-1111-4111-8111-111111111111"
CLAIMS_JSON='{"sub":"c0c00002-1111-4111-8111-111111111111","role":"authenticated"}'

# Launches two separate psql processes synchronized on a PostgreSQL clock_timestamp() barrier.
run_two_workers() {
  local case_label="$1"
  local sd_1="$2"
  local status_1="$3"
  local uuid_1="$4"
  local note_1="$5"
  local sd_2="$6"
  local status_2="$7"
  local uuid_2="$8"
  local note_2="$9"

  local barrier_ts
  barrier_ts="$(psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -t -A -c "SELECT (clock_timestamp() + interval '500 milliseconds')::text;")" \
    || fail "[$case_label] Failed to compute PostgreSQL synchronization barrier timestamp."

  local w1_sql="$TMP_DIR/${case_label}_w1.sql"
  local w2_sql="$TMP_DIR/${case_label}_w2.sql"
  local w1_out="$TMP_DIR/${case_label}_w1.out"
  local w2_out="$TMP_DIR/${case_label}_w2.out"
  local w1_err="$TMP_DIR/${case_label}_w1.err"
  local w2_err="$TMP_DIR/${case_label}_w2.err"

  cat > "$w1_sql" <<EOF
BEGIN;
SELECT set_config('request.jwt.claim.sub', '$PATIENT_UID', true);
SELECT set_config('request.jwt.claims', '$CLAIMS_JSON', true);
SET LOCAL ROLE authenticated;
DO \$\$
BEGIN
  PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ('$barrier_ts'::timestamptz - clock_timestamp()))));
END \$\$;
SELECT public.confirm_scheduled_dose(
  '$sd_1'::uuid,
  '$status_1',
  '$uuid_1'::uuid,
  '$note_1'
)::text;
COMMIT;
EOF

  cat > "$w2_sql" <<EOF
BEGIN;
SELECT set_config('request.jwt.claim.sub', '$PATIENT_UID', true);
SELECT set_config('request.jwt.claims', '$CLAIMS_JSON', true);
SET LOCAL ROLE authenticated;
DO \$\$
BEGIN
  PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ('$barrier_ts'::timestamptz - clock_timestamp()))));
END \$\$;
SELECT public.confirm_scheduled_dose(
  '$sd_2'::uuid,
  '$status_2',
  '$uuid_2'::uuid,
  '$note_2'
)::text;
COMMIT;
EOF

  psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -t -A -f "$w1_sql" >"$w1_out" 2>"$w1_err" &
  local pid1=$!
  psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -t -A -f "$w2_sql" >"$w2_out" 2>"$w2_err" &
  local pid2=$!

  local rc1=0
  local rc2=0
  wait "$pid1" || rc1=$?
  wait "$pid2" || rc2=$?

  echo "    [$case_label] worker1 rc=$rc1 payload=$(tr -d '\r\n' < "$w1_out")"
  echo "    [$case_label] worker2 rc=$rc2 payload=$(tr -d '\r\n' < "$w2_out")"

  if [ "$rc1" -ne 0 ] || [ -s "$w1_err" ]; then
    fail "[$case_label] Worker 1 failed (rc=$rc1): $(cat "$w1_err")"
  fi
  if [ "$rc2" -ne 0 ] || [ -s "$w2_err" ]; then
    fail "[$case_label] Worker 2 failed (rc=$rc2): $(cat "$w2_err")"
  fi

  local json1 json2
  json1="$(grep -E '^\s*\{.*\}\s*$' "$w1_out" | tail -n 1 || true)"
  json2="$(grep -E '^\s*\{.*\}\s*$' "$w2_out" | tail -n 1 || true)"

  [ -n "$json1" ] || fail "[$case_label] Worker 1 produced missing or non-JSON output: $(cat "$w1_out")"
  [ -n "$json2" ] || fail "[$case_label] Worker 2 produced missing or non-JSON output: $(cat "$w2_out")"

  printf '%s\n%s\n' "$json1" "$json2" > "$TMP_DIR/${case_label}_pair.json"
}

assert_case_a_payloads() {
  local j1 j2
  j1="$(sed -n '1p' "$TMP_DIR/case_a_pair.json")"
  j2="$(sed -n '2p' "$TMP_DIR/case_a_pair.json")"

  psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v w1="$j1" -v w2="$j2" <<'SQL'
SELECT set_config('masar.w1', :'w1', false), set_config('masar.w2', :'w2', false);
DO $$
DECLARE
  v_w1 jsonb := current_setting('masar.w1')::jsonb;
  v_w2 jsonb := current_setting('masar.w2')::jsonb;
  v_winners integer := 0;
  v_replays integer := 0;
BEGIN
  IF (v_w1->>'ok')::boolean IS DISTINCT FROM true OR (v_w2->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CASE A FAILED: Both parallel workers must return ok=true. w1=%, w2=%', v_w1, v_w2;
  END IF;

  IF (v_w1->>'doseEventId') IS NULL OR (v_w1->>'doseEventId') IS DISTINCT FROM (v_w2->>'doseEventId') THEN
    RAISE EXCEPTION 'CASE A FAILED: Both workers must reference identical doseEventId. w1=%, w2=%', v_w1, v_w2;
  END IF;

  IF (v_w1->>'idempotentReplay')::boolean = false THEN v_winners := v_winners + 1; ELSE v_replays := v_replays + 1; END IF;
  IF (v_w2->>'idempotentReplay')::boolean = false THEN v_winners := v_winners + 1; ELSE v_replays := v_replays + 1; END IF;

  IF v_winners <> 1 OR v_replays <> 1 THEN
    RAISE EXCEPTION 'CASE A FAILED: Expected exactly 1 fresh write and 1 idempotentReplay=true. w1=%, w2=%', v_w1, v_w2;
  END IF;
END $$;
SQL
}

assert_case_b_payloads() {
  local j1 j2
  j1="$(sed -n '1p' "$TMP_DIR/case_b_pair.json")"
  j2="$(sed -n '2p' "$TMP_DIR/case_b_pair.json")"

  psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v w1="$j1" -v w2="$j2" <<'SQL'
SELECT set_config('masar.w1', :'w1', false), set_config('masar.w2', :'w2', false);
DO $$
DECLARE
  v_w1 jsonb := current_setting('masar.w1')::jsonb;
  v_w2 jsonb := current_setting('masar.w2')::jsonb;
  v_winner jsonb;
  v_loser  jsonb;
BEGIN
  IF (v_w1->>'ok')::boolean = true AND (v_w2->>'ok')::boolean = false THEN
    v_winner := v_w1; v_loser := v_w2;
  ELSIF (v_w2->>'ok')::boolean = true AND (v_w1->>'ok')::boolean = false THEN
    v_winner := v_w2; v_loser := v_w1;
  ELSE
    RAISE EXCEPTION 'CASE B FAILED: Expected exactly 1 ok=true winner and 1 ok=false loser. w1=%, w2=%', v_w1, v_w2;
  END IF;

  IF (v_winner->>'idempotentReplay')::boolean IS DISTINCT FROM false
     OR (v_loser->>'errorCode') <> 'DUPLICATE_DOSE_CONFIRMATION_BLOCKED'
     OR (v_loser->>'existingDoseEventId') IS DISTINCT FROM (v_winner->>'doseEventId')
  THEN
    RAISE EXCEPTION 'CASE B FAILED: Winner/loser mismatch. winner=%, loser=%', v_winner, v_loser;
  END IF;
END $$;
SQL
}

assert_case_c_payloads() {
  local j1 j2
  j1="$(sed -n '1p' "$TMP_DIR/case_c_pair.json")"
  j2="$(sed -n '2p' "$TMP_DIR/case_c_pair.json")"

  psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v w1="$j1" -v w2="$j2" <<'SQL'
SELECT set_config('masar.w1', :'w1', false), set_config('masar.w2', :'w2', false);
DO $$
DECLARE
  v_w1 jsonb := current_setting('masar.w1')::jsonb;
  v_w2 jsonb := current_setting('masar.w2')::jsonb;
  v_winner jsonb;
  v_loser  jsonb;
BEGIN
  IF (v_w1->>'ok')::boolean = true AND (v_w2->>'ok')::boolean = false THEN
    v_winner := v_w1; v_loser := v_w2;
  ELSIF (v_w2->>'ok')::boolean = true AND (v_w1->>'ok')::boolean = false THEN
    v_winner := v_w2; v_loser := v_w1;
  ELSE
    RAISE EXCEPTION 'CASE C FAILED: Expected exactly 1 ok=true winner and 1 ok=false loser. w1=%, w2=%', v_w1, v_w2;
  END IF;

  IF (v_winner->>'idempotentReplay')::boolean IS DISTINCT FROM false
     OR (v_loser->>'errorCode') <> 'CLIENT_EVENT_UUID_CONFLICT'
  THEN
    RAISE EXCEPTION 'CASE C FAILED: Expected CLIENT_EVENT_UUID_CONFLICT on loser. winner=%, loser=%', v_winner, v_loser;
  END IF;
END $$;
SQL
}

# 3. Execute parallel cases
echo "==> Running Case A: Same scheduled_dose_id + SAME client_event_uuid..."
run_two_workers "case_a" \
  "c4444444-1111-4111-8111-00000000000a" "taken" "c9990001-1111-4111-8111-111111111111" "Case A Worker 1" \
  "c4444444-1111-4111-8111-00000000000a" "taken" "c9990001-1111-4111-8111-111111111111" "Case A Worker 2"
assert_case_a_payloads

echo "==> Running Case B: Same scheduled_dose_id + DIFFERENT client_event_uuids..."
run_two_workers "case_b" \
  "c4444444-1111-4111-8111-00000000000b" "taken"   "c9990002-1111-4111-8111-111111111111" "Case B Worker 1" \
  "c4444444-1111-4111-8111-00000000000b" "delayed" "c9990003-1111-4111-8111-111111111111" "Case B Worker 2"
assert_case_b_payloads

echo "==> Running Case C: Different scheduled_dose_ids + SAME client_event_uuid..."
run_two_workers "case_c" \
  "c4444444-1111-4111-8111-00000000000c" "taken" "c9990004-1111-4111-8111-111111111111" "Case C Worker 1" \
  "c4444444-1111-4111-8111-00000000000d" "taken" "c9990004-1111-4111-8111-111111111111" "Case C Worker 2"
assert_case_c_payloads

# 4. Phase 2: Post-Race Strict Database Invariants
echo "==> Phase 2: Verifying committed database state..."
psql "$DEV_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v run_verify=1 -f "$SQL_FILE"

echo "PASS: Two-session concurrency harness succeeded for Cases A, B, and C."
echo "NEXT STEP: Destroy or reset this disposable development database cleanly (immutable ledgers cannot be deleted via DELETE)."
