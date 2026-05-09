# ADR-004: TS subprocess bridge with JSON-over-stdio

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

ADR-001 commits us to `@actual-app/api` (Node). Python needs to drive it. Options: a long-running Node service, an HTTP/IPC sidecar, or a child-process bridge using stdio.

## Decision

A TypeScript script exposes the JS API as a JSON-over-stdio interface; a Python subprocess sends commands and reads responses. Business logic (batching, classification, circuit breaker) stays in Python; only the Actual protocol handling is delegated.

### JS API surface used

| Need                        | Method                                      | Notes                                                                                                              |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Import transactions         | `importTransactions(accountId, txs, opts?)` | Returns `{ added, updated, errors }`. `imported_id` exact-match dedup + fuzzy fallback. We use `imported_id` only. |
| Query existing transactions | `getTransactions(accountId, start, end)`    | Full tx objects: `imported_id`, `cleared`, `amount`, `date`, `notes`, `category`.                                  |
| List accounts               | `getAccounts()`                             | `id`, `name`, `offbudget`, `closed`, `balance_current`. (No `type` field in 26.x.)                                 |
| Account balance at date     | `getAccountBalance(id, cutoff?)`            | Integer cents at optional cutoff; enables CAMT-checkpoint verification.                                            |
| Assign category             | `category` field on tx objects              | Pass UUID; resolve via `getCategories()` or `getIDByName({ type: 'category', string })`.                           |
| Flexible queries            | `runQuery(query)`                           | ActualQL fallback.                                                                                                 |
| Lookup by name              | `getIDByName({ type, string })`             | Resolve account/payee/category name → UUID.                                                                        |

**Lifecycle:** `init({ serverURL, password, dataDir })` → `downloadBudget(syncId)` (the `groupId` field, not `cloudFileId`) → operations → `sync()` → `shutdown()`.
**Amounts:** integer cents. `$120.30 = 12030`. Helpers: `utils.amountToInteger`, `utils.integerToAmount`.
**Encryption:** pass password to `downloadBudget()`; transparent.

### `importTransactions` dedup details

1. Exact `imported_id` updates.
2. Without it, fuzzy on amount + date + payee.
3. Duplicate `imported_id`s within the same call are NOT deduped against each other.
4. Different `imported_id`s never fuzzy-merge.

We only rely on (1) — see ADR-002 / ADR-006.

## Consequences

- Stdout is the protocol channel; the bridge MUST monkey-patch `console.{log,info,warn,error}` to write to stderr before importing the API (the API writes `[Breadcrumb]` lines to `console.log`).
- Python wraps the subprocess in a context manager (`ActualBridge`) that drains stderr to the project logger and raises `BridgeError` on any non-ok response.
- `getAccountBalance(id, cutoff?)` takes a `Date`, not a string — the bridge converts ISO strings from Python.
- `importTransactions` requires `account` per tx in 26.x — the bridge injects `accountId` automatically; callers don't set it.
- See `bridge-implementation-notes.md` for the full bootstrap-script gotcha list.
