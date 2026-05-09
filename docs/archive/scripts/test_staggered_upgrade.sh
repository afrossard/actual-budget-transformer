#!/usr/bin/env bash
# Test staggered version upgrades for the Actual Budget round-trip path.
#
# Unlike test_version_matrix.sh, this script tests *persisted state* crossing
# the version boundary. A single budget volume is reused across server image
# swaps and api version changes, simulating the real workflow where server
# and api are upgraded at different times.
#
# Two scenarios:
#   server-ahead:  server upgrades first; api catches up later
#   client-ahead:  api upgrades first; server catches up later
#
# Each scenario runs three phases against the same budget volume:
#   p1: both old        — create budget, import N tx
#   p2: one upgraded    — open budget, verify p1 survived, import N more
#   p3: both new        — open budget, verify p1+p2 survived, import N more
#
# The script bypasses the compose `tmpfs:/data` config (which would wipe
# server state on every restart) by running the server via `docker run` with
# a named volume on the compose-managed network.
#
# Per-scenario logs in tmp/staggered/<scenario>.log

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/tmp/staggered"
mkdir -p "$LOG_DIR"

NETWORK="$(docker network ls \
  --filter 'label=com.docker.compose.project=actual-budget-transformer' \
  --format '{{.Name}}' | head -n1)"
if [ -z "$NETWORK" ]; then
  NETWORK="actual-budget-transformer_default"
fi

CONTAINER="actual-server-staggered"
VOLUME="actual-budget-transformer-staggered-data"

V_OLD="${V_OLD:-25.3.1}"
V_NEW="${V_NEW:-26.4.0}"

server_up() {
  local image_tag="$1"
  docker run -d --rm \
    --name "$CONTAINER" \
    --network "$NETWORK" \
    --network-alias actual-server \
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

phase() {
  local label="$1"
  local api_version="$2"
  local prior_names="$3"
  local index="$4"
  local log="$5"

  local data_dir="$PROJECT_DIR/tmp/staggered/api-${api_version}-${label}"
  rm -rf "$data_dir"

  echo "--- phase $label (api=$api_version, server=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo '?')) ---" \
    | tee -a "$log"

  ACTUAL_API_VERSION="$api_version" \
    ACTUAL_DATA_DIR="$data_dir" \
    npx tsx "$PROJECT_DIR/scripts/bootstrap_test_budget.ts" >>"$log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: bootstrap rc=$rc in phase $label" | tee -a "$log"
    return 1
  fi

  ACTUAL_API_VERSION="$api_version" \
    ACTUAL_DATA_DIR="$data_dir" \
    PHASE_NAME="$label" \
    PHASE_PRIOR_NAMES="$prior_names" \
    PHASE_INDEX="$index" \
    npx tsx "$PROJECT_DIR/scripts/staggered_phase.ts" >>"$log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: phase $label rc=$rc" | tee -a "$log"
    return 1
  fi
  return 0
}

run_server_ahead() {
  local log="$1"
  reset_volume

  server_up "$V_OLD" 2>&1 | tee -a "$log"
  wait_for_server || { echo "FAIL: server $V_OLD unreachable" | tee -a "$log"; return 1; }
  phase p1 "$V_OLD" ""      1 "$log" || return 1
  server_down

  server_up "$V_NEW" 2>&1 | tee -a "$log"
  wait_for_server || { echo "FAIL: server $V_NEW unreachable" | tee -a "$log"; return 1; }
  phase p2 "$V_OLD" "p1"    2 "$log" || return 1
  phase p3 "$V_NEW" "p1,p2" 3 "$log" || return 1
  server_down
  return 0
}

run_client_ahead() {
  local log="$1"
  reset_volume

  server_up "$V_OLD" 2>&1 | tee -a "$log"
  wait_for_server || { echo "FAIL: server $V_OLD unreachable" | tee -a "$log"; return 1; }
  phase p1 "$V_OLD" ""      1 "$log" || return 1
  phase p2 "$V_NEW" "p1"    2 "$log" || return 1
  server_down

  server_up "$V_NEW" 2>&1 | tee -a "$log"
  wait_for_server || { echo "FAIL: server $V_NEW unreachable" | tee -a "$log"; return 1; }
  phase p3 "$V_NEW" "p1,p2" 3 "$log" || return 1
  server_down
  return 0
}

run_scenario() {
  local name="$1"
  local log="$LOG_DIR/$name.log"
  : > "$log"
  echo "===== scenario: $name (old=$V_OLD new=$V_NEW) =====" | tee "$log"

  case "$name" in
    server-ahead) run_server_ahead "$log" ;;
    client-ahead) run_client_ahead "$log" ;;
    *) echo "unknown scenario: $name"; return 1 ;;
  esac
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS: $name" | tee -a "$log"
  else
    echo "FAIL: $name" | tee -a "$log"
  fi
  return $rc
}

trap 'server_down' EXIT

results=()
for scenario in server-ahead client-ahead; do
  if run_scenario "$scenario"; then
    results+=("$scenario | PASS")
  else
    results+=("$scenario | FAIL")
  fi
done

server_down
docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true

echo
echo "===== Staggered upgrade results ====="
printf 'scenario     | result\n'
printf '%s\n' "${results[@]}"
echo "Per-scenario logs in: $LOG_DIR"
