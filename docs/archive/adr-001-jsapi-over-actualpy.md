# ADR-001: Use the official JS API, not `actualpy`

**Status:** Accepted
**Date:** 2026-04 (originally), recorded here 2026-05-09

## Context

Three options existed for talking to an Actual Budget server from Python:

1. Reimplement the sync protocol from scratch.
2. Use `actualpy`, a third-party Python port.
3. Drive the official `@actual-app/api` (Node) from Python via a subprocess bridge.

## Decision

Use the official JS API (option 3).

- **Reimplementing** is ruled out: undocumented CRDT/binary/libsodium machinery.
- **`actualpy`** is rejected: it reimplements the sync protocol in Python and writes directly to the SQLite schema. A server-side schema or protocol change can silently corrupt the user's real budget; integration tests would catch it only after the fact.
- **Official JS API** is maintained by the Actual team alongside the server. Schema changes are handled internally; if it breaks, it breaks cleanly.

## Consequences

- Node runtime dependency in the toolchain.
- Subprocess overhead per import run.
- Bridge code (TS) needed to expose the API to Python (see ADR-004).
- Bounded engineering cost vs. unbounded data-loss risk from a stale third-party reimplementation.
