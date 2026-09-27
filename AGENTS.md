# AGENTS.md — Contributor Guide for LLMs

> **Note for LLMs:** This file is the persistent memory for this project. Running in a devcontainer means any memory written outside the repo will not survive a restart. Always persist valuable context (decisions, progress, conventions) here — not in `~/.claude/`. See `CHANGELOG.md` for release history.

## Communication style

- Keep answers concise. Prefer short, direct responses over long explanations.

## Working style

- **Don't mark plan/checklist items "done" until validated.** Writing the code is not the same as confirming it works. Wait for the user to report results before editing a plan's status for anything only they can run. Pre-marking creates false signal that's worse than the unfinished state.
- **Know which things actually need the human.** Docker availability depends on where the session runs, so check it rather than assuming: an agent session may run outside the devcontainer (`ls /.dockerenv`, `docker info`), in which case docker works but `actual-up`/`actual-down` do **not**, because the `dc` alias hardcodes `/workspaces/actual-budget-transformer`. Bring the test server up directly instead (see Devcontainer below).
  The real human-only boundary is **the user's own data and budget**, not docker: downloading statements from UBS e-banking, anything touching the real Actual budget, and verifying results in the Actual UI. A disposable test server is not a substitute for any of those.

## Project purpose

CLI tool that transforms bank statement files into CSV files compatible with [Actual Budget](https://actualbudget.org/). Input files are detected automatically; output is grouped by account, year, and month, with deduplication across overlapping exports.

---

## Two codebases, for now

The project is moving to **one TypeScript codebase calling `@actual-app/api` in process** (#41).
Until the TypeScript CLI reaches parity on both UBS CSV inputs, both live side by side, and neither is a permanent state:

- **`src/*.ts`** — the TypeScript import CLI: read a statement, propose, confirm, write. This is where new work goes.
- **`src/actual_budget_transformer/`** — the Python package: the file-output paths (CSV, CAMT.053) and the JSON-over-stdio bridge to `@actual-app/api`. It keeps working and is deleted in one commit once parity is reached.

See "The TypeScript import CLI" below for the new codebase, and everything from "Processor pattern" onwards for the Python one.

---

## The TypeScript import CLI

One account at a time: read a bank statement file, read Actual, classify once, prompt on every row, write only what the human confirms.

```bash
npm ci                                   # once
npm run typecheck                        # tsc --noEmit
npm test                                 # node:test; integration tests skip if no server
ACTUAL_BUDGET_PASSWORD=… npm run import -- -c config.yml statement.csv
```

There is **no build step**. `tsconfig.json` is `noEmit`, and Node 24 strips types natively, so `node src/cli.ts` runs the source directly — `tsx` is only still here for the Python bridge.

### Module layout

```
src/
├── cli.ts             # argument parsing and wiring
├── import-run.ts      # one run: parse, read Actual, classify once, review
├── config.ts          # the user's config.yml (account_names + actual_budget only)
├── classify.ts        # THE CLASSIFIER SEAM — pure, no server, no I/O
├── actual-gateway.ts  # THE GATEWAY SEAM — the only module touching @actual-app/api
├── actual-version.ts  # ADR-007 version-skew gate
├── review.ts          # the review loop: four actions, one confirmation per row
├── tape.ts            # the Tape's rendering, and how evidence is worded
├── io.ts              # terminal input (single keystroke on a TTY, lines otherwise)
├── imported-id.ts     # minting, and the forced-copy scheme
├── money.ts           # integer cents; the debit/credit sign convention
└── sources/           # one parser per statement format, plus the registry
```

**The two seams are pre-agreed and closed.** The classifier takes source transactions plus Actual transactions and returns four states; most tests live there. The gateway is integration-tested against a real server. The review loop is tested through the gateway rather than given a seam of its own. Do not add a third.

### Rules the code enforces, and why

| Rule | Where | Why |
| --- | --- | --- |
| Never `importTransactions` | `actual-gateway.ts`, guarded by a test in `tests/ts/write-path.test.ts` | It carries Actual's own matcher (same amount, ±7 days, any row with no imported ID). Two matchers over one decision caused every surprise in #38. |
| Nothing is written without a confirmation for that row | `review.ts` | Including inside the reconciled range: `updateTransaction` patches a reconciled transaction without complaint and leaves `reconciled` true, so the guard is ours. Proven in `review.integration.test.ts`, both directions. |
| A reconciled target is warned about even when the row is not Locked | `review.ts` `warnings()` | The boundary is the newest reconciled date, so a row one day *after* it can still match that transaction. Such a row is Suspicious, not Locked, and correcting it would reach into an attested range on the strength of one evidence line. |
| A correction never writes the amount | `actual-gateway.ts` `correct()` | A split's parts must still sum to their parent. Where the bank and Actual disagree on an amount, nothing is applied and the difference is reported (#49 owns what to do instead). |
| Classify once per batch | `import-run.ts` | Re-reading Actual between prompts makes each confirmation flag the next transaction — #50's noise, manufactured. |
| A decline is a decision | `review.ts`, `tape.ts` | Skip and Locked rows are prompted and show what they matched. Bank data never goes out on a log line. |
| Read the account's **whole** history, never a window around the file's dates | `import-run.ts`, `gateway.getAccountHistory` | An imported ID has to be recognised wherever the transaction now sits. The cards parser dates a purchase by `Date d'achat` while the bank books it weeks later, so re-dating it in Actual moves it outside any sensible window — and a missed imported ID means the row comes back as Clean, which claims nothing in Actual looks like it. Guarded by the `re-dated` test. |

### Testing it

Unit tests need nothing. Integration tests need the disposable server and **skip themselves with an explanatory message** when it is unreachable:

```bash
docker compose -f .devcontainer/docker-compose.yml --profile actual up -d actual-server
ACTUAL_SERVER_URL=http://localhost:5006 npm run bootstrap
ACTUAL_SERVER_URL=http://localhost:5006 npm test
```

- **Never mock `@actual-app/api`.** These tests exist because Actual's real behaviour is surprising; a mock would encode our assumptions instead of checking them.
- **`tests/ts/actual-api.characterization.test.ts`** holds the five probes from `prototype/38-interactive-import`, turned into assertions. They are the guard that an api version bump cannot quietly invalidate the write path (ADR-007). If one fails, the write path's design needs re-reading, not the test.
- **Each integration run creates its own account.** The reconciliation boundary is account-global server state, so owning the account is what lets this suite skip the date partitioning the Python suite needed, and leaves the Python suite's accounts alone. Test accounts are named `TS <label> <tag>`; `actual-down` + `actual-up` + `npm run bootstrap` clears the debris.

### Choices, so they are not re-litigated

- **Test runner: `node:test`.** Zero dependencies, and Node 24 runs `.ts` files directly. Native type stripping forbids `enum` and parameter properties — use unions and an explicit constructor body.
- **CSV parsing: `csv-parse`.** The node-csv project's parser, the standard for Node rather than merely a popular one. Verified against the real fixtures: it handles the quoted field with an embedded semicolon, the ragged column counts, and `latin1`. Hand-rolling was rejected after testing the alternative, not before.
- **YAML: `yaml`.** Reads the same `config.yml` the Python path uses.
- **Only two config blocks are read**, `account_names` and `actual_budget`. Column names, encodings, date formats and the reference columns are facts about the export format, so they are constants in the parsers, not settings.
- **Minted imported IDs are prefixed `abt1-`**, where `1` versions the scheme, so a change to how IDs are derived is visible rather than silent. They are not byte-compatible with the Python path's hashes, which is fine: nothing has ever been written to the real budget (#32 is still open).

---

## Architecture

> Everything from here down describes the **Python** package.

### Processor pattern

Each input format is handled by a **processor** — a class that:

1. Declares whether it can handle a given file (`can_process`)
2. Parses the file and returns a normalised `ProcessingResult`

All processors live in `src/actual_budget_transformer/processors/` and inherit from `BaseProcessor`.

```
src/actual_budget_transformer/
├── main.py               # CLI entry point; orchestrates file discovery and writer dispatch
├── factory.py            # Processor registry; auto-selects processor per file
├── config.py             # YAML config loader with singleton cache
├── logging_config.py     # Shared logger
├── processors/
│   ├── base_processor.py                       # Abstract base + ProcessingResult dataclass
│   ├── camt053_parser.py                       # CAMT.053 XML parser utility
│   ├── camt053_processor.py                    # CAMT.053 processor
│   ├── ubs_csv_transaction_processor.py        # UBS account CSV
│   └── ubs_cards_csv_transaction_processor.py  # UBS card CSV
└── writers/
    ├── base_writer.py      # Abstract base with monthly-split + dedup orchestration
    ├── csv_writer.py       # CSV output (read-back for dedup + write)
    └── camt053_writer.py   # CAMT.053 XML output (build_camt053_document + Camt053Writer)

scripts/
├── bootstrap_test_budget.ts  # Bootstrap Actual Budget test server with accounts
└── anonymize_*.py            # Anonymize real data for test fixtures
```

### Output contract

Every processor must return a `ProcessingResult` with:

- `data`: a `pandas.DataFrame` with exactly these columns: `transaction_date`, `payee`, `notes`, `debit`, `credit`, `reference`
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
uv sync          # install Python dependencies into .venv
npm install      # install Node.js dependencies (@actual-app/api)
uv run pytest    # run tests
```

**Always reach Python through `uv`.**
There is no `python` or `python3` on `PATH` in this devcontainer, and `.venv/` does not exist until `uv sync` has run, so a bare `python3 script.py` fails with `command not found`.
Use `uv run python …` inside the project, or `uv run --no-project python …` for a throwaway script that needs no project dependencies (it fetches a standalone interpreter).
`perl`, `awk` and `sed` are available if a one-off text edit is easier that way.

Convenience script (clears output, then processes `tmp/input_files/` → `tmp/output_files/`):

```bash
bash process_transactions.sh
```

### Devcontainer

The devcontainer uses Docker Compose (`.devcontainer/docker-compose.yml`). Only the main devcontainer starts automatically. Auxiliary services use compose profiles:

```bash
actual-up       # start Actual Budget test server (profile: actual)
actual-down     # stop AND remove the container — fresh tmpfs on next up
claude-up       # start Claude Code container (profile: claude)
claude-down     # stop it
```

Those aliases live in `.devcontainer/.zsh_aliases` and only work **inside** the devcontainer, because `dc` hardcodes the `/workspaces/...` compose path.
Outside it, drive compose directly from the repo root — the `actual-server` service is standalone (no `depends_on`, no build, no workspace volume), so it comes up on its own:

```bash
docker compose -f .devcontainer/docker-compose.yml --profile actual up -d actual-server
curl -s http://localhost:5006/info      # verified healthy, reports the sync-server version
docker compose -f .devcontainer/docker-compose.yml --profile actual rm -sf actual-server
```

Reach it at `http://localhost:5006` from outside the devcontainer, not `http://actual-server:5006` (that name only resolves on the compose network).
`/data` is a tmpfs, so removing the container always yields a clean budget on the next start.
Note the default pin is `actualbudget/actual-server:26.5.2` while `@actual-app/cli` pins its own bundled api — so a CLI newer than the server reproduces exactly the client-ahead skew ADR-007 is about, which makes this a useful place to test that gate rather than reason about it.

---

## Testing

Tests live in `tests/`. Each processor has its own test file. The test config is at `tests/data/test_config.yml` and is loaded via an environment variable set at the top of each test file:

```python
os.environ["ACTUAL_BUDGET_TRANSFORMER_CONFIG"] = os.path.join(DATA_DIR, "test_config.yml")
```

### Anonymizing test data

> **Security rule — mandatory for public repos:** The salt must be high-entropy (generate with `uv run python -c "import secrets; print(secrets.token_hex(32))"`), kept private, and never committed. Without a strong secret salt, hashes are reversible by brute-force: Swiss IBANs, card numbers, and account numbers are finite enumerable sets, so an attacker who knows the algorithm (it's in the repo) can recover the original value.
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
    uv run python scripts/anonymize_camt.py "$f" tests/data/
done
```

**UBS cards CSV** (`scripts/anonymize_ubs_cards.py`) — replaces account number, card number, cardholder name, merchant names, and sector. Footer/summary lines are preserved as-is.

```bash
uv run python scripts/anonymize_ubs_cards.py /path/to/real/cards.csv tests/data/ubs_cards_anon_1.csv
```

**UBS account CSV** (`scripts/anonymize_ubs_csv.py`) — replaces account number, IBAN, transaction reference, and description fields.

```bash
uv run python scripts/anonymize_ubs_csv.py /path/to/real/account.csv tests/data/ubs_valid.csv
```

---

## Dependencies

| Package         | Role                                    |
| --------------- | --------------------------------------- |
| pandas          | DataFrame parsing & merging             |
| pyyaml          | Config file loading                     |
| pyiso20022      | CAMT.053 typed dataclasses (via xsdata) |
| pytest          | Test runner (dev only)                  |
| ruff            | Linter & formatter (dev only)           |
| @actual-app/api | Official Actual Budget JS API (Node.js) |
| tsx             | TypeScript execution for bridge scripts |

---

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues (`afrossard/actual-budget-transformer`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` at the repo root; new ADRs in `docs/adr/`, original seven in `docs/archive/`). See `docs/agents/domain.md`.
