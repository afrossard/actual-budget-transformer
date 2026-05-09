# ADR-007: Version-skew policy — abort on `api > server`

**Status:** Accepted
**Date:** 2026-05-07 (supersedes the original log-only policy from 2026-04)

## Context

The Actual server is upgraded independently of `@actual-app/api`.

- Server exposes `GET /info` (unauthenticated): `{ build: { name, description, version } }`.
- No documented compatibility matrix. Releases are calver and roughly monthly; the 25 → 26 bump is calver, not semver, with no implied break.
- Sync routes (`/sync`, `/upload-user-file`, `/download-user-file`, …) have been stable across the sampled releases.
- Observed breaks were JS-API type-shape changes (e.g. `APIAccountEntity.type` removed, `ImportTransactionEntity.account` required) — caught by `tsc` at build time, not runtime sync corruption.

### Original policy (2026-04, now superseded)

Pin + log-only: pin `@actual-app/api` in `dependencies`, log `{ server, api }` on connect, never abort. Rationale rested on `test_staggered_upgrade.sh` showing wide skew was fine in practice.

### What changed

- **2026-05-02 — `client-ahead` (newer API + older server) breaks the bundled web client.** The newer API migrates the SQLite schema forward; the older web client then refuses to load the budget ("Please update Actual!"). Data is not corrupted — the migration is well-formed — but the only review UI is unusable until the server is upgraded. (See `2026-05-02-client-ahead-skew-finding.md`.)
- **2026-05-07 — `server-ahead` (newer server + older API) is clean.** Validated baseline/warm/cold across V_OLD=25.3.1 API ↔ V_NEW=26.4.0 server with bit-for-bit readback, idempotency, balance, and browser cross-check. (See `2026-05-07-server-ahead-assessment.md`.)
- **API↔API tests don't prove web-client compatibility.** The older API tolerates schema versions the web client refuses, so `test_staggered_upgrade.sh` cannot detect the client-ahead break. Headless-browser detection is out of scope; manual check before planned upgrades is acceptable for a single user.

API may lag the server, but the reverse breaks the UI. Conservative-automation principles (ADR-002) argue for abort.

## Decision

1. **Pin** stays as-is (`@actual-app/api` in `dependencies`).
2. **Abort on `api > server`** at bridge `cmdOpen` time, with a message that explains the actual failure mode (newer API would migrate schema → older server's bundled web client refuses → recovery is server upgrade, not data loss).
3. **Abort on any unknown-version case** — `/info` unreachable, version field missing, version unparseable, or our own pinned version unset. If we can't assess the skew, we don't proceed.
4. **Proceed (log-only) on `api ≤ server`.**

### Implementation sketch

- Source of our API version: hardcoded literal in the bridge.

  ```ts
  // kept in sync with package.json's @actual-app/api dep. Bundle-safe — a
  // literal, no fs/JSON read at runtime. Update on every dep bump.
  const PINNED_API_VERSION = '26.4.0';
  ```

  Rationale: `package.json` may not be reachable from a bundled production build. Resolution at runtime: `process.env.ACTUAL_API_VERSION` (test override) → `PINNED_API_VERSION` → abort.

- Drift mitigation between `PINNED_API_VERSION` and `package.json` (pick one or none):
  - Release-checklist note: "bumping `@actual-app/api` → update `PINNED_API_VERSION` in `actual_api_bridge.ts`."
  - Pre-commit / CI grep that fails on mismatch.

- In `src/actual_budget_transformer/bridge/actual_api_bridge.ts`, after the existing `probeServerVersion(serverURL)` call in `cmdOpen`:
  1. Resolve API version (`ACTUAL_API_VERSION` env > `PINNED_API_VERSION`). Missing → abort.
  2. Server version from `/info` (already fetched). Missing → abort.
  3. Semver compare on `[major, minor, patch]`. Unparseable on either side → abort.
  4. `api > server` → abort with the schema-migration / web-client explanation, naming the minimum server version that would lift the block (`>= ${apiVersion}`).
  5. `api ≤ server` → existing log line, proceed.

- The smoke test (`test_actual_api_smoke.py`) goes through the bridge. In the dev devcontainer the server is pinned to 25.3.1 and the API is 26.4.0, so the smoke test will trip the abort. **The smoke test will fail until either (a) the dev server pin is bumped to ≥ 26.4.0 or (b) the smoke test is run with `ACTUAL_API_VERSION=25.3.1` to match the server.** Decide which before merging.

### Out of scope for the initial change

- Pytest integration test that stands up V_OLD server with V_NEW API and asserts `BridgeError` with the version-skew message. Worth adding alongside the broader `tests/test_actual_importer_integration.py` work.

## Consequences

- Files to touch when implementing:
  - `src/actual_budget_transformer/bridge/actual_api_bridge.ts` — add `PINNED_API_VERSION`, helpers, and the gate in `cmdOpen`.
  - (Optional) `.devcontainer/docker-compose.yml` server pin and/or `package.json` to align dev-server with API version, so the smoke test still passes.

- Tested compatible range to date: `@actual-app/api` 25.3.1 ↔ 26.4.0 against `actualbudget/actual-server` 25.3.1 ↔ 26.4.0, both directions, fresh-slate and staggered-volume. `server-ahead` direction additionally validated 2026-05-07 with bit-for-bit readback + browser cross-check (warm + cold cache).
