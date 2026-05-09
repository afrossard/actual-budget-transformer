# ADR-002: Conservative-automation principles for direct import

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

The user's manual import workflow is deliberate: one month at a time, check the reconciliation boundary, manually review duplicates. Actual's built-in dedup (`importTransactions`) is not fully reliable — particularly for transactions without a bank reference. An automated path must never create a mess that's harder to clean up than doing it by hand.

## Decision

Direct import is governed by these principles:

- **Skip reconciled.** Transactions before the account's last reconciled date are locked and verified — never touched.
- **Flag, don't guess.** Uncertain matches go to async human review, not silent merge.
- **Stop early.** Per-account circuit breaker: if a monthly batch's suspicious count exceeds threshold, abort that account's batch (don't import the clean ones either — keep batches atomic). Other accounts continue.
- **Monthly batches.** Manageable review windows and clear resume points.
- **Log everything.** Imported, flagged, skipped, where it stopped — both for diagnostics and for trust.
- **Resume safely.** Re-running is idempotent: already-imported tx skipped by `imported_id`; monthly batching ensures only unprocessed months retry; circuit-breaker stops avoid partial-import tangles.

## Consequences

- The importer must query reconciliation state and existing transactions before deciding what to write.
- Bucket classification (ADR-006) and batch boundaries (ADR-005) follow from these principles.
- The user is the loop: review categories surface flagged tx in the Actual UI; the next run picks up where the previous one stopped.
