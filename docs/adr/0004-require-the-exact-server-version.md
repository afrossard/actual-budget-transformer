# Require the server version to match `@actual-app/api` exactly

**Status:** accepted (2026-10-10)

The import aborts before it downloads anything unless the installed `@actual-app/api` version equals the version the server reports at `/info`, patch included.
This supersedes ADR-007's direction rule, which aborted only when the api was newer than the server.
ADR-007's other rule stands: a version that cannot be read on either side aborts too.

## Why

A run with api 26.9.0 against a server on 26.10.0 died inside `downloadBudget` with `Database is out of sync with migrations (index past available)` (#125).
A 26.10.0 client had already migrated that budget, so it carried a migration api 26.9.0 does not ship, and `@actual-app/core` refuses to open such a budget (`checkDatabaseValidity`).
The same run against another 26.10.0 server, holding an unmigrated copy of the same budget, had succeeded shortly before.

So whether a server-ahead run works depends on whether any newer client has opened the budget yet: server state this tool cannot see.
`docs/archive/2026-05-07-server-ahead-assessment.md` found server-ahead clean because its budget had only ever been opened by the older api; that finding no longer holds.
The api-ahead direction is still the break ADR-007 describes: the newer api migrates the budget, and the older server's web client refuses to load it.

## Trade-off

Exact, rather than the same major and minor, so nobody has to know which Actual releases carry migrations.
What it costs: every Actual release, patches included, needs a release of this tool before it can import against the upgraded server.
The grouped Renovate PR (`feat(deps): require actual server <version>`) already produces one per Actual release, and the abort names the `:actual-<version>` image tag to use instead.

## Consequences

- The server-ahead failure is not characterized by a test: the gate makes it unreachable through this tool, and reproducing it would need a second, newer `@actual-app/api` installed beside the pinned one to migrate the budget first.
- An image works with exactly one Actual server version, which `:actual-<version>` and the `actual-api-version` label name.
