# Plan: Direct Import into Actual Budget

## Context

Currently the CLI transforms bank statement files into CSV/XML files that must be manually imported into Actual Budget. This feature adds a new `--format actual` option that imports transactions directly into a self-hosted Actual Budget server using the `actualpy` Python library, eliminating the manual import step.

### Design philosophy: conservative automation

The user's current manual workflow is careful and deliberate: import one month at a time, check the reconciliation boundary, manually review potential duplicates. Actual's built-in dedup (`importTransactions`) is not fully reliable, especially for transactions without a bank reference.

The automated import must be **at least as safe as manual import**. It should never create a mess that's harder to clean up than doing it by hand. Key principles:

- Skip transactions that are already reconciled (locked)
- Flag uncertain matches for async human review rather than guessing
- Stop early if too much uncertainty (circuit breaker)
- Process in monthly batches for manageable review and clear resume points
- Log everything: what was imported, flagged, skipped, and where it stopped

---

## Design Decisions

1. **Not a writer subclass** — `BaseWriter.save_monthly()` is file-oriented (file I/O, file-based dedup). Direct import needs different logic. Create a standalone `ActualBudgetImporter` class with its own `import_transactions()` method and a small branch in `main.py`.

2. **Account matching** — Reuse existing `account_names` values as Actual Budget account names. Before importing, validate that the target account exists in Actual Budget and fail clearly if not (listing available accounts).

3. **Checkpoint-based batching with inline balance verification** — Batches are bounded by whichever comes first: end of calendar month, or the next CAMT.053 statement balance checkpoint. After each batch is committed, compare Actual's account balance at the batch boundary against the CAMT balance; on mismatch, stop this account's import immediately so the user can fix the small, recent discrepancy before resuming. Without CAMT data, fall back to pure monthly batching with no inline verification. CSV files have balance fields structurally but have been empty in practice — support them if populated, don't rely on them.

4. **Reconciliation boundary** — Before importing a batch, query the account's last reconciled transaction date. Skip all transactions dated before that boundary (they're locked and verified). Only process transactions on or after the reconciliation date.

5. (needs review) **Three-bucket classification** for transactions on/after the reconciliation date:
   - **Skip** — high-confidence duplicate: same `imported_id`/reference already exists in Actual
   - **Suspicious** — no reference, but an existing transaction in the account matches on amount within ±1 day. Needs count-aware matching (see below). Imported with a configurable "to review" category.
   - **Clean** — no match found → import normally

6. (needs review) **Conservative duplicate detection** — When matching by amount+date (without payee), we cannot reliably pair specific source transactions with specific existing ones. If there are ANY existing transactions matching on amount within ±1 day and the source transactions lack a reference, the **entire group is suspicious** — flag all for review. The count information is still logged to help the human resolve it quickly (e.g. "5 source transactions of 12.50 around Jan 15, 2 already exist — flagging all 5 for review"). Only transactions with a matching `imported_id` can be confidently skipped.

7. **Circuit breaker** — Per-account threshold. If suspicious transaction count in any monthly batch exceeds a configurable limit, abort that account's import entirely (don't import the clean ones from that batch either — keep it atomic). Continue processing other accounts. Log clearly what happened and where to resume.

8. **Resume** — Re-running the tool is safe: already-imported transactions are skipped (by `imported_id`), and the monthly batching means only unprocessed months are attempted. The circuit breaker means a tripped account won't have partial imports to untangle.

9. **CLI** — Add `"actual"` to `--format` choices. When used, `--output` is optional/ignored.

10. **Config** — New `actual_budget` section in YAML. Environment variables as overrides for sensitive values (password).

11. **Connection lifecycle** — Single `Actual` connection per CLI invocation via context manager, reused across files in directory mode.

---

## Config (needs review)

```yaml
# Direct import into Actual Budget (--format actual)
# Env var overrides: ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD, ACTUAL_BUDGET_FILE
actual_budget:
  url: 'http://localhost:5006'
  password: '' # prefer ACTUAL_BUDGET_PASSWORD env var
  file: 'My Budget'
  review_category: 'To Review' # category assigned to suspicious transactions
  suspicious_threshold: 5 # per-account: abort if >N suspicious in a monthly batch
```

Reviewer's comment: may need a sync_id and an encryption key

---

## Implementation Steps

### Current focus

**Next up: Step 1 — build the JS API bridge.** Step 1b is closed (see findings + decision below); Step 0 and Step 7 (test infra) are also done. The pinned `@actual-app/api` version (26.4.0) and the log-only version-check decision feed directly into the bridge's `init` command.

Originally: a TS-only end-to-end smoke test before building the bridge or any Python wiring. The test reuses `scripts/bootstrap_test_budget.ts` to get a live budget, then exercises `@actual-app/api` directly: import a handful of synthetic transactions, read them back, assert the round-trip.

Why this ordering:

- **De-risks the API contract first.** We find out whether we can reliably talk to Actual before investing in bridge design or Python plumbing.
- **Gives us the rig for Step 1b.** Client/server version-mismatch questions are empirical — they need a harness to probe. This test _is_ that harness: swap the Actual image tag, rerun.
- **Keeps the blast radius small.** The bridge (Step 1) and Python wrapper add subprocess + JSON marshaling failure modes that are orthogonal to "does the API work?". Adding them now would couple protocol research to IPC debugging.
- **Python comes later.** Once the TS path is proven, the bridge and `actual_api.py` wrap a known-good surface. Pytest can shell out to the TS tests or trust them.

After this smoke test lands, the next decision point is Step 1b (version compatibility), then Step 1 (bridge).

#### First slice ✅

- File: `tests/actual/import_roundtrip.test.ts`
- Runner: `node --test` via `tsx` (no new deps — `tsx` already in `devDependencies`)
- npm script: `npm run test:actual`
- Preconditions: `actual-up` running, `npm run bootstrap` already executed so "Test Budget" with "Test Checking" exists (bootstrap creates `/tmp/actual-data` via `ACTUAL_DATA_DIR`; the dir must exist before first run)
- Behaviour:
  1. `api.init` + `downloadBudget` against the dev server (fresh temp `dataDir` per run via `mkdtempSync`)
  2. Resolve the "Test Checking" account id
  3. Import 3 synthetic transactions with `Date.now()`-tagged `imported_id`s so repeat runs stay isolated
  4. `getTransactions` over the matching date range, filter to this run's ids
  5. Assert count, amount (integer cents), date, notes match
  6. `api.shutdown` + rm the temp dir
- Verified idempotent across repeat runs. Tx accumulate in the test budget — teardown deferred.

#### 1b rig ✅

Two scripts cover the version-compat surface:

- `scripts/test_version_matrix.sh` — fresh-slate `(client, server)` matrix; each cell starts with a clean tmpfs server volume and a clean per-cell `ACTUAL_DATA_DIR`. Proves the API surface boots across the matrix.
- `scripts/test_staggered_upgrade.sh` — single persistent budget volume across version transitions. Two scenarios: server-ahead (server upgrades first) and client-ahead (api upgrades first). Each scenario runs three phases that import + verify the prior phases' tagged transactions still round-trip. Bypasses the compose `tmpfs:/data` by running the server with `docker run` and a docker named volume on the compose-managed network.

Both run today against `25.3.1 ↔ 26.4.0`. To validate a future upgrade target: `V_OLD=<current> V_NEW=<target> ./scripts/test_staggered_upgrade.sh`.

### Step 0: Evaluate `actualpy` vs direct Actual API ✅

**Decision: Use the official JS API (`@actual-app/api`) via a Node.js bridge script.**

#### Research findings

**Actual Budget has no REST API.** It uses a CRDT-based sync protocol. Clients download an encrypted SQLite database, apply changes as CRDT messages locally, and sync diffs back to the server. There are three integration options:

**Option 1 — Direct sync protocol reimplementation: ruled out.**
The sync protocol is undocumented internal machinery (CRDTs, binary message format, optional libsodium encryption). Reimplementing it is infeasible for this project's scope.

**Option 2 — `actualpy` (Python, community): rejected due to database safety risk.**

- v0.21.0 (Feb 2026), actively maintained, single primary maintainer (bvanelli)
- Reimplements the CRDT sync protocol in Python using SQLAlchemy ORM against the local SQLite budget database
- Provides `reconcile_transaction()` for dedup, direct SQLAlchemy queries for flexible data access
- **Critical risk**: because it reimplements the sync protocol and writes directly to the database schema, a server-side schema or protocol change can cause silent data corruption. The Actual server updates independently of `actualpy` — code that worked yesterday may break the database tomorrow. SQLAlchemy writes could silently produce bad data (renamed column, new required field), and malformed CRDT sync messages could corrupt budget state with no rollback. Integration tests catch breakage _after the fact_; they don't prevent corruption of the user's real budget between test runs.

**Option 3 — Official JS API (`@actual-app/api`): selected.**

- Maintained by the Actual team, released alongside the server
- Schema changes are handled internally — we code against the API contract, not the database
- If the API breaks, it breaks cleanly (method signature changes, missing fields) rather than silently corrupting data
- Requires Node.js runtime, called from Python via a bridge script (subprocess)
- **Trade-off**: adds a Node.js dependency and subprocess overhead, but this is a bounded engineering cost. Database corruption risk from a stale third-party sync reimplementation is unbounded.

#### JS API capabilities (covers all plan requirements)

| Need                        | JS API method                                        | Notes                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import transactions         | `importTransactions(accountId, transactions, opts?)` | Returns `{ added, updated, errors }`. Built-in dedup via `imported_id` (exact match) + fuzzy fallback (amount + date + payee). We'll use `imported_id` for skip detection but own the suspicious/clean classification ourselves. |
| Query existing transactions | `getTransactions(accountId, startDate, endDate)`     | Returns full transaction objects including `imported_id`, `cleared`, `amount`, `date`, `notes`, `category`                                                                                                                       |
| List accounts               | `getAccounts()`                                      | Returns `id`, `name`, `type`, `balance_current`, `offbudget`, `closed`                                                                                                                                                           |
| Account balance at date     | `getAccountBalance(id, cutoff?)`                     | Integer balance (cents) at optional cutoff date — enables balance verification against CAMT checkpoints                                                                                                                          |
| Assign category             | `category` field on transaction objects              | Pass category UUID when importing; use `getCategories()` to resolve name → ID                                                                                                                                                    |
| Flexible queries            | `runQuery(query)`                                    | ActualQL queries for anything the typed methods don't cover                                                                                                                                                                      |
| Lookup by name              | `getIDByName({ type, string })`                      | Resolve account/payee/category name → UUID                                                                                                                                                                                       |

**Connection lifecycle**: `init({ serverURL, password, dataDir })` → `downloadBudget({ syncId, password? })` → operations → `sync()` → `shutdown()`

**Amounts**: integers in cents. `$120.30` = `12030`. Utility: `utils.amountToInteger()` / `utils.integerToAmount()`.

**Encryption**: pass encryption password in `downloadBudget()`, handled transparently.

**`importTransactions` dedup detail**:

1. Exact `imported_id` match → updates existing transaction (primary dedup)
2. No `imported_id` → fuzzy match on amount + date proximity + payee similarity
3. Known gap: duplicate `imported_id` values _within the same API call_ are not deduped (only across calls)
4. Transactions with _different_ `imported_id` values are never fuzzy-merged

#### Bridge architecture

A TypeScript bridge script (`src/actual_budget_transformer/bridge/actual_api_bridge.ts`) exposes the API as a JSON-over-stdio interface:

- Python subprocess starts the bridge, sends JSON commands to stdin, reads JSON responses from stdout
- Commands: `init`, `download_budget`, `get_accounts`, `get_transactions`, `import_transactions`, `get_account_balance`, `get_categories`, `sync`, `shutdown`
- The bridge is stateful (holds the connection) for the duration of a CLI invocation
- Error handling: bridge returns structured errors; Python side raises typed exceptions
- **Node.js dependency**: documented as a requirement; checked at startup with a clear error message if missing

This keeps all business logic (batching, dedup classification, circuit breaker) in Python while delegating only the Actual protocol handling to the official JS implementation.

### Step 1: Build the JS API bridge

> Steps 0 and 1 from the original plan are merged — the research is complete, and the next implementation step is the bridge.

Create `src/actual_budget_transformer/bridge/actual_api_bridge.ts`:

- `@actual-app/api` installed via `package.json` in project root (Node.js available in both dev and prod containers)
- Implement a stdin/stdout JSON-RPC-like protocol: read newline-delimited JSON commands, execute the corresponding API call, write JSON response
- Handle connection lifecycle (init/download/sync/shutdown)
- Handle errors gracefully (return structured error objects, never crash silently)

Create `src/actual_budget_transformer/actual_api.py`:

- Python wrapper class that manages the Node.js subprocess
- Methods matching the bridge commands, with typed return values
- Context manager for lifecycle (`__enter__` starts bridge + init + download, `__exit__` syncs + shuts down)
- Node.js availability check at startup

**Files**: `src/actual_budget_transformer/bridge/actual_api_bridge.ts`, `package.json`, `src/actual_budget_transformer/actual_api.py`

### Step 1b: Assess client/server version mismatch behavior ✅

#### Findings

- **Server version endpoint**: `GET /info` (unauthenticated) returns `{ build: { name, description, version: "X.Y.Z" } }`. Implemented in `packages/sync-server/src/app.ts` of `actualbudget/actual`. The compiled `@actual-app/api` already calls it internally (`get-server-version` handler) but does not expose it on the public API surface — we'd hit it ourselves with plain `fetch` (same way `bootstrap_test_budget.ts` calls `/account/needs-bootstrap`).
- **No documented compatibility matrix**. Actual ships calver releases roughly monthly; the 25 → 26 bump is calver, not semver, and carries no implied break. Sampled release notes (25.4.0, 26.1.0, 26.4.0) mention no sync-protocol changes. Sync routes (`/sync`, `/upload-user-file`, `/download-user-file`, …) are stable.
- **Empirical coverage** (`scripts/test_version_matrix.sh` + `scripts/test_staggered_upgrade.sh`):
  - Fresh-slate matrix `{25.3.1, 26.4.0}² = 4` cells: all pass.
  - Staggered upgrade with persistent budget volume across version transitions: server-ahead and client-ahead scenarios both pass.
  - 13-month, 13-release gap survives bidirectional skew.
- **Breaks we did hit**: surface-level type changes in `@actual-app/api` between 25.3.1 and 26.4.0 — `APIAccountEntity` dropped `type`, `ImportTransactionEntity` now requires `account`. These are caught by `tsc` at build time on the project that uses the SDK; they don't manifest as runtime sync corruption. `@actual-app/core` ships raw `.ts` source that fails strict tsc, so type checking has to scope to our own files (`tsc --noEmit 2>&1 | grep -E "^(scripts|tests|src)/"`).

#### Decision: pin + log, no abort

1. **Pin `@actual-app/api`** in `dependencies` (currently `26.4.0`). The two version-matrix aliases stay in `devDependencies` so production installs don't pull duplicates.
2. **Log-only runtime version check**. On import startup, fetch `/info`, log `{ server: X.Y.Z, api: X.Y.Z }`. Do not abort on mismatch — the user's "conservative automation" workflow (monthly imports, circuit breaker) values surfaceable diagnostics over hard failures, and our staggered test shows wide skew is fine in practice. If runtime breakage ever does appear, the log gives us the version pair to reproduce against.
3. **Re-validate before any planned upgrade**: `V_OLD=<current> V_NEW=<target> ./scripts/test_staggered_upgrade.sh` exercises a real budget across the boundary; run it before bumping either component in production.

#### Tested compatible range

`@actual-app/api` 25.3.1 ↔ 26.4.0 against `actualbudget/actual-server` 25.3.1 ↔ 26.4.0, both directions, fresh-slate and staggered-volume.

### Step 2: Add dependencies

- Add `@actual-app/api` to `package.json` in project root, with `typescript` and `@types/node` as dev dependencies
- Commit `package-lock.json` for reproducible installs
- Add `npm install` to the Dockerfile / devcontainer setup (alongside existing `uv sync`)
- Add `tsconfig.json` for the bridge script compilation
- No new Python dependencies needed — subprocess communication uses only stdlib (`subprocess`, `json`)

**Files**: `package.json`, `package-lock.json`, `tsconfig.json`, Dockerfile / devcontainer config

### Step 3: Add `get_actual_budget_config()` to config

New helper that reads config + env var overrides:

```python
def get_actual_budget_config() -> dict:
    config = load_config()
    ab = config.get("actual_budget", {})
    return {
        "url": os.environ.get("ACTUAL_BUDGET_URL", ab.get("url", "")),
        "password": os.environ.get("ACTUAL_BUDGET_PASSWORD", ab.get("password", "")),
        "file": os.environ.get("ACTUAL_BUDGET_FILE", ab.get("file", "")),
        "review_category": ab.get("review_category", "To Review"),
        "suspicious_threshold": int(ab.get("suspicious_threshold", 5)),
    }
```

**File**: `src/actual_budget_transformer/config.py`

### Step 4: Update `config.template.yml`

Add commented-out `actual_budget` section with all fields documented.

**File**: `config.template.yml`

### Step 5: Create `ActualBudgetImporter`

New class in `writers/` directory:

- **Context manager** (`__enter__`/`__exit__`) opens/closes `Actual` connection
- **`import_transactions(result: ProcessingResult, balance_checkpoints: list)`**:
  1. Resolve account name from `output_prefix` → look up in Actual → fail with available accounts list if not found
  2. Compute batch boundaries: merge month-end dates with CAMT balance checkpoint dates for this account, take whichever comes first at each step
  3. For each batch (chronological order):
     a. Query account's reconciliation boundary → filter out transactions before it
     b. Query existing transactions in the date range from Actual
     c. Classify each transaction into skip / suspicious / clean (see bucket logic)
     d. Check circuit breaker: if suspicious count > threshold, abort this account, log clearly, move on
     e. Import clean transactions normally
     f. Import suspicious transactions with the configured review category
     g. If a balance checkpoint exists at this batch boundary: compare Actual's account balance against CAMT expected balance. On mismatch → stop this account, log the discrepancy (expected vs actual, difference amount)
     h. Log summary: N imported, N flagged for review, N skipped (duplicate), N skipped (reconciled), balance check pass/fail
- **Handle missing Node.js / `@actual-app/api`** gracefully: check at startup, clear error directing user to install

**Bucket classification logic (conservative):**

```
For each source transaction in the batch:
  if transaction has imported_id AND that imported_id exists in Actual → skip
  else:
    existing = Actual transactions matching same amount within ±1 day
    if len(existing) == 0 → clean (import normally)
    else → suspicious (flag entire amount/date group for review)
      Log: "N source tx of {amount} around {date}, M already in Actual — flagging all N for review"
```

The key insight: without references, we cannot pair source rows to existing rows. If any ambiguity exists, the whole group goes to review. This is more conservative but avoids silent duplicates.

**File**: `src/actual_budget_transformer/writers/actual_budget_importer.py`

### Step 6: Wire up in `main.py`

1. Add `"actual"` to `--format` choices
2. When format is `"actual"`:
   - Read config via `get_actual_budget_config()`
   - Validate config (url, password, file must be set) and Node.js availability
   - Create `ActualBudgetImporter` context manager (which starts the JS bridge subprocess)
   - Call `importer.import_transactions(result)` for each processed file
   - Skip the `_get_writers()` / `save_monthly()` path entirely
   - At the end, print a summary of all accounts: what was imported, flagged, skipped, and any tripped circuit breakers

```python
if args.output_format == "actual":
    importer = _create_actual_importer()
    with importer:
        if os.path.isfile(args.file_path):
            process_single_file(args.file_path, importer=importer)
        else:
            process_directory(args.file_path, importer=importer)
    importer.print_summary()
```

**File**: `src/actual_budget_transformer/main.py`

### Step 7: Test infrastructure — Actual Budget container ✅

#### Container setup — done

Actual server runs as a profiled service in `.devcontainer/docker-compose.yml` (pinned to `actualbudget/actual-server:25.3.1`), on the same Docker network as the devcontainer. Services use compose profiles so only the devcontainer starts automatically; auxiliary services start on demand (`docker compose --profile actual up -d`). Node.js 22 installed in both container images. The `postCreateCommand.sh` runs `npm install` alongside `uv sync`.

#### Server bootstrap — done

A fresh Actual server has no password and no budget. The bootstrap is handled by `scripts/bootstrap_test_budget.ts`, which is idempotent (safe to re-run).

**Findings from implementation:**

1. **Password setup**: Simple HTTP — `POST /account/bootstrap` with `{"password": "..."}`. Check first with `GET /account/needs-bootstrap`.

2. **Budget creation**: `api.runImport(name, callback)` is the public API for this. It creates a local SQLite DB, runs the callback (where you create accounts/transactions), then finalizes and uploads to the server. **Requires `ACTUAL_DATA_DIR` env var** pointing to a writable directory — without this, the upload step silently fails because the internal `exportDatabase` function uses `process.env.ACTUAL_DATA_DIR` directly (not the `dataDir` passed to `init()`).

3. **Budget download**: `api.downloadBudget(syncId)` where `syncId` is the **`groupId`** field from `getBudgets()` — not `cloudFileId` (despite the field name in some responses).

4. **Upstream test approach**: The `@actual-app/api` tests work fully offline — `api.init({ dataDir })` with no `serverURL`, loading a pre-built SQLite template. No server, no sync. This is useful for fast unit tests of our business logic.

5. **Account creation**: Standard `api.createAccount({ name, type }, initialBalance)` followed by `api.sync()`.

**Decision: Use `@actual-app/api` directly for bootstrap** (no `actualpy` needed). The bootstrap script uses the same JS API that the production bridge will use, keeping the dependency set minimal.

**Bootstrap script** (`scripts/bootstrap_test_budget.ts`):

```
ACTUAL_DATA_DIR=/tmp/actual-data npx tsx scripts/bootstrap_test_budget.ts
```

- Bootstraps server password if needed
- Creates "Test Budget" with three accounts (Test Checking, Test Savings, Test Credit Card)
- Idempotent: downloads existing budget on re-run, only creates missing accounts

#### Test modes

| Mode    | Server needed | Use case                                                        | API init                                                                     |
| ------- | ------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Offline | No            | Fast unit tests: dedup logic, batching, circuit breaker         | `api.init({ dataDir })` + `api.loadBudget(id)` with template SQLite          |
| Online  | Yes           | Integration tests: full import path, sync, balance verification | `api.init({ serverURL, password, dataDir })` + `api.downloadBudget(groupId)` |

#### Remaining work

- Pytest fixtures for integration tests (skip if server unreachable, seed transactions, teardown)
- Offline test template budget for unit tests

**Files**: `.devcontainer/docker-compose.yml` (done), `scripts/bootstrap_test_budget.ts` (done), `tests/conftest.py` (fixtures — pending)

### Step 8: Tests

**Unit tests** (no server needed, fast):

- Amount conversion (debit → negative cents, credit → positive cents, NaN handling)
- Batch boundary computation (month-end + CAMT checkpoint merging)
- Bucket classification logic (skip / suspicious / clean)
- Circuit breaker logic (threshold, per-account isolation)
- Config loading with env var overrides

**Integration tests** (against Actual container):

- Account resolution + account-not-found error with helpful message
- Import transactions → verify they appear in Actual
- Re-import same transactions → all skipped (dedup by imported_id)
- Import into account with pre-existing manual entries → suspicious flagged with review category
- Circuit breaker trips → account aborted, others continue
- Balance verification against CAMT checkpoint → mismatch stops import
- Resume after partial import → picks up cleanly
- **Server version compatibility**: run the suite against different Actual server image tags to detect breakage
- **Client/server version mismatch**: test with a deliberately mismatched `@actual-app/api` version against the server — verify that the version check (from Step 1b) detects the mismatch and aborts cleanly rather than proceeding with potentially incompatible operations. Test both directions: client older than server, and client newer than server.

**Files**: `tests/test_actual_importer_unit.py`, `tests/test_actual_importer_integration.py`

### Step 9: Update docs

Update `CLAUDE.md` architecture section and config docs to reflect the new feature, including how to run integration tests.

**Files**: `CLAUDE.md`, `config.template.yml`

---

## Verification

1. `uv sync && cd scripts && npm install` — deps install cleanly
2. `docker compose --profile actual up -d` — Actual server starts and is healthy
3. `uv run pytest tests/test_actual_importer_unit.py` — unit tests pass (no server needed)
4. `uv run pytest tests/test_actual_importer_integration.py` — integration tests pass against container
5. Bump Actual image tag → re-run integration tests → confirm compatibility
6. Manual smoke test: import real files against the test container, review in Actual UI

---

## Critical Files

- `src/actual_budget_transformer/bridge/actual_api_bridge.ts` (new — TypeScript bridge to `@actual-app/api`)
- `package.json` (new — `@actual-app/api` dependency + TypeScript tooling)
- `package-lock.json` (new — lockfile)
- `tsconfig.json` (new)
- `src/actual_budget_transformer/actual_api.py` (new — Python wrapper around the bridge subprocess)
- `src/actual_budget_transformer/writers/actual_budget_importer.py` (new — business logic: batching, dedup, circuit breaker)
- `src/actual_budget_transformer/main.py` (modify)
- `src/actual_budget_transformer/config.py` (modify)
- `config.template.yml` (modify)
- `tests/test_actual_importer_unit.py` (new)
- `tests/test_actual_importer_integration.py` (new)
