import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Types newer than the oldest Node we support let code typecheck against APIs
// a user on that Node does not have. Actual pins `@types/node` to the major of
// its own `engines` floor, and so do we. The major is written three times,
// and this test is what keeps the copies together (#127; AGENTS.md, "Versions:
// follow Actual").
const root = new URL('../../', import.meta.url);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8')) as T;
}

function enginesMajor(): string {
  const { engines } = readJson<{ engines: { node: string } }>('package.json');
  const floor = /^>=(\d+)\.\d+\.\d+$/.exec(engines.node);
  assert.ok(floor, `engines.node is not a >= floor: ${engines.node}`);
  return floor[1]!;
}

test('@types/node is pinned to the major of the engines.node floor', () => {
  const pkg = readJson<{ devDependencies: Record<string, string> }>('package.json');
  assert.match(
    pkg.devDependencies['@types/node'] ?? '',
    new RegExp(`^\\^${enginesMajor()}(\\.|$)`),
  );
});

test('Renovate keeps @types/node to the major of the engines.node floor', () => {
  const renovate = readJson<{
    packageRules: { matchPackageNames?: string[]; allowedVersions?: string }[];
  }>('renovate.json');
  const rules = renovate.packageRules.filter((rule) =>
    rule.matchPackageNames?.includes('@types/node'),
  );
  assert.deepEqual(
    rules.map((rule) => rule.allowedVersions),
    [`${enginesMajor()}.x`],
  );
});
