# AGENTS.md — Contributor Guide for LLMs

> **Note for LLMs:** This file is the persistent memory for this project. Running in a devcontainer means any memory written outside the repo will not survive a restart. Always persist valuable context (decisions, progress, conventions) here — not in `~/.claude/`. See `CHANGELOG.md` for release history.

## Communication style

- Keep answers concise. Prefer short, direct responses over long explanations.

## Working style

- **Conventional Commits, squash-merged** (#87). The PR title becomes the commit release-please computes the next version from; `CONTRIBUTING.md` says which type bumps what. Never edit `CHANGELOG.md` by hand.
- **Don't mark plan/checklist items "done" until validated.** Writing the code is not the same as confirming it works. Wait for the user to report results before editing a plan's status for anything only they can run. Pre-marking creates false signal that's worse than the unfinished state.
- **Know which things actually need the human.** Docker availability depends on where the session runs, so check it rather than assuming: an agent session may run outside the devcontainer (`ls /.dockerenv`, `docker info`). `npm run actual:up` works wherever docker does (see Devcontainer below).
  The real human-only boundary is **the user's own data and budget**, not docker: downloading statements from UBS e-banking, anything touching the real Actual budget, and verifying results in the Actual UI. A disposable test server is not a substitute for any of those.

## Project purpose

CLI tool that imports bank statement files into a self-hosted [Actual Budget](https://actualbudget.org/) server, one account at a time, asking about every transaction before it writes anything.
It is one TypeScript codebase calling `@actual-app/api` in process (#41).

The Python package that came before it, which wrote CSV and CAMT.053 files for Actual's own import dialog, was deleted in #41.
Its last image stays in GHCR as the fallback for file output, pinned by digest: `ghcr.io/afrossard/actual-budget-transformer-main@sha256:89a73600137963c83b31a73f751b84c7cf4824150d52a3c61f9168f02a2043e8`.
Nothing in this repo builds it any more.
The CLI's own image is `ghcr.io/afrossard/actual-budget-transformer`, without the suffix (#61); see "The container image" below.

---

## The TypeScript import CLI

One account at a time: read a bank statement file, read Actual, classify once, prompt on every row, write only what the human confirms.

```bash
npm ci                                   # once
npm run typecheck                        # tsc --noEmit
npm run lint                             # type-aware ESLint; see "What the checkers enforce"
npm test                                 # node:test; integration tests skip if no server
ACTUAL_BUDGET_PASSWORD=… npm run import -- -c config.yaml statement.csv
```

There is **no build step**. `tsconfig.json` is `noEmit` and Node strips types natively, so `node src/cli.ts` runs the source directly.

### Versions: follow Actual

Five pins move together, and they all follow whatever Actual is on. When upgrading:

| Ours | Set it to | Currently |
| --- | --- | --- |
| `@actual-app/api` in `package.json` | the server version you run, **exactly** — no caret. A range could pull another api, which ADR 0004 aborts on | `26.10.0` |
| `actualbudget/actual-server` in `.devcontainer/docker-compose.yml` and `.github/workflows/test.yaml` | the same version, so the characterization tests check the behaviour you actually run | `26.10.0` |
| `.nvmrc` | Actual's own `.nvmrc` for that release (`actualbudget/actual` at tag `vX.Y.Z`). CI reads this file, so it is the single place to change | `24.18.1` |
| `FROM` in `Containerfile`, both stages | `node:<.nvmrc>-trixie-slim`. `FROM` cannot read a file, so the version is written twice and `tests/ts/containerfile.test.ts` fails when the two disagree | `24.18.1` |
| `@types/node` in `package.json` | the major of `engines.node`, as in Actual's own `package.json`: types newer than the oldest supported Node typecheck APIs it lacks. `tests/ts/types-node.test.ts` fails when the range or the Renovate rule names another major | `^22` |

Renovate is configured to keep this rule (#97), and nothing else has to be remembered:

- **One grouped `Actual` PR per release** (`renovate.json`) moves the api and both server lines together, so the api never lands ahead of the server.
  It is titled `feat(deps): require actual server <version>`, so it cuts a release whose notes say which server the image needs (#87).
  The compose line is a literal tag for that reason: Renovate extracts nothing from a `${VAR:-default}` image.
- **Renovate's Node updates are off** for `.nvmrc` and the Containerfile, because it would propose Node's latest and cannot read Actual's `.nvmrc`.
- **Renovate keeps `@types/node` to the `engines.node` major** (`allowedVersions`), so it proposes patches and minors but never the next major.
- **The `node-follows-actual` check** (`npm run check:node`, a job in `test.yaml`) fetches Actual's `.nvmrc` at the tag matching the api pin and fails with the exact fix, so on the grouped PR a red check says which Node to set.

Verify a `renovate.json` change with Renovate's own local dry run before relying on it: `GITHUB_COM_TOKEN=$(gh auth token) LOG_LEVEL=debug npx renovate --platform=local --dry-run=lookup`, then read the `branchName` of each update in the `packageFiles with updates` log line.

`engines.node` is `>=22.18.0`, which is both Actual's own floor and the Node release where type stripping stopped needing a flag — so it is the real floor for `node src/cli.ts`, not a guess.

**After any bump, re-run the characterization tests against the new server.** That is what they are for: they turned a 26.5.2 → 26.9.0 bump from a hope into a checked fact (all five passed unchanged).

### Module layout

```
src/
├── cli.ts             # argument parsing and wiring
├── import-run.ts      # one run: parse, read Actual, pair once, review
├── config.ts          # the user's config.yaml (account_names, processors, actual_budget)
├── account-resolution.ts # which account a statement goes into; the not-found message
├── classify.ts        # THE CLASSIFIER SEAM — pairing; pure, no server, no I/O
├── actual-gateway.ts  # THE GATEWAY SEAM — the only module touching @actual-app/api
├── actual-version.ts  # ADR 0004: the server must be the api version
├── review.ts          # the review loop: import or leave, one confirmation each
├── statement-report.ts # the statement report, the review blocks, and [?]
├── io.ts              # terminal input (single keystroke on a TTY, lines otherwise)
├── imported-id.ts     # minting
├── money.ts           # integer cents; the debit/credit sign convention
└── sources/
    ├── formats.ts      # what each export looks like, as overridable settings
    ├── index.ts        # builds the parsers from those settings, and picks one
    ├── delimited.ts    # the CSV read
    └── ubs-*.ts        # one parser factory per statement format
```

**The two seams are pre-agreed and closed.** The classifier takes statement transactions plus Actual transactions and returns each statement transaction's pair, or none; most tests live there. The gateway is integration-tested against a real server. The review loop is tested through the gateway rather than given a seam of its own. Do not add a third.

### Rules the code enforces, and why

| Rule | Where | Why |
| --- | --- | --- |
| Never `importTransactions` | `actual-gateway.ts`, guarded by a test in `tests/ts/write-path.test.ts` | It carries Actual's own matcher (same amount, ±7 days, any row with no imported ID). Two matchers over one decision caused every surprise in #38. |
| Nothing is written without a confirmation for that statement transaction | `review.ts` | Including in the reconciled period, where Actual enforces nothing. Proven in `review.integration.test.ts`. |
| Pair **one to one**, and never review a pair | `classify.ts`, `review.ts` | ADR 0003. A pair is a shared imported ID, or the same amount within ±1 day unless the two carry different **bank references** (minted `abt1-` IDs do not count: they can shift between exports); each Actual transaction pairs at most once, so of two identical statement transactions with one counterpart, one is reviewed. Amount pairs are a maximum matching, same-day first, so a run of entries typed a day late does not leave half of them reviewed. |
| Nothing is written for a pair, and nothing patches an Actual transaction | `actual-gateway.ts`, guarded by a test in `tests/ts/write-path.test.ts` | A paired statement transaction is already in Actual. A pair Actual needs fixed (the amounts differ) is listed in the statement report and never prompted: the fix is made in Actual (#49 owns doing more). `updateTransaction` would also patch a reconciled transaction without complaint, so its absence is the guard. |
| Dates decide nothing | `classify.ts`, `review.ts` `warnings()` | An unpaired statement transaction dated on or before the reconciled-through date is reviewed like any other - it is most probably one deleted from Actual to be imported again (#82) - and carries a warning that importing it changes a reconciled balance. |
| Every Actual transaction in the statement's period is paired or listed, and nothing is written for it | `classify.ts` `unpairedActual`, `statement-report.ts` | #109. An **unpaired Actual transaction** is one dated within the period that no statement transaction took, or one holding an imported ID the file carries, wherever it is dated (#119); a **duplicate** is one holding a paired one's imported ID, or its amount within ±1 day, and is listed beside that twin. The period is the file's own (`Du`-`Au` in the account CSV), or else its first to last transaction date, so `import-run.ts` reads the whole period as well as the pairing window. The gateway gains no delete: the fix is made in Actual (#112 owns doing more). |
| Pair once per batch | `import-run.ts` | Re-reading Actual between prompts would pair each statement transaction with what the last import wrote — #50's noise, manufactured. |
| A minted imported ID hashes the reference columns **verbatim** | `sources/ubs-cards-csv.ts` | Not the parsed date. Correcting `date_format` after a UBS change is exactly what the config is for, and it must not silently renumber every transaction already written. |
| Two statement transactions sharing an identity key: the later one says **`identical to #N`** | `classify.ts` `identityKey` | **Kept deliberately** (review, 2026-09-28), from #38's closing recommendation to catch the twins by comparing statement transactions to each other. It is informational: both are reviewed if unpaired and both are written if confirmed, because the bank's file is authoritative on the count; it stops the human leaving one of two identical lines by mistake. A **repeated non-blank reference** pairs once per copy Actual holds, and only holders beyond the number of copies the file carries are left unpaired, to be listed as duplicates. |
| Look imported IDs up **unbounded in date**, never in a window around the file's dates | `import-run.ts`, `gateway.findByImportedIds` | An imported ID has to be recognised wherever the transaction now sits. The cards parser dates a purchase by `Date d'achat` while the bank books it weeks later, so re-dating it in Actual moves it outside any sensible window — and a missed imported ID sends the statement transaction to review as "not in Actual". Guarded by the `re-dated` test. Unbounded in date is not the same as reading everything: the lookup is bounded in rows instead (#67). |
| Build ActualQL filters only from shapes the characterization tests pin | `actual-gateway.ts` | ActualQL answers some filter shapes **wrongly and silently**: `amount: { $oneof }` matches nothing, `date: { $gte, $lte }` in one object drops a bound. `$oneof` also pastes its values into SQL unescaped, so the gateway doubles quotes itself - and a plain string filter reads a leading `$` as a field and a leading `:` as a parameter, which is why imported IDs go through `$oneof` and nothing else. |

### What the checkers enforce

Three commands, three jobs, no overlap: `npm run typecheck` checks types, `npm run lint` checks what types alone cannot, `npm run format:check` checks formatting.
Prettier stays the only formatter - `eslint-plugin-prettier` is deliberately not installed, because formatting is already a checked step.

`tsconfig.json` runs `strict` plus the seven flags `strict` does not imply (#64).
Two of them are worth knowing by name:

- **`erasableSyntaxOnly`** makes `tsc` reject exactly what Node's type stripping rejects, so `enum`, parameter properties and `namespace` fail the check rather than the run.
- **`noUncheckedIndexedAccess`** makes `rows[i]` a `T | undefined` read, which is what it has always been at runtime.
  It is why a `!` in the parsers is load-bearing rather than decorative.

`eslint.config.js` is flat config, type-aware (`parserOptions.projectService`), and scoped to the same files `typecheck` and `format:check` cover.
The rule it exists for is **`@typescript-eslint/no-floating-promises`**: every write is `await gateway.add(…)` / `sync()`, and a dropped `await` there is a silently skipped write or a race, in a tool whose whole premise is that nothing reaches Actual without a confirmation for that statement transaction.
No grep can prove the next one absent.
`node:test`'s `test` / `it` / `before` and friends are listed under `allowForKnownSafeCalls`, because the runner owns those promises; nothing in `src/` is exempt.

`@typescript-eslint/no-non-null-assertion` is a **warning**, and off in `tests/ts/`.
`foo!` after a `find()` is ordinary test shorthand and 90 of them live there; a wall of warnings would hide one in `src/`, where there are none: each `!` the rule flagged there was replaced by code the compiler can check (#68).

### Testing it

Unit tests need nothing. Integration tests need the disposable server and **skip themselves with an explanatory message** when it is unreachable:

```bash
npm run actual:up
npm run bootstrap
npm test
```

The devcontainer sets `ACTUAL_SERVER_URL`; anywhere else, export `ACTUAL_SERVER_URL=http://localhost:5006` first.

- **Never mock `@actual-app/api`.** These tests exist because Actual's real behaviour is surprising; a mock would encode our assumptions instead of checking them.
- **`tests/ts/actual-api.characterization.test.ts`** holds the five probes from `prototype/38-interactive-import`, turned into assertions, and the ActualQL filter shapes the gateway's reads are built on (#67), the silently wrong ones included. They are the guard that an api version bump cannot quietly invalidate the write path or the reads (ADR-007, ADR 0004). If one fails, the design they pin needs re-reading, not the test.
- **Each integration run creates its own account.** The reconciled-through date is account-global server state, so owning the account is what lets this suite skip date partitioning altogether. Test accounts are named `TS <label> <tag>`; `npm run actual:down` + `npm run actual:up` + `npm run bootstrap` clears the debris.

### Choices, so they are not re-litigated

- **Test runner: `node:test`.** Zero dependencies, and Node 24 runs `.ts` files directly. Native type stripping forbids `enum` and parameter properties — use unions and an explicit constructor body. `erasableSyntaxOnly` in `tsconfig.json` makes `tsc` reject exactly what the runtime rejects, so this is enforced rather than remembered.
- **CSV parsing: `csv-parse`, because Actual already depends on it.** `@actual-app/core` pulls in `csv-parse`, and at api 26.9.0 that is the same 7.0.3 we ask for, so npm dedupes to **one** copy. Any other parser adds a second, unrelated CSV library beside it.

  The reasoning first given here — that it is "the standard for Node rather than merely popular" — did not survive review. papaparse was driven against the same fixtures and handles both files with zero errors, including the ragged rows and the quoted `;`. It also has three times the stars (13.6k vs 4.3k). Capability was never the differentiator.

  On security, csv-parse is the one with the **recent** advisory, so this is a trade rather than a win: GHSA-8cw4-87c7-c6xx (moderate, 2026-09-08) is *"prototype replacement **still** reachable via columns path"*, and "still" means an earlier fix was incomplete. We are clear twice — it is fixed in 7.0.2 and we pin `^7.0.3`, and the parsers never pass the `columns` option because the header sits on line 10. Both parsers also carry an ancient ReDoS, fixed long before the versions in use. csv-parse has npm provenance attestations where papaparse does not; papaparse has two maintainers where csv-parse has one.

  **Run `npm audit` after touching dependencies.** It was not run while this code was written, and the tree then carried three high advisories, all transitive through a stale `@actual-app/api`.
- **YAML: `yaml`.** Reads the `config.yml` users already had for the Python package. Both its advisories are fixed well below the pinned version.
- **`allowScripts` denies `better-sqlite3`'s install script.** From 13 (pulled in by api 26.10.0) it ships its own prebuilt binaries, but npm still runs an implicit `node-gyp rebuild` for its `binding.gyp`, which fails wherever there is no Python: this devcontainer and the slim `Containerfile` builder (WiseLibs/better-sqlite3#1503, npm/cli#9837).
  The deny is npm's own policy field, honoured by npm 11; nothing else in the tree has an install script. Drop it once npm stops inventing the script.
- **The bank's column names, encodings, separators and date formats are `config.yml` settings, not constants.** They were briefly hard-coded here on the grounds that they describe the export rather than the user's preferences. That was wrong twice over: UBS changes its exports without announcing it, and the labels are in the language of the user's e-banking, so they move when that setting moves. Either way the person hitting it has to be able to fix it by editing a file, which is why they were in a config file to begin with. `src/sources/formats.ts` holds the defaults; `processors.ubs_csv` / `processors.ubs_cards` override them key by key, in **the schema the Python package read**, so an existing config keeps working. A partial block keeps the defaults for what it does not restate, and a test asserts `config.template.yml` and the defaults have not drifted apart.
- **Minted imported IDs are prefixed `abt1-`**, where `1` versions the scheme, so a change to how IDs are derived is visible rather than silent. They are not byte-compatible with the deleted Python package's hashes, which is fine: nothing has ever been written to the real budget (#32 is still open).

### The container image

`Containerfile` builds the CLI into `ghcr.io/afrossard/actual-budget-transformer`: `npm ci --omit=dev` in a builder stage, then `node_modules`, `package.json` and `src/` on `node:<version>-trixie-slim`, run as `node src/cli.ts` by the non-root `node` user.
`.dockerignore` admits only those three, so `config.yaml` and the statements under `tmp/` never enter a build context.

- **No bundler, no prune step.** Actual's own image ships `node_modules` whole too.
  Bundling crashes on Actual's dynamic requires as ESM and is a silent no-op as CJS (`invokedDirectly()` has no `import.meta.filename` there), and better-sqlite3 is a native addon either way (#61).
- **No init in the image.** Under msb, `node` is not PID 1; under docker it is, and `docker run --init` is what lets a signal through, so that is documented rather than baked in.
  The review prompts read raw keystrokes on a TTY, so Ctrl-C there is a byte the prompt answers as quit, not a signal.
- **Publishing is release-please's** (#87): merging its release PR tags the release and `release.yml` publishes the image for amd64 and arm64 in the same run, under the version, its moving ranges, `:latest` and `:actual-<api version>`.
  `CONTRIBUTING.md` holds the tags, the bump rules, and how to recover a failed release.
  `scripts/abt-import` pins the version on a line marked `x-release-please-version`, which release-please bumps and `tests/ts/abt-import-script.test.ts` checks against `.release-please-manifest.json`.
- **The PR check** (`container` in `test.yaml`) builds the image for amd64 and runs it with no arguments, which must print the usage line and fail.
  That is the guard against an entry point that exits 0 having done nothing.
- **`scripts/abt-import`** runs the image under `msb run` as the calling user, with the config and the statement mounted read-only and the `ACTUAL_BUDGET_*` variables forwarded.
  It passes `--net private --no-dns-rebind-protection`: without them a self-hosted server's name failed to resolve in the sandbox (`ENOTFOUND`), and with both it answered. Neither flag has been tried alone.
  The docker equivalent and the retired image are comments in it.
  `tests/ts/abt-import-script.test.ts` checks the `msb run` line it assembles against a stub `msb`; booting it for real needs KVM.
- **`afrossard/homebrew-tap` ships `scripts/abt-import`** as `abt-import`, from the tagged release tarball (#101).
  The tap's Renovate bumps that formula when a release is tagged, and its bottle workflow bottles it; nothing in this repo pushes to the tap.
  msb is deliberately not a dependency there, because it may already be installed by its own `curl` installer.

---

## Configuration

`config.template.yml` is the reference; users copy it to `config.yaml`, which `.gitignore` keeps out of commits.
The path comes from `-c`, or else `ACTUAL_BUDGET_TRANSFORMER_CONFIG`.
Three blocks are read: `account_names`, `processors.ubs_csv` / `processors.ubs_cards`, and `actual_budget`.
Keys only the retired file-output image reads (`expected_columns`, a trailing `"Unnamed: 14"` column, `output.date_format`) stay in the template, marked *fallback only*, because that image fails without them; the CLI ignores them, and anything else an old config carries.

---

## Development setup

```bash
npm ci           # install dependencies
npm test         # run the tests; see "Testing it" for the server
```

Python is left only in the anonymize scripts (see below), which `uv` runs.
There is no `python` or `python3` on `PATH` in this devcontainer, so reach any Python through `uv run --no-project python …` (it fetches a standalone interpreter).
`perl`, `awk` and `sed` are available if a one-off text edit is easier that way.

### Devcontainer

`.devcontainer/Containerfile` is one `FROM ghcr.io/afrossard/container-base:<version>-dev` line, bumped by Renovate (#132).
The dev image brings mise, uv, chezmoi and Claude Code; the shell setup is the operator's dotfiles, which `post-start` applies through `dotfiles-bootstrap` when `DOTFILES_REPO` is set on the host.
Nothing in this repo writes to `~/.zshrc`.

- **`mise.toml` makes mise read `.nvmrc`.** Without `idiomatic_version_file_enable_tools = ["node"]` mise ignores it and runs the image's baked default Node, so the pin in "Versions: follow Actual" would silently not apply here.
- **`post-start` strips `credsStore` from `~/.docker/config.json`** on every start, because docker-outside-of-docker copies it from a macOS host, where it names a helper that does not exist in this container, and every pull fails.
- **`gh auth login` again after a rebuild.** Its config is not kept in a volume.

The devcontainer uses Docker Compose (`.devcontainer/docker-compose.yml`).
Only the devcontainer starts automatically; the Actual test server is the `actual` profile, driven by npm scripts with a repo-relative path, so they work inside the devcontainer, in an agent runtime and on a host alike:

```bash
npm run actual:up      # start the Actual test server and wait until it is healthy
curl -s http://localhost:5006/info      # reports the sync-server version
npm run actual:down    # stop AND remove it - fresh tmpfs on next up
```

Inside the devcontainer, `ACTUAL_SERVER_URL` is already `http://actual-server:5006`: under docker-outside-of-docker a published port lands on the host's `localhost`, not the devcontainer's, so the compose network is the way in.
Reach it at `http://localhost:5006` from outside the devcontainer, not `http://actual-server:5006` (that name only resolves on the compose network).
`/data` is a tmpfs, so removing the container always yields a clean budget on the next start.
Note the default pin is `actualbudget/actual-server:26.10.0` while `@actual-app/cli` pins its own bundled api — so a CLI on another version than the server reproduces exactly the skew ADR 0004 aborts on, which makes this a useful place to test that gate rather than reason about it.

---

## Anonymizing test data

> **Security rule — mandatory for public repos:** The salt must be high-entropy (generate with `uv run --no-project python -c "import secrets; print(secrets.token_hex(32))"`), kept private, and never committed. Without a strong secret salt, hashes are reversible by brute-force: Swiss IBANs, card numbers, and account numbers are finite enumerable sets, so an attacker who knows the algorithm (it's in the repo) can recover the original value.
>
> **Never pass the salt as a CLI argument** — it would appear in shell history and process listings. Set it via the environment variable instead (see below).
>
> For the same reason: **never hardcode fake account identifiers** (IBANs, card numbers) in test source files or fixture filenames. Use semantic fixture names (e.g. `camt_single_debit.xml`) and read identifiers dynamically in tests.

Three scripts anonymize real files before they are committed as fixtures.
They are the last Python in the repo: standalone PEP 723 scripts with no dependencies beyond the standard library, run by `uv run --script` (or directly, through their shebang).
#88 decides whether they are ported to TypeScript or deleted.
The salt is read from `ANONYMIZE_SALT` (preferred) or prompted interactively.

```bash
# Set the salt for the session without it entering shell history
read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
```

**CAMT.053 XML** (`scripts/anonymize_camt.py`) — replaces IBANs, names, addresses, postal codes, BIC codes, remittance text, and reference IDs. IBANs in the output filename are also replaced.

```bash
for f in /path/to/real/exports/*.xml; do
    uv run --script scripts/anonymize_camt.py "$f" tests/data/
done
```

**UBS cards CSV** (`scripts/anonymize_ubs_cards.py`) — replaces account number, card number, cardholder name, merchant names, and sector. Footer/summary lines are preserved as-is.

```bash
uv run --script scripts/anonymize_ubs_cards.py /path/to/real/cards.csv tests/data/ubs_cards_anon_1.csv
```

**UBS account CSV** (`scripts/anonymize_ubs_csv.py`) — replaces account number, IBAN, transaction reference, and description fields.

```bash
uv run --script scripts/anonymize_ubs_csv.py /path/to/real/account.csv tests/data/ubs_valid.csv
```

---

## Dependencies

| Package           | Role                            |
| ----------------- | ------------------------------- |
| @actual-app/api   | Official Actual Budget JS API   |
| csv-parse         | CSV reading for the parsers     |
| yaml              | `config.yml`                    |
| typescript        | Type checking (dev only)        |
| eslint            | Linter (dev only)               |
| typescript-eslint | Its type-aware rules (dev only) |
| prettier          | Formatter (dev only)            |

---

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues (`afrossard/actual-budget-transformer`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` at the repo root; new ADRs in `docs/adr/`, original seven in `docs/archive/`). See `docs/agents/domain.md`.
