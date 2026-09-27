# Probes: what Actual's write API actually does

Three throwaway node scripts that establish the behaviour the direct-import
write path rests on.
They are not tests; they print what happened so a human can read it.

They matter more than the prototype beside them, for two reasons.
They are plain node against `@actual-app/api`, which is the stack the project moves to (#41), so they do not die with the Python code.
And they are re-runnable: when the server or the api version bumps, these three files re-check assumptions that ADR-007 exists because version skew has broken before.

## Running them

They need the disposable server and a bootstrapped budget:

```bash
docker compose -f .devcontainer/docker-compose.yml --profile actual up -d actual-server
ACTUAL_SERVER_URL=http://localhost:5006 npm run bootstrap
node probes/probe_add.cjs
```

Each writes into `Test Savings` on dates far in the future, so they do not collide with the integration suite.
`/data` is tmpfs, so `down` then `up` then `bootstrap` gives a clean budget.

## What each one established

### `probe_add.cjs` - `importTransactions` matches, `addTransactions` does not

A hand-entered transaction, then one bank copy through each write path, each carrying a **unique** imported ID.

- `importTransactions` returned `added=0 updated=1`: it merged the bank's copy into the hand entry although the imported ID was new.
- `addTransactions` created a row.

This is why the write path bypasses `importTransactions` entirely (map #43, *Write path*).
Minting a distinct imported ID does **not** prevent a merge: the matcher keys on the *candidate* row having no imported ID, not on ours.

### `probe_fields.cjs` - the update set on an `imported_id` match

Two seeded transactions re-sent under a matching imported ID with both the amount and the date changed.
One had payee, notes and category filled; the other had them empty.

| field | existing full | existing empty |
| --- | --- | --- |
| `date` | unchanged | unchanged |
| `amount` | unchanged | unchanged |
| `imported_payee` | written | written |
| `cleared` | written | written |
| `notes` | unchanged | written |
| `category` | unchanged | written |
| `payee` (link) | unchanged | unchanged |

The amount and date are never written, even when they differ and nothing required them to match.
`notes` and `category` are written only into empty fields.
The policy is *fill the gaps, never overwrite the human, always claim the row with my imported ID* - reasonable for a bank-sync tool, wrong for this one, because the bank's date and amount are the fields we trust most.

### `probe_splits.cjs` - splits survive

A transaction split across two categories, then the bank re-sends it under the same imported ID with a different amount.

- The amount stayed, and the parts stayed. A re-import cannot break a split's sum.
- A plain `updateTransaction` on the parent's date and notes left the parts untouched.

Actual does propagate to children, but only `cleared` and `date`, and only when those changed.
Since `updateDates` is hard-coded `false` for the public `importTransactions`, that leaves `cleared` as the only propagating field.

### `probe_reconciled.cjs` and `probe_patch.cjs` - the reconciled guard is ours

A pending-style transaction (no imported ID) reconciled, then the booked version arriving with a **new date and a new amount**.

- `importTransactions` returned `added=1`: it created a second transaction rather than touching the reconciled one.
  The source reads `if (match.reconciled) { … continue; }` (`dist/index.js:111607`).
  Nothing linked the two - no imported ID to match, and both our +/-1 day check and Actual's fuzzy layer require an equal amount, which had changed.
  So importing pending card rows trades a missing transaction for a duplicate one unless identity is solved (#48).
- `updateTransaction` has **no reconciled guard**.
  Patching `date` and `amount` on a reconciled transaction succeeded, and the `reconciled` flag stayed true.
  `probe_patch.cjs` isolates this against a non-reconciled row to show the behaviour is the same either way.

ADR-002's keystone rule - never touch a reconciled transaction - is therefore **this tool's own guard**, not something Actual enforces on the write path.

One unexplained detail: in `probe_reconciled.cjs` the patch call also raised `Cannot read properties of undefined (reading 'slice')` *after* applying the change.
`probe_patch.cjs` does not reproduce it, so it is incidental rather than a refusal.
Not chased further; noted so nobody reads it as a rejection.

## Still open

What to do when the bank's amount differs from a split parent's amount.
Patching the parent leaves the parts not summing to it; leaving it means Actual disagrees with the bank.
Undecided - see #38.
