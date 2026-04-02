# CLAUDE.md — Contributor Guide for LLMs

> **Note for LLMs:** This file is the persistent memory for this project. Running in a devcontainer means any memory written outside the repo will not survive a restart. Always persist valuable context (decisions, progress, conventions) here or in `PLAN.md` — not in `~/.claude/`.


## Project purpose

CLI tool that transforms bank statement files into CSV files compatible with [Actual Budget](https://actualbudget.org/). Input files are detected automatically; output is grouped by account, year, and month, with deduplication across overlapping exports.

---

## Architecture

### Processor pattern

Each input format is handled by a **processor** — a class that:
1. Declares whether it can handle a given file (`can_process`)
2. Parses the file and returns a normalised `ProcessingResult`

All processors live in `src/actual_budget_transformer/processors/` and inherit from `BaseProcessor`.

```
src/actual_budget_transformer/
├── main.py               # CLI entry point; orchestrates file discovery and output
├── factory.py            # Processor registry; auto-selects processor per file
├── config.py             # YAML config loader with singleton cache
├── logging_config.py     # Shared logger
└── processors/
    ├── base_processor.py                       # Abstract base + ProcessingResult dataclass
    ├── ubs_csv_transaction_processor.py        # UBS account CSV
    └── ubs_cards_csv_transaction_processor.py  # UBS card CSV
```

### Output contract

Every processor must return a `ProcessingResult` with:
- `data`: a `pandas.DataFrame` with exactly these columns: `transaction_date`, `payee`, `notes`, `debit`, `credit`
- `output_prefix`: a string used as the suffix of output filenames (e.g. `ubs_personal` → `202501_ubs_personal.csv`)

---

## How to add a new processor

1. **Create** `src/actual_budget_transformer/processors/my_format_processor.py` inheriting `BaseProcessor`.
2. **Implement** `can_process(cls, file_path) -> bool` — inspect the file (extension, header bytes, first lines) without raising.
3. **Implement** `process(self, file_path) -> ProcessingResult` — parse and return the normalised DataFrame.
4. **Register** the class in `factory.py` by appending it to the `PROCESSORS` list.
5. **Add processor config** to `config.template.yml` under `processors.my_format` if needed.
6. **Add test data** under `tests/data/` and tests in `tests/test_my_format_processor.py`.

### `can_process` conventions

- Return `False` silently for unrecognised files — never raise.
- Check cheapest signals first (extension, then first bytes/lines).
- Log rejections at `DEBUG` level with a reason.

### Config access

Use helpers from `config.py`:
```python
from actual_budget_transformer.config import get_processor_config, get_account_name

config = get_processor_config("my_format")   # reads processors.my_format from YAML
```

---

## Configuration

`config.template.yml` is the reference. Users copy it to `config.yaml`. Key sections:

- `processors.<name>` — per-processor settings (CSV encoding, expected headers, account name mappings, date formats)
- `output.date_format` — strftime format used in output filenames (default `%Y%m`)

Config is loaded once and cached. The path is resolved in order:
1. `-c` CLI argument
2. `ACTUAL_BUDGET_TRANSFORMER_CONFIG` environment variable

---

## Development setup

```bash
uv sync          # install dependencies into .venv
uv run pytest    # run tests
```

Convenience script (clears output, then processes `tmp/input_files/` → `tmp/output_files/`):
```bash
bash process_transactions.sh
```

---

## Testing

Tests live in `tests/`. Each processor has its own test file. The test config is at `tests/data/test_config.yml` and is loaded via an environment variable set at the top of each test file:

```python
os.environ["ACTUAL_BUDGET_TRANSFORMER_CONFIG"] = os.path.join(DATA_DIR, "test_config.yml")
```

### Anonymizing test data

> **Security rule — mandatory for public repos:** The salt must be high-entropy (generate with `python -c "import secrets; print(secrets.token_hex(32))"`), kept private, and never committed. Without a strong secret salt, hashes are reversible by brute-force: Swiss IBANs, card numbers, and account numbers are finite enumerable sets, so an attacker who knows the algorithm (it's in the repo) can recover the original value.
>
> **Never pass the salt as a CLI argument** — it would appear in shell history and process listings. Set it via the environment variable instead (see below).
>
> For the same reason: **never hardcode fake account identifiers** (IBANs, card numbers) in test source files or fixture filenames. Use semantic fixture names (e.g. `camt_single_debit.xml`) and read identifiers dynamically in tests.

Three scripts are available to anonymize real files before committing them as fixtures. The salt is read from `ANONYMIZE_SALT` (preferred) or prompted interactively.

```bash
# Set the salt for the session without it entering shell history
read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
```

**CAMT.053 XML** (`scripts/anonymize_camt.py`) — replaces IBANs, names, addresses, postal codes, BIC codes, remittance text, and reference IDs. IBANs in the output filename are also replaced.

```bash
for f in /path/to/real/exports/*.xml; do
    python scripts/anonymize_camt.py "$f" tests/data/
done
```

**UBS cards CSV** (`scripts/anonymize_ubs_cards.py`) — replaces account number, card number, cardholder name, merchant names, and sector. Footer/summary lines are preserved as-is.

```bash
python scripts/anonymize_ubs_cards.py /path/to/real/cards.csv tests/data/ubs_cards_anon_1.csv
```

**UBS account CSV** (`scripts/anonymize_ubs_csv.py`) — replaces account number, IBAN, transaction reference, and description fields.

```bash
python scripts/anonymize_ubs_csv.py /path/to/real/account.csv tests/data/ubs_valid.csv
```

---

## Work in progress

Branch `feature/handle-camt-files` adds support for **CAMT.053** (ISO 20022 XML bank statements, used by UBS Switzerland). See `PLAN.md` for the full iteration plan.

**Progress:**
- Iteration 0 ✅ — `pyiso20022` assessed and adopted (runtime dep)
- Iteration 1.1 ✅ — `camt053_parser.py` implemented and tested
- Iteration 1.2 ✅ — `Camt053Processor.can_process` implemented and tested
- Iteration 1.3 ✅ — `Camt053Processor.process()` implemented and tested
- Iteration 1.3b ✅ — `ProcessingResult.COLUMNS` centralised in `BaseProcessor` with `__post_init__` validation
- Iteration 1.3c ✅ — UBS cards processor tests added; also fixed card number read as float bug and deprecated `date_parser` warning
- Iteration 1.4 ✅ — `Camt053Processor` registered in factory; `camt053` section added to `config.template.yml`; factory + integration tests added
- Iteration 2.1 ✅ — `build_camt053_document` implemented in `writers/camt053_writer.py` with roundtrip tests
- Iteration 2.1b ✅ — `reference` column added to pipeline; CAMT preserves `AcctSvcrRef`, UBS CSV carries `transaction_number`, UBS cards generates deterministic hash from configurable `reference_columns`
- Next: Iteration 2.2 — `--format` flag + output integration

**Key decisions:**
- Use `pyiso20022` + `xsdata` for parsing/generating CAMT.053 (not stdlib `xml.etree`)
- Use `ValDt` (value date) over `BookgDt` (booking date) — more meaningful for budgeting

---

## Dependencies

| Package      | Role                                      |
|--------------|-------------------------------------------|
| pandas       | DataFrame parsing & merging               |
| pyyaml       | Config file loading                       |
| pyiso20022   | CAMT.053 typed dataclasses (via xsdata)   |
| pytest       | Test runner (dev only)                    |
| ruff         | Linter & formatter (dev only)             |
