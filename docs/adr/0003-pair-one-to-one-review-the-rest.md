# Pair one to one, review only the unpaired

**Status:** accepted (2026-10-04)

The direct import pairs each statement transaction with at most one Actual transaction - by shared imported ID, or by the same amount within ±1 day - and only the unpaired statement transactions go to review.
A pair is accepted without asking, and nothing is written for it.
Dates no longer decide anything: a statement transaction dated inside the reconciled period is reviewed like any other if it has no pair, and only carries a warning that importing it changes a reconciled balance.

## Why

Almost everything in Actual today was typed by hand or imported by other means, so it carries none of this tool's imported IDs.
Reviewing every statement transaction without an ID pair meant walking through a 90-day export of which only a handful are new.
The date rule that kept that noise down (anything dated on or before the newest reconciled transaction was set aside) also set aside transactions that are genuinely missing: one deleted from Actual to be re-imported, or one on the same day as the last reconciled transaction.
A statement transaction Actual does not hold most probably needs importing, whatever its date.

## Trade-off

This supersedes, for direct import, ADR-002's "Skip reconciled" and "Flag, don't guess", and ADR-006's group rule ("5 source tx of 12.50 around Jan 15 and 2 already exist - we cannot know which 2. So the entire group goes to review.").
Under this rule two of those five pair and three are reviewed.

What is given up: when identical transactions sit within a day of each other, the tool may pair the wrong one.
What that costs: the paired Actual transaction keeps its own date, at most one day off the bank's, and no amount or count changes - the unpaired statement transaction is still reviewed, and says which statement transaction took its lookalike.
Reviewing the whole group instead would bring back the noise this decision removes, for a difference that never reaches a balance.

## Consequences

- Review offers import and leave only. Correcting an Actual transaction from the bank's data and forcing a second copy of an already-imported one have nothing left to act on, and go.
- Because nothing is written for a pair made by amount and date, every run pairs it again. Stamping the bank's imported ID onto such a pair would make later runs certain, and would need its own confirmation if it ever comes back.
- The ±1 day window is kept until a real card file shows whether purchase dates sit too far from the booking dates Actual holds.
- Two different bank references never pair on amount and date (added in review of #82): the bank says they are two transactions, and pairing them would take a second purchase of the same amount, the day after one already imported, as already in Actual and never review it.
  Only bank references count, because an ID this tool mints can shift between two exports of one purchase.
- Pairing also runs the other way (#109): every Actual transaction dated within the statement's period that no statement transaction took is an unpaired Actual transaction, listed in the statement report, and a duplicate when a paired one holds its imported ID or its amount within ±1 day.
  So is one holding an imported ID the statement carries, wherever it is dated (#119): a card purchase re-dated to its booking date can sit weeks outside a period that is only the span of the file's transactions.
  Nothing is written for one, so a second holder of an imported ID is shown as a duplicate beside its pair rather than as a pair to fix.
