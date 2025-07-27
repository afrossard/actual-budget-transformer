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

### Running with Docker

The following commands allow you to run the application using Docker. They are designed to work both when run directly on your host machine and from within the provided Dev Container.

> **Note on paths:** The commands use `${LOCAL_WORKSPACE_FOLDER:-$PWD}` to correctly resolve the project's path.
>
> - Inside the Dev Container, `LOCAL_WORKSPACE_FOLDER` is automatically set to the project's path on your host machine.
> - Outside the Dev Container, it falls back to `$PWD` (the current working directory).

```bash
docker run --rm -it \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 ghcr.io/afrossard/actual-budget-transformer-main:main \
 -f /app/input \
 -o /app/output \
 -c /app/config.yaml \
 -v
```

```bash
docker run --rm -it \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 actual-budget-transformer:latest \
 -f /app/input \
 -o /app/output \
 -c /app/config.yaml \
 -v
```

### Debugging

If you need to debug the container, for instance to check the volume mounts, you can get an interactive shell inside it by overriding the entrypoint:

```bash
docker run --rm -it \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/input_files":/app/input \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/tmp/output_files":/app/output \
 -v "${LOCAL_WORKSPACE_FOLDER:-$PWD}/config.yaml":/app/config.yaml \
 --entrypoint /bin/bash \
 actual-budget-transformer:latest
```
