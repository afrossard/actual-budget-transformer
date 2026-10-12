# Import without review, except into the reconciled period

**Status:** accepted (2026-10-12)

The importer writes every unpaired statement transaction without asking, except one dated before the reconciled-through date, which it does not write and lists in the statement report.
Review, one confirmation per unpaired statement transaction, is still there behind `--review`, and is how a statement transaction dated in the reconciled period gets imported.
This supersedes the principle that nothing is written without a confirmation for that statement transaction, and answers #58: trust was earned by real runs, and a closing balance agreeing (#57) is not a precondition for it.

## Why

Real runs since ADR 0003 needed no correction the confirmations caught: the human imported what was proposed, and every fix was made in Actual afterwards, by deleting the wrong transaction and running again.
A confirmation per statement transaction was paying for a check the statement report already makes visible.

## Trade-off

The reconciled-through date is unreliable on its own day: reconciling in the morning and shopping in the afternoon puts new transactions on that date, so a transaction dated on it is written like any other.
One dated before it is most probably one the human deleted from Actual to import again, and writing it changes a balance already reconciled, which is the one mess harder to clean up than doing it by hand.
Leaving it out costs a re-run with `--review`.

Nothing a statement report lists holds a file back.
A hand-typed transaction with a slip in its amount does not pair, so the bank's copy is written and the hand-typed one is listed as an unpaired Actual transaction, for the human to delete.
Holding back on that would hold back almost every file.

## Consequences

- A run takes several files and directories, one level deep, in the order given, and ends with an import summary; the budget is downloaded once and each file is paired against a fresh read, so overlapping exports pair with what an earlier file wrote.
- A file not recognised, or failing before anything is written for it, is explained in the import summary and the run goes on; a failed write stops it.
- The exit code is non-zero whenever something is not fully in Actual: a file not imported, a failed write, a quit under `--review`, or a statement transaction left out for being in the reconciled period. Distinct codes wait for an unattended setup that needs them.
