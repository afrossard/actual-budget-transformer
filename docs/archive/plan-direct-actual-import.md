# Plan: Direct Import into Actual Budget

## Intent

A new `--format actual` option that imports transactions straight into a self-hosted Actual Budget server, replacing the manual CSV/XML import step. The automated path must be at least as safe as the manual workflow it replaces — see `archive/adr-002-conservative-automation-principles.md`.

## Scope (decided 2026-06-15)

**CAMT.053 is parked.** The user no longer downloads CAMT files (too annoying); the active workflow is UBS CSV (account + cards). CAMT code stays in place but is *not* on the prod-readiness path. This parks the CAMT-specific risks: **#3** (real CAMT untested), **#8** (CAMT float→cents rounding), and **#9** (multi-statement CAMT — open question of data-loss vs. anomaly left unresolved; revisit only if CAMT is unparked). The pre-prod checklist's CAMT dry-run/live steps retarget to a UBS CSV account.

**Balance verification is dormant.** Checkpoints came only from CAMT CLBD, and the UBS account CSV — which used to carry a running `balance` — now delivers that column as nulls. So *no active input path produces a `BalanceCheckpoint`*, and the inline balance check (ADR-005's second half) never runs. The code stays for if/when a balance source returns. **Consequence:** the automated safety net is now reconciliation-boundary skip + imported-ID dedup + bucket classification + circuit breaker only. **Balance reconciliation is manual** (the human reconciles in Actual). ADR-005 is therefore half-dormant — monthly batching still gives atomic circuit-breaker windows; its balance-verification purpose is inert.

## Status

- **In place:** TS bridge with version-skew gate (ADR-007), Python wrapper, smoke + gate pytest suites, devcontainer Actual profile (server pinned to 26.4.0), bootstrap script (now also creates the `Review` group + `To Review` category). `ActualBudgetImporter` (ADR-002/005/006) wired through `--format actual`; offline unit tests + 6 live-server integration tests passing (smoke / idempotent re-run / suspicious + review category / circuit breaker / balance match / balance mismatch).
- **Decided:** see `archive/adr-001` … `archive/adr-007`.

## Next: prod-readiness gaps

The current suite validates the design we tested (offline logic + wiring against a synthetic budget). It does NOT validate two assumptions that matter most for a real budget — the `reconciled` field name, and the importer's behaviour on data prod accumulates over years. Run on a copy/subset before the real budget.

> **Doc/code drift to clear (found 2026-06-07).** ADR-0001's report-as-return-value design (importer returns a structured run report; `--dry-run` and live share one path) is **decided but unbuilt** — `import_transactions(...)` still returns `None` and communicates only via the logger. This gates checklist item 2: `--dry-run` is "produce the report, don't commit", so the report refactor is its prerequisite. Sequencing: checklist item 1 (reconciled-skip) is independent of the report and lands first; the report refactor must precede `--dry-run`.
>
> **The report's named deliverables** (per the *Run report* definition in `CONTEXT.md` — "bank data the tool chose not to import is surfaced here, never silently dropped"): per-account imported/skipped counts, **ignored extra CAMT statements**, balance mismatches, and account stops. Of these, ignored extra CAMT statements is a *silent drop today* and the report is what closes it — see multi-statement CAMT (risk #9). Until the report lands, it remains a logger-only gap, not the intended behaviour. (Pre-boundary drops are *not* a gap — see risk #1.)

**Top risks** (in order):

1. **Reconciliation filter unverified end-to-end.** ADR-002's keystone safety guarantee — "never touch reconciled tx" — is filtered on `t.get("reconciled")`. Field name confirmed by typedef inspection: `@actual-app/core/src/types/models/transaction.ts:25` declares `TransactionEntity.reconciled?: boolean` (distinct from `cleared` on line 24). Still unverified end-to-end: whether `getTransactions()` actually surfaces the field at runtime, and the actual skip behavior on a reconciled tx. `updateTransaction(id, fields)` exists in the public API (`@actual-app/api/@types/index.d.ts:171`), so the bridge can be extended to mark a tx reconciled programmatically — no UI dance.

   **Pre-boundary drops are correct behavior (decided 2026-06-15).** The filter (`actual_budget_importer.py:332`) drops on/before-boundary tx with only a `logger.info` count, and that is intentional: reconciliation is the human's attestation that the locked range is complete and correct, so the importer does not second-guess it. The one dangerous case — a backdated posting the bank value-dates inside the already-reconciled range — is caught by **manual reconciliation**: with balance verification dormant (see Scope), the human's next reconcile in Actual won't balance against the bank, so they investigate. (Had automated balance verification been live, it would have caught the same case as a checkpoint mismatch; it isn't, so the net is the human.) We accept that such an item surfaces as a balance discrepancy the human chases down, not a pinpointed missing-tx warning. The former "pre-boundary orphan" concept and its report section were removed.
2. **No dry-run mode.** First-time prod use is unrehearsed: classify → import → sync either commits or it doesn't. Add `--dry-run` that runs classification, logs `would import N clean / M suspicious / K skipped` per batch, and skips `importTransactions`/`sync`.
3. **Real CAMT against the importer is untested.** The processor has been chewing on real CAMT for the CSV path for months, but the CLBD-extraction → `BalanceCheckpoint` → in-bridge balance verification is fresh. Live balance math against real history is the assertion that matters.

   **Absolute balance check is intentional (decided 2026-06-15).** Verification compares Actual's *absolute* balance at the boundary to the *absolute* CLBD — not a relative OPBD→CLBD delta. Rationale: Actual's balance is only meaningful if it equals the bank's, so a matching balance is a precondition of using Actual at all, not a burden the importer adds. **Operating assumption:** each account has a starting-balance entry in Actual that matches the bank at that date; the span from there to the reconciliation boundary is attested by reconciliation; everything after is what the importer writes. Given that, absolute == absolute holds, and any in-span drift (missing/extra/wrong-amount tx) trips the check. **OPBD is parsed but currently unused** — it would only be needed for a relative check, which we rejected. Left in the parser as harmless (cheap, may support a future independent sanity-check); not wired into verification.

**Medium risks**:

4. **Transfers between accounts.** Actual links transfers as paired entries. The importer treats each side independently.
   - *One leg already in Actual:* the bank's copy matches by amount/±1-day → **blind duplicate** → suspicious → imported with review category; human cleans up. (Interaction with Actual's transfer-pair invariant still untested, but non-destructive: we import a plain tx, never a link.)
   - *Both legs clean in one run (decided 2026-06-15):* import **both as independent plain tx; do not auto-link** (option A). Auto-pairing two legs across accounts by amount/±1-day is a guess, forbidden by ADR-002's flag-don't-guess. Actual is *supposed* to auto-create the transfer link but has been unreliable in practice, so the human links them in the UI. Accepted cost: recurring manual linking. *Future option B (not now):* surface "likely transfer pairs seen this run" in the run report as a convenience, still without auto-linking.
5. **Manually-entered tx (no `imported_id`) with same amount/date.** Suspicious path imports a *new* tx with the review category alongside the manual one → user has two visually-duplicate rows to clean up. Not destructive but messy.
6. **`imported_id` drift (reframed + downgraded to low, 2026-06-15).** The original framing — "when `reference` is empty, hash = `(date, amount, payee, notes)` and drifts when banks reformat descriptions" — does **not** apply to the active workflow: both UBS processors always populate `reference`, so `_stable_id(date, amount, payee, notes)` (`actual_budget_importer.py:77`) is never reached. (It survives only as a fallback for a hypothetical reference-less source; CAMT, which could have hit it, is parked.)
   - **Account CSV:** native `N° de transaction` reference — stable, no drift.
   - **Cards:** synthesized reference = `sha256(Date d'achat | Texte comptable | Montant | Monnaie originale | <occurrence>)` (`ubs_cards_csv_transaction_processor.py:113-121`). The four content fields are stable (original-currency, pending excluded). The **only** drift vector is the per-export `cumcount` occurrence index used to disambiguate same-day/same-merchant/same-amount/same-currency duplicates: stable under strictly non-overlapping monthly exports, but can shift across **overlapping** exports if a same-key duplicate group's membership changes between exports (e.g. one of two identical charges was pending in export A, posted in B → indices reshuffle → that tx's reference changes → re-imported).
   - **Disposition:** accept and document. Mitigated by the monthly-forward operating rule (don't re-export an imported month). The old "measure empty-reference fraction" spike is moot (~zero by construction). *Optional future hardening, only if real collisions appear:* fold a more disambiguating stable field (e.g. settlement date `Ecriture`) into the cards key to lean less on the counter — deferred, as it risks its own drift.

**Low risks**:

7. Bridge subprocess has no read timeout — a stalled sync hangs indefinitely (Ctrl-C works).
8. Float→cents rounding in `BalanceCheckpoint.amount` could miss by 1 cent on degenerate decimals; bank-provided amounts make this unlikely.
9. Multi-statement CAMT (`stmt[1+]`) is ignored — we only read `stmt[0]`. **Currently silent; the report closes this** by surfacing ignored extra statements as a warning section (`CONTEXT.md`, *Run report*). Logger-only until then.

**Pre-prod checklist** (in order — earlier items unblock later ones):

- [ ] Add `update_transaction` to the bridge (generic `{id, fields}` TS command + Python wrapper `update_transaction(tx_id, fields)`) and write an automated integration test for the reconciled-skip path. **Settled design (2026-06-07):** runs on "Test Savings" with deep-past dates to stay reset-free — the reconciliation boundary is account-global persistent server state and cannot be `run_tag`-scoped, so it must sit *below* every other test's date range (convention: real test dates ≥ 2030, deep-past reserved for reconciliation-boundary tests; documented in the integration test docstring). Seed a tx at `2020-06-30`, mark it reconciled via the bridge, then three assertions: **(A)** `getTransactions()` surfaces it with `reconciled` truthy (runtime field-name confirmation); **(B)** a source tx dated `2020-06-15` (≤ boundary) is filtered out; **(C)** a source tx dated `2020-07-15` (> boundary) is imported (control — proves the filter isn't dropping everything). Settles risk #1 and gives a regression guard in one shot.
- [ ] **Report refactor (ADR-0001).** Make the importer produce a structured run report (per-run summary) instead of communicating only via the logger. **Active deliverables (post-CAMT-park):** per-account imported/skipped counts; **account stops** (circuit-breaker trips). Dormant/parked deliverables — keep in the model, won't fire without their source: *balance mismatches* (no checkpoints — see Scope) and *ignored extra CAMT statements* (risk #9, CAMT parked). Warning sections render only when non-empty (so the dormant ones simply never show). Prerequisite for `--dry-run`. **Mechanism is undefined (2026-06-15):** whether it's a return value of `import_transactions`, a per-call fragment aggregated by the importer, or an accessor is an open implementation detail — ADR-0001's "return-value" title over-commits this and should be narrowed when the mechanism settles to its durable decision (the report, not the log, is the trusted record; dry-run/live share the classification path).
- [ ] Add `--dry-run` flag. Settles risk #2. Active behaviour: run classification + build the report (clean/suspicious/skip counts per batch), skip `importTransactions`/`sync`. **Balance verification in dry-run (decided 2026-06-15, currently dormant):** *if* a checkpoint source ever returns (CAMT unparked, or a balance reappears in the CSV), dry-run must not read post-write balance (no writes); instead it **simulates** the projected balance — `current account balance + sum(clean+suspicious cents that would be imported in the batch, after the circuit breaker)` — and compares to the checkpoint, surfacing the same mismatch a live run would. This is a deliberate `if dry_run:` fork at the verification step (a narrow exception to ADR-0001's "one path"; fold into ADR-0001 when its mechanism settles). Moot today since balance verification is dormant.
- [ ] Run `--dry-run` on one month of the smallest account; eyeball the log.
- [ ] Live-run that same month; verify in the Actual UI before scaling up.
- [ ] Add a test fixture for transfers. Behaviour decided (risk #4, option A): both legs clean → two independent plain tx imported, both clean, no breaker trip, no link created. Test asserts that outcome. (Also worth observing how an Actual-linked counter-tx surfaces in `getTransactions` for the one-leg-already-present blind-duplicate case.)

## Future work

- **Import pending card transactions (wanted; not now).** UBS cards routinely carry 5–10 pending tx — date and amount mostly known, but `Débit`/`Crédit` empty until booked, so the cards processor currently filters them out (`ubs_cards_csv_transaction_processor.py:86-88`). The user nearly always reconciles, and the UBS UI's balance *includes* pending, so today the user must hand-enter (or deduce from the balance) those tx to reconcile. Automating this is a definite future want.
  - **Hard part — pending→posted identity.** A pending tx, once booked, reappears as a posted tx (booking date added, converted CHF amount finalized, possibly FX-adjusted). The importer must recognize the posted row as the *same* tx and update rather than duplicate.
  - **Foundation already exists.** The cards' synthesized reference uses *original-currency* fields (`Date d'achat`, `Texte comptable`, `Montant`, `Monnaie originale`) — all present in the pending state — so the reference is likely stable across the pending→posted transition. Watch: the `cumcount` occurrence counter (risk #6) and the moment the converted amount finalizes. Pending rows have no `Débit`/`Crédit`, so amount must be taken from `Montant`/`Monnaie` and the import path taught to handle that.

## Code in place

- `src/actual_budget_transformer/bridge/actual_api_bridge.ts` — bridge with version-skew gate
- `src/actual_budget_transformer/actual_api.py` — Python wrapper
- `src/actual_budget_transformer/writers/actual_budget_importer.py` — direct importer (ADR-002/005/006)
- `src/actual_budget_transformer/processors/camt053_parser.py` — now also returns balance entries (OPBD/CLBD/CLAV) for checkpoint batching
- `src/actual_budget_transformer/main.py` — `--format actual` enters the importer once per CLI invocation, lifts CAMT CLBD into checkpoints
- `config.template.yml` — `actual_budget:` block + env-var overrides
- `tests/test_actual_api_smoke.py` — bridge end-to-end smoke (6 cases)
- `tests/test_actual_api_version_gate.py` — version-skew gate (3 cases)
- `tests/test_actual_budget_importer.py` — offline unit tests (amounts, batches, classification, circuit breaker, config)
- `tests/test_actual_budget_importer_integration.py` — live-server integration tests (6 cases)
- `package.json`, `package-lock.json`, `tsconfig.json`

## Archive

Decisions and past test findings live in `archive/`:

- [ADR-001 — JS API over actualpy](archive/adr-001-jsapi-over-actualpy.md)
- [ADR-002 — Conservative-automation principles](archive/adr-002-conservative-automation-principles.md)
- [ADR-003 — Standalone importer (not writer subclass)](archive/adr-003-standalone-importer-not-writer.md)
- [ADR-004 — Bridge architecture](archive/adr-004-bridge-architecture.md)
- [ADR-005 — Checkpoint-based batching with balance verification](archive/adr-005-checkpoint-batching.md)
- [ADR-006 — Bucket classification + dedup](archive/adr-006-bucket-classification-and-dedup.md)
- [ADR-007 — Version-skew policy (abort on `api > server`)](archive/adr-007-version-skew-policy.md)
- [2026-05-02 — Client-ahead skew finding](archive/2026-05-02-client-ahead-skew-finding.md)
- [2026-05-07 — Server-ahead assessment](archive/2026-05-07-server-ahead-assessment.md)
- [Bridge implementation notes (gotchas, test modes)](archive/bridge-implementation-notes.md)
