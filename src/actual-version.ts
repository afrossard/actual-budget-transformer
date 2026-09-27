/**
 * ADR-007: abort when `@actual-app/api` is newer than the server, and abort
 * whenever the skew cannot be assessed at all.
 *
 * A newer API migrates the budget's schema forward; the older server's bundled
 * web client then refuses to load it. No data is lost, but the only review UI
 * is unusable until the server is upgraded, so the conservative move is not to
 * start.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Semver = [number, number, number];

function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * The installed `@actual-app/api` version, read from the package itself.
 *
 * ADR-007's sketch kept this as a literal because a bundled build might not
 * reach `package.json`; this codebase has no bundling step and runs from
 * source, so reading the installed package removes the drift the ADR listed as
 * a risk. (The bridge's literal has since drifted: it says 26.4.0 against a
 * 26.5.2 dependency.) `./package.json` is not an exported subpath, so resolve
 * the entry point and walk up to the manifest beside it.
 */
export function installedApiVersion(): string | null {
  const require = createRequire(import.meta.url);
  let dir: string;
  try {
    dir = dirname(require.resolve('@actual-app/api'));
  } catch {
    return null;
  }
  for (let i = 0; i < 6; i += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === '@actual-app/api') return manifest.version ?? null;
    } catch {
      // Not this directory; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function probeServerVersion(serverUrl: string): Promise<string | null> {
  try {
    const response = await fetch(new URL('/info', serverUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { build?: { version?: string } };
    return body.build?.version ?? null;
  } catch {
    return null;
  }
}

/** Throws unless the API is at most as new as the server. */
export function assertVersionCompatible(
  apiVersion: string | null,
  serverVersion: string | null,
): void {
  if (!apiVersion) {
    throw new Error(
      'aborting: could not determine the installed @actual-app/api version. Cannot assess version skew (ADR-007).',
    );
  }
  if (!serverVersion) {
    throw new Error(
      'aborting: could not determine the server version from /info. Cannot assess version skew (ADR-007).',
    );
  }
  const api = parseSemver(apiVersion);
  if (!api) throw new Error(`aborting: cannot parse API version '${apiVersion}'`);
  const server = parseSemver(serverVersion);
  if (!server)
    throw new Error(`aborting: cannot parse server version '${serverVersion}'`);
  if (compareSemver(api, server) > 0) {
    throw new Error(
      `aborting: @actual-app/api ${apiVersion} is newer than server ${serverVersion}. ` +
        `The newer API would migrate the budget schema forward, and the older server's bundled ` +
        `web client would then refuse to load it ("Please update Actual!"). Upgrade the server ` +
        `to >= ${apiVersion}. Data is not lost. See docs/archive/adr-007-version-skew-policy.md.`,
    );
  }
}
