# Plan: Direct Import into Actual Budget

## Intent

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces — see `archive/adr-002-conservative-automation-principles.md`.

## Status

- **In place:** TS bridge with version-skew gate (ADR-007), Python wrapper, smoke + gate pytest suites, devcontainer Actual profile (server pinned to 26.4.0), bootstrap script (now also creates the `Review` group + `To Review` category). `ActualBudgetImporter` (ADR-002/005/006) wired through `--format actual`; offline unit tests + 6 live-server integration tests passing (smoke / idempotent re-run / suspicious + review category / circuit breaker / balance match / balance mismatch).
- **Decided:** see `archive/adr-001` … `archive/adr-007`.

## Next: prod-readiness gaps

The current suite validates the design we tested (offline logic + wiring against a synthetic budget). It does NOT validate two assumptions that matter most for a real budget — the `reconciled` field name, and the importer's behaviour on data prod accumulates over years. Run on a copy/subset before the real budget.

> **Doc/code drift to clear (found 2026-06-07).** ADR-0001's report-as-return-value design (importer returns a structured run report; `--dry-run` and live share one path) is **decided but unbuilt** — `import_transactions(...)` still returns `None` and communicates only via the logger. This gates checklist item 2: `--dry-run` is "produce the report, don't commit", so the report refactor is its prerequisite. Sequencing: checklist item 1 (reconciled-skip) is independent of the report and lands first; the report refactor must precede `--dry-run`.
>
> **The report's named deliverables** (per the *Run report* definition in `CONTEXT.md` — "bank data the tool chose not to import is surfaced here, never silently dropped"): per-account imported/skipped counts, **pre-boundary orphans**, **ignored extra CAMT statements**, balance mismatches, and account stops. Two of these are *silent drops today* and the report is what closes them — see the reconciliation filter (risk #1, below) and multi-statement CAMT (risk #9). Until the report lands, both remain logger-only gaps, not the intended behaviour.

**Top risks** (in order):

1. **Reconciliation filter unverified end-to-end.** ADR-002's keystone safety guarantee — "never touch reconciled tx" — is filtered on `t.get("reconciled")`. Field name confirmed by typedef inspection: `@actual-app/core/src/types/models/transaction.ts:25` declares `TransactionEntity.reconciled?: boolean` (distinct from `cleared` on line 24). Still unverified end-to-end: whether `getTransactions()` actually surfaces the field at runtime, and the actual skip behavior on a reconciled tx. `updateTransaction(id, fields)` exists in the public API (`@actual-app/api/@types/index.d.ts:171`), so the bridge can be extended to mark a tx reconciled programmatically — no UI dance.

   **Silent-drop gap.** The filter (`actual_budget_importer.py:332`) drops on/before-boundary tx with only a `logger.info` count; it never checks whether a dropped tx is absent from Actual — i.e. it does not detect **pre-boundary orphans** (`CONTEXT.md`). Per the *Pre-boundary orphan* definition these "must be surfaced … rather than silently dropped." The report closes this; until then it's a logger-only gap.
2. **No dry-run mode.** First-time prod use is unrehearsed: classify → import → sync either commits or it doesn't. Add `--dry-run` that runs classification, logs `would import N clean / M suspicious / K skipped` per batch, and skips `importTransactions`/`sync`.
3. **Real CAMT against the importer is untested.** The processor has been chewing on real CAMT for the CSV path for months, but the CLBD-extraction → `BalanceCheckpoint` → in-bridge balance verification is fresh. Live balance math against real history is the assertion that matters.

**Medium risks**:

4. **Transfers between accounts.** Actual links transfers as paired entries. The importer treats each side independently. If Actual already has the transfer and we import the bank's debit/credit copy, classification flags it suspicious — but the interaction with Actual's transfer-pair invariant is untested.
5. **Manually-entered tx (no `imported_id`) with same amount/date.** Suspicious path imports a *new* tx with the review category alongside the manual one → user has two visually-duplicate rows to clean up. Not destructive but messy.
6. **`imported_id` hash drift.** When `reference` is empty, hash = `(date, amount, payee, notes)`. Banks reformat descriptions between exports → same logical tx, different hash. Bucket classification still catches it via amount/date, but a re-export of an entire month could flip many tx into "suspicious" → trip the breaker → abort.

   **Open — needs real-data spike before deciding.** Unknown whether this bites in practice: how often is `reference` actually empty across our CAMT/UBS exports, and does `notes` actually drift between two real exports of the same month? Investigate before choosing a fix.
   - **Measure:** across the real export corpus, what fraction of tx have an empty `reference`? For those, re-export an already-imported month and diff the computed hashes — count how many drift.
   - **If drift is rare/zero:** leave the hash alone; close this out.
   - **If drift is common:** do *not* narrow the hash to `(date, amount)` — that trades visible friction for silent data loss via collisions (two distinct same-day/same-amount tx → second silently skipped). Prefer solving at the report layer: split suspicious into "matches an already-imported tx" (benign drift) vs "matches a manual/unknown tx" (genuine), so a breaker trip on re-export is diagnosable. Plus operational guidance: workflow is monthly-forward, don't re-export an imported month. See discussion in this grill session.

**Low risks**:

7. Bridge subprocess has no read timeout — a stalled sync hangs indefinitely (Ctrl-C works).
8. Float→cents rounding in `BalanceCheckpoint.amount` could miss by 1 cent on degenerate decimals; bank-provided amounts make this unlikely.
9. Multi-statement CAMT (`stmt[1+]`) is ignored — we only read `stmt[0]`. **Currently silent; the report closes this** by surfacing ignored extra statements as a warning section (`CONTEXT.md`, *Run report*). Logger-only until then.

**Pre-prod checklist** (in order — earlier items unblock later ones):

- [ ] Add `update_transaction` to the bridge (generic `{id, fields}` TS command + Python wrapper `update_transaction(tx_id, fields)`) and write an automated integration test for the reconciled-skip path. **Settled design (2026-06-07):** runs on "Test Savings" with deep-past dates to stay reset-free — the reconciliation boundary is account-global persistent server state and cannot be `run_tag`-scoped, so it must sit *below* every other test's date range (convention: real test dates ≥ 2030, deep-past reserved for reconciliation-boundary tests; documented in the integration test docstring). Seed a tx at `2020-06-30`, mark it reconciled via the bridge, then three assertions: **(A)** `getTransactions()` surfaces it with `reconciled` truthy (runtime field-name confirmation); **(B)** a source tx dated `2020-06-15` (≤ boundary) is filtered out; **(C)** a source tx dated `2020-07-15` (> boundary) is imported (control — proves the filter isn't dropping everything). Settles risk #1 and gives a regression guard in one shot.
- [ ] **Report refactor (ADR-0001).** Make `import_transactions` return a structured run report instead of returning `None`. Named deliverables (per `CONTEXT.md` *Run report*): per-account imported/skipped counts; **pre-boundary orphans** (closes the risk #1 silent-drop gap — detect filtered tx absent from Actual); **ignored extra CAMT statements** (closes risk #9); balance mismatches; account stops. Warning sections render only when non-empty. Prerequisite for `--dry-run`.
- [ ] Add `--dry-run` flag. Settles risk #2.
- [ ] Run `--dry-run` on one month of the smallest account; eyeball the log.
- [ ] Live-run that same month; verify in the Actual UI before scaling up.
- [ ] Add a test fixture for transfers (write one side, observe how the linked counter-tx surfaces in `getTransactions`, decide on importer behaviour).

## Code in place

- `src/actual_budget_transformer/bridge/actual_api_bridge.ts` — bridge with version-skew gate
- `src/actual_budget_transformer/actual_api.py` — Python wrapper
- `src/actual_budget_transformer/writers/actual_budget_importer.py` — direct importer (ADR-002/005/006)
- `src/actual_budget_transformer/processors/camt053_parser.py` — now also returns balance entries (OPBD/CLBD/CLAV) for checkpoint batching
- `src/actual_budget_transformer/main.py` — `--format actual` enters the importer once per CLI invocation, lifts CAMT CLBD into checkpoints
- `config.template.yml` — `actual_budget:` block + env-var overrides
- `tests/test_actual_api_smoke.py` — bridge end-to-end smoke (6 cases)
- `tests/test_actual_api_version_gate.py` — version-skew gate (3 cases)
- `tests/test_actual_budget_importer.py` — offline unit tests (amounts, batches, classification, circuit breaker, config)
- `tests/test_actual_budget_importer_integration.py` — live-server integration tests (6 cases)
- `package.json`, `package-lock.json`, `tsconfig.json`

## Archive

Decisions and past test findings live in `archive/`:

- [ADR-001 — JS API over actualpy](archive/adr-001-jsapi-over-actualpy.md)
- [ADR-002 — Conservative-automation principles](archive/adr-002-conservative-automation-principles.md)
- [ADR-003 — Standalone importer (not writer subclass)](archive/adr-003-standalone-importer-not-writer.md)
- [ADR-004 — Bridge architecture](archive/adr-004-bridge-architecture.md)
- [ADR-005 — Checkpoint-based batching with balance verification](archive/adr-005-checkpoint-batching.md)
- [ADR-006 — Bucket classification + dedup](archive/adr-006-bucket-classification-and-dedup.md)
- [ADR-007 — Version-skew policy (abort on `api > server`)](archive/adr-007-version-skew-policy.md)
- [2026-05-02 — Client-ahead skew finding](archive/2026-05-02-client-ahead-skew-finding.md)
- [2026-05-07 — Server-ahead assessment](archive/2026-05-07-server-ahead-assessment.md)
- [Bridge implementation notes (gotchas, test modes)](archive/bridge-implementation-notes.md)
