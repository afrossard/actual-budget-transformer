# The import CLI, run as `node src/cli.ts` - there is no build step, because
# Node strips the types itself.
#
# This follows Actual's own default image (actual-server is built from
# node:<major>-bookworm-slim): a production-only install, `node_modules`
# shipped whole, no bundler. Bundling does not work against Actual's CJS graph
# today, and better-sqlite3 is a native addon that could never be bundled (#61).
#
# The Node version is Actual's, from `.nvmrc`; a unit test fails when the two
# disagree (AGENTS.md, "Versions: follow Actual").

# The builder holds npm's cache and anything an install script leaves behind.
FROM node:24.18.1-trixie-slim AS builder

ARG TARGETPLATFORM

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm,id=npm-${TARGETPLATFORM} \
  --mount=type=bind,source=package.json,target=package.json \
  --mount=type=bind,source=package-lock.json,target=package-lock.json \
  npm ci --omit=dev

FROM node:24.18.1-trixie-slim

ENV NODE_ENV=production

WORKDIR /app

# Owned by root: readable by whichever user runs it, writable by none.
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The image's own non-root `node` user, numeric so a runtime can check it is
# not root without resolving a name. `--user "$(id -u):$(id -g)"` overrides it,
# which works because nothing above is writable or needs to be: the gateway
# downloads the budget into a fresh directory under /tmp.
USER 1000:1000

# No init: this is a short interactive process, not a server. Under msb `node`
# is not PID 1; under docker, `docker run --init` is what lets Ctrl-C through.
ENTRYPOINT ["node", "src/cli.ts"]
