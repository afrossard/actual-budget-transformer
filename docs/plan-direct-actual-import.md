# Plan: Direct Import into Actual Budget

## Intent

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces — see `archive/adr-002-conservative-automation-principles.md`.

## Status

- **In place:** TS bridge with version-skew gate (ADR-007), Python wrapper, smoke + gate pytest suites, devcontainer Actual profile (server pinned to 26.4.0), bootstrap script. `ActualBudgetImporter` (ADR-002/005/006) wired through `--format actual`; offline unit tests passing.
- **Decided:** see `archive/adr-001` … `archive/adr-007`.

## Next

Integration tests against the live container (none of these can run in the devcontainer — user-driven):

- Direct-import smoke: feed an anonymized CAMT.053 fixture through `--format actual`; assert added/skipped counts and that closing balance matches the CAMT CLBD.
- Re-run idempotency: same input twice → second run reports zero adds, no errors.
- Bucket classification: pre-seed Actual with one tx that matches a CAMT entry by amount/date; expect that source row in the suspicious bucket with the review category, not in clean.
- Circuit breaker: pre-seed > threshold collisions; assert account stops mid-import.
- Balance-mismatch abort: synthesise a CAMT whose CLBD does not match (or remove a tx) and assert the importer aborts the account at the boundary.

When integration tests are green, retire this plan to `archive/`.

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
