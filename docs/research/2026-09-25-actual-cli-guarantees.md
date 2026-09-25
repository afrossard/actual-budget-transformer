# 2026-09-25 — What `@actual-app/cli` requires and guarantees

**Type:** research finding (issue #52)
**Feeds:** #40 (replace the custom TS/Python bridge with the official CLI), ADR-007 (version-skew policy)

## Method and evidence grading

Version under test: `@actual-app/cli` **26.9.0**, the current `latest` on npm (`npm view @actual-app/cli version` → `26.9.0`; `nightly` is `26.10.0-nightly.20260925`).
Installed into a scratch directory outside the repo and driven with `node ./node_modules/@actual-app/cli/dist/cli.js …` on Node v24.21.0.
The published package ships only a bundled `dist/cli.js`, so the TypeScript sources were read from the upstream tag `v26.9.0` (`gh api repos/actualbudget/actual/contents/packages/cli/src/... ?ref=v26.9.0`) and cross-checked against the bundle.
Bundled `@actual-app/api` internals were read from `node_modules/@actual-app/api/dist/index.js` and the shipped `@types/`.

No Actual server was contacted: docker is unavailable in this devcontainer, so every command that needs a live server fails at the connection step by design.
Findings are graded:

- **VERIFIED** — executed here, or read directly in the shipped source / upstream source at `v26.9.0`.
- **DOCUMENTED** — the official docs or the package README say so, and it was not executed.
- **UNKNOWN** — not established; needs a live server.

Sources cited as `file:line` refer to upstream `packages/cli/` at tag `v26.9.0`, or to the installed `node_modules/@actual-app/api/dist/index.js` where noted.
Doc sources are <https://actualbudget.org/docs/api/cli/> and the package's own `README.md` (shipped inside the npm tarball, and materially longer than the website page).

## 1. Cache TTL and read-after-write

**A write followed by a read observes the write. VERIFIED (source).**

The whole cache decision is one pure function, `decideSyncAction` (`src/cache.ts:88-107`), called once per invocation from `withConnection` (`src/connection.ts:91-101`).
Its inputs are the persisted cache state, the TTL, and two booleans: `mutates` (set per command) and `refresh`.

- A **mutating** command (`transactions import`, `transactions add`, `transactions update`, `rules create/update/delete`, …) can never take the `skip` branch: `if (mutates || refresh || ttlMs === 0 || encrypted) return { action: 'sync', state }` (`src/cache.ts:100-102`).
  It therefore syncs with the server *before* the write, and `withConnection` syncs again *after* it (`src/connection.ts:140-146`), then bumps `lastSyncedAt` to now.
  Upstream's own unit test asserts exactly this: `it('write command syncs before and after the callback, even when fresh')` expects `api.sync` to have been called twice (`src/connection.test.ts:121-133`).
- A **read** inside the TTL takes the `skip` branch, which still calls `api.loadBudget(state.budgetId)` and only omits the network `api.sync()` (`src/connection.ts:123-131`; `src/connection.test.ts:92-105`).

The key point is that "cached" here means *the local SQLite budget in `dataDir`*, not a cached response.
The preceding write mutated that same local budget on disk (the `mutates` path writes locally and then pushes), so the following read loads a file that already contains it.
Skipping the sync skips the network round-trip, not the local data.
So the reconciled-skip flow's read → update → re-read sequence cannot fail to see its own updates, regardless of TTL.

**What the TTL *can* hide is other writers, and that is the real hazard for this project. VERIFIED (source).**

Within the TTL a read does not sync, so changes made on the server since the last sync are invisible — including a reconciliation the human just performed in the Actual web UI, and including anything a bank-sync job wrote.
The importer's reconciliation boundary is derived from exactly that kind of state, so the read that establishes the boundary must not be served from a stale cache.
Mitigations, all first-class flags (`README.md`, *Caching*; `src/config.ts:214`):

- `--refresh` (alias `--no-cache`) forces a sync for one call (`src/connection.test.ts:135-147`).
- `--cache-ttl 0` disables the skip branch entirely (`src/cache.ts:100`).
- `actual sync` once up front, then reads within the TTL; `actual sync --status` reports `ageSeconds` and a `stale` boolean (`src/commands/sync.ts:46-79`).

Recommendation for the importer: `--refresh` (or a leading `actual sync`) on the first read of a run, default TTL thereafter.

**Local writes are not silently discarded. VERIFIED (source).**

Two edge cases are worth recording, because both looked dangerous and turn out not to be.

- `decideSyncAction` returns `download` when the cache-state file is missing or its `syncId`/`serverUrl` differ (`src/cache.ts:96-99`), and `download` calls `api.downloadBudget`.
  But `api/download-budget` checks for an existing local budget with that `groupId` first, and if there is one it just loads it and syncs — it does not re-fetch or overwrite (`@actual-app/api/dist/index.js:112097-112122`).
  Unsynced local changes are pushed, not lost.
- `actual sync --clear` deletes only `state.json`, via `rmSync(join(meta, CACHE_FILE_NAME))` (`src/commands/sync.ts:81-96`); the budget database itself stays.

Cache-state writes are deliberately best-effort and swallow errors (`src/cache.ts:56-71`), so a read-only `dataDir` degrades to "sync every time" rather than failing.

**Concurrency. VERIFIED (source), DOCUMENTED for the wait behaviour.**

Reads take a shared lock and writes an exclusive lock on the per-budget meta directory, implemented over `proper-lockfile` plus a reader-marker directory with stale-PID sweeping (`src/lock.ts`).
Waiting longer than `--lock-timeout` (default 10s) fails with `Another CLI process is holding the budget (waited Ns). Retry, or use a different --data-dir.` (`src/lock.ts:50-55`).
`--no-lock` / `ACTUAL_NO_LOCK=1` opts out.

## 2. Auth and config for a self-hosted server

**Secrets can stay out of argv today via environment variables. VERIFIED (executed).**

Resolution order is flags → env → cosmiconfig file → defaults (`src/config.ts:147-235`), matching the README.
For a self-hosted server the minimum is `ACTUAL_SERVER_URL` plus either `ACTUAL_PASSWORD` or `ACTUAL_SESSION_TOKEN`, plus `ACTUAL_SYNC_ID` for every command except `server version`.
Missing pieces fail fast and specifically, before any network access:

```
Error: Server URL is required. Set --server-url, ACTUAL_SERVER_URL env var, or serverUrl in config file.
Error: Authentication required. Set --password/--session-token, ACTUAL_PASSWORD/ACTUAL_SESSION_TOKEN env var, or password/sessionToken in config file.
```

Executed checks:

- `ACTUAL_SERVER_URL` + `ACTUAL_PASSWORD` + `ACTUAL_SYNC_ID` in the environment, nothing on argv: the CLI proceeds to the login attempt (`Connecting to http://…` with `--verbose`, then a connection error), so the env password was picked up.
- The password never appears in stdout or stderr, including under `--verbose` (grep for the value: 0 matches).
- `--password argvsecret` is of course world-readable in `/proc/<pid>/cmdline` for the process lifetime — confirmed by reading it — so flags are the wrong channel on a shared host.
- A config file is found in the working directory *and from a subdirectory* (cosmiconfig `searchStrategy: 'global'`, so it walks up towards `$HOME`), and an `"actual"` key in a `package.json` anywhere up that chain is read as configuration (`src/config.ts:110-122`; both executed).
- Unknown config-file keys are rejected outright: `Error: Invalid config file: unknown key "bogusKey"` (`src/config.ts:69-104`, executed).

Two consequences worth flagging for this repo:
running the CLI from the repo root means *this repo's* `package.json` is inspected for an `actual` key, and because unknown keys hard-fail, an unrelated `actual` key there would break every invocation.
Config-file secrets are plaintext; the README explicitly advises against them and recommends env vars or a session token, with mode 600 and `.gitignore` if used anyway.

**Secret *files* (`ACTUAL_PASSWORD_FILE`) are documented but not released. VERIFIED (source) — a docs/release skew.**

The docs page lists `ACTUAL_PASSWORD_FILE` and `ACTUAL_SESSION_TOKEN_FILE` under a `_FILE` suffix convention.
That support exists on `master` (`readFileEnv`, `src/config.ts:133-197` on `master`, covering `ACTUAL_PASSWORD_FILE`, `ACTUAL_SESSION_TOKEN_FILE`, `ACTUAL_ENCRYPTION_PASSWORD_FILE`) but is **absent from 26.9.0**: the released `config.ts` has no `_FILE` handling and the string does not occur anywhere in the shipped bundle.
So a Docker/systemd/podman secret-file mount is only an option from the next release; on 26.9.0 the answer is env vars.

Also relevant to self-hosting: `NODE_TLS_REJECT_UNAUTHORIZED=0` is the documented escape hatch for self-signed certificates (DOCUMENTED, docs page, *Self-Signed SSL Certificates*).
`--encryption-password` / `ACTUAL_ENCRYPTION_PASSWORD` covers end-to-end-encrypted budgets, and an encrypted budget forces a sync on every read (`src/cache.ts:100`, `src/connection.test.ts:149-161`).

## 3. Error surface: exit codes and stderr

**There is exactly one failure exit code, and the import failure channel is partly in *stdout*. VERIFIED (executed + source).**

The top-level handler is four lines: print `Error: ${message}` to stderr, set `process.exitCode = 1` (`src/index.ts:73-89`, identical on `master`).
There is no error taxonomy, no exit-code mapping, and the `code` property that `@actual-app/api` attaches to its errors (`withErrorCode`, e.g. `network-failure`, `token-expired`, `out-of-sync-migrations`; `@actual-app/api/dist/index.js:14082-14084`) is **discarded** — only `err.message` reaches stderr.

Executed matrix, all on 26.9.0:

| Situation | exit | stderr |
| --- | --- | --- |
| no server URL | 1 | `Error: Server URL is required. …` |
| no password/token | 1 | `Error: Authentication required. …` |
| unreachable server | 1 | `Error: Authentication failed: network-failure` |
| bad `--cache-ttl` | 1 | `Error: Invalid --cache-ttl: "-5". Expected a non-negative integer.` |
| unknown command | 1 | `error: unknown command 'frobnicate'` (commander, lowercase `error:`) |
| unknown option | 1 | `error: unknown option '--bogus'` |
| missing required option | 1 | `error: required option '--start <date>' not specified` |
| `--help` | 0 | — |

So **a failed import and a failed connection are not distinguishable by exit code** — both are 1.
They are distinguishable by stderr text, but only by string matching, and the strings are not part of any documented contract.
Connection failures are reasonably identifiable because `@actual-app/api` prefixes them `Authentication failed: …` with a machine-ish suffix (`network-failure`, `invalid-password`, `token-expired`, `server offline or unreachable`; `@actual-app/api/dist/index.js:130060-130068`).

Two sharper findings:

- **Order of operations hides input errors behind connection errors.** `readJsonInput` runs *inside* the `withConnection` callback (`src/commands/transactions.ts:69-98`), so malformed `--data`, a missing `--file`, and even `Cannot use both --data and --file` are all reported as `Error: Authentication failed: network-failure` when the server is down (executed, four separate cases).
  A caller cannot conclude anything about its payload from a failed run until the connection succeeds.
- **A validation failure of an import exits 0 and reports through stdout JSON.** `importTransactions` returns `{ added, updated, updatedPreview, errors: [{ message }] }` (`@actual-app/api/@types/methods.d.ts:61-65`), and the handler converts a thrown `TransactionError` into `errors: [...]` with empty `added`/`updated` rather than rethrowing (`@actual-app/api/dist/index.js:111576-111602`).
  `TransactionError` is currently raised only for non-integer amounts, including in subtransactions (`ibid.:110412-110414`), and any other failure still throws and becomes exit 1.
  Either way, **a wrapper must parse stdout and check `errors.length`; exit code alone is not a sufficient success test.**
  This is not a regression against the current bridge, which already funnels `result.errors ?? []` back to Python (`src/actual_budget_transformer/bridge/actual_api_bridge.ts:205-217`) — but it is a guarantee the CLI's own contract does not spell out.
- **`server version` never fails loudly.** `api.getServerVersion()` returns `{ error: 'no-server' } | { error: 'network-failure' } | { version }` instead of throwing (`@types/methods.d.ts:126-132`; `dist/index.js:130002-130012`), and the command prints `printOutput({ version })` (`src/commands/server.ts:12-24`).
  Output is therefore nested — `{"version":{"version":"26.9.0"}}` on success and `{"version":{"error":"network-failure"}}` on failure, **exit 0 in both cases** (VERIFIED by source; not executed against a live server).

Documented position, for the record: "Non-zero exit codes indicate an error", "Errors are written as plain text to stderr", "Use `--verbose` to enable informational stderr messages" (docs page, *Error Handling*).
`--verbose` output goes to stderr and is prose (`Connecting to …`, `Using cached budget (synced Ns ago)…`, `Pushing changes for …`), so stdout stays clean JSON (`src/connection.ts:21-23`, executed).

## 4. Version skew: does the CLI make ADR-007 moot?

**No. The CLI exposes both version numbers but performs no compatibility check. VERIFIED (source + executed).**

- CLI version: `actual --version` → `26.9.0` (executed). The CLI pins `"@actual-app/api": "26.9.0"` **exactly**, no range (`packages/cli/package.json`), so the CLI version *is* the api version for a given release and no separate `PINNED_API_VERSION` literal is needed.
- Server version: `actual server version` → `api.getServerVersion()`, which GETs `/info` and reads `build.version` — the same endpoint ADR-007's `probeServerVersion` already uses (`@actual-app/api/dist/index.js:130002-130012`).
  It runs with `skipBudget: true`, so it needs a server URL and credentials but no sync ID (`src/commands/server.ts:12-24`).
- There is **no semver comparison, no gate, and no warning** anywhere in `packages/cli/src` — grep over the sources and the bundle finds none, and `withConnection` goes straight from `api.init` to download/sync (`src/connection.ts`).

What the stack *does* have is a post-hoc, protocol-level guard: a sync whose migrations or schema disagree with the server fails with `out-of-sync-migrations`, `out-of-sync-data` or `invalid-schema`, surfaced as `Error: This budget cannot be loaded with this version of the app.` and exit 1 (`@actual-app/api/dist/index.js:111834-111840`, `112136-112140`).
That is **not** the failure ADR-007 guards against.
ADR-007 exists because the *client-ahead* direction succeeds at the api/sync level while breaking the server's bundled web client ("Please update Actual!") — see `docs/archive/2026-05-02-client-ahead-skew-finding.md`.
The CLI migrates the schema forward exactly as the api does, because it *is* the api, so that hazard is unchanged and undetected.

**Conclusion: ADR-007's decision survives a move to the CLI; only its implementation site moves.**
The gate becomes a pre-flight comparison of `actual --version` against `actual server version` before the first mutating command, aborting on `cli > server` and on any unknown/unparseable version — which is cheaper than today's in-bridge gate (no hardcoded literal to keep in sync, and the drift-mitigation note in ADR-007 becomes unnecessary).
Note the parsing gotchas from point 3 when reading `server version`: nested `version` key, and failures reported as `{"version":{"error":…}}` with exit 0.

## 5. Rules

**Full read *and* write access to categorisation rules. VERIFIED (executed help + source).**

`actual rules` exposes `list`, `payee-rules <payeeId>`, `create`, `update`, `delete <id>`, mapping one-to-one onto `api.getRules()`, `api.getPayeeRules(id)`, `api.createRule(rule)`, `api.updateRule(rule)`, `api.deleteRule(id)` (`src/commands/rules.ts`).
`create` prints `{ id }`; `update` and `delete` print `{ success: true }`.
Payloads are the api's rule entities (`Omit<APIRuleEntity,'id'>` for create, full `APIRuleEntity` including `id` for update — `@actual-app/api/@types/methods.d.ts:110-117`), passed via `--data` or `--file` (see point 6).
All three writes are `mutates: true`, so they sync before and after.

Not covered by the CLI: there is no command to *run* rules over existing transactions, and no rule-ordering/stage manipulation beyond whatever the rule entity itself carries.
`transactions add` has `--learn-categories` (payee-to-category learning) but `transactions import` does not expose it (`src/commands/transactions.ts:36-67`).
The exact accepted rule JSON was **not** exercised against a server — shape correctness is UNKNOWN pending a live test.

## 6. Payload size

**`--data` hits a hard argv limit at 128 KiB; `--file` and `--file -` are the answer, and they exist for every JSON-taking command. VERIFIED (executed).**

`transactions import`, `transactions add`, `transactions update`, `rules create`, `rules update` and `query run` all accept `--file <path>`, with `-` meaning stdin, via a shared `readJsonInput` helper (`src/input.ts`; `--help` for each, executed).
`--data` and `--file` are mutually exclusive (`Cannot use both --data and --file`) and one of them is required.

The limit is the OS's per-argument cap, not the CLI's.
Bisected empirically: the largest single `--data` argument accepted is **131071 bytes**; **131072** bytes fails with `E2BIG` before the process even starts — i.e. Linux `MAX_ARG_STRLEN` = 32 × 4096, which `getconf ARG_MAX` (2097152 here) does *not* tell you.
With a realistic transaction shape (date, amount, payee_name, imported_id, notes) that is roughly 800–900 transactions:

| transactions | `--data` bytes | result |
| --- | --- | --- |
| 100 | 15 491 | reached the connection step |
| 500 | 77 891 | reached the connection step |
| 1 000 | 155 891 | `spawn E2BIG` — process never started |
| 20 000 | 3 148 891 | `spawn E2BIG` |

The same payloads via `--file` reached the connection step unimpeded at 1 000, 20 000 and 200 000 transactions (the largest ≈ 21 MB on disk).
So the monthly-batch sizes this project uses are comfortably fine with `--file` and would already be at risk with `--data` at a few hundred transactions.

One caveat for the stdin form: because `readJsonInput` runs after the connection is established, a writer piping into `--file -` must keep the pipe open across login, and a connection failure surfaces to the writer as `EPIPE` (observed while streaming ~31 MB into a run that failed at auth).
Writing a temp file and passing its path avoids that entirely, and is the recommendation.

## Incidental findings that bear on #40

These are not part of the six questions but were established while answering them.

- **No batch update.** `transactions update <id>` takes a single id (`src/commands/transactions.ts:101-118`).
  Updating N transactions means N process launches, each doing `api.init` → `loadBudget` → sync → write → sync → `shutdown`, with an exclusive lock held per invocation.
  The current bridge does all of them inside one long-lived connection.
  This matters for ADR-005's circuit-breaker window: a loop of CLI calls has no shared atomic boundary, so a failure part-way leaves earlier updates applied and pushed.
  It is a cost and a design constraint, not a correctness blocker, but it deserves a decision in #40.
- **`transactions list` requires `--start` and `--end`** — both are `requiredOption`, so there is no open-ended listing (`src/commands/transactions.ts:13-34`, executed).
- **`transactions import` hardcodes `defaultCleared: true`** and exposes no flag for it (`src/commands/transactions.ts:86-93`).
  This matches today's behaviour rather than changing it: the bridge passes no options (`actual_api_bridge.ts:205-207`) and the core default is already `defaultCleared = true` (`@actual-app/api/dist/index.js:110494`).
  Other `reconcileTransactions` options (`updateDates`, `reimportDeleted`, `payeeNameNormalization`, `strictIdChecking`) are **not** reachable through the CLI.
- **`--dry-run` maps to the api's `isPreview`** (`opts.dryRun` → `isPreview`, `@actual-app/api/dist/index.js:130475-130480`) and returns `updatedPreview` entries of shape `{ transaction, existing?, ignored?, tombstone? }`.
  It is still registered as `mutates: true`, so it takes the exclusive lock and syncs before and after — it just does not write.
- **`importTransactions` already refuses to modify a matched transaction that is reconciled**, recording `{ transaction, ignored: true }` in `updatedPreview` and skipping it (`@actual-app/api/dist/index.js:110506-110512`).
  This is api-level behaviour shared with the current bridge, so it is not new — and it is *not* a substitute for the importer's boundary filter, because it only protects existing matched rows, never the *addition* of a new transaction dated inside an already-reconciled range.
- **Node ≥ 22 is required** (`engines` in `package.json`, enforced by `validateNodeVersion()` inside `api.init`); the devcontainer has v24.21.0.
- Installing the CLI pulls `@actual-app/api` + `@actual-app/core` + `better-sqlite3` (a native module): ≈ 209 MB of `node_modules` in the scratch install, versus the repo's existing direct `@actual-app/api` dependency.
  Net dependency change is the CLI shell itself (`commander`, `cosmiconfig`, `cli-table3`, `proper-lockfile`), so the deployment surface barely moves.

## Bottom line for #40

**Nothing found on these six points blocks replacing the bridge.**
Three items become explicit requirements of the replacement rather than objections to it:

1. `--refresh` (or a leading `actual sync`) on the boundary-establishing read, because the default 60s TTL can hide a reconciliation the human just made.
2. The wrapper must treat stdout as part of the error surface — check `errors.length` on import and do not trust exit 0 — and must classify failures by stderr string, since every failure is exit 1.
3. The ADR-007 gate must be reimplemented on top of the CLI (`actual --version` vs `actual server version`); the CLI does not perform it, and its sync-time schema guard does not cover the client-ahead web-client break.

The one item that deserves a real design decision is the absence of a batch update and of a long-lived connection: N single-id `transactions update` invocations cannot share an atomic window the way the current bridge can.
