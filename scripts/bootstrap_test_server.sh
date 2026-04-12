#!/usr/bin/env bash
# Bootstrap the Actual Budget test server.
# Idempotent — safe to run multiple times.
#
# Usage:
#   ./scripts/bootstrap_test_server.sh
#
# Environment (all optional):
#   ACTUAL_SERVER_URL   default: http://actual-server:5006
#   ACTUAL_PASSWORD     default: test-password
#   ACTUAL_DATA_DIR     default: /tmp/actual-data

set -euo pipefail

# Auto-detect: try compose hostname first, fall back to localhost
if [ -z "${ACTUAL_SERVER_URL:-}" ]; then
  if curl -sf "http://actual-server:5006/account/needs-bootstrap" > /dev/null 2>&1; then
    ACTUAL_SERVER_URL="http://actual-server:5006"
  else
    ACTUAL_SERVER_URL="http://localhost:5006"
  fi
fi
ACTUAL_PASSWORD="${ACTUAL_PASSWORD:-test-password}"
ACTUAL_DATA_DIR="${ACTUAL_DATA_DIR:-/tmp/actual-data}"

export ACTUAL_SERVER_URL ACTUAL_PASSWORD ACTUAL_DATA_DIR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Wait for server to be reachable
echo "Waiting for Actual server at $ACTUAL_SERVER_URL..."
for i in $(seq 1 30); do
  if curl -sf "$ACTUAL_SERVER_URL/account/needs-bootstrap" > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Server not reachable after 30 seconds" >&2
    exit 1
  fi
  sleep 1
done
echo "Server is up."

# Ensure local data directory exists
mkdir -p "$ACTUAL_DATA_DIR"

# Ensure npm dependencies are installed
if [ ! -d "$PROJECT_DIR/node_modules/@actual-app" ]; then
  echo "Installing npm dependencies..."
  npm --prefix "$PROJECT_DIR" install
fi

# Run the TypeScript bootstrap script
npx --prefix "$PROJECT_DIR" tsx "$SCRIPT_DIR/bootstrap_test_budget.ts"
