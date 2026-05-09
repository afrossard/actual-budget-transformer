# ADR-003: Standalone `ActualBudgetImporter`, not a `BaseWriter` subclass

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

Existing output formats (CSV, CAMT.053) inherit from `BaseWriter`, whose `save_monthly()` orchestrates monthly splitting and read-back-based deduplication against files on disk. Direct import to an Actual server has different shape: no files, network calls, server-side state, batching tied to balance checkpoints.

## Decision

`ActualBudgetImporter` is its own class in `writers/actual_budget_importer.py`, not a `BaseWriter` subclass. `main.py` adds a small branch: when `--format actual` is chosen, build the importer and run it as a context manager around single-file or directory processing; skip the writer path entirely.

Connection lifecycle: a single `Actual` connection per CLI invocation, reused across files in directory mode.

## Consequences

- No forced conformance to a file-oriented base class.
- Account name resolution reuses the existing `account_names` config, mapping `output_prefix` → Actual account name. Unknown account → fail clearly with the available list.
- CLI: `"actual"` joins `--format` choices; `--output` is optional/ignored when chosen.
- Config: new `actual_budget` YAML section; env vars (`ACTUAL_BUDGET_URL`, `ACTUAL_BUDGET_PASSWORD`, `ACTUAL_BUDGET_FILE`) override sensitive values.
