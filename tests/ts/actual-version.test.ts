import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertVersionCompatible,
  infoUrl,
  installedApiVersion,
} from '../../src/actual-version.ts';

test('an api at most as new as the server proceeds', () => {
  assertVersionCompatible('26.5.2', '26.5.2');
  assertVersionCompatible('25.3.1', '26.4.0');
  assertVersionCompatible('26.4.0', '26.5.0');
});

test('an api newer than the server aborts, and says how to lift the block', () => {
  assert.throws(
    () => assertVersionCompatible('26.6.0', '26.5.2'),
    (error: Error) => {
      assert.match(error.message, /newer than server 26\.5\.2/);
      assert.match(error.message, /Upgrade the server to >= 26\.6\.0/);
      assert.match(error.message, /Data is not lost/);
      return true;
    },
  );
  assert.throws(() => assertVersionCompatible('27.0.0', '26.5.2'), /aborting/);
  assert.throws(() => assertVersionCompatible('26.5.3', '26.5.2'), /aborting/);
});

test('a skew that cannot be assessed aborts rather than proceeding', () => {
  assert.throws(
    () => assertVersionCompatible(null, '26.5.2'),
    /@actual-app\/api version/,
  );
  assert.throws(() => assertVersionCompatible('26.5.2', null), /server version/);
  assert.throws(
    () => assertVersionCompatible('not-a-version', '26.5.2'),
    /cannot parse API/,
  );
  assert.throws(
    () => assertVersionCompatible('26.5.2', 'unknown'),
    /cannot parse server/,
  );
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
