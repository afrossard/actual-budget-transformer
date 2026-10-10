import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertVersionCompatible,
  infoUrl,
  installedApiVersion,
  probeServerVersion,
  type ServerVersionProbe,
} from '../../src/actual-version.ts';

const URL_PROBED = 'http://actual.example/info';

function at(version: string): ServerVersionProbe {
  return { url: URL_PROBED, version };
}

function unreadable(failure: string): ServerVersionProbe {
  return { url: URL_PROBED, version: null, failure, hint: 'Try this.' };
}

/** The probe failed; narrows it so its failure and hint can be read. */
function failed(probe: ServerVersionProbe): { failure: string; hint: string } {
  if (probe.version !== null)
    assert.fail(`expected a failed probe, got ${probe.version}`);
  return probe;
}

/** A local HTTP server for one test; the probe is never pointed at Actual's api. */
async function serving(
  handler: RequestListener,
  run: (serverUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/actual`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('an api built for the server version proceeds', () => {
  assertVersionCompatible('26.9.0', at('26.9.0'));
  assertVersionCompatible('26.10.0', at('26.10.0'));
});

test('a server ahead of the api aborts, and names the release built for it', () => {
  // #125: a budget a newer client has migrated carries migrations an older api
  // does not ship, and `downloadBudget` then dies with "Database is out of sync
  // with migrations". Whether that has happened is server state this tool cannot
  // see, so a newer server aborts before anything is downloaded.
  assert.throws(
    () => assertVersionCompatible('26.9.0', at('26.10.0')),
    (error: Error) => {
      assert.match(
        error.message,
        /Actual server is 26\.10\.0, as reported by http:\/\/actual\.example\/info, but this tool is built for 26\.9\.0\./,
      );
      assert.match(error.message, /abt-import release built for 26\.10\.0/);
      assert.match(error.message, /:actual-26\.10\.0/);
      assert.doesNotMatch(error.message, /Upgrade the Actual server/);
      return true;
    },
  );
  // Patch included: nobody has to know which Actual releases carry migrations.
  assert.throws(() => assertVersionCompatible('26.9.0', at('26.9.1')), /aborting/);
  assert.throws(() => assertVersionCompatible('25.3.1', at('26.4.0')), /aborting/);
});

test('an api ahead of the server aborts, and says what it would break and how to lift the block', () => {
  assert.throws(
    () => assertVersionCompatible('26.10.0', at('26.9.0')),
    (error: Error) => {
      assert.match(
        error.message,
        /Actual server is 26\.9\.0, as reported by http:\/\/actual\.example\/info, but this tool is built for 26\.10\.0\./,
      );
      assert.match(error.message, /web client cannot open/);
      assert.match(error.message, /abt-import release built for 26\.9\.0/);
      assert.match(error.message, /Upgrade the Actual server to 26\.10\.0/);
      return true;
    },
  );
  assert.throws(() => assertVersionCompatible('27.0.0', at('26.9.0')), /aborting/);
  assert.throws(() => assertVersionCompatible('26.9.1', at('26.9.0')), /aborting/);
});

test('a version that cannot be read aborts rather than proceeding', () => {
  assert.throws(
    () => assertVersionCompatible(null, at('26.9.0')),
    /@actual-app\/api.*npm ci/s,
  );
  assert.throws(
    () => assertVersionCompatible('26.9.0', unreadable('HTTP 404 Not Found')),
    (error: Error) => {
      assert.match(error.message, /http:\/\/actual\.example\/info: HTTP 404 Not Found/);
      assert.match(error.message, /Try this\./);
      assert.match(error.message, /only with the Actual server version/);
      return true;
    },
  );
  assert.throws(
    () => assertVersionCompatible('not-a-version', at('26.9.0')),
    /cannot parse.*'not-a-version'/,
  );
  assert.throws(
    () => assertVersionCompatible('26.9.0', at('unknown')),
    /cannot parse.*'unknown'.*actual\.example/,
  );
});

test('no message names an ADR or a path inside this repo', () => {
  const messages = [
    () => assertVersionCompatible('26.10.0', at('26.9.0')),
    () => assertVersionCompatible('26.9.0', at('26.10.0')),
    () => assertVersionCompatible(null, at('26.9.0')),
    () => assertVersionCompatible('26.9.0', unreadable('HTTP 500')),
    () => assertVersionCompatible('x', at('26.9.0')),
    () => assertVersionCompatible('26.9.0', at('x')),
  ].map((fail) => {
    try {
      fail();
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail('expected a throw');
  });
  for (const message of messages) {
    assert.doesNotMatch(message, /ADR|docs\/|skew/i);
  }
});

test('the pinned api version is read from the installed package, so it cannot drift', () => {
  // ADR-007's sketch kept this as a literal for bundle safety; there is no
  // bundling step here, and the bridge's literal has already drifted.
  assert.match(installedApiVersion() ?? '', /^\d+\.\d+\.\d+$/);
});

test('the /info probe keeps the server URL base path', () => {
  // `new URL('/info', base)` throws the base path away, which 404s for a server
  // behind a subpath reverse proxy and aborts the run on an unknown version.
  assert.equal(
    infoUrl('https://host.example/actual/').href,
    'https://host.example/actual/info',
  );
  assert.equal(
    infoUrl('https://host.example/actual').href,
    'https://host.example/actual/info',
  );
  assert.equal(infoUrl('http://localhost:5006').href, 'http://localhost:5006/info');
  assert.equal(infoUrl('http://localhost:5006/').href, 'http://localhost:5006/info');
});

test('the probe reads the version from /info', async () => {
  await serving(
    (req, res) => {
      assert.equal(req.url, '/actual/info');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ build: { name: 'Actual', version: '26.9.0' } }));
    },
    async (serverUrl) => {
      assert.deepEqual(await probeServerVersion(serverUrl), {
        url: `${serverUrl}/info`,
        version: '26.9.0',
      });
    },
  );
});

test('the probe says which status came back', async () => {
  await serving(
    (_req, res) => {
      res.statusCode = 404;
      res.end('Not Found');
    },
    async (serverUrl) => {
      const probe = await probeServerVersion(serverUrl);
      assert.equal(probe.url, `${serverUrl}/info`);
      assert.match(failed(probe).failure, /^HTTP 404 Not Found$/);
      assert.match(failed(probe).hint, /base path/);
    },
  );
});

test("the probe tells a web page from Actual's API", async () => {
  // Actual's own web app answers a wrong base path with HTML, and so does
  // a login page or an authenticating proxy.
  await serving(
    (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Sign in</title>');
    },
    async (serverUrl) => {
      const probe = await probeServerVersion(serverUrl);
      assert.match(failed(probe).failure, /not JSON.*text\/html/);
      assert.match(failed(probe).hint, /base path/);
      assert.match(failed(probe).hint, /login page|proxy/);
    },
  );
});

test('the probe says when the response has no version field', async () => {
  await serving(
    (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ build: { name: 'Actual' } }));
    },
    async (serverUrl) => {
      const probe = await probeServerVersion(serverUrl);
      assert.equal(failed(probe).failure, 'no version field in the response');
    },
  );
});

test('the probe says why it could not connect', async () => {
  // Bind and release a port, so nothing listens on it.
  let refused = '';
  await serving(
    (_req, res) => res.end(),
    async (serverUrl) => {
      refused = serverUrl;
    },
  );
  // Through `localhost`, which resolves to both ::1 and 127.0.0.1: Node then
  // refuses with an AggregateError whose own message is empty.
  const probe = await probeServerVersion(refused.replace('127.0.0.1', 'localhost'));
  assert.match(failed(probe).failure, /^connect ECONNREFUSED .*:\d+$/);
  assert.match(failed(probe).hint, /running|reachable/);
});

test('the probe says when server_url is not an http(s) URL', async () => {
  // `localhost:5006` parses as scheme `localhost:`, and a bare host not at all.
  for (const serverUrl of ['localhost:5006', 'actual.example.com', 'ftp://host/']) {
    const probe = await probeServerVersion(serverUrl);
    assert.equal(probe.url, serverUrl);
    assert.equal(failed(probe).failure, 'not an http:// or https:// URL');
    assert.match(failed(probe).hint, /http:\/\/localhost:5006/);
  }
});

test('the probe names a TLS failure in a line, not as an OpenSSL dump', async () => {
  // https:// against a plain HTTP server, as with a wrong scheme in server_url.
  await serving(
    (_req, res) => res.end(),
    async (serverUrl) => {
      const probe = await probeServerVersion(serverUrl.replace('http:', 'https:'));
      assert.equal(
        failed(probe).failure,
        'ERR_SSL_WRONG_VERSION_NUMBER: wrong version number',
      );
    },
  );
});

test('the probe gives up after its timeout, and says so', async () => {
  await serving(
    () => {
      // Never answer.
    },
    async (serverUrl) => {
      const probe = await probeServerVersion(serverUrl, 50);
      assert.match(failed(probe).failure, /no response within/);
    },
  );
});
