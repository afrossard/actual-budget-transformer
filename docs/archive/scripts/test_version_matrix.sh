#!/usr/bin/env bash
# Run the Actual round-trip smoke test across a matrix of (client, server)
# version pairs and report pass/fail per cell.
#
# Each pair:
#   - starts actual-server with image tag $server
#   - waits for the server to be reachable
#   - bootstraps the test budget against it (idempotent)
#   - runs `npm run test:actual` with @actual-app/api pinned to $client
#   - tears the server back down
#
# Client versions must already be installed as npm aliases in package.json
# (e.g. `@actual-app/api-26-4-0`). Server versions are docker image tags.
#
# Usage:
#   ./scripts/test_version_matrix.sh                    # run the default matrix
#   ./scripts/test_version_matrix.sh 25.3.1:25.3.1 26.4.0:25.3.1   # explicit pairs
#
# Output: a summary table written to stdout. Per-pair logs are saved to
# tmp/version-matrix/<client>_<server>.log

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/tmp/version-matrix"
mkdir -p "$LOG_DIR"

COMPOSE_FILE="$PROJECT_DIR/.devcontainer/docker-compose.yml"

DEFAULT_PAIRS=(
  "25.3.1:25.3.1"   # baseline
  "25.3.1:26.4.0"   # client older than server
  "26.4.0:25.3.1"   # client newer than server
  "26.4.0:26.4.0"   # both at latest
)

if [ "$#" -gt 0 ]; then
  PAIRS=("$@")
else
  PAIRS=("${DEFAULT_PAIRS[@]}")
fi

results=()

server_up() {
  local version="$1"
  ACTUAL_SERVER_VERSION="$version" docker compose -f "$COMPOSE_FILE" \
    --profile actual up -d actual-server >/dev/null
}

server_down() {
  docker compose -f "$COMPOSE_FILE" --profile actual stop actual-server >/dev/null
  # Remove the container so the next `up` recreates with the new image tag
  docker compose -f "$COMPOSE_FILE" --profile actual rm -f actual-server >/dev/null
}

wait_for_server() {
  for i in $(seq 1 60); do
    if curl -sf http://actual-server:5006/account/needs-bootstrap >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_pair() {
  local client="$1"
  local server="$2"
  local log="$LOG_DIR/${client}_${server}.log"

  echo "=== client=$client server=$server ===" | tee "$log"

  server_up "$server" 2>&1 | tee -a "$log"
  if ! wait_for_server 2>&1 | tee -a "$log"; then
    echo "FAIL: server $server did not become reachable" | tee -a "$log"
    server_down 2>&1 | tee -a "$log" || true
    results+=("$client | $server | FAIL (server unreachable)")
    return
  fi

  # Bootstrap with the matching client (we use the *client* under test for
  # bootstrap too — that exercises createAccount/runImport for that pin).
  # Wipe the per-pair data dir: the actual-server container uses tmpfs for
  # /data, so each pair gets a fresh server. The local API cache must match
  # or downloadBudget will 404 on a budget the server no longer has.
  rm -rf "$PROJECT_DIR/tmp/actual-data-$client-$server"
  ACTUAL_API_VERSION="$client" \
    ACTUAL_DATA_DIR="$PROJECT_DIR/tmp/actual-data-$client-$server" \
    npx tsx "$PROJECT_DIR/scripts/bootstrap_test_budget.ts" >>"$log" 2>&1
  local bootstrap_rc=$?
  if [ "$bootstrap_rc" -ne 0 ]; then
    echo "FAIL: bootstrap exited $bootstrap_rc" | tee -a "$log"
    server_down 2>&1 | tee -a "$log" || true
    results+=("$client | $server | FAIL (bootstrap rc=$bootstrap_rc)")
    return
  fi

  ACTUAL_API_VERSION="$client" \
    npx tsx --test "$PROJECT_DIR/tests/actual/"*.test.ts >>"$log" 2>&1
  local test_rc=$?

  server_down 2>&1 | tee -a "$log" || true

  if [ "$test_rc" -eq 0 ]; then
    results+=("$client | $server | PASS")
  else
    results+=("$client | $server | FAIL (test rc=$test_rc)")
  fi
}

for pair in "${PAIRS[@]}"; do
  client="${pair%%:*}"
  server="${pair##*:}"
  run_pair "$client" "$server"
done

echo
echo "===== Matrix results ====="
printf 'client | server | result\n'
printf '%s\n' "${results[@]}"
echo "Per-pair logs in: $LOG_DIR"
