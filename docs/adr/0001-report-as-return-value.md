# Report-as-return-value; dry-run and live import share one path

The direct importer returns a structured **run report** (per-account imported/skipped counts, pre-boundary orphans, stop reasons, balance-check results) instead of side-effecting silently through the log stream. Classification and report-building are a single path: `--dry-run` runs it and stops; a live run runs it and then commits (`importTransactions` + `sync`).

## Considered options

- **Report as return value, shared path (chosen).** Dry-run is "produce the report, don't commit"; live is the same plus commit.
- **Bolt-on end-of-run summary + separate dry-run branch (rejected).** Divergent paths let dry-run and live drift apart, defeating the rehearsal value of dry-run (plan risk #2) — the thing you rehearse wouldn't be the thing you run.

## Consequences

- The human-facing report, not the log stream, is the trusted record of what a run did (the user does not read logs thoroughly every time).
- Warning sections (pre-boundary orphans, account stops, balance mismatches) render only when non-empty, so a clean run is a few tidy lines and a problem run is impossible to miss.
- Every caller and test of the importer now consumes a report object rather than asserting on side effects/log lines.
