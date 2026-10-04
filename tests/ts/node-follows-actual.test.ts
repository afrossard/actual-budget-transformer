import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeMismatch } from '../../scripts/check-node-follows-actual.ts';

// The check that Node follows Actual (#97). Fetching Actual's `.nvmrc` is the
// script's own business; these pin the comparison and the message it prints.

test('agrees when our .nvmrc matches Actual’s, whose copy carries a v', () => {
  assert.equal(
    nodeMismatch({
      actualVersion: '26.9.0',
      actualNvmrc: 'v24.18.1\n',
      ourNvmrc: '24.18.1\n',
    }),
    undefined,
  );
});

test('names the Actual release, its Node, and the fix on a mismatch', () => {
  assert.equal(
    nodeMismatch({
      actualVersion: '26.11.0',
      actualNvmrc: 'v24.22.0\n',
      ourNvmrc: '24.18.1\n',
    }),
    'Actual v26.11.0 runs Node 24.22.0, but .nvmrc says 24.18.1; ' +
      'set .nvmrc and the Containerfile FROM to 24.22.0',
  );
});

test('a v on our side is a mismatch too, since FROM cannot carry it', () => {
  assert.match(
    nodeMismatch({
      actualVersion: '26.9.0',
      actualNvmrc: 'v24.18.1',
      ourNvmrc: 'v24.18.1',
    }) ?? '',
    /set \.nvmrc and the Containerfile FROM to 24\.18\.1$/,
  );
});
