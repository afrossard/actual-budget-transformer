# 2026-05-07 — Server-ahead skew assessment

**Type:** test finding + methodology
**Drives:** ADR-007 (server-ahead direction is safe; only `api > server` requires abort)

## Result

**Clean.** V_OLD=25.3.1 API ↔ V_NEW=26.4.0 server (post-migration). All three phases passed (baseline / warm-cache / cold-cache). Bit-for-bit readback, idempotent re-import, balance match, browser cross-check (V_NEW SPA, 9 tx visible, balance 709558¢) all green.

**Implementation note:** `loadBudget` requires offline-mode init (no `serverURL`), so the warm path uses `downloadBudget` against a retained `ACTUAL_DATA_DIR` — the cache distinction lives in dataDir state, not API call sequence.

## Methodology (preserved for future re-validation)

Realistic scenario: server upgrade (DB migrated on startup) → V_OLD API runs next import → user opens the V_NEW web bundle to verify. "Older browser" is moot — the server serves its own bundle, so post-upgrade the browser is V_NEW.

Test two cache variants, which exercise distinct code paths:

- **Warm cache** (run first, realistic): retain the pre-migration `ACTUAL_DATA_DIR` from the V_OLD baseline; V_OLD API's `sync()` applies deltas across the migration boundary. Unique failure mode: **silent divergence** — V_OLD API may drop fields it doesn't recognise from deltas, leaving the local mirror inconsistent with the server. Only visible by comparing API readback against the browser.
- **Cold cache** (recovery baseline): wipe `ACTUAL_DATA_DIR`, force `downloadBudget` to refetch. Decode-only path.

### Setup (extends the staggered server-ahead phase)

1. V_OLD baseline — start `actual-server:$V_OLD` on a persistent named volume, bootstrap with V_OLD API, seed a handful of transactions so migration has prior data.
2. Stop V_OLD container, start `actual-server:$V_NEW` on the same volume; wait healthy; confirm V_NEW via `GET /info`.
3. With V_OLD API pinned, run phase 3 twice — warm first, then cold.

### Phase 3 (fixed input set with stable `imported_id`s)

1. (Warm) `sync()` — does the cross-migration delta apply without error?
2. (Cold) `downloadBudget(syncId)` — does V_OLD API decode the migrated budget?
3. `importTransactions`; capture `{ added, updated, errors }`.
4. `sync()`.
5. `getTransactions` — assert count/amount/date/payee/`imported_id`/account match input bit-for-bit. Field drift surfaces here.
6. `getAccountBalance` — assert equals `sum(input amounts)`.
7. Re-import the same batch — assert zero new rows (dedup survives the migration).

### Browser cross-check (manual, private window for a fresh bundle)

- Page loads without "Please update Actual!"
- Imported transactions visible with correct fields
- UI balance matches API readback from step 6
- Sidebar and monthly views render

This is what catches warm-cache divergence.

### Outcome buckets

- Both pass → V_OLD API fully compatible with V_NEW server. Log the pair in the tested-range note.
- Warm fails, cold passes → documented mitigation: wipe `ACTUAL_DATA_DIR` after a server upgrade before the next import.
- Cold fails too → V_OLD API cannot talk to V_NEW server; bump the API in lockstep with the server.

## Harness

- `scripts/server_ahead_phase.ts` — single phase, `PHASE_MODE=baseline|warm|cold`. Fixed input set; bit-for-bit readback, idempotency, balance assertion. Reuses `api-loader.ts` for V_OLD pinning.
- `scripts/test_server_ahead_assessment.sh` — orchestrator. `V_OLD`/`V_NEW` env vars (default 25.3.1/26.4.0). Runs container `actual-server-skewtest` on volume `actual-budget-transformer-skewtest-data` with port 5006 published; leaves V_NEW server up at end for the manual browser check; `teardown` arg cleans up.
