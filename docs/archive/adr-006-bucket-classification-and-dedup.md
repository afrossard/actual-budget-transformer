# ADR-006: Three-bucket classification with conservative dedup

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

ADR-002 commits us to flagging uncertain matches rather than guessing. We need a deterministic rule for deciding what to import, what to flag, and what to skip — applied per source transaction on or after the reconciliation date.

## Decision

Three buckets:

- **Skip** — the source tx has an `imported_id` that already exists in Actual.
- **Suspicious** — flagged for human review (assigned the configured review category).
- **Clean** — imported normally.

### Classification

```
For each source transaction in the batch:
  if transaction has imported_id AND that imported_id exists in Actual → skip
  else:
    existing = Actual transactions matching same amount within ±1 day
    if len(existing) == 0 → clean (import normally)
    else → suspicious (flag entire amount/date group for review)
      Log: "N source tx of {amount} around {date}, M already in Actual — flagging all N for review"
```

### Conservative dedup rationale

Without a reference, we cannot reliably pair source rows to existing rows. Example: 5 source tx of 12.50 around Jan 15 and 2 already exist — we cannot know which 2. So **the entire group goes to review.** Counts are logged so the human resolves fast.

Only matching `imported_id` allows confident skip. We do not use `importTransactions`'s fuzzy fallback (ADR-004 lists the modes; we deliberately ignore (2)).

## Consequences

- The review category is a config value (`review_category`, default `"To Review"`) — must exist in the Actual budget.
- Suspicious-flagged tx still get imported (with the review category) — they are not dropped. The user resolves them in the Actual UI.
- The circuit breaker (ADR-002) observes the suspicious count per batch and aborts if it exceeds the configured threshold (`suspicious_threshold`).
