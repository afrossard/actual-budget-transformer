#!/usr/bin/env bash
# Server-ahead skew assessment.
#
# Mirrors plan-direct-actual-import.md "Server-ahead assessment methodology":
#   1. baseline   V_OLD server, V_OLD API, fresh dataDir; bootstrap + seed.
#   2. server upgrade  swap server image V_OLD -> V_NEW on the same volume.
#   3. warm       V_NEW server, V_OLD API, retained dataDir; sync deltas across
#                 the migration boundary; import warm batch; assertions.
#   4. cold       V_NEW server, V_OLD API, wiped dataDir; downloadBudget
#                 refetches; import cold batch; assertions.
#
# Browser cross-check is manual: at the end the V_NEW server is left running
# with port 5006 published so the user can open the budget in a private window
# and verify the imported transactions and account balance.
#
# Run:
#   ./scripts/test_server_ahead_assessment.sh
#   ./scripts/test_server_ahead_assessment.sh teardown    # cleanup after browser check
#
# Logs in tmp/server-ahead/<phase>.log

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/tmp/server-ahead"
DATA_DIR="$LOG_DIR/api-data"
mkdir -p "$LOG_DIR"

NETWORK="$(docker network ls \
  --filter 'label=com.docker.compose.project=actual-budget-transformer' \
  --format '{{.Name}}' | head -n1)"
if [ -z "$NETWORK" ]; then
  NETWORK="actual-budget-transformer_default"
fi

CONTAINER="actual-server-skewtest"
VOLUME="actual-budget-transformer-skewtest-data"

V_OLD="${V_OLD:-25.3.1}"
V_NEW="${V_NEW:-26.4.0}"

server_up() {
  local image_tag="$1"
  docker run -d --rm \
    --name "$CONTAINER" \
    --network "$NETWORK" \
    --network-alias actual-server \
    -p 5006:5006 \
    -v "$VOLUME:/data" \
    "actualbudget/actual-server:$image_tag" >/dev/null
}

server_down() {
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
}

wait_for_server() {
  for _ in $(seq 1 60); do
    if curl -sf "http://actual-server:5006/account/needs-bootstrap" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

reset_volume() {
  server_down
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker volume create "$VOLUME" >/dev/null
}

teardown() {
  server_down
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
  echo "Teardown complete."
}

if [ "${1:-}" = "teardown" ]; then
  teardown
  exit 0
fi

# Sanity: the compose actual-server (port 5006) must not also be running.
if docker ps --format '{{.Names}}' | grep -qx 'actual-budget-transformer-actual-server-1'; then
  echo "ERROR: compose 'actual-server' is running and would conflict on port 5006."
  echo "Run 'actual-down' first."
  exit 1
fi

run_phase() {
  local phase="$1"
  local log="$LOG_DIR/$phase.log"
  : > "$log"
  echo "----- phase: $phase -----" | tee -a "$log"
  ACTUAL_API_VERSION="$V_OLD" \
    ACTUAL_DATA_DIR="$DATA_DIR" \
    PHASE_MODE="$phase" \
    COLD_EXPECT_WARM="${COLD_EXPECT_WARM:-0}" \
    npx tsx "$PROJECT_DIR/scripts/server_ahead_phase.ts" 2>&1 | tee -a "$log"
  return "${PIPESTATUS[0]}"
}

echo "===== Server-ahead assessment (V_OLD=$V_OLD V_NEW=$V_NEW) ====="
echo

# --- Setup: fresh volume + fresh dataDir ---
reset_volume
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

# --- Phase 1: baseline (V_OLD server, V_OLD API) ---
server_up "$V_OLD"
wait_for_server || { echo "FAIL: server $V_OLD unreachable"; teardown; exit 1; }
echo "[setup] V_OLD=$V_OLD server up; bootstrapping budget..."
ACTUAL_API_VERSION="$V_OLD" \
  ACTUAL_DATA_DIR="$DATA_DIR" \
  npx tsx "$PROJECT_DIR/scripts/bootstrap_test_budget.ts" 2>&1 | tee "$LOG_DIR/bootstrap.log"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  echo "FAIL: bootstrap"; teardown; exit 1
fi

run_phase baseline
baseline_rc=$?
if [ "$baseline_rc" -ne 0 ]; then
  echo "FAIL: baseline phase rc=$baseline_rc — aborting (no point continuing)."
  teardown
  exit 1
fi

# --- Server upgrade: V_OLD -> V_NEW on same volume ---
echo
echo "[setup] Upgrading server $V_OLD -> $V_NEW (same volume) ..."
server_down
server_up "$V_NEW"
wait_for_server || { echo "FAIL: server $V_NEW unreachable"; teardown; exit 1; }
SERVER_VERSION="$(curl -sf http://actual-server:5006/info \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["build"]["version"])' 2>/dev/null || echo '?')"
echo "[setup] V_NEW server reports version: $SERVER_VERSION"

# --- Phase 2: warm (data dir retained from baseline) ---
run_phase warm
warm_rc=$?

# --- Phase 3: cold (wipe data dir, force fresh downloadBudget) ---
echo
echo "[setup] Wiping ACTUAL_DATA_DIR for cold phase..."
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

# If warm passed, the warm batch is on the server and cold should expect it.
if [ "$warm_rc" -eq 0 ]; then
  COLD_EXPECT_WARM=1 run_phase cold
else
  COLD_EXPECT_WARM=0 run_phase cold
fi
cold_rc=$?

# --- Summary ---
result_for() {
  if [ "$1" -eq 0 ]; then echo "PASS"; else echo "FAIL (rc=$1)"; fi
}

echo
echo "===== Server-ahead assessment results ====="
echo "V_OLD=$V_OLD  V_NEW=$V_NEW (server reports: $SERVER_VERSION)"
echo "  baseline: PASS (gate)"
echo "  warm:     $(result_for "$warm_rc")"
echo "  cold:     $(result_for "$cold_rc")"
echo "Per-phase logs in: $LOG_DIR"
echo

# --- Browser cross-check instructions ---
cat <<EOF
===== Browser cross-check (manual) =====
The V_NEW server is still running and published on port 5006.

1. Open http://localhost:5006 in a *private/incognito window* (forces fresh
   bundle download — V_NEW SPA from V_NEW server).
2. Verify the page loads without "Please update Actual!".
3. Login with password: test-password
4. Open "Test Budget" -> "Test Checking".
5. Verify exactly 9 transactions visible (3 seed, 3 warm, 3 cold) with the
   imported_id values seed-1..3, warm-1..3, cold-1..3.
6. Verify the account balance matches the API readback above
   (cents: $((-2599 -12345 +250000 -3499 -7800 +250000 -4200 -9999 +250000))).
7. Click around (sidebar, monthly view) — confirm no rendering errors.

When done:
  ./scripts/test_server_ahead_assessment.sh teardown

Outcome interpretation:
  - All API phases PASS + browser OK -> V_OLD API fully compatible with V_NEW server.
  - warm FAIL, cold PASS                -> mitigation: wipe ACTUAL_DATA_DIR after upgrade.
  - cold FAIL                           -> V_OLD API cannot talk to V_NEW server; bump in lockstep.
  - browser shows wrong balance/missing tx -> warm-cache silent divergence; treat as warm FAIL.
EOF

# Exit code summarises the API phases. Browser is informational.
if [ "$warm_rc" -ne 0 ] || [ "$cold_rc" -ne 0 ]; then
  exit 1
fi
exit 0
