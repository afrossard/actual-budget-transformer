# Plan: Direct Import into Actual Budget

## Context

Currently the CLI transforms bank statement files into CSV/XML files that must be manually imported into Actual Budget. This feature adds a new `--format actual` option that imports transactions directly into a self-hosted Actual Budget server using the `actualpy` Python library, eliminating the manual import step.

### Design philosophy: conservative automation

The user's current manual workflow is careful and deliberate: import one month at a time, check the reconciliation boundary, manually review potential duplicates. Actual's built-in dedup (`importTransactions`) is not fully reliable, especially for transactions without a bank reference.

The automated import must be **at least as safe as manual import**. It should never create a mess that's harder to clean up than doing it by hand. Key principles:
- Skip transactions that are already reconciled (locked)
- Flag uncertain matches for async human review rather than guessing
- Stop early if too much uncertainty (circuit breaker)
- Process in monthly batches for manageable review and clear resume points
- Log everything: what was imported, flagged, skipped, and where it stopped

---

## Design Decisions

1. **Not a writer subclass** — `BaseWriter.save_monthly()` is file-oriented (file I/O, file-based dedup). Direct import needs different logic. Create a standalone `ActualBudgetImporter` class with its own `import_transactions()` method and a small branch in `main.py`.

2. **Account matching** — Reuse existing `account_names` values as Actual Budget account names. Before importing, validate that the target account exists in Actual Budget and fail clearly if not (listing available accounts).

3. **Checkpoint-based batching** — Import transactions in batches bounded by whichever comes first: end of calendar month, or the next available balance checkpoint from CAMT files. If CAMT provides a closing balance on Jan 15, the batch covers Jan 1–15, verified against that balance, then Jan 16–31 follows. If no CAMT data exists for an account, fall back to pure monthly batching (no inline verification possible). This ensures you never import more than you can verify.

4. **Reconciliation boundary** — Before importing a batch, query the account's last reconciled transaction date. Skip all transactions dated before that boundary (they're locked and verified). Only process transactions on or after the reconciliation date.

5. **Three-bucket classification** for transactions on/after the reconciliation date:
   - **Skip** — high-confidence duplicate: same `imported_id`/reference already exists in Actual
   - **Suspicious** — no reference, but an existing transaction in the account matches on amount within ±1 day. Needs count-aware matching (see below). Imported with a configurable "to review" category.
   - **Clean** — no match found → import normally

6. **Conservative duplicate detection** — When matching by amount+date (without payee), we cannot reliably pair specific source transactions with specific existing ones. If there are ANY existing transactions matching on amount within ±1 day and the source transactions lack a reference, the **entire group is suspicious** — flag all for review. The count information is still logged to help the human resolve it quickly (e.g. "5 source transactions of 12.50 around Jan 15, 2 already exist — flagging all 5 for review"). Only transactions with a matching `imported_id` can be confidently skipped.

7. **Circuit breaker** — Per-account threshold. If suspicious transaction count in any monthly batch exceeds a configurable limit, abort that account's import entirely (don't import the clean ones from that batch either — keep it atomic). Continue processing other accounts. Log clearly what happened and where to resume.

8. **Balance verification** — If CAMT.053 files are present in the input directory, extract their statement balances (opening/closing balance per statement period). During import, after each monthly batch is committed, compare Actual's account balance at the statement date against the CAMT balance. If there's a mismatch, **stop the import for that account immediately** — the discrepancy is small and recent, so the user can fix it quickly before resuming. This is an inline check (not post-import), because catching errors early minimizes manual correction work. CSV files also have balance fields structurally, but they've been empty in practice — support them if populated, don't rely on them.

9. **Resume** — Re-running the tool is safe: already-imported transactions are skipped (by `imported_id`), and the monthly batching means only unprocessed months are attempted. The circuit breaker means a tripped account won't have partial imports to untangle.

10. **CLI** — Add `"actual"` to `--format` choices. When used, `--output` is optional/ignored.

11. **Config** — New `actual_budget` section in YAML. Environment variables as overrides for sensitive values (password).

12. **Connection lifecycle** — Single `Actual` connection per CLI invocation via context manager, reused across files in directory mode.

---

## Config

```yaml
# Direct import into Actual Budget (--format actual)
# Env var overrides: ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD, ACTUAL_BUDGET_FILE
actual_budget:
  url: "http://localhost:5006"
  password: ""                  # prefer ACTUAL_BUDGET_PASSWORD env var
  file: "My Budget"
  review_category: "To Review"  # category assigned to suspicious transactions
  suspicious_threshold: 5       # per-account: abort if >N suspicious in a monthly batch
```

---

## Implementation Steps

### Step 0: Evaluate `actualpy` vs direct Actual API

Decide whether to use the `actualpy` library or call Actual Budget's API directly. The concern is long-term reliability and technical debt, not dependency size.

**`actualpy`:**
- Pro: Higher-level abstractions, less boilerplate
- Con: Third-party dependency we don't control — if it becomes unmaintained or diverges from Actual's protocol, we inherit the problem
- Con: May hide important details of the sync protocol that matter for our dedup/verification logic
- Question: Is it a thin wrapper or does it handle heavy lifting (sync protocol, encryption, conflict resolution)?

**Direct API:**
- Pro: No third-party coupling — we depend only on Actual Budget itself
- Pro: Full control over exactly which API calls we make, important for our custom dedup and balance verification
- Con: More upfront work to implement
- Con: Need to understand and implement the API protocol ourselves
- Question: Is the API well-documented and stable enough to use directly?

**Research tasks:**
- Study Actual Budget's API surface: what endpoints exist for importing transactions, querying existing transactions, checking balances, reconciliation status
- Study `actualpy` source: how much heavy lifting does it do vs thin wrapping? How does it handle the sync protocol?
- Assess: if `actualpy` became unmaintained tomorrow, how hard is it to replace?
- Assess: does the direct API give us everything we need for our dedup/verification logic?
- **API stability**: Actual Budget is actively developed and the user updates frequently. How stable is the API across server versions? Is there a versioned API contract, or do endpoints change with releases? Does `actualpy` pin to a specific server version? If using the direct API, how do we detect or handle breaking changes? This directly impacts maintenance burden — if every server update risks breaking the import, the feature becomes a liability.

**Decision**: Make based on research findings. Lean toward direct API if it's well-documented and `actualpy` is mostly a thin wrapper. Lean toward `actualpy` if it handles complex protocol details (encryption, sync) that would be costly to reimplement. If neither option offers a stable contract across server updates, reconsider whether direct import is viable at all — or scope it to a known-compatible server version range with a clear compatibility check at connection time.

### Step 1: Research Actual's internals

Study both `actualpy` and Actual Budget's API to inform the Step 0 decision and the dedup/verification implementation:

- How does `importTransactions` work? What fields does it match on? What does it return?
- Can we query existing transactions by date range and amount?
- Can we read reconciliation status / last reconciled date per account?
- Can we read account balances at specific dates?
- Can we assign a category when importing a transaction?
- What does "merge suggestion" mean at the API level?
- How does the sync protocol work? Is there encryption or conflict resolution we'd need to handle?

**Output**: Update this plan with concrete API details and the Step 0 decision before proceeding to implementation.

### Step 2: Add dependency to `pyproject.toml`

Based on Step 0 decision, add either `actualpy` or relevant HTTP/API libraries.

**File**: `pyproject.toml`

### Step 3: Add `get_actual_budget_config()` to config

New helper that reads config + env var overrides:

```python
def get_actual_budget_config() -> dict:
    config = load_config()
    ab = config.get("actual_budget", {})
    return {
        "url": os.environ.get("ACTUAL_BUDGET_URL", ab.get("url", "")),
        "password": os.environ.get("ACTUAL_BUDGET_PASSWORD", ab.get("password", "")),
        "file": os.environ.get("ACTUAL_BUDGET_FILE", ab.get("file", "")),
        "review_category": ab.get("review_category", "To Review"),
        "suspicious_threshold": int(ab.get("suspicious_threshold", 5)),
    }
```

**File**: `src/actual_budget_transformer/config.py`

### Step 4: Update `config.template.yml`

Add commented-out `actual_budget` section with all fields documented.

**File**: `config.template.yml`

### Step 5: Create `ActualBudgetImporter`

New class in `writers/` directory:

- **Context manager** (`__enter__`/`__exit__`) opens/closes `Actual` connection
- **`import_transactions(result: ProcessingResult, balance_checkpoints: list)`**:
  1. Resolve account name from `output_prefix` → look up in Actual → fail with available accounts list if not found
  2. Compute batch boundaries: merge month-end dates with CAMT balance checkpoint dates for this account, take whichever comes first at each step
  3. For each batch (chronological order):
     a. Query account's reconciliation boundary → filter out transactions before it
     b. Query existing transactions in the date range from Actual
     c. Classify each transaction into skip / suspicious / clean (see bucket logic)
     d. Check circuit breaker: if suspicious count > threshold, abort this account, log clearly, move on
     e. Import clean transactions normally
     f. Import suspicious transactions with the configured review category
     g. If a balance checkpoint exists at this batch boundary: compare Actual's account balance against CAMT expected balance. On mismatch → stop this account, log the discrepancy (expected vs actual, difference amount)
     h. Log summary: N imported, N flagged for review, N skipped (duplicate), N skipped (reconciled), balance check pass/fail
- **Handle missing `actualpy`** gracefully: clear error directing user to install

**Bucket classification logic (conservative):**
```
For each source transaction in the batch:
  if transaction has imported_id AND that imported_id exists in Actual → skip
  else:
    existing = Actual transactions matching same amount within ±1 day
    if len(existing) == 0 → clean (import normally)
    else → suspicious (flag entire amount/date group for review)
      Log: "N source tx of {amount} around {date}, M already in Actual — flagging all N for review"
```

The key insight: without references, we cannot pair source rows to existing rows. If any ambiguity exists, the whole group goes to review. This is more conservative but avoids silent duplicates.

**File**: `src/actual_budget_transformer/writers/actual_budget_importer.py`

### Step 6: Wire up in `main.py`

1. Add `"actual"` to `--format` choices
2. When format is `"actual"`:
   - Read config via `get_actual_budget_config()`
   - Validate config (url, password, file must be set)
   - Create `ActualBudgetImporter` context manager
   - Call `importer.import_transactions(result)` for each processed file
   - Skip the `_get_writers()` / `save_monthly()` path entirely
   - At the end, print a summary of all accounts: what was imported, flagged, skipped, and any tripped circuit breakers

```python
if args.output_format == "actual":
    importer = _create_actual_importer()
    with importer:
        if os.path.isfile(args.file_path):
            process_single_file(args.file_path, importer=importer)
        else:
            process_directory(args.file_path, importer=importer)
    importer.print_summary()
```

**File**: `src/actual_budget_transformer/main.py`

### Step 7: Test infrastructure — Actual Budget container

Add an Actual Budget server container for integration testing and development prototyping.

**`docker-compose.test.yml`** (or extend `docker-compose.claude.yml`):
```yaml
services:
  actual-server:
    image: actualbudget/actual-server:latest  # pin to specific tag once stable
    ports:
      - "5006:5006"
    volumes:
      - actual-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5006"]
      interval: 5s
      retries: 5

volumes:
  actual-data:
```

**Test setup fixture** (pytest):
- Start/verify the container is running (or skip integration tests if not)
- Create a budget file, set password, create test accounts via the API
- Seed known transactions for dedup/balance testing scenarios
- Tear down: reset budget state between test runs

**Uses:**
- Integration tests run against real server — catches API breakage on server upgrades
- Bump the image tag to test compatibility with new Actual releases before updating your own server
- Quick prototyping during development — no separate Actual instance needed

**Files**: `docker-compose.test.yml`, `tests/conftest.py` (fixtures)

### Step 8: Tests

**Unit tests** (no server needed, fast):
- Amount conversion (debit → negative cents, credit → positive cents, NaN handling)
- Batch boundary computation (month-end + CAMT checkpoint merging)
- Bucket classification logic (skip / suspicious / clean)
- Circuit breaker logic (threshold, per-account isolation)
- Config loading with env var overrides

**Integration tests** (against Actual container):
- Account resolution + account-not-found error with helpful message
- Import transactions → verify they appear in Actual
- Re-import same transactions → all skipped (dedup by imported_id)
- Import into account with pre-existing manual entries → suspicious flagged with review category
- Circuit breaker trips → account aborted, others continue
- Balance verification against CAMT checkpoint → mismatch stops import
- Resume after partial import → picks up cleanly
- **Server version compatibility**: run the suite against different Actual image tags

**Files**: `tests/test_actual_importer_unit.py`, `tests/test_actual_importer_integration.py`

### Step 9: Update docs

Update `CLAUDE.md` architecture section and config docs to reflect the new feature, including how to run integration tests.

**Files**: `CLAUDE.md`, `config.template.yml`

---

## Verification

1. `uv sync` — deps install cleanly
2. `docker compose -f docker-compose.test.yml up -d` — Actual server starts and is healthy
3. `uv run pytest tests/test_actual_importer_unit.py` — unit tests pass (no server needed)
4. `uv run pytest tests/test_actual_importer_integration.py` — integration tests pass against container
5. Bump Actual image tag → re-run integration tests → confirm compatibility
6. Manual smoke test: import real files against the test container, review in Actual UI

---

## Critical Files

- `src/actual_budget_transformer/writers/actual_budget_importer.py` (new)
- `src/actual_budget_transformer/main.py` (modify)
- `src/actual_budget_transformer/config.py` (modify)
- `config.template.yml` (modify)
- `pyproject.toml` (modify)
- `tests/test_actual_budget_importer.py` (new)
