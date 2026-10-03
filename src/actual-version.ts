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
  for (const i of [0, 1, 2] as const) {
    if (a[i] !== b[i]) return a[i] - b[i];
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

/**
 * `/info` under the server's own base path.
 *
 * A root-relative URL would throw the base path away - `new URL('/info',
 * 'https://host/actual/')` is `https://host/info` - which 404s for a server
 * behind a subpath reverse proxy. The probe would then report an unknown version
 * and the run would abort, although `@actual-app/api` works against that same
 * URL perfectly well.
 */
export function infoUrl(serverUrl: string): URL {
  return new URL('info', serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
}

/** Where the server's version was asked for, and what came back. */
export type ServerVersionProbe =
  | { url: string; version: string }
  | {
      url: string;
      version: null;
      /** What came back instead: the reason, the HTTP status, or a missing field. */
      failure: string;
      /** What the user can do about this particular failure. */
      hint: string;
    };

const UNREACHABLE =
  'Check that the Actual server is running and reachable from this machine at ' +
  'server_url (or ACTUAL_BUDGET_URL).';

/**
 * Asks `/info` for the server's version, and keeps the reason when it cannot
 * (#78): a wrong URL, a TLS error, a timeout, a login page in front of the
 * server and a server without the field each call for a different fix.
 */
export async function probeServerVersion(
  serverUrl: string,
  timeoutMs = 10_000,
): Promise<ServerVersionProbe> {
  // `localhost:5006` parses with `localhost:` as its scheme; a bare host does
  // not parse at all.
  let info: URL | null = null;
  try {
    info = infoUrl(serverUrl);
  } catch {
    // Reported below, with the address as the user wrote it.
  }
  if (info === null || (info.protocol !== 'http:' && info.protocol !== 'https:')) {
    return {
      url: serverUrl,
      version: null,
      failure: 'not an http:// or https:// URL',
      hint:
        'Write server_url (or ACTUAL_BUDGET_URL) in full, with its scheme, such as ' +
        'http://localhost:5006.',
    };
  }
  const url = info.href;
  const fail = (failure: string, hint: string): ServerVersionProbe => ({
    url,
    version: null,
    failure,
    hint,
  });

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return fail(`no response within ${timeoutMs / 1000} seconds`, UNREACHABLE);
    }
    return fail(connectionFailure(error), UNREACHABLE);
  }

  if (!response.ok) {
    return fail(
      `HTTP ${response.status} ${response.statusText}`.trim(),
      'Check that server_url (or ACTUAL_BUDGET_URL) is the address you open Actual at ' +
        'in a browser, including any base path.',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const type = response.headers.get('content-type') ?? 'no content type';
    return fail(
      `the response is not JSON (${type})`,
      // Actual's own web app answers any path it does not serve with HTML.
      "A web page answered instead of Actual's API: either server_url (or ACTUAL_BUDGET_URL) " +
        'has the wrong base path, or a login page or an authenticating proxy sits in ' +
        'front of the server. Point it at an address that reaches Actual directly.',
    );
  }
  const version = (body as { build?: { version?: unknown } } | null)?.build?.version;
  if (typeof version !== 'string') {
    return fail(
      'no version field in the response',
      'The server answered, but not as an Actual server does. Check that server_url ' +
        '(or ACTUAL_BUDGET_URL) points at Actual.',
    );
  }
  return { url, version };
}

/** `fetch failed` says nothing; the reason is on its `cause`. */
function connectionFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  // A host with several addresses (`localhost`: ::1 and 127.0.0.1) fails with
  // one error per address, and an empty message of its own.
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors
      .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
      .join('; ');
  }
  if (cause instanceof Error) {
    const { code, reason } = cause as { code?: unknown; reason?: unknown };
    // An OpenSSL error's message is a colon-separated dump; its `reason` is the
    // readable part.
    const message = typeof reason === 'string' ? reason : cause.message.trim();
    if (typeof code === 'string' && !message.includes(code)) {
      return `${code}: ${message}`;
    }
    return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Why the version matters, in the user's terms rather than this repo's. */
const CONSEQUENCE =
  'This tool does not open a budget while its @actual-app/api library is newer than ' +
  "the server: the library would upgrade the budget to a format the server's web " +
  'client cannot open.';

const REINSTALL = "Reinstall this tool's dependencies with `npm ci`.";

/** Throws unless the API is at most as new as the server. */
export function assertVersionCompatible(
  apiVersion: string | null,
  server: ServerVersionProbe,
): void {
  if (!apiVersion) {
    throw new Error(
      'aborting: could not determine the installed @actual-app/api version.\n' +
        `  ${REINSTALL}\n  ${CONSEQUENCE}`,
    );
  }
  if (server.version === null) {
    throw new Error(
      `aborting: could not read the Actual server's version from ${server.url}: ` +
        `${server.failure}.\n  ${server.hint}\n  ${CONSEQUENCE}`,
    );
  }
  const api = parseSemver(apiVersion);
  if (!api) {
    throw new Error(
      `aborting: cannot parse the installed @actual-app/api version '${apiVersion}'.\n` +
        `  ${REINSTALL}`,
    );
  }
  const serverSemver = parseSemver(server.version);
  if (!serverSemver) {
    throw new Error(
      `aborting: cannot parse the Actual server's version '${server.version}', ` +
        `as reported by ${server.url}.\n  ${CONSEQUENCE}`,
    );
  }
  if (compareSemver(api, serverSemver) > 0) {
    throw new Error(
      `aborting: this tool's @actual-app/api ${apiVersion} is newer than the Actual ` +
        `server's ${server.version}, as reported by ${server.url}.\n` +
        '  Opening the budget with it would upgrade the budget to a format the ' +
        "server's web client cannot open, until the server is upgraded too. " +
        'Nothing is lost, but the budget cannot be reviewed in Actual in the meantime.\n' +
        `  Upgrade the Actual server to ${apiVersion} or later.`,
    );
  }
}
