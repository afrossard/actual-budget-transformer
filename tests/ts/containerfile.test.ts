import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The image carries the Node version Actual itself runs, like CI does through
// `.nvmrc`. `FROM` cannot read a file, so the version is written twice and this
// test is what keeps the two copies together (AGENTS.md, "Versions: follow
// Actual").
const root = new URL('../../', import.meta.url);

test('every Containerfile stage runs the Node version in .nvmrc', () => {
  const nvmrc = readFileSync(new URL('.nvmrc', root), 'utf8').trim();
  const containerfile = readFileSync(new URL('Containerfile', root), 'utf8');

  const parents = [...containerfile.matchAll(/^FROM\s+(\S+)/gim)].map(
    (match) => match[1],
  );
  assert.ok(parents.length > 0, 'Containerfile has no FROM line');
  for (const parent of parents) {
    assert.equal(parent, `node:${nvmrc}-trixie-slim`);
  }
});
