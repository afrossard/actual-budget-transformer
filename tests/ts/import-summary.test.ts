import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allInActual,
  importSummary,
  type FileOutcome,
} from '../../src/import-summary.ts';
import type { RunResult } from '../../src/import-run.ts';
import type { Outcome } from '../../src/review.ts';

/** A run's result, from the actions taken on its unpaired statement transactions. */
function ran(
  actions: readonly Outcome['action'][],
  over: Partial<RunResult> = {},
): RunResult {
  return {
    accountName: 'Checking',
    outcomes: actions.map((action) => ({
      classified: {} as Outcome['classified'],
      kind: 'write',
      action,
      wrote: action === 'import' ? 'added' : 'nothing',
    })),
    stopped: false,
    statementTransactions: actions.length,
    alreadyInActual: 0,
    ...over,
  };
}

test('one line per statement file, with what came of it', () => {
  const outcomes: FileOutcome[] = [
    {
      path: 'a.csv',
      kind: 'imported',
      result: ran(['import', 'import'], {
        statementTransactions: 5,
        alreadyInActual: 3,
      }),
    },
    { path: 'b.csv', kind: 'imported', result: ran(['import', 'left-out']) },
    { path: 'c.csv', kind: 'imported', result: ran([]) },
  ];
  assert.deepEqual(importSummary(outcomes), [
    '',
    'Import summary:',
    '  a.csv: 2 imported, 3 already in Actual',
    '  b.csv: 1 imported, 1 left out, 0 already in Actual',
    '  c.csv: no transactions',
  ]);
  assert.equal(allInActual(outcomes), false, 'b.csv left one out');
  assert.equal(allInActual([outcomes[0]!, outcomes[2]!]), true);
});

test('corrections are counted beside writes, and one not made is to fix in Actual', () => {
  const correction = (wrote: Outcome['wrote']): Outcome => ({
    classified: {} as Outcome['classified'],
    kind: 'correction',
    action: wrote === 'corrected' ? 'correct' : 'left-out',
    wrote,
  });
  const fixed = ran(['import'], { statementTransactions: 3, alreadyInActual: 2 });
  fixed.outcomes.push(correction('corrected'));
  const held = ran([], { statementTransactions: 1, alreadyInActual: 1 });
  held.outcomes.push(correction('nothing'));
  const outcomes: FileOutcome[] = [
    { path: 'a.csv', kind: 'imported', result: fixed },
    { path: 'b.csv', kind: 'imported', result: held },
  ];
  assert.deepEqual(importSummary(outcomes).slice(2), [
    '  a.csv: 1 imported, 1 corrected, 1 already in Actual',
    '  b.csv: 0 imported, 1 to fix in Actual, 0 already in Actual',
  ]);
  assert.equal(allInActual([outcomes[0]!]), true);
  assert.equal(allInActual([outcomes[1]!]), false, 'Actual disagrees with the bank');
});

test('a file not imported says why, under its line', () => {
  const outcomes: FileOutcome[] = [
    {
      path: 'x.csv',
      kind: 'not-imported',
      reason: 'CH00 is not in account_names. Add this entry:\n\n  "CH00": "<name>"',
    },
  ];
  assert.deepEqual(importSummary(outcomes), [
    '',
    'Import summary:',
    '  x.csv: not imported',
    '    CH00 is not in account_names. Add this entry:',
    '',
    '      "CH00": "<name>"',
  ]);
  assert.equal(allInActual(outcomes), false);
});

test('a quit under review, a failed write, and the files neither reached', () => {
  const outcomes: FileOutcome[] = [
    {
      path: 'a.csv',
      kind: 'imported',
      result: ran(['import', 'leave', 'quit'], {
        statementTransactions: 4,
        stopped: true,
      }),
    },
    { path: 'b.csv', kind: 'not-reached' },
  ];
  assert.deepEqual(importSummary(outcomes), [
    '',
    'Import summary:',
    '  a.csv: stopped, 1 imported, 3 left, 0 already in Actual',
    '  b.csv: not reached',
  ]);
  assert.equal(allInActual(outcomes), false);

  const failed: FileOutcome[] = [
    { path: 'a.csv', kind: 'failed', reason: 'network error' },
  ];
  assert.deepEqual(importSummary(failed).slice(2), [
    '  a.csv: failed, the run stopped',
    '    network error',
  ]);
  assert.equal(allInActual(failed), false);
});

test('an empty directory is a run with nothing to import', () => {
  assert.deepEqual(importSummary([]), ['', 'Import summary:', '  no statement files']);
  assert.equal(allInActual([]), true);
});

test("a reason wraps to the terminal's width, each line keeping its indent", () => {
  const outcomes: FileOutcome[] = [
    {
      path: 'x.csv',
      kind: 'not-imported',
      reason: 'one two three four five six\n  seven eight nine',
    },
  ];
  assert.deepEqual(importSummary(outcomes, 20).slice(2), [
    '  x.csv: not imported',
    '    one two three',
    '    four five six',
    '      seven eight',
    '      nine',
  ]);
});
