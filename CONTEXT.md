# Actual Budget Transformer

Imports bank statement files straight into a self-hosted Actual Budget server, one account at a time, writing nothing without a confirmation for that statement transaction.
It is governed by conservative-automation principles: it must never create a mess harder to clean up than doing it by hand.

## Language

### Statement side

**Statement transaction**:
A transaction as a bank statement file (CAMT.053, UBS CSV) states it: the bank's version, which the importer decides what to do with.
_Avoid_: source transaction, row, record, entry

**Imported ID**:
The identifier attached to each statement transaction so a later run pairs it with what an earlier run wrote; stored as Actual's `imported_id`.
The bank's reference where the statement carries one.
Blank where a format that normally carries one did not, because a later export will carry the real one and a minted identifier would never match it.
Minted deterministically only where the bank never supplies one, as on the UBS cards CSV.
_Avoid_: dedup key, hash, fingerprint

**Pending**:
The state of a statement transaction the bank has authorised but not yet booked, as a UBS cards CSV states some card purchases.
Its amount is not final: a purchase in another currency is stated in that currency only, and the booked amount may differ.
_Avoid_: unbooked, provisional, authorisation

### Actual side

**Actual transaction**:
A transaction as the Actual budget holds it, whoever put it there: this importer, another import, or the human by hand.

**Reconciled**:
The state of an Actual transaction the human has attested in Actual's reconcile flow; Actual shows it with a lock icon and asks to unlock it before an edit. Applies only to Actual transactions, never to a statement transaction.
_Avoid_: locked

**Reconciled-through date**:
The date of the newest reconciled Actual transaction in an account. Importing a statement transaction dated on or before it changes a balance the human already reconciled. Not Actual's own `last_reconciled`, which records when the reconcile flow was last completed, not up to which transaction date.
_Avoid_: reconciliation boundary, last reconciled date, lock date

### Direct-import side

**Pair**:
A statement transaction and the Actual transaction taken to be the same one: either they share an imported ID, or they have the same amount within ±1 day of each other and do not carry two different bank references. Each Actual transaction pairs with at most one statement transaction, so of two identical statement transactions with one counterpart in Actual, one stays unpaired.
_Avoid_: blind duplicate, match, near-match

**Unpaired Actual transaction**:
An Actual transaction in the statement's account that no statement transaction pairs with, and either is dated within the statement's period or holds an imported ID the statement carries, wherever it is dated. The statement's period is the one the file states, or else its first to last statement transaction date, so a statement with no transactions has one only if it states it; a holder of an imported ID is found wherever it now sits, so the period does not bound it. The bank does not hold it as Actual does, so it is listed in the statement report to be fixed in Actual.
_Avoid_: orphan, extra, stray, unmatched

**Duplicate**:
An unpaired Actual transaction that holds the imported ID of a paired Actual transaction, or has the same amount within ±1 day of one. The statement holds the transaction once and Actual holds it twice; which copy the pairing took is arbitrary, so both are shown and the human deletes one in Actual.

**Review**:
The human deciding, one at a time, what happens to each unpaired statement transaction. A paired statement transaction is never reviewed: it is already in Actual.

**Statement report**:
What the importer prints for one statement file before any review: the statement's period and how many of its statement transactions are already in Actual, the pairs that need fixing in Actual, the unpaired Actual transactions, and the statement transactions to review.
_Avoid_: tape, summary
