# Correct the amount from the booked statement

**Status:** accepted (2026-10-18); supersedes ADR 0003's "nothing patches an Actual transaction" and its dropping of corrections from review

When a booked statement transaction and an Actual transaction are paired by imported ID and their amounts differ, the importer sets the Actual transaction's amount to the bank's, unattended.
This is a correction, and it is the only way the importer changes an Actual transaction it did not just write.
Answers #112.

## Why

A foreign-currency card purchase imported while pending is written at its original amount (14.95 USD as -14.95), and books days later at another CHF amount (-12.90).
Since #151 the booked row pairs with the pending one by imported ID, so nothing is written twice, but every such purchase needed a manual amount edit in Actual once it booked.
The bank's booked amount is the fact Actual should follow; an amount that differs from it in Actual is most probably a slip, whoever typed it.

## Rules

- **Amount only.** The date of a card purchase does not move when it books, and the payee is often renamed in Actual by the human or by payee rules, so overwriting it would undo their work.
- **Only a booked statement transaction corrects.** A pending one's amount is not final, so a pending statement transaction whose amount differs from its pair is accepted silently; otherwise running an older export after a newer one would undo a correction.
- **Only a pair made by imported ID.** A pair made by amount and date has equal amounts by definition.
- **A reconciled Actual transaction is corrected only under `--review`**, after a confirmation with a warning, as a statement transaction dated in the reconciled period is imported only there (ADR 0005). Unattended it stays listed to be fixed in Actual.
- **A split is never corrected.** Which part absorbs the difference is the human's choice; it stays listed to be fixed in Actual.
- **Under `--review` each correction is prompted**, correct or leave, as each write is.
- **The exit code is non-zero** whenever a correction is left undone: reconciled, split, or left under review. Actual's balance then disagrees with the bank's, which is "not fully in Actual" (ADR 0005).

## Trade-off

The gateway gains a write that patches an existing Actual transaction, and Actual's API patches a reconciled one without complaint.
The guard that the gateway had no `updateTransaction` at all becomes a guard on what it is called with: an amount, and never a reconciled transaction outside review.
A deliberate amount edit in Actual is overwritten by the next run of an overlapping booked export; we accept that, because the bank is authoritative and the correction is listed in the statement report with both amounts.

## Out of scope

- Deleting a duplicate stays in Actual: which copy to keep is arbitrary, and no real run has produced one.
- Stamping the bank's imported ID onto a pair made by amount and date stays as ADR 0003 left it.
