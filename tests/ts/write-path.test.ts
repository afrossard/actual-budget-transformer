/**
 * Structural guards on the write path and the actions offered.
 *
 * These are cheap and they protect decisions that are easy to undo by accident:
 * that `importTransactions` never comes back, that the gateway stays the only
 * door to `@actual-app/api`, that nothing ever patches an Actual transaction,
 * and that review offers import and leave and no more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify } from '../../src/classify.ts';
import { ACTIONS, warnings } from '../../src/review.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every module under `src/`. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(`${dir}${entry.name}/`)
      : entry.name.endsWith('.ts')
        ? [`${dir}${entry.name}`]
        : [],
  );
}

test('nothing in src imports @actual-app/api except the gateway', () => {
  const importers = sourceFiles().filter((path) =>
    /from '@actual-app\/api'|import\('@actual-app\/api'\)/.test(
      readFileSync(path, 'utf8'),
    ),
  );
  assert.deepEqual(
    importers.map((p) => p.slice(SRC.length)),
    ['actual-gateway.ts'],
  );
});

test('the write path never calls importTransactions', () => {
  // Actual's own matcher inside importTransactions is a second matcher
  // competing with our classification, which caused every surprise in #38.
  const offenders = sourceFiles().filter((path) =>
    readFileSync(path, 'utf8').includes('importTransactions('),
  );
  assert.deepEqual(offenders, []);
});

test('nothing in src patches an Actual transaction', () => {
  // A paired statement transaction is already in Actual, and nothing is
  // written for it (ADR 0003). `updateTransaction` would also patch a
  // reconciled transaction without complaint, so its absence is the guard.
  const offenders = sourceFiles().filter((path) =>
    readFileSync(path, 'utf8').includes('updateTransaction('),
  );
  assert.deepEqual(offenders, []);
});

test('review offers import and leave, and no more', () => {
  assert.deepEqual(ACTIONS, ['import', 'leave']);
});

function src(over: Partial<SourceTransaction> = {}): SourceTransaction {
  return {
    date: '2031-03-10',
    amountCents: -450,
    payee: 'CAFE LUGANO',
    notes: 'Carte',
    importedId: 'T-1',
    importedIdOrigin: 'bank-reference',
    sourceLine: 1,
    ...over,
  };
}

test('one dated in the reconciled period is warned about, and nothing else is', () => {
  const [inside, after] = classify(
    [src({ date: '2020-06-30' }), src({ date: '2020-07-01', importedId: 'T-2' })],
    [],
    '2020-06-30',
  );
  assert.deepEqual(warnings(inside!), [
    'dated in your reconciled period: importing it changes a reconciled balance',
  ]);
  assert.deepEqual(warnings(after!), []);
});
