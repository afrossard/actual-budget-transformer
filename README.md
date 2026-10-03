# CLI program to transform bank statements into formats understood by Actual Budget

See [Actual Budget](https://actualbudget.org/)

## Supported input formats

- UBS Switzerland e-banking
  - Account transactions CSV files
  - Credit card transactions CSV files (pending transactions are automatically skipped)
- CAMT.053 (ISO 20022 XML bank statements)

## Two ways to get transactions into Actual

**Direct import** (`npm run import`) reads a statement and writes into a self-hosted Actual server, asking about every transaction first.
It is the path being built out, and it currently covers the two UBS CSV formats.

**File output** (`--format csv|camt053|both`) writes files you then import through Actual's own dialog.
This is the original path and still covers CAMT.053.

### Direct import

```bash
npm ci
read -s ACTUAL_BUDGET_PASSWORD && export ACTUAL_BUDGET_PASSWORD # Sets a password without leaving traces in shell history
ACTUAL_BUDGET_URL=http://localhost:5006 npm run import -- -c config.yaml statement.csv
```

It reads the account from the file, reads the account's history from Actual, and classifies every transaction once into one of four buckets:

| Bucket         | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| **clean**      | nothing in Actual looks like it                                                |
| **suspicious** | something does — same amount within a day — but not confidently enough to pair |
| **skip**       | its imported ID is already in Actual; nothing left to do                       |
| **locked**     | dated on or before the newest reconciled transaction                           |

It then prints one line per transaction — the Tape — and prompts on **every** row, including the ones it is declining, showing what each matched and why.
Four answers: **i**mport it, **c**orrect the matched transaction from the bank's data, **l**eave it, or **f**orce a separate transaction. `?` shows the detail and `q` stops the run.

Nothing is written without an answer for that transaction, a correction never changes an amount, and re-running the same file writes nothing — which is also how an interrupted run resumes.

Server settings come from the config's `actual_budget` block, overridden by `ACTUAL_BUDGET_URL`, `ACTUAL_BUDGET_PASSWORD` and `ACTUAL_BUDGET_SYNC_ID`.
The budget is identified by its Sync ID, found in Actual under *Settings → Show advanced settings*, because two budgets on one server can share a name.
The account names in `account_names` must match the account names in your budget.

## Output formats

Use `--format` to select the output format for file output:

| Flag                     | Output             | Use case                                                                      |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------- |
| `--format csv` (default) | CSV files          | Actual Budget CSV import                                                      |
| `--format camt053`       | CAMT.053 XML files | Actual Budget CAMT import (preserves transaction references as `imported_id`) |
| `--format both`          | Both CSV and XML   |                                                                               |

Output files are grouped by account and month (e.g. `202507_personal.csv`). Transactions from different input formats for the same account are merged into a single output file. Re-running with overlapping data deduplicates automatically.

## Usage

### Development setup

```bash
uv sync       # install dependencies
uv run pytest # run tests
```

A convenience script is also available that clears `tmp/output_files/` and processes all files from `tmp/input_files/`:

```bash
bash process_transactions.sh
```

### Installation

Inspiration available in `./devcontainer` or `./Containerfile`.

### Config file

Create a new `config.yaml` based on `config.template.yml`.

Optional: edit the top-level `account_names` section to map your IBANs and card numbers to friendly names. These names are used across all processors and in output filenames.

### CLI

`python -m actual_budget_transformer.main -f <INPUT> -o <OUTPUT_DIR> -c <CONFIG_FILE> --format <FORMAT> -v`

- `INPUT`: path to input file or directory. Any file will be opened and scanned. Supported files are processed, others are ignored. Files can contain overlapping date ranges — the transformer detects duplicates and only outputs unique transactions.
- `OUTPUT_DIR`: location for output files. Transactions are grouped by account and month (e.g. `202507_personal.csv`). Account names are configured in the config file; IBANs and card numbers are used as fallback.
- `CONFIG_FILE`: path to config file.
- `FORMAT`: `csv` (default), `camt053`, or `both`.

### Running with Docker

The following commands allow you to run the application using Docker. They are designed to work both when run directly on your host machine and from within the provided Dev Container.

> **Note on paths:** The commands use `${LOCAL_WORKSPACE_FOLDER:-$PWD}` to correctly resolve the project's path.
>
> - Inside the Dev Container, `LOCAL_WORKSPACE_FOLDER` is automatically set to the project's path on your host machine.
> - Outside the Dev Container, it falls back to `$PWD` (the current working directory).

```bash
docker run --rm -it \
 --user "$(id -u):$(id -g)" \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 ghcr.io/afrossard/actual-budget-transformer-main:main \
 -f /app/input \
 -o /app/output \
 -c /app/config.yaml \
 --format csv \
 -v
```

Or with local build

`docker build -f Containerfile -t actual-budget-transformer:latest .`

```bash
docker run --rm -it \
 --user "$(id -u):$(id -g)" \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 actual-budget-transformer:latest \
 -f /app/input \
 -o /app/output \
 -c /app/config.yaml \
 --format csv \
 -v
```

If you need to debug the container, for instance to check the volume mounts, you can get an interactive shell inside it by overriding the entrypoint:

```bash
docker run --rm -it \
 --user "$(id -u):$(id -g)" \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 --entrypoint /bin/bash \
 actual-budget-transformer:latest
```

## Known limitations

- **Don't mix input formats for the same account**: CAMT and CSV exports from the same bank account use different languages (e.g. French vs English), merchant names, and reference schemes. The deduplication logic cannot reliably match the same transaction across formats. Pick one input format per account.

- **Actual Budget CAMT import preview**: When importing generated CAMT.053 files into Actual Budget, the import dialog may not show the duplicate-detection preview (matched/skipped transactions) that CSV import shows. This is a [bug in Actual Budget's import UI](https://github.com/actualbudget/actual/blob/master/packages/desktop-client/src/components/modals/ImportTransactionsModal/ImportTransactionsModal.tsx) where CAMT files are not treated as pre-parsed for date handling in the preview path. The transactions themselves import correctly with proper `imported_id` for deduplication.

## Test data

Real bank statement files can be anonymized before committing as test fixtures using the provided scripts. They replace sensitive fields with deterministic fakes (same input → same output) while preserving amounts, dates, and structure.

### Salt setup

The scripts require a secret salt to make the hashes irreversible. Generate one and set it for the session:

```bash
# Generate a strong salt (copy the output to a password manager)
python -c "import secrets; print(secrets.token_hex(32))"

# Set it for the current shell session (not saved to history)
read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
```

If `ANONYMIZE_SALT` is not set, the scripts will prompt interactively.

### CAMT.053 XML files

Replaces IBANs, names, addresses, postal codes, BIC codes, and remittance text. IBANs in filenames are also replaced.

```bash
for f in /path/to/real/exports/*.xml; do
    python scripts/anonymize_camt.py "$f" tests/data/
done
```

### UBS cards CSV files

Replaces account number, card number, cardholder name, merchant names, and sector. Footer/summary lines are preserved as-is.

```bash
python scripts/anonymize_ubs_cards.py /path/to/real/cards.csv tests/data/ubs_cards_valid.csv
```

### UBS account CSV files

Replaces account number, IBAN, transaction reference, and description fields.

```bash
python scripts/anonymize_ubs_csv.py /path/to/real/account.csv tests/data/ubs_valid.csv
```

## Debug

### Docker multi-stage build

`docker build -f Containerfile --target builder -t actual-budget-transformer-builder-stage:latest .`
