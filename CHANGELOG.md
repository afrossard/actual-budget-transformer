# Changelog

## 2026-04-04 — CAMT.053 Support & Writer Refactor

Added full support for CAMT.053 (ISO 20022) bank statements as both input and output format, plus several improvements to the UBS cards processor.

### CAMT.053 Input

- New `Camt053Processor` auto-detects `.xml` files with the `camt.053` namespace
- Parser extracts IBAN, amounts, dates (value date), payee, notes, and `AcctSvcrRef`
- Uses `pyiso20022` + `xsdata` for typed dataclass access (not stdlib XML)

### CAMT.053 Output

- New `Camt053Writer` generates valid CAMT.053 XML from any processor's output
- `--format` CLI flag: `csv` (default), `camt053`, or `both`
- Monthly file splitting and deduplication work identically to CSV output

### Transaction References

- `reference` column added to all processors for cross-format dedup and Actual Budget's `imported_id`
- CAMT.053: preserves `AcctSvcrRef` as-is
- UBS account CSV: carries `transaction_number` through as reference
- UBS cards CSV: generates deterministic hash from configurable `reference_columns` with `cumcount()` disambiguator

### UBS Cards Processor

- Pending (unbooked) transactions are now filtered out — prevents duplicates when the booked version appears in a later export
- Footer/summary rows are filtered out
- Fixed card number being read as float
- Fixed deprecated `date_parser` warning
- Added full test coverage

### Writer Refactor

- Extracted `BaseWriter` with shared monthly-split and dedup orchestration
- `CsvWriter` and `Camt053Writer` inherit from `BaseWriter`
- Dedup prefers `reference` when available, falls back to `(transaction_date, payee, debit, credit)`

### Pipeline

- `ProcessingResult.COLUMNS` centralised in `BaseProcessor` with `__post_init__` validation
- `metadata` dict on `ProcessingResult` (carries `account_id`/`iban` for writer dispatch)

### Key Decisions

- **`pyiso20022` over stdlib `xml.etree`** — typed dataclasses, round-trip generation, namespace version tolerance
- **Value date (`ValDt`) over booking date (`BookgDt`)** — more meaningful for budgeting
- **`AcctSvcrRef` for Actual Budget dedup** — it's the only field Actual Budget reads as `imported_id`

---

## 2026-03-27 — Devcontainer & Anonymization

- Isolated Claude Code container setup
- Switched devcontainer shell from bash to zsh with Starship prompt
- Hardened anonymization scripts: salted hashes, date shifting, broader field coverage

---

## 2026-03-23 — CAMT.053 Parser Foundation

- Initial `camt053_parser.py` and `Camt053Processor` (iterations 0-1.4)
- Documented anonymization security requirements

---

## 2025-11-26 — Initial Release

- UBS account CSV processor
- UBS cards CSV processor
- CSV output with monthly splitting and deduplication
- YAML-based configuration with account name mappings
