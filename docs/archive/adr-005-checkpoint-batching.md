# ADR-005: Checkpoint-based batching with inline balance verification

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

The conservative-automation principles (ADR-002) require monthly batches and cheap stop-points. CAMT.053 statements carry official balance checkpoints; we should use them when present rather than ignore them.

## Decision

**Batch boundaries** end at the first of:

- end of calendar month, or
- next CAMT.053 statement balance checkpoint.

After each batch commits, compare Actual's account balance at the boundary against the CAMT balance.

- **Match** → continue.
- **Mismatch** → stop this account so the user can fix the small recent gap before resuming. Other accounts continue.
- **No CAMT data** → pure monthly batching, no inline check.

**Reconciliation boundary.** Query the account's last reconciled date; skip everything before it (locked and verified — see ADR-002).

CSV files have balance fields, but they've been empty in practice. Support if populated; don't depend on them.

## Consequences

- Batching logic must merge month-end with the (possibly empty) checkpoint set per account.
- Each batch is atomic with respect to imports (see ADR-002 circuit-breaker note): if balance verification fails, the batch already committed — but the *next* batch is what gets gated, so the user resolves a small recent slice rather than a month-wide tangle.
- `getAccountBalance(id, cutoff)` is the API call that makes the inline check possible.
