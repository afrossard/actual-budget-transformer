# Plan: Direct Import into Actual Budget

## Intent

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces — see `archive/adr-002-conservative-automation-principles.md`.

## Status

- **In place:** TS bridge with version-skew gate (ADR-007), Python wrapper, smoke + gate pytest suites, devcontainer Actual profile (server pinned to 26.4.0), bootstrap script (now also creates the `Review` group + `To Review` category). `ActualBudgetImporter` (ADR-002/005/006) wired through `--format actual`; offline unit tests + 6 live-server integration tests passing (smoke / idempotent re-run / suspicious + review category / circuit breaker / balance match / balance mismatch).
- **Decided:** see `archive/adr-001` … `archive/adr-007`.

## Next: prod-readiness gaps

The current suite validates the design we tested (offline logic + wiring against a synthetic budget). It does NOT validate two assumptions that matter most for a real budget — the `reconciled` field name, and the importer's behaviour on data prod accumulates over years. Run on a copy/subset before the real budget.

**Top risks** (in order):

1. **Reconciliation filter unverified end-to-end.** ADR-002's keystone safety guarantee — "never touch reconciled tx" — is filtered on `t.get("reconciled")`. Actual's public docs document `cleared`, not `reconciled`; we picked the field name from internal type definitions. The bridge has no `update_transaction` command, so we can't mark a tx reconciled in the test budget to verify. On prod with years of reconciled history, a wrong/missing field name silently breaks the guarantee.
2. **No dry-run mode.** First-time prod use is unrehearsed: classify → import → sync either commits or it doesn't. Add `--dry-run` that runs classification, logs `would import N clean / M suspicious / K skipped` per batch, and skips `importTransactions`/`sync`.
3. **Real CAMT against the importer is untested.** The processor has been chewing on real CAMT for the CSV path for months, but the CLBD-extraction → `BalanceCheckpoint` → in-bridge balance verification is fresh. Live balance math against real history is the assertion that matters.

**Medium risks**:

4. **Transfers between accounts.** Actual links transfers as paired entries. The importer treats each side independently. If Actual already has the transfer and we import the bank's debit/credit copy, classification flags it suspicious — but the interaction with Actual's transfer-pair invariant is untested.
5. **Manually-entered tx (no `imported_id`) with same amount/date.** Suspicious path imports a *new* tx with the review category alongside the manual one → user has two visually-duplicate rows to clean up. Not destructive but messy.
6. **`imported_id` hash drift.** When `reference` is empty, hash = `(date, amount, payee, notes)`. Banks reformat descriptions between exports → same logical tx, different hash. Bucket classification still catches it via amount/date, but a re-export of an entire month could flip many tx into "suspicious" → trip the breaker → abort.

**Low risks**:

7. Bridge subprocess has no read timeout — a stalled sync hangs indefinitely (Ctrl-C works).
8. Float→cents rounding in `BalanceCheckpoint.amount` could miss by 1 cent on degenerate decimals; bank-provided amounts make this unlikely.
9. Multi-statement CAMT (`stmt[1+]`) is silently ignored — we only read `stmt[0]`.

**Pre-prod checklist** (in order — earlier items unblock later ones):

- [ ] Read-only probe against the prod budget: dump one tx with `bridge.get_transactions(...)` and confirm the `reconciled` key exists and is populated as expected. Settles risk #1.
- [ ] Add `--dry-run` flag. Settles risk #2.
- [ ] Run `--dry-run` on one month of the smallest account; eyeball the log.
- [ ] Live-run that same month; verify in the Actual UI before scaling up.
- [ ] Add a test fixture for the reconciled-tx skip path (requires extending the bridge with `update_transaction` to mark a seed tx reconciled).
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
