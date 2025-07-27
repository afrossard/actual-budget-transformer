# CLI program to transform some bank statements into CSV files understood by Actual Budget

See [Actual Budget](https://actualbudget.org/)

## Supported input formats

- UBS Switzerland e-banking
  - Account transactions CSV files
  - Credit card transactions CSV files

## Output format

```
transaction_date,payee,notes,debit,credit
<YYYY-MM-DD>,<some payee>,<some notes>,<debit>,<credit>
```

## Usage

### Installation

Inspiration available in `./devcontainer` or `./Containerfile`.

### Config file

Create a new `config.yaml` based on `config.template.yml`.

Optional: edit the `account_names` sections to replace your IBANs and card numbers with user friendly names.

### CLI

`python -m actual_budget_transformer.main -f <INPUT_DIR> -o <OUTPUT_DIR> -c <CONFIG_FILE> -v`

- `INPUT_DIR`: path to input file or directory. Any file will opened and scanned. Supported files will be processed, others will be ignored. Files can contain overlapping date ranges. For instance, if you're lazy and always download the last 90 days of transactions, the transformer will detect duplicates and only output unique transactions.
- `OUTPUT_DIR`: location for output files. Transactions will be grouped into separate files by account, year and month. For instance, 202507_personal.csv will contain transactions from July 2025 for account "personal". Account names are configured in the config file, otherwise IBANs and card numbers are used.
- `CONFIG_FILE`: path to config file.
