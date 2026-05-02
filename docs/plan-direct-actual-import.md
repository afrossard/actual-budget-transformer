# Plan: Direct Import into Actual Budget

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the current manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces.

## Status

- **Now**: Build `ActualBudgetImporter` (writers/actual_budget_importer.py) — see Python integration in open work.
- **Pinned**: `@actual-app/api@26.4.0`. Version-skew strategy: log on connect, never abort. **Caveat (manually confirmed 2026-05-02): `client-ahead` skew breaks the older web client** — see "Version-skew tolerance findings" below. `server-ahead` not yet assessed.
- **Done**: API choice, version-skew policy, test infra (devcontainer + bootstrap + compat rigs), TS smoke test, **JS-API bridge end-to-end** (TS bridge + Python wrapper + 6-test pytest smoke suite).
- **Carrying**: pytest fixtures (per-test budgets) and an offline template-budget for unit tests; verify `npm install` runs in the devcontainer's `postCreateCommand.sh`. Assess whether `server-ahead` skew (newer server, older API/web client) breaks the web client; same manual procedure as `client-ahead`.

---

## Open work

### Python integration

- **`get_actual_budget_config()` in `config.py`** — reads `actual_budget` YAML section with env-var overrides for `url`, `password`, `file`.
- **`ActualBudgetImporter` in `writers/actual_budget_importer.py`** — context-managed, holds the bridge connection. Method `import_transactions(result, balance_checkpoints)`:
  1. Resolve account name from `output_prefix`; fail clearly with available accounts list if missing.
  2. Compute batch boundaries — month-end merged with CAMT balance-checkpoint dates.
  3. Per batch: filter by reconciliation boundary → query existing tx → bucket-classify (skip/suspicious/clean) → check circuit breaker → import clean → import suspicious with review category → balance check at boundary if checkpoint present → log summary.
- **`main.py` wiring** — add `"actual"` to `--format`; when chosen, build the importer, run it as a context manager around single-file/directory processing, print summary at end. Skip the writer path entirely.
- **`config.template.yml`** — add commented `actual_budget` block.

### Tests

Unit (no server):

- Amount conversion (debit → negative cents, credit → positive, NaN).
- Batch-boundary merge (month-end + CAMT checkpoint).
- Bucket classification.
- Circuit breaker (threshold, per-account isolation).
- Config loading with env-var overrides.

Integration (Actual container):

- Account resolution + account-not-found error.
- Import → read back.
- Re-import → all skipped by `imported_id`.
- Pre-existing manual entries → suspicious flagged with review category.
- Circuit breaker trips → account aborted, others continue.
- Balance mismatch against CAMT checkpoint → import stops.
- Resume after partial import.
- Server-version compatibility (already partially covered by `test_version_matrix.sh` / `test_staggered_upgrade.sh`).

**Known gap (discovered 2026-04-27, characterised 2026-05-02):** `test_staggered_upgrade.sh` only verifies API↔API round-trips. It cannot detect web-browser breakage caused by API↔server skew. See "Version-skew tolerance findings" below for what we tried and why an automated check inside the staggered rig isn't viable. Browser compatibility currently has to be verified manually after a version bump.

### Docs

Update `CLAUDE.md` architecture section and `config.template.yml` for the new feature, including how to run integration tests.

### Outstanding test infra

- Pytest fixtures: skip if server unreachable, seed transactions, teardown.
- Offline template budget for unit tests (`api.init({ dataDir }) + api.loadBudget(id)` against a pre-built SQLite template — no server, no sync).

---

## Architecture

### Conservative-automation principles

The user's manual workflow is deliberate: one month at a time, check the reconciliation boundary, manually review duplicates. Actual's built-in dedup (`importTransactions`) is not fully reliable — particularly for transactions without a bank reference. The automated import must never create a mess that's harder to clean up than doing it by hand:

- Skip transactions that are already reconciled (locked).
- Flag uncertain matches for async human review rather than guessing.
- Stop early if too much uncertainty (circuit breaker).
- Process in monthly batches for manageable review and clear resume points.
- Log everything — imported, flagged, skipped, where it stopped.

### Design decisions

1. **Standalone importer, not a writer subclass.** `BaseWriter.save_monthly()` is file-oriented; direct import has different logic. `ActualBudgetImporter` is its own class with a small branch in `main.py`.
2. **Account matching.** Reuse existing `account_names` as Actual account names. Validate the target account before importing; fail with the available list if missing.
3. **Checkpoint-based batching with inline balance verification.** Batches end at the first of: end of calendar month or next CAMT.053 statement balance checkpoint. After each commit, compare Actual's account balance at the boundary against the CAMT balance; on mismatch, stop this account so the user can fix the small recent gap before resuming. No CAMT data → pure monthly batching with no inline check. CSV files have balance fields but they've been empty in practice — support if populated, don't depend on them.
4. **Reconciliation boundary.** Query the account's last reconciled date; skip everything before it (locked and verified).
5. **Three-bucket classification** (needs review) for transactions on/after the reconciliation date — Skip / Suspicious / Clean. See bucket pseudocode below.
6. **Conservative duplicate detection** (needs review). Without a reference we cannot reliably pair source rows to existing rows; if any existing tx matches on amount within ±1 day and the source rows lack a reference, the entire group goes to review. Count info is logged so the human can resolve fast (e.g. "5 source tx of 12.50 around Jan 15, 2 already exist — flagging all 5"). Only matching `imported_id` allows confident skip.
7. **Per-account circuit breaker.** If suspicious count in a monthly batch exceeds the configured threshold, abort that account's batch (don't import the clean ones either — keep batches atomic). Continue with other accounts.
8. **Resume.** Re-running is safe: already-imported tx skipped by `imported_id`; monthly batching ensures only unprocessed months retry; circuit-breaker stops avoid partial-import tangles.
9. **CLI.** Add `"actual"` to `--format` choices. `--output` is optional/ignored when chosen.
10. **Config.** New `actual_budget` YAML section. Env vars override sensitive values.
11. **Connection lifecycle.** Single `Actual` connection per CLI invocation via context manager; reused across files in directory mode.

### Bucket classification (conservative)

```
For each source transaction in the batch:
  if transaction has imported_id AND that imported_id exists in Actual → skip
  else:
    existing = Actual transactions matching same amount within ±1 day
    if len(existing) == 0 → clean (import normally)
    else → suspicious (flag entire amount/date group for review)
      Log: "N source tx of {amount} around {date}, M already in Actual — flagging all N for review"
```

### Bridge architecture

A TypeScript script exposes the JS API as a JSON-over-stdio interface; a Python subprocess sends commands and reads responses. Business logic (batching, classification, circuit breaker) stays in Python; only the Actual protocol handling is delegated.

### JS API surface used

| Need                        | Method                                      | Notes                                                                                                              |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Import transactions         | `importTransactions(accountId, txs, opts?)` | Returns `{ added, updated, errors }`. `imported_id` exact-match dedup + fuzzy fallback. We use `imported_id` only. |
| Query existing transactions | `getTransactions(accountId, start, end)`    | Full tx objects: `imported_id`, `cleared`, `amount`, `date`, `notes`, `category`.                                  |
| List accounts               | `getAccounts()`                             | `id`, `name`, `offbudget`, `closed`, `balance_current`. (No `type` field in 26.x — see version-skew log.)          |
| Account balance at date     | `getAccountBalance(id, cutoff?)`            | Integer cents at optional cutoff; enables CAMT-checkpoint verification.                                            |
| Assign category             | `category` field on tx objects              | Pass UUID; resolve via `getCategories()` or `getIDByName({ type: 'category', string })`.                           |
| Flexible queries            | `runQuery(query)`                           | ActualQL fallback.                                                                                                 |
| Lookup by name              | `getIDByName({ type, string })`             | Resolve account/payee/category name → UUID.                                                                        |

**Lifecycle**: `init({ serverURL, password, dataDir })` → `downloadBudget(syncId)` (the `groupId` field, not `cloudFileId`) → operations → `sync()` → `shutdown()`.
**Amounts**: integer cents. `$120.30 = 12030`. Helpers: `utils.amountToInteger`, `utils.integerToAmount`.
**Encryption**: pass password to `downloadBudget()`; transparent.
**`importTransactions` dedup details**: (1) exact `imported_id` updates; (2) without it, fuzzy on amount + date + payee; (3) duplicate `imported_id`s within the same call are NOT deduped against each other; (4) different `imported_id`s never fuzzy-merge.

### Config draft (needs review)

```yaml
# Direct import into Actual Budget (--format actual)
# Env var overrides: ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD, ACTUAL_BUDGET_FILE
actual_budget:
  url: 'http://localhost:5006'
  password: '' # prefer ACTUAL_BUDGET_PASSWORD env var
  file: 'My Budget'
  review_category: 'To Review'
  suspicious_threshold: 5
```

Reviewer comment: may need a `sync_id` and an encryption key.

---

## Decisions log

### Use the official JS API, not `actualpy`

Three options were considered: reimplement the sync protocol (ruled out — undocumented CRDT/binary/libsodium machinery), `actualpy` (rejected — reimplements the sync protocol in Python and writes directly to the SQLite schema, so a server-side schema or protocol change can silently corrupt the user's real budget; integration tests catch breakage after the fact), and the official JS API (selected — maintained by the Actual team alongside the server; schema changes handled internally; if it breaks it breaks cleanly). Trade-off: a Node runtime dependency and subprocess overhead — bounded engineering cost vs. unbounded data-loss risk from a stale third-party reimplementation.

### Version-skew policy: pin + log, never abort

The Actual server is upgraded independently of `@actual-app/api`. Findings:

- Server exposes `GET /info` (unauthenticated): `{ build: { name, description, version } }`. Implemented in `packages/sync-server/src/app.ts` of `actualbudget/actual`. The compiled API calls it internally as `get-server-version` but doesn't surface it on the public API — we hit it ourselves with plain `fetch` (the same pattern as the existing `/account/needs-bootstrap` call in `bootstrap_test_budget.ts`).
- No documented compatibility matrix. Releases are calver and roughly monthly; the 25 → 26 bump is calver, not semver, with no implied break. Sampled release notes (25.4.0, 26.1.0, 26.4.0) flag no sync-protocol changes; sync routes (`/sync`, `/upload-user-file`, `/download-user-file`, …) are stable.
- Empirical: `scripts/test_version_matrix.sh` (fresh-slate `{25.3.1, 26.4.0}²` = 4 cells, all pass) and `scripts/test_staggered_upgrade.sh` (single persistent budget across server-ahead and client-ahead transitions, both pass) cover a 13-month, 13-release gap without breakage.
- Observed breaks were JS-API type-shape changes — `APIAccountEntity` dropped `type`, `ImportTransactionEntity` now requires `account` per tx — caught by `tsc` at build time, not runtime sync corruption. `@actual-app/core` ships raw `.ts` source that fails strict tsc, so type checking has to scope to our own files: `tsc --noEmit 2>&1 | grep -E "^(scripts|tests|src)/"`.

Decision:

1. **Pin** `@actual-app/api` in `dependencies` (currently 26.4.0). Version-matrix aliases stay in `devDependencies` so production installs don't pull duplicates.
2. **Log-only runtime check.** On import startup, fetch `/info` and log `{ server, api }`. Do not abort — the conservative-automation workflow values surfaceable diagnostics over hard failures, and the staggered test shows wide skew is fine in practice. If runtime breakage ever appears, the log gives the version pair to reproduce against.
3. **Re-validate before any planned upgrade**: `V_OLD=<current> V_NEW=<target> ./scripts/test_staggered_upgrade.sh` exercises a real budget across the boundary.

Tested compatible range: `@actual-app/api` 25.3.1 ↔ 26.4.0 against `actualbudget/actual-server` 25.3.1 ↔ 26.4.0, both directions, fresh-slate and staggered-volume.

### Version-skew tolerance findings (2026-05-02)

We tried to extend `test_staggered_upgrade.sh` with an automated `browser_compat_check` step and learned why it can't work.

- **`client-ahead` skew breaks the older web client (manually confirmed).** Run `actual-up` (server pinned to 25.3.1) → `npm run bootstrap` → `uv run pytest tests/test_actual_api_smoke.py`. The 26.4.0 API migrates the SQLite schema forward; opening `http://localhost:5006` in a browser then shows "Please update Actual!" and refuses to load the budget.
- **The older API does not detect the same breakage.** After the 26.4.0 API touched the budget, opening it with the 25.3.1 API (fresh data dir → `downloadBudget` → `getAccounts` → `getTransactions` → `getAccountBalance` → `getCategories` → `sync`) succeeds without error. Mirroring the smoke test surface in p2 did trigger the migration but the V_OLD API still opened the result cleanly. So **"old API can open" is not a valid proxy for "old browser can open"** — the API tolerates schema versions the web client refuses.
- **Implication for the staggered test.** API↔API tests cannot prove web-client compatibility; the only reliable signal is loading the actual web bundle (e.g. headless Playwright against the live server). The `browser_compat_check` direction was abandoned.
- **`server-ahead` skew (newer server, older API/client) not yet assessed.** Same manual procedure: stand up the newer server, run the older-API smoke test, open the older browser. To do when there's bandwidth.
- **Proper automated detection would require a headless browser test.** Out of scope for now; manual check before planned upgrades is acceptable given a single user.

---

## Reference

### Verification checklist

1. `uv sync && npm install` — deps install cleanly.
2. `docker compose --profile actual up -d` — Actual server healthy.
3. `uv run pytest tests/test_actual_importer_unit.py` — unit tests pass without server.
4. `uv run pytest tests/test_actual_importer_integration.py` — integration tests pass against the container.
5. Bump Actual image tag → re-run integration tests → confirm compatibility.
6. Manual smoke: import real files against the test container, review in Actual UI.

### Critical files

- `src/actual_budget_transformer/bridge/actual_api_bridge.ts` (in place — bridge)
- `src/actual_budget_transformer/actual_api.py` (in place — Python wrapper around the bridge subprocess)
- `tests/test_actual_api_smoke.py` (in place — bridge end-to-end smoke)
- `src/actual_budget_transformer/writers/actual_budget_importer.py` (new — batching, dedup, circuit breaker)
- `src/actual_budget_transformer/main.py` (modify)
- `src/actual_budget_transformer/config.py` (modify)
- `config.template.yml` (modify)
- `tests/test_actual_importer_unit.py` (new)
- `tests/test_actual_importer_integration.py` (new)
- `package.json`, `package-lock.json`, `tsconfig.json` (in place)

### Bootstrap-script gotchas (for future reference)

From building `scripts/bootstrap_test_budget.ts` and the bridge against a fresh server:

1. **Password setup**: `POST /account/bootstrap` with `{"password": "..."}`; check first via `GET /account/needs-bootstrap`.
2. **Budget creation**: `api.runImport(name, callback)` is the public entry point. **Requires `ACTUAL_DATA_DIR`** — the internal `exportDatabase` reads `process.env.ACTUAL_DATA_DIR` directly (not the `dataDir` passed to `init()`), so without it the upload step silently fails.
3. **Budget download**: `api.downloadBudget(syncId)` uses the **`groupId`** field from `getBudgets()`, not `cloudFileId`.
4. **Offline mode**: `api.init({ dataDir })` (no `serverURL`) loads a pre-built SQLite template — useful for fast unit tests of business logic with no server, no sync.
5. **Account creation**: `api.createAccount({ name }, initialBalance)` then `api.sync()`. (`type` was removed from `APIAccountEntity` in 26.x.)
6. **`importTransactions` requires `account` per tx in 26.x**. The bridge injects `accountId` into every tx automatically; callers should not bother setting it.
7. **`@actual-app/api` writes `[Breadcrumb]` lines to `console.log`**. Anything using stdout as a protocol channel (the bridge) MUST monkey-patch `console.{log,info,warn,error}` to write to stderr before importing the API.
8. **`getAccountBalance(id, cutoff?)`** takes a `Date`, not a string. The bridge converts an ISO date string from Python into a `Date` object before calling.

### Test modes

| Mode    | Server | Use case                                           | API init                                                                     |
| ------- | ------ | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Offline | No     | Fast unit tests: dedup, batching, circuit breaker  | `api.init({ dataDir })` + `api.loadBudget(id)` with template SQLite          |
| Online  | Yes    | Integration tests: full import path, sync, balance | `api.init({ serverURL, password, dataDir })` + `api.downloadBudget(groupId)` |

---

## Archive

Done implementation work. Detail lives in code; this is just an index.

- **JS-API bridge (TS + Python wrapper)**:
  - `src/actual_budget_transformer/bridge/actual_api_bridge.ts` — JSON-over-stdio bridge. Commands: `open`, `get_accounts`, `get_transactions`, `import_transactions`, `get_account_balance`, `get_categories`, `sync`, `shutdown`. Stdout reserved for protocol JSON; `console.*` rerouted to stderr; server `/info` probed on `open` and logged with the api package name.
  - `src/actual_budget_transformer/actual_api.py` — `ActualBridge` context manager. Spawns the bridge via `node_modules/.bin/tsx`, drains stderr to the project logger, raises `BridgeError` on any non-ok response.
  - `tests/test_actual_api_smoke.py` — 6 pytest cases (accounts list, unknown-budget error, import round-trip, balance with/without cutoff, categories, idempotent sync). Module-level skip when the server is unreachable.

- **TS smoke test** — `tests/actual/import_roundtrip.test.ts`, run via `npm run test:actual`. Idempotent (`Date.now()`-tagged `imported_id`s); transactions accumulate in the test budget — teardown deferred.
- **Devcontainer Actual server profile** — `.devcontainer/docker-compose.yml`, profiled service pinned to `actualbudget/actual-server:25.3.1`, on the same network as the devcontainer. Started on demand via `actual-up` / `docker compose --profile actual up -d`. Node 22 in both containers; `postCreateCommand.sh` runs `npm install` alongside `uv sync`.
- **Server bootstrap** — `scripts/bootstrap_test_budget.ts`, idempotent (downloads existing budget on re-run, only creates missing accounts). Creates "Test Budget" with Test Checking, Test Savings, Test Credit Card.
- **Version-compat rigs**:
  - `scripts/test_version_matrix.sh` — fresh-slate `(client, server)` matrix; clean tmpfs server volume + clean `ACTUAL_DATA_DIR` per cell.
  - `scripts/test_staggered_upgrade.sh` — single persistent budget volume across server image swaps; server-ahead and client-ahead scenarios, three phases each. Bypasses the compose `tmpfs:/data` by running the server with `docker run` and a docker named volume on the compose-managed network.
