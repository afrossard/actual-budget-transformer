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

## Still open

What to do when the bank's amount differs from a split parent's amount.
Patching the parent leaves the parts not summing to it; leaving it means Actual disagrees with the bank.
Undecided - see #38.
