# Plan: Direct Import into Actual Budget

## Context

Currently the CLI transforms bank statement files into CSV/XML files that must be manually imported into Actual Budget. This feature adds a new `--format actual` option that imports transactions directly into a self-hosted Actual Budget server using the `actualpy` Python library, eliminating the manual import step.

## Design Decisions

1. **Not a writer subclass** -- `BaseWriter.save_monthly()` is file-oriented (monthly grouping, file I/O, file-based dedup). Direct import needs none of that. Instead, create a standalone `ActualBudgetImporter` class with its own `import_transactions()` method and a small branch in `main.py`.

2. **Account matching** -- Reuse existing `account_names` values as Actual Budget account names. Before importing, validate that the target account exists in Actual Budget and warn/fail clearly if not (listing available accounts).

3. **Deduplication** -- Use the `reference` field from `ProcessingResult` as Actual's `imported_id`. Actual's `importTransactions` handles server-side dedup, so no monthly splitting needed.

4. **CLI** -- Add `"actual"` to `--format` choices. When used, `--output` is optional/ignored.

5. **Config** -- New `actual_budget` section in YAML. Environment variables as overrides for sensitive values (password).

6. **Connection lifecycle** -- Single `Actual` connection per CLI invocation via context manager, reused across files in directory mode.

## Step 0: Evaluate `actualpy` dependency strategy

Before implementation, evaluate whether `actualpy` should be optional or required:

**Optional extra** (`pip install .[actual]`):
- Pro: Keeps base install lightweight; users who only want CSV/CAMT output don't pull in actualpy + its deps
- Pro: actualpy depends on SQLAlchemy, protobuf, etc. -- meaningful dependency tree
- Con: Slightly more complex install instructions for direct-import users
- Con: Need lazy import + clear runtime error if missing

**Required dependency**:
- Pro: Simpler -- always available, no conditional imports
- Con: Heavier install for users who don't need direct import
- Con: More breakage surface from transitive dependencies

**Decision**: Evaluate the actual size of actualpy's dependency tree (`uv pip install actualpy --dry-run`) and decide. Lean toward optional unless the dep tree is small.

## Step 1: Add `actualpy` dependency to `pyproject.toml`

Based on Step 0 decision, either add to `[project.dependencies]` or `[project.optional-dependencies]`.

**File**: `pyproject.toml`

## Step 2: Add `get_actual_budget_config()` to config

New helper that reads config + env var overrides:

```python
def get_actual_budget_config() -> dict:
    config = load_config()
    ab = config.get("actual_budget", {})
    return {
        "url": os.environ.get("ACTUAL_BUDGET_URL", ab.get("url", "")),
        "password": os.environ.get("ACTUAL_BUDGET_PASSWORD", ab.get("password", "")),
        "file": os.environ.get("ACTUAL_BUDGET_FILE", ab.get("file", "")),
    }
```

**File**: `src/actual_budget_transformer/config.py`

## Step 3: Update `config.template.yml`

Add commented-out `actual_budget` section:

```yaml
# Direct import into Actual Budget (--format actual)
# Env var overrides: ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD, ACTUAL_BUDGET_FILE
# actual_budget:
#   url: "http://localhost:5006"
#   password: ""          # prefer ACTUAL_BUDGET_PASSWORD env var
#   file: "My Budget"
```

**File**: `config.template.yml`

## Step 4: Create `ActualBudgetImporter`

New class in `writers/` directory:

- Context manager (`__enter__`/`__exit__`) opens/closes `Actual` connection
- `import_transactions(result: ProcessingResult)`:
  - Resolves account name from `output_prefix` (the friendly name from `account_names`)
  - Looks up account in Actual Budget -- **fails with clear error listing available accounts** if not found
  - Converts debit/credit columns to signed cents: `round(amount * 100)`, debits negative
  - Uses `reference` as `imported_id`
  - Logs count of added/updated/skipped transactions
- Handle missing `actualpy` gracefully: if import fails, raise clear error directing user to install

**File**: `src/actual_budget_transformer/writers/actual_budget_importer.py`

## Step 5: Wire up in `main.py`

1. Add `"actual"` to `--format` choices
2. When format is `"actual"`:
   - Read config via `get_actual_budget_config()`
   - Validate config (url, password, file must be set)
   - Create `ActualBudgetImporter` context manager
   - Call `importer.import_transactions(result)` for each processed file
   - Skip the `_get_writers()` / `save_monthly()` path entirely

```python
if args.output_format == "actual":
    importer = _create_actual_importer()
    with importer:
        if os.path.isfile(args.file_path):
            process_single_file(args.file_path, importer=importer)
        else:
            process_directory(args.file_path, importer=importer)
```

**File**: `src/actual_budget_transformer/main.py`

## Step 6: Tests

Mock `actualpy` to test:
- Amount conversion (debit -> negative cents, credit -> positive cents, NaN handling)
- Reference -> imported_id mapping
- Account name resolution + account-not-found error with helpful message
- Connection lifecycle (context manager)
- Config loading with env var overrides

**File**: `tests/test_actual_budget_importer.py`

## Step 7: Update docs

Update `CLAUDE.md` architecture section and config docs to reflect the new feature.

**Files**: `CLAUDE.md`, `config.template.yml`

## Verification

1. `uv sync` (or `uv sync --extra actual`) -- deps install cleanly
2. `uv run pytest` -- all existing + new tests pass
3. Manual test: `uv run actual-budget-transformer -f tmp/input_files/ --format actual -c config.yaml` against a running Actual Budget server
4. Verify transactions appear in correct accounts in Actual Budget UI
5. Re-run same command -- verify deduplication (no duplicate transactions)

## Critical Files

- `src/actual_budget_transformer/writers/actual_budget_importer.py` (new)
- `src/actual_budget_transformer/main.py` (modify)
- `src/actual_budget_transformer/config.py` (modify)
- `config.template.yml` (modify)
- `pyproject.toml` (modify)
- `tests/test_actual_budget_importer.py` (new)
