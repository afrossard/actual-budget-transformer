# Actual Budget Transformer

Transforms bank statement files into a form Actual Budget can ingest. Two output paths: CSV/XML files for manual import, and **direct import** straight into a self-hosted Actual server. The direct-import path is governed by conservative-automation principles (must never create a mess harder to clean up than doing it by hand).

## Language

### Source side

**Source transaction**:
A transaction parsed from a bank statement file (CAMT.053, UBS CSV). The raw input the importer classifies and decides what to do with.
_Avoid_: row, record, entry

**Imported ID**:
The stable identifier attached to each source transaction so re-runs are idempotent. The bank reference when present; otherwise a deterministic hash of `(date, amount, payee, notes)`. Matches Actual's `imported_id` dedup key.
_Avoid_: dedup key, hash, fingerprint

### Direct-import side

**Reconciliation boundary**:
The date through which an account is considered locked and verified. Defined as the date of the newest reconciled transaction in Actual (`max` over transactions where `reconciled` is truthy) — Actual has no native "last reconciled date" field, so the importer synthesizes it. Source transactions dated on or before the boundary are never imported.
_Avoid_: last reconciled date, reconcile cutoff, lock date

**Bucket**:
The classification outcome assigned to each source transaction on or after the reconciliation boundary. Exactly one of three:
- **Clean** — no matching transaction in Actual; imported normally.
- **Suspicious** — an Actual transaction with the same amount within ±1 day exists, but no confident imported-ID match; imported *with the review category* so the human resolves it.
- **Skip** — the imported ID already exists in Actual; not imported.
_Avoid_: category (means something else in Actual), status, state

**Review category**:
The Actual category assigned to suspicious transactions so they surface for human review in the Actual UI. A configured value (`review_category`, default `"To Review"`) that must already exist in the budget.

**Batch**:
One processing window ending at a boundary — the earlier of a calendar month-end or a CAMT.053 balance checkpoint. Atomic with respect to import: if the circuit breaker trips, none of the batch's transactions are imported.
_Avoid_: chunk, window, group

**Balance checkpoint**:
An official closing balance carried by a CAMT.053 statement (CLBD), used to verify Actual's account balance at a batch boundary. A mismatch stops that account.
_Avoid_: balance point, snapshot

**Circuit breaker**:
The per-account stop rule: if a batch's suspicious count exceeds the configured threshold, abort that account's remaining batches (other accounts continue).
_Avoid_: kill switch, abort threshold

**Blind duplicate**:
An Actual transaction that the bank's copy matches only by amount and date (within ±1 day), with no shared imported ID — so the importer cannot confidently pair them. Covers both a manually-entered transaction and one half of an Actual-linked transfer pair. Always classified suspicious and imported with the review category; the importer never guesses a pairing (per conservative-automation principles).
_Avoid_: collision, near-match, fuzzy duplicate

**Run report**:
The structured result the importer returns for a whole run and renders to the human at the end: per-account imported/skipped counts, plus every case where the importer declined to act on bank data — ignored extra CAMT statements, balance mismatches, and account stops. The governing rule: bank data the tool chose not to import is surfaced here, never silently dropped. (Note: transactions dropped by the reconciliation filter are *not* surfaced individually — the locked range is the human's attested source of truth, and a real omission inside it surfaces during manual reconciliation, not as a per-tx warning.) The importer's primary return value — a live import is "produce the report, then commit"; a dry run is "produce the report, don't commit." Warning sections appear only when non-empty.
_Avoid_: summary, log, output
