# Plan: Direct Import into Actual Budget

## Intent

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces — see `archive/adr-002-conservative-automation-principles.md`.

## Status

- **In place:** TS bridge + Python wrapper + 6-test pytest smoke suite, devcontainer Actual profile, bootstrap script, version-compat rigs.
- **Decided:** see `archive/adr-001` … `adr-007`. Most recent: ADR-007 flips version-skew policy to abort on `api > server` (not yet implemented in the bridge).

## Next

Implement ADR-007's version-skew gate in `src/actual_budget_transformer/bridge/actual_api_bridge.ts`. Add `PINNED_API_VERSION`, semver compare against the server's `/info` version (already fetched in `cmdOpen`), abort on `api > server` or any unknown-version case. Reconcile dev-env afterwards: either bump the devcontainer Actual server pin to ≥ the API version, or run the smoke test with `ACTUAL_API_VERSION=25.3.1`.

After that, build `ActualBudgetImporter` in `src/actual_budget_transformer/writers/actual_budget_importer.py` (per ADR-002 / ADR-005 / ADR-006):

- Context-managed; holds the bridge connection.
- `import_transactions(result, balance_checkpoints)`:
  1. Resolve account name from `output_prefix`; fail with the available list if missing.
  2. Compute batch boundaries — month-end merged with CAMT balance-checkpoint dates.
  3. Per batch: filter by reconciliation boundary → query existing tx → bucket-classify (skip/suspicious/clean) → check circuit breaker → import clean → import suspicious with review category → balance check at boundary if checkpoint present → log summary.
- Wire into `main.py` (`"actual"` in `--format`, context-managed around single-file/directory processing) and add an `actual_budget` block to `config.template.yml`.

Then unit tests (offline: amount conversion, batch boundaries, bucket classification, circuit breaker, config) and integration tests against the container. Order may change.

## Code in place

- `src/actual_budget_transformer/bridge/actual_api_bridge.ts` — bridge
- `src/actual_budget_transformer/actual_api.py` — Python wrapper
- `tests/test_actual_api_smoke.py` — bridge end-to-end smoke
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
