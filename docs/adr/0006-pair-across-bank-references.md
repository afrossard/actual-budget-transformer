# Pair across two different bank references

**Status:** accepted (2026-10-18); supersedes ADR 0003's "Two different bank references never pair on amount and date"

A statement transaction pairs on amount and date with an Actual transaction holding another bank reference, as it does with one holding a minted ID or none.
A UBS account CSV row with no booking date is pending: it carries no imported ID, and its provisional transaction number is cut from its notes.

## Why

UBS gives an account CSV row a provisional transaction number while it is pending, and another one once it is booked (#147).
Two overlapping exports therefore state one transaction under two references, and the block on pairing them wrote both copies.

The block existed for #82's case: a second purchase of the same amount, the day after one already imported, must not be taken as already in Actual.
It is no longer needed for that.
The human never edits a bank transaction's date or amount in Actual, because the goal is equivalence between the bank and Actual, so amount-and-date pairing is reliable.
And the classifier still handles #82's case without it: pairs by shared imported ID come first, so the first purchase takes its own Actual transaction and the second finds none left.

Keeping the block and only blanking the pending row's imported ID would fix this one export format, and keep a rule whose only remaining effect is this bug.

## Trade-off

#82's case relies on the first purchase being in the file too, to take its own Actual transaction by imported ID.
Exports overlap by weeks, so only a file that starts the day after the previous one ended would miss it, and the second purchase would then pair with the first.

## Consequences

- The `other-reference` lookalike goes, and an Actual transaction under another bank reference can be a duplicate.
- A pending account row is written unattended, as a pending card purchase is, and `--review` warns that its amount may change when booked.
- When the booked row later pairs with it, the Actual transaction is left as it is.
  Actual resolves a payee name without regard to case, so the pending row's CAPS name and the booked row's Title Case name map to one payee, and the budget's rules can fix a spacing change.
- The provisional number is removed from the notes as an exact value the row itself carries; nothing around it is guessed at.
