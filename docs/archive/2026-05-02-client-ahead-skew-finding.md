# 2026-05-02 — Client-ahead skew breaks the bundled web client

**Type:** test finding
**Drives:** ADR-007 (version-skew policy flipped to abort on `api > server`)

## What was tried

Extend `test_staggered_upgrade.sh` with an automated `browser_compat_check` step so that API↔server skew breakage would be caught by CI, not by the user noticing the UI is broken.

## What was found

- **`client-ahead` skew breaks the older web client (manually confirmed).** Run `actual-up` (server pinned to 25.3.1) → `npm run bootstrap` → `uv run pytest tests/test_actual_api_smoke.py`. The 26.4.0 API migrates the SQLite schema forward; opening `http://localhost:5006` in a browser then shows "Please update Actual!" and refuses to load the budget.
- **The older API does not detect the same breakage.** After the 26.4.0 API touched the budget, opening it with the 25.3.1 API (fresh data dir → `downloadBudget` → `getAccounts` → `getTransactions` → `getAccountBalance` → `getCategories` → `sync`) succeeds without error. Mirroring the smoke test surface in p2 did trigger the migration, but the V_OLD API still opened the result cleanly. So **"old API can open" is not a valid proxy for "old browser can open"** — the API tolerates schema versions the web client refuses.
- **Implication for the staggered test.** API↔API tests cannot prove web-client compatibility. The only reliable signal is loading the actual web bundle (e.g. headless Playwright against the live server).
- **`browser_compat_check` direction abandoned.** Proper automated detection would require a headless browser test — out of scope; manual check before planned upgrades is acceptable given a single user.

## Outcome

The findings flipped the version-skew policy. See ADR-007 for the new abort-on-`api>server` rule and rationale.
