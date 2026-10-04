# CLI program to import bank statements into Actual Budget

See [Actual Budget](https://actualbudget.org/)

## Supported input formats

- UBS Switzerland e-banking
  - Account transactions CSV files
  - Credit card transactions CSV files (pending transactions are automatically skipped)

## Direct import

```bash
npm ci
read -s ACTUAL_BUDGET_PASSWORD && export ACTUAL_BUDGET_PASSWORD # Sets a password without leaving traces in shell history
ACTUAL_BUDGET_URL=http://localhost:5006 npm run import -- -c config.yaml statement.csv
```

It reads the account from the file, reads from Actual what each statement transaction could pair with, and pairs each one once.
A pair is the Actual transaction that shares its imported ID, or failing that one with the same amount within a day, unless the two carry different bank references; each Actual transaction pairs at most once.

A paired statement transaction is already in Actual, so it is never asked about and nothing is written for it.
It then prints a statement report: how many are already in Actual, the pairs Actual needs fixed (an amount that differs, or two transactions holding one imported ID), and one line per statement transaction to review.
Only the unpaired ones are reviewed, whatever their date; one dated in your reconciled period carries a warning, because importing it changes a reconciled balance.
Two answers: **i**mport it or **l**eave it. `?` shows the detail and `q` stops the run.

Nothing is written without an answer for that transaction, nothing in Actual is ever changed, and re-running the same file has nothing left to review - which is also how an interrupted run resumes.

Server settings come from the config's `actual_budget` block, overridden by `ACTUAL_BUDGET_URL`, `ACTUAL_BUDGET_PASSWORD` and `ACTUAL_BUDGET_SYNC_ID`.
The budget is identified by its Sync ID, found in Actual under *Settings → Show advanced settings*, because two budgets on one server can share a name.
*Reset sync* in Actual gives the budget a new Sync ID, so update `sync_id` after using it; until then the import stops and lists the budgets with their current IDs.
The account names in `account_names` must match the account names in your budget.

## Running the image

`ghcr.io/afrossard/actual-budget-transformer:main` carries the same CLI, so Node and `npm ci` are not needed.
`scripts/abt-import` runs it under [msb](https://github.com/superradcompany/microsandbox), with the config and the statement mounted read-only:

```bash
read -s ACTUAL_BUDGET_PASSWORD && export ACTUAL_BUDGET_PASSWORD
scripts/abt-import -c config.yaml statement.csv
```

With docker instead, `-it` gives the prompts a terminal and `--init` lets Ctrl-C through:

```bash
docker run --rm -it --init \
 --user "$(id -u):$(id -g)" \
 -v "$PWD/config.yaml":/abt/config.yaml:ro \
 -v "$PWD/statement.csv":/abt/statement/statement.csv:ro \
 -e ACTUAL_BUDGET_PASSWORD \
 ghcr.io/afrossard/actual-budget-transformer:main \
 -c /abt/config.yaml /abt/statement/statement.csv
```

Inside the container `localhost` is the container itself, so `server_url` must name the server's host as the container sees it.

## Config file

Create a new `config.yaml` based on `config.template.yml`, and pass it with `-c` or `ACTUAL_BUDGET_TRANSFORMER_CONFIG`.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test # integration tests skip themselves without a test server
```

## File output (retired)

Earlier versions wrote CSV and CAMT.053 files to import through Actual's own dialog, and also read CAMT.053.
That Python program has been removed from this repository.
Its last image is kept as a fallback, pinned by digest:

```bash
docker run --rm -it \
 --user "$(id -u):$(id -g)" \
 -v "$PWD/tmp/input_files":/app/input:ro \
 -v "$PWD/tmp/output_files":/app/output \
 -v "$PWD/config.yaml":/app/config.yaml:ro \
 ghcr.io/afrossard/actual-budget-transformer-main@sha256:89a73600137963c83b31a73f751b84c7cf4824150d52a3c61f9168f02a2043e8 \
 -f /app/input \
 -o /app/output \
 -c /app/config.yaml \
 --format csv \
 -v
```

`--format` takes `csv` (default), `camt053` or `both`.
Output files are grouped by account and month (e.g. `202507_personal.csv`), and re-running with overlapping input deduplicates.

## Test data

Real bank statement files can be anonymized before committing as test fixtures using the provided scripts. They replace sensitive fields with deterministic fakes (same input → same output) while preserving amounts, dates, and structure.

They are standalone Python scripts with no dependencies, run by [uv](https://docs.astral.sh/uv/).

### Salt setup

The scripts require a secret salt to make the hashes irreversible. Generate one and set it for the session:

```bash
# Generate a strong salt (copy the output to a password manager)
uv run --no-project python -c "import secrets; print(secrets.token_hex(32))"

# Set it for the current shell session (not saved to history)
read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
```

If `ANONYMIZE_SALT` is not set, the scripts will prompt interactively.

### CAMT.053 XML files

Replaces IBANs, names, addresses, postal codes, BIC codes, and remittance text. IBANs in filenames are also replaced.

```bash
for f in /path/to/real/exports/*.xml; do
    uv run --script scripts/anonymize_camt.py "$f" tests/data/
done
```

### UBS cards CSV files

Replaces account number, card number, cardholder name, merchant names, and sector. Footer/summary lines are preserved as-is.

```bash
uv run --script scripts/anonymize_ubs_cards.py /path/to/real/cards.csv tests/data/ubs_cards_valid.csv
```

### UBS account CSV files

Replaces account number, IBAN, transaction reference, and description fields.

```bash
uv run --script scripts/anonymize_ubs_csv.py /path/to/real/account.csv tests/data/ubs_valid.csv
```
