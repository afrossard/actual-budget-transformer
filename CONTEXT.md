# Actual Budget Transformer

Transforms bank statement files into a form Actual Budget can ingest. Two output paths: CSV/XML files for manual import, and **direct import** straight into a self-hosted Actual server. The direct-import path is governed by conservative-automation principles (must never create a mess harder to clean up than doing it by hand).

## Language

### Statement side

**Statement transaction**:
A transaction as a bank statement file (CAMT.053, UBS CSV) states it: the bank's version, which the importer decides what to do with.
_Avoid_: source transaction, row, record, entry

**Imported ID**:
The stable identifier attached to each statement transaction so re-runs are idempotent. The bank reference when present; otherwise a deterministic hash of `(date, amount, payee, notes)`. Matches Actual's `imported_id` dedup key.
_Avoid_: dedup key, hash, fingerprint

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
A statement transaction and the Actual transaction taken to be the same one: either they share an imported ID, or they have the same amount within ±1 day of each other. Each Actual transaction pairs with at most one statement transaction, so of two identical statement transactions with one counterpart in Actual, one stays unpaired.
_Avoid_: blind duplicate, match, near-match

**Review**:
The human deciding, one at a time, what happens to each unpaired statement transaction. A paired statement transaction is never reviewed: it is already in Actual.

**Statement report**:
What the importer prints for one statement file before any review: how many statement transactions are already in Actual, the ones in Actual that need fixing there, and the ones to review.
_Avoid_: tape, summary
