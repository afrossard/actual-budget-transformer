# Bridge implementation notes

Built 2026-04 → 2026-05. Detail lives in code; this file collects the gotchas worth remembering when touching it again.

## What's in place

- **`src/actual_budget_transformer/bridge/actual_api_bridge.ts`** — JSON-over-stdio bridge. Commands: `open`, `get_accounts`, `get_transactions`, `import_transactions`, `get_account_balance`, `get_categories`, `sync`, `shutdown`. Stdout reserved for protocol JSON; `console.*` rerouted to stderr; server `/info` probed on `open`, version-skew gated per ADR-007.
- **`src/actual_budget_transformer/actual_api.py`** — `ActualBridge` context manager. Spawns the bridge via `node_modules/.bin/tsx`, drains stderr to the project logger, raises `BridgeError` on any non-ok response.
- **`tests/test_actual_api_smoke.py`** — 6 pytest cases (accounts list, unknown-budget error, import round-trip, balance with/without cutoff, categories, idempotent sync). Module-level skip when the server is unreachable.
- **`tests/test_actual_api_version_gate.py`** — 3 pytest cases for the ADR-007 gate (api>server abort, api<server proceed, unparseable abort), driven by the `ACTUAL_API_VERSION` env override.
- **Devcontainer Actual server profile** — `.devcontainer/docker-compose.yml`, profiled service pinned to `actualbudget/actual-server:26.4.0` (matches the pinned API), on the same network as the devcontainer. Started on demand via `actual-up` / `docker compose --profile actual up -d`. `actual-down` removes the container so the next `actual-up` starts on a fresh tmpfs (cattle, not pets). Node 22 in both containers; `postCreateCommand.sh` runs `npm install` alongside `uv sync`.
- **Server bootstrap** — `scripts/bootstrap_test_budget.ts`, idempotent. Wipes `ACTUAL_DATA_DIR` at startup before `api.init` because `@actual-app/api` keeps process-global state across `shutdown()` that defeats in-process recovery from a stale local cache. Creates "Test Budget" with Test Checking, Test Savings, Test Credit Card.

Version-compat rigs and the TS smoke test were retired 2026-05-09 once skew assessment finished; ADR-007's bridge gate is the safety mechanism going forward. The retired files live in `docs/archive/scripts/` for reference.

## Bootstrap-script gotchas

From building `scripts/bootstrap_test_budget.ts` and the bridge against a fresh server:

1. **Password setup**: `POST /account/bootstrap` with `{"password": "..."}`; check first via `GET /account/needs-bootstrap`.
2. **Budget creation**: `api.runImport(name, callback)` is the public entry point. **Requires `ACTUAL_DATA_DIR`** — the internal `exportDatabase` reads `process.env.ACTUAL_DATA_DIR` directly (not the `dataDir` passed to `init()`), so without it the upload step silently fails.
3. **Budget download**: `api.downloadBudget(syncId)` uses the **`groupId`** field from `getBudgets()`, not `cloudFileId`.
4. **Offline mode**: `api.init({ dataDir })` (no `serverURL`) loads a pre-built SQLite template — useful for fast unit tests of business logic with no server, no sync.
5. **Account creation**: `api.createAccount({ name }, initialBalance)` then `api.sync()`. (`type` was removed from `APIAccountEntity` in 26.x.)
6. **`importTransactions` requires `account` per tx in 26.x**. The bridge injects `accountId` into every tx automatically; callers should not bother setting it.
7. **`@actual-app/api` writes `[Breadcrumb]` lines to `console.log`**. Anything using stdout as a protocol channel (the bridge) MUST monkey-patch `console.{log,info,warn,error}` to write to stderr before importing the API.
8. **`getAccountBalance(id, cutoff?)`** takes a `Date`, not a string. The bridge converts an ISO date string from Python into a `Date` object before calling.
9. **Process-global state.** `@actual-app/api` keeps in-process state (current budget reference, background syncs) that survives `shutdown()`. After `shutdown()` + wipe + `init()`, the module may still kick off a sync against the old budget ID and crash the script. Don't try in-process recovery from a stale local cache — wipe the data dir before `init()`, or spawn a fresh subprocess.
10. **Error shape isn't stable across versions.** Server-`file-not-found` surfaced as `PostError` with `err.reason === 'file-not-found'` in 25.x; in 26.x it's wrapped as a bare `Error` with an empty/translated message. Don't pattern-match on error fields.

## Test modes

| Mode    | Server | Use case                                           | API init                                                                     |
| ------- | ------ | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Offline | No     | Fast unit tests: dedup, batching, circuit breaker  | `api.init({ dataDir })` + `api.loadBudget(id)` with template SQLite          |
| Online  | Yes    | Integration tests: full import path, sync, balance | `api.init({ serverURL, password, dataDir })` + `api.downloadBudget(groupId)` |

## `@actual-app/core` type-checking caveat

`@actual-app/core` ships raw `.ts` source that fails strict tsc, so type checking has to scope to our own files: `tsc --noEmit 2>&1 | grep -E "^(scripts|tests|src)/"`.
