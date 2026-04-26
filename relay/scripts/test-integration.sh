#!/usr/bin/env bash
#
# Integration test runner. Each file gets its own fresh vitest invocation
# (= fresh Node process). Between files we issue a TRUNCATE via docker exec
# so each file starts with a clean Postgres state.
#
# We do NOT clean state via vitest's `setupFiles` — that approach raced
# against test files' own top-level `tryConnect()` calls and the worker
# pool froze with all 11 workers wedged on connection setup. Truncating
# externally via `docker exec` sidesteps that entirely.
#
# Requires:
#   - RELAY_TEST_DATABASE_URL set
#   - The Postgres container `agentrelay-postgres` to be running
#     (i.e. `docker compose up -d` has been done)

set -euo pipefail

if [[ -z "${RELAY_TEST_DATABASE_URL:-}" ]]; then
  echo "RELAY_TEST_DATABASE_URL must be set to run integration tests." >&2
  echo "Example: RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay" >&2
  exit 1
fi

# Override via env if your container has a different name.
PG_CONTAINER="${RELAY_PG_CONTAINER:-agentrelay-postgres}"
PG_USER="${RELAY_PG_USER:-agentrelay}"
PG_DB="${RELAY_PG_DB:-agentrelay}"

if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "Postgres container '$PG_CONTAINER' is not running." >&2
  echo "Try: docker compose up -d" >&2
  exit 1
fi

truncate_all() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -q -c \
    "TRUNCATE agents, agent_cards, api_keys, handoffs, messages, audit_log, agent_blocks RESTART IDENTITY CASCADE;" \
    >/dev/null 2>&1
}

# Files that hit the database. The remaining test files (config.test.ts,
# errors.test.ts, server.test.ts, auth/keys.test.ts, notifications/crypto.test.ts)
# are pure unit tests and run fine via the regular `test` script.
INTEGRATION_FILES=(
  src/db/schema.test.ts
  src/routes/admin.test.ts
  src/routes/agents.test.ts
  src/routes/a2a.test.ts
  src/routes/blocks.test.ts
  src/routes/me.test.ts
  src/notifications/dispatcher.test.ts
)

failed=()
total_pass=0
total_fail=0

for f in "${INTEGRATION_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    # File doesn't exist at this codebase iteration — skip silently.
    continue
  fi
  truncate_all
  echo "=== $f ==="
  if output=$(./node_modules/.bin/vitest run "$f" 2>&1); then
    pass=$(echo "$output" | grep -E "^ +Tests" | grep -oE "[0-9]+ passed" | grep -oE "[0-9]+" | head -1 || echo 0)
    total_pass=$((total_pass + pass))
    echo "✓ $f — $pass passed"
  else
    fail=$(echo "$output" | grep -E "^ +Tests" | grep -oE "[0-9]+ failed" | grep -oE "[0-9]+" | head -1 || echo "?")
    total_fail=$((total_fail + ${fail//\?/0}))
    failed+=("$f")
    echo "✗ $f — $fail failed"
    echo "$output" | tail -30
  fi
done

echo
echo "=== summary ==="
echo "passed: $total_pass"
echo "failed: $total_fail"
if (( ${#failed[@]} > 0 )); then
  echo "failing files:"
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
