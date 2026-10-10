# Contributing

## Commit messages: Conventional Commits

Every commit that lands on `main` follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
release-please cuts the releases, and the commit type is what computes the version bump, so this is load-bearing, not cosmetic.

Pull requests are squash-merged with the PR title as the commit subject, so **the PR title is the commit message**.
The `PR title lint` check rejects a title that does not follow the convention.

## Versioning

The image's version is its own semver, not Actual's.
The two change for different reasons: a UBS export change needs a release with no Actual bump, and an Actual release needs one with no change to the tool.

Releases stay below 1.0 until the tool has run against a real budget (#27, #32).
Until then a breaking change bumps the minor version, as a `feat:` does.
From 1.0 on:

| Change | Commit | Bump |
| --- | --- | --- |
| A `config.yaml` change that makes you edit yours, a removed or renamed CLI flag | `feat!:`, or a `BREAKING CHANGE:` footer | major |
| New behaviour, a new statement format, **a new Actual version** | `feat:` | minor |
| A parser fix after a UBS export change, wording, docs | `fix:` | patch |
| Tests, CI, tooling, refactoring | `chore:`, `ci:`, `test:`, `refactor:` | no release |

A new Actual version is a `feat(deps)`, not a `fix(deps)`, because it changes the one server version the image works with.
Strict semver would call that breaking, but a major version every month is noise, and the CLI fails safely with a message naming both versions and the image tag to use (ADR 0004).

## Releases

There is no manual release step.
Merging to `main` lets release-please maintain a release PR, which collects the commits since the last release into `CHANGELOG.md`, `package.json`'s version, and the image pin in `scripts/abt-import`.
Merging that PR tags the release and, in the same run of `release.yml`, publishes the image.
`CHANGELOG.md` is release-please's: never edit it by hand.

Each release, say `0.4.2`, publishes `ghcr.io/afrossard/actual-budget-transformer` under these tags:

| Tag | Moves | Points at |
| --- | --- | --- |
| `:0.4.2` | never | this release; `scripts/abt-import` pins it |
| `:0.4`, `:0` | yes | the newest release in that range |
| `:latest` | yes | the newest release |
| `:actual-26.10.0` | yes | the newest release built against `@actual-app/api` 26.10.0 |

The image also carries an `actual-api-version` label, so `docker inspect` says which Actual it was built against.
It works with exactly that server version, patch included (ADR 0004).

### Republishing

Dispatching `Publish image` by hand (`gh workflow run publish-image.yml`) rebuilds and republishes the newest release, for instance after a base image fix.
It never republishes an older release, because the moving tags would then point backwards.

### A failed release run is healed by re-running it

A transient GitHub API error can crash release-please mid-release, leaving a tag with no GitHub release and no image.
release-please is idempotent on retry: it finds the merged release PR still labelled `autorelease: pending`, reuses the tag, creates the missing release, and sets the outputs the publish job needs.
So the recovery is `gh workflow run release.yml` on `main`.
Never hand-create the GitHub release: the retry would then see it, skip ahead, and never publish the image.

### Never snooze a closed release PR

release-please reuses one branch, `release-please--branches--main`, for its release PR every cycle.
The `autorelease: snooze` label triggers an unfixed upstream bug ([googleapis/release-please#2566](https://github.com/googleapis/release-please/issues/2566)) that makes the next release skip silently.
Leave an unwanted release PR open, which release-please updates in place; if it must be closed, leave it unlabelled.

## Renovate PRs

`renovate.json` makes Renovate title its PRs as Conventional Commits:

- **The grouped `Actual` PR** is `feat(deps): require actual server <version>`, so it releases, and the release notes say which server the new image needs.
- **Other runtime dependencies** (`csv-parse`, `yaml`) are `fix(deps)`, because they ship in the image.
- **Everything else** (dev tooling, GitHub Actions) is `chore(deps)`: nothing shipped changes, so nothing is released.
