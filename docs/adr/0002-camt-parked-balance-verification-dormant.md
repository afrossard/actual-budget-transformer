# CAMT.053 parked; balance verification dormant

**Status:** accepted (2026-06-15); amended 2026-10-04

> **Amended by #41 (2026-10-04).** The Python package is deleted, and with it the CAMT.053 code and ADR-005's balance-verification machinery that this ADR kept in place.
> CAMT.053 stays parked, and balance correctness still falls to manual reconciliation.
> What no longer holds is the *Reversible* consequence below: unparking CAMT, or verifying balances (#57), now means building it in TypeScript rather than re-activating dormant code.
> The last Python image still reads and writes CAMT.053 as a file-output fallback (see README).

The active direct-import workflow is UBS CSV only (account + cards). CAMT.053 is **parked** — the user no longer downloads it (too annoying). Its code stays in place but is off the prod-readiness path. As a direct consequence, **inline balance verification (ADR-005's second half) is dormant**: `BalanceCheckpoint`s were only ever produced from CAMT CLBD, and the UBS account CSV — which used to carry a running balance — now delivers that column as nulls, so no active input path yields a checkpoint. Balance correctness therefore falls to **manual reconciliation** in Actual.

## Why record this

The decision is invisible-but-surprising in the code: a future reader finds ADR-005's balance-verification machinery present but never executing, `OPBD` parsed but unused, and the CAMT processors maintained but excluded from the prod path — and would reasonably "fix" what looks like dead code. This ADR marks the deadness as deliberate.

## Trade-off

We gave up the only *automated* end-to-end correctness check (the balance net) in exchange for not maintaining the CAMT path the user has abandoned. The automated safety net is now reconciliation-boundary skip + imported-ID dedup + bucket classification + circuit breaker (ADR-002/006); the balance net is the human's manual reconciliation. The one case this weakens — a bank backdating a posting inside the already-reconciled range — surfaces as a balance discrepancy the human chases during reconciliation, not as an automated stop. Accepted given reconciliation is already a deliberate manual step in this workflow.

## Consequences

- ADR-005 is half-dormant: monthly batching still provides atomic circuit-breaker windows; its balance-verification purpose is inert until a checkpoint source returns.
- The pre-prod `--dry-run` balance-simulation decision (plan, 2026-06-15) is likewise moot until then.
- **Reversible:** if a checkpoint source reappears (CAMT unparked, or a CSV balance returns), the dormant machinery re-activates with no structural change. Unparking CAMT also reopens the unresolved multi-statement question (risk #9).
