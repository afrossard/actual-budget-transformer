# CAMT.053 Input + Output — Implementation Plan

## Overview

Two new features, implemented in small iterations. Each iteration is independently testable and leaves existing functionality intact.

```
0 (pyiso20022 spike)
        │
        ▼
1.1 (parser utility)  ──┐
                        ├──> 1.2 (can_process) ──> 1.3 (process) ──> 1.4 (factory + config)
2.1 (XML builder)     ──┘                                                      │
                                                                               ▼
                                                              2.2 (--format flag + output) ──> 2.3 (merge/dedup)
```

Iteration 0 gates the rest: its outcome determines whether iterations 1.1 and 2.1 use `pyiso20022` or stdlib `xml.etree.ElementTree`.

1.1 and 2.1 have no dependency on each other and can be done in parallel.

---

## Iteration 0 — pyiso20022 Library Assessment ✅

**Goal:** Decide whether to use [pyiso20022](https://github.com/phoughton/pyiso20022) (typed dataclass API via xsdata) or stdlib `xml.etree.ElementTree` for parsing and generating CAMT.053 files.

**Steps:**

1. Add `pyiso20022` as a dev dependency and install it:
   ```bash
   uv add --dev pyiso20022
   ```

2. Write a short spike script `scripts/spike_pyiso20022.py` that:
   - Parses several of the existing `tests/data/*.xml` fixtures using `pyiso20022`
   - Prints the extracted IBAN, entry count, amounts, and counterparty names for each file
   - Attempts to build a minimal CAMT.053 document and serialise it back to XML

3. Evaluate against these criteria:

   | Criterion | Question | Result |
   |-----------|----------|--------|
   | camt.053 support | Does it parse our test files without errors? | ✅ 52/52 files parsed without errors |
   | Data access | Can we reach `Ntry/Amt`, `CdtDbtInd`, `BookgDt`, `AddtlNtryInf`, `RltdPties` cleanly? | ✅ Typed dataclasses via xsdata — clean attribute access |
   | Generation | Can it produce valid CAMT.053 XML that round-trips through its own parser? | ✅ Round-trip OK |
   | Version tolerance | Does it handle our files' specific namespace version? | ✅ Versions 01–12 available; our files use 08 |
   | Dependency cost | Are `xsdata` + `lxml` acceptable additions to `pyproject.toml`? | ✅ Accepted |

**Decision: use `pyiso20022`.**

- `pyiso20022` and `xsdata[lxml]` moved to runtime dependencies.
- Spike script kept at `scripts/spike_pyiso20022.py` for reference.
- Iterations 1.1 and 2.1 updated below to use the `pyiso20022` / xsdata API instead of stdlib.

**Note on empty payees:** several test entries have `payee=''` because `RltdPties` contains no `Cdtr`/`Dbtr` name. This is a data characteristic, not a library limitation. The processor should handle this gracefully (empty string).

**Key API pattern (parsing):**
```python
from xsdata.formats.dataclass.parsers import XmlParser
from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import Document

parser = XmlParser()
doc = parser.parse(file_path, Document)
stmt = doc.bk_to_cstmr_stmt.stmt[0]
iban = stmt.acct.id.iban
for ntry in stmt.ntry:
    amount = float(ntry.amt.value)
    direction = ntry.cdt_dbt_ind.value        # 'DBIT' or 'CRDT'
    date = ntry.bookg_dt.dt                    # datetime.date
    notes = ntry.addtl_ntry_inf or ""
    tx = ntry.ntry_dtls[0].tx_dtls[0] if ntry.ntry_dtls else None
    payee = ""
    if tx and tx.rltd_pties:
        cdtr = tx.rltd_pties.cdtr
        dbtr = tx.rltd_pties.dbtr
        if cdtr and cdtr.pty and cdtr.pty.nm:
            payee = cdtr.pty.nm
        elif dbtr and dbtr.pty and dbtr.pty.nm:
            payee = dbtr.pty.nm
```

**Key API pattern (generation):**
```python
from xsdata.formats.dataclass.serializers import XmlSerializer
from xsdata.formats.dataclass.serializers.config import SerializerConfig

serializer = XmlSerializer(config=SerializerConfig(pretty_print=True))
xml_str = serializer.render(doc)
```

---

## Feature 1: CAMT.053 Input Processor

### Iteration 1.1 — CAMT.053 Parser Utility ✅

**New file:** `src/actual_budget_transformer/processors/camt053_parser.py`

A standalone `parse_camt053(file_path) -> tuple[str, list[dict]]` function. No processor, no config, no pandas.

Uses `XmlParser` + `pyiso20022.camt.camt_053_001_08.Document` (see API pattern in iteration 0).

Returns `(iban, entries)` where each entry dict has keys: `date` (`datetime.date`), `amount` (`float`), `direction` (`"DBIT"` or `"CRDT"`), `payee` (`str`, empty if absent), `notes` (`str`, from `AddtlNtryInf` falling back to `RmtInf/Ustrd`).

Raises `ValueError` on files that cannot be parsed.

**Tests** (`tests/test_camt053_parser.py`):
- Parse a single-entry debit file → 1 entry, correct IBAN, amount, direction
- Parse a multi-entry file → correct entry count
- Parse a credit file → direction is `CRDT`
- Parse a file with no entries → 0 entries, IBAN still extracted
- Parse a non-XML file → raises `ValueError`

---

### Iteration 1.2 — `can_process` Only ✅

**New file:** `src/actual_budget_transformer/processors/camt053_processor.py`

`Camt053Processor` with `can_process` implemented; `process` raises `NotImplementedError`.

`can_process` logic:
1. Reject if extension is not `.xml`
2. Read only the root element via `iterparse` (cheap — does not load the full file)
3. Return `True` if the namespace contains `camt.053`, `False` on any exception

**Tests** (`tests/test_camt053_processor.py`):
- `can_process` returns `True` for all `.xml` fixtures in `tests/data/`
- `can_process` returns `False` for a `.csv` file
- `can_process` returns `False` for a non-CAMT XML file (e.g. a minimal `<root/>` written to a temp file)
- `can_process` returns `False` for a malformed XML file
- Regression: `UBSCSVTransactionProcessor.can_process` returns `False` for all XML fixtures

---

### Iteration 1.3 — `process()` Method ✅

Implement `process()` in `Camt053Processor` using the parser from 1.1.

Builds a pandas DataFrame with columns `transaction_date`, `payee`, `notes`, `debit`, `credit`:
- `transaction_date`: parsed as `datetime` from `BookgDt/Dt` (`%Y-%m-%d`)
- `payee`: counterparty name from `RltdPties`
- `notes`: `AddtlNtryInf` if present, else `RmtInf/Ustrd`
- `debit`: amount if `CdtDbtInd == DBIT`, else `NaN`
- `credit`: amount if `CdtDbtInd == CRDT`, else `NaN`

Looks up a friendly name via `get_account_name(iban, processor_name="camt053")`.

Returns `ProcessingResult(data=df, output_prefix=f"camt053_{account_name}")`.

Zero-entry case: returns an empty DataFrame with the correct column schema (so `save_monthly_transactions` does not crash).

**Tests** (extend `tests/test_camt053_processor.py`):
- Single-debit file → 1 row, `debit` populated, `credit` is NaN
- Multi-entry file → N rows
- Credit file → `credit` populated, `debit` is NaN
- `output_prefix` is `camt053_<iban>` when no config mapping exists
- `output_prefix` uses the friendly name when one is configured
- Zero-entry file → empty DataFrame with correct columns, no exception
- All existing tests still pass

---

### Iteration 1.3b — Output Columns Contract in `BaseProcessor` ✅

**Motivation:** `OUTPUT_COLUMNS` is duplicated across `camt053_processor.py` and `test_camt053_processor.py`, and implicitly assumed in both CSV processors. Centralising it makes the output contract explicit and single-sourced.

**Changes:**
- `base_processor.py` — add `COLUMNS = ["transaction_date", "payee", "notes", "debit", "credit"]` as a class attribute on `ProcessingResult`, type `data` as `pd.DataFrame`, and add a `__post_init__` that raises `ValueError` if any expected column is missing
- `camt053_processor.py` — remove local `OUTPUT_COLUMNS`, use `ProcessingResult.COLUMNS`
- `ubs_csv_transaction_processor.py` — use `ProcessingResult.COLUMNS` when selecting the final DataFrame columns (replaces the hardcoded list literal)
- `ubs_cards_csv_transaction_processor.py` — same as above
- `test_camt053_processor.py` — remove local `OUTPUT_COLUMNS`, use `ProcessingResult.COLUMNS`

**Tests:** add a test that `ProcessingResult` raises `ValueError` when constructed with a DataFrame missing expected columns. Full suite still passes.

---

### Iteration 1.3c — UBS Cards Processor Tests ✅

**Motivation:** `UBSCardsCSVTransactionProcessor` has no test coverage at all.

**New file:** `tests/test_ubs_cards_csv_transaction_processor.py`

Follows the same pattern as `test_ubs_csv_transaction_processor.py`. Requires adding UBS cards test fixtures to `tests/data/` and a `ubs_cards` section to `tests/data/test_config.yml`.

**Tests:**
- `can_process` returns `True` for a valid UBS cards CSV fixture
- `can_process` returns `False` for a file missing the `sep=;` first line
- `can_process` returns `False` for a file with wrong column headers
- `can_process` returns `False` for a non-CSV file
- `process` returns a `ProcessingResult` with correct columns and at least one row
- `process` uses the friendly name from config when the card number is mapped
- `process` falls back to `card_<number>` when the card number is not mapped

---

### Iteration 1.4 — Factory + Config Wiring ✅

**Files modified:**
- `src/actual_budget_transformer/factory.py` — append `Camt053Processor` to `PROCESSORS`
- `config.template.yml` — add `processors.camt053.account_names` example section
- `tests/data/test_config.yml` — add `camt053` section to suppress config warnings in tests

**Tests** (extend `tests/test_camt053_processor.py`):
- `get_processor_for_file` returns a `Camt053Processor` instance for any XML fixture
- `get_processor_for_file` still returns `UBSCSVTransactionProcessor` / `UBSCardsCSVTransactionProcessor` for CSV fixtures
- Integration: `process_single_file(xml_fixture, output_dir=None)` runs end-to-end without exception

---

## Feature 2: CAMT.053 Output Writer

### Iteration 2.1 — XML Builder Utility ✅

**New file:** `src/actual_budget_transformer/writers/camt053_writer.py`
**New file:** `src/actual_budget_transformer/writers/__init__.py` (empty)

`build_camt053_document(df, iban, currency="CHF") -> str`

Pure function — no file I/O. Takes a DataFrame, returns an XML string.

Uses `pyiso20022` dataclasses + `XmlSerializer` to build and serialise the document (see API pattern in iteration 0).

Produces a `Document` with `BkToCstmrStmt/GrpHdr` (UUID `MsgId`, `CreDtTm`), and a single `Stmt` with:
- `Acct/Id/IBAN`
- `FrToDt` from min/max `transaction_date` in the DataFrame
- One `Ntry` per row: `Amt`, `CdtDbtInd`, `BookgDt/Dt`, `AddtlNtryInf` (notes), and `NtryDtls/TxDtls/RltdPties` with the payee as `Cdtr/Pty/Nm` (debits) or `Dbtr/Pty/Nm` (credits)

**Tests** (`tests/test_camt053_writer.py`):
- Output is valid XML re-parseable by `XmlParser`
- Amount, `CdtDbtInd`, and booking date correctly serialised
- Roundtrip: `build_camt053_document` → `parse_camt053` → entries match input DataFrame
- Empty DataFrame → valid XML with zero `Ntry` elements

---

### Iteration 2.1b — Preserve Transaction References Through the Pipeline ✅

**Goal:** Ensure that transaction reference IDs survive the input→output round-trip. When the output format is CAMT.053, each `Ntry` should carry a meaningful `AcctSvcrRef`. This is critical because Actual Budget uses `AcctSvcrRef` as the sole `imported_id` for deduplication on import ([source](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/transactions/import/xmlcamt2json.ts)). Three scenarios:

| Source | Reference available? | Strategy |
|--------|---------------------|----------|
| CAMT.053 input | Yes — `AcctSvcrRef` (always), sometimes `EndToEndId` | Preserve as-is |
| UBS account CSV | Yes — `transaction_number` column (e.g. `1234563AB9269773`) | Carry through as `AcctSvcrRef` |
| UBS cards CSV | No | Generate a reproducible hash from `(transaction_date, payee, amount, direction)` so the same row always produces the same ID |

**Changes:**

1. **`ProcessingResult.COLUMNS`** — append `"reference"` to the column list (all processors must now include this column)

2. **`camt053_parser.py`** — extract `acct_svcr_ref` from each `Ntry` and include it as a `reference` key in `Camt053Entry`

3. **`camt053_processor.py`** — map `reference` into the DataFrame

4. **`ubs_csv_transaction_processor.py`** — rename `transaction_number` → `reference` in the column mapping instead of discarding it

5. **`ubs_cards_csv_transaction_processor.py`** — generate a reproducible reference via a deterministic hash:
   ```python
   import hashlib
   def _generate_reference(row) -> str:
       key = f"{row['transaction_date']}|{row['payee']}|{row['debit']}|{row['credit']}"
       return hashlib.sha256(key.encode()).hexdigest()[:16]
   ```

6. **`camt053_writer.py`** — if `reference` column is present and non-empty, set `AcctSvcrRef` on the `Ntry` and `Refs/AcctSvcrRef` on the `TxDtls` (Actual Budget only reads `AcctSvcrRef` — `EndToEndId` is ignored, so we don't need to populate it)

7. **`main.py`** — `save_monthly_transactions` (CSV output) includes `reference` in the written columns; existing CSV output gains the column but is otherwise unchanged

**Tests:**
- CAMT parser returns `reference` for each entry
- CAMT processor DataFrame includes `reference` column
- UBS CSV processor carries `transaction_number` through as `reference`
- UBS cards processor generates stable references (same input → same hash)
- UBS cards processor generates distinct references for different rows
- CAMT writer round-trip preserves the original reference
- CAMT writer with empty reference produces valid XML (no `AcctSvcrRef`)
- `ProcessingResult` rejects DataFrame missing `reference` column

---

### Iteration 2.2 — `--format` Flag + Output Integration

**Files modified:**
- `src/actual_budget_transformer/processors/base_processor.py` — add `metadata: dict = field(default_factory=dict)` to `ProcessingResult` (non-breaking: defaults to empty dict)
- `src/actual_budget_transformer/processors/camt053_processor.py` — store `{"iban": iban}` in `metadata`
- `src/actual_budget_transformer/main.py`:
  - Add `save_monthly_camt053(df, output_dir, output_prefix, iban)` mirroring `save_monthly_transactions` but writing `.xml` files via `build_camt053_document`
  - Add `--format` CLI argument: choices `csv` (default), `camt053`, `both`
  - Route to `save_monthly_transactions`, `save_monthly_camt053`, or both based on flag

**Tests** (extend `tests/test_camt053_writer.py` or new integration test):
- `save_monthly_camt053` on a 2-row DataFrame writes one `.xml` file in a temp dir
- Written file passes `Camt053Processor.can_process`
- Written file round-trips correctly through `parse_camt053`
- `--format csv` → only `.csv` files produced
- `--format camt053` → only `.xml` files produced
- `--format both` → both produced
- Default (`--format csv`) behaviour unchanged — all existing tests still pass

---

### Iteration 2.3 — Merge/Dedup for CAMT.053 Output

Harden `save_monthly_camt053` to handle the incremental-export scenario (same as the CSV path).

When a monthly `.xml` already exists:
1. Parse the existing file with `parse_camt053`
2. Convert to DataFrame
3. Deduplicate: prefer `reference` when present, fall back to `(transaction_date, payee, debit, credit)`
4. Rebuild with `build_camt053_document` and overwrite

Logs new vs. existing transaction counts using the same `logger.info` pattern as `save_monthly_transactions`.

**Tests**:
- Write 2 entries, call again with same 2 → file still has exactly 2 entries
- Write 2 entries, call with 1 duplicate + 1 new → file has 3 entries
- Merged file still passes `can_process`
- Merged file round-trips correctly through `parse_camt053`

---

## Feature 3: UBS Cards Pending Transaction Handling

### Problem

UBS cards CSV exports include **pending (announced) transactions** at the top of the file. These rows have a `Montant` (original-currency amount) but empty `Débit`/`Crédit` and empty `Ecriture` (booking date). A few days later the same transaction appears booked with `Débit`/`Crédit` populated.

Currently the processor `fillna(0)` on debit/credit, so pending rows become `debit=0, credit=0`. When the booked version appears in a later export, Actual Budget sees two different transactions instead of one updated one — causing duplicates.

Pending rows have `Montant` and original currency but empty `Débit`, `Crédit`, and `Ecriture` columns. Booked rows have all fields populated.

### Iteration 3.1 — Skip Pending Transactions

**Strategy:** Filter out rows where `Débit` and `Crédit` are both empty (i.e. `Ecriture`/booking date is absent). These are not yet final and will appear as booked rows in a future export.

**Files modified:**
- `ubs_cards_csv_transaction_processor.py` — after reading the CSV, drop rows where both `Débit` and `Crédit` are NaN (before the `fillna(0)` call). Log skipped count at INFO level.

**Tests:**
- Process a fixture with pending rows at the top → they are excluded from the result
- Process a fixture with only booked rows → all rows present
- Process a fixture with a mix → only booked rows in output, count matches

### Iteration 3.2 — Stable References for UBS Cards (ties into 2.1b)

With pending rows excluded, the reference hash from iteration 2.1b should be generated from booked transaction data only. This ensures that:
- The same booked transaction always gets the same reference regardless of which export file it came from
- References are stable for Actual Budget's `imported_id` deduplication
- No phantom references from pending rows that later change shape

The `Montant` (original-currency amount) + `Date d'achat` + `Texte comptable` form the most stable identity for a card transaction, since `Débit`/`Crédit` in CHF may differ slightly between exports due to exchange rate changes. The hash should use these original-currency fields:

```python
key = f"{date}|{payee}|{montant}|{monnaie_originale}"
```

**Files modified:**
- `ubs_cards_csv_transaction_processor.py` — pass `Montant` and `Monnaie originale` into the hash (these columns are read but currently discarded)

**Tests:**
- Same transaction in two different exports → same reference
- Different transactions on the same date → different references
