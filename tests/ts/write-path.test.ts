/**
 * Structural guards on the write path and the actions offered.
 *
 * These are cheap and they protect decisions that are easy to undo by accident:
 * that `importTransactions` never comes back, that the gateway stays the only
 * door to `@actual-app/api`, and that there are four actions and no more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify, type ActualTransaction } from '../../src/classify.ts';
import {
  availableActions,
  correctionTargets,
  MAX_CORRECTION_CHOICES,
  warnings,
} from '../../src/review.ts';
import { explain, tapeLine, TAPE_HEADER } from '../../src/tape.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * The TypeScript CLI's own modules.
 *
 * `src/actual_budget_transformer/` is skipped: it is the Python package, whose
 * `bridge/actual_api_bridge.ts` does call `importTransactions`. That path keeps
 * working until the TypeScript CLI reaches parity on both CSV inputs, and then
 * goes away in one commit.
 */
const PYTHON_PACKAGE = 'actual_budget_transformer';

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === PYTHON_PACKAGE
        ? []
        : sourceFiles(`${dir}${entry.name}/`)
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

let line = 0;
function src(over: Partial<SourceTransaction> = {}): SourceTransaction {
  line += 1;
  return {
    date: '2031-03-10',
    amountCents: -450,
    payee: 'CAFE LUGANO',
    notes: 'Carte',
    importedId: `T-${line}`,
    importedIdOrigin: 'bank-reference',
    sourceLine: line,
    ...over,
  };
}

function actual(over: Partial<ActualTransaction> = {}): ActualTransaction {
  return {
    id: 'stored-1',
    date: '2031-03-10',
    amount: -450,
    imported_id: null,
    payee: null,
    payeeName: 'Coffee (typed by hand)',
    notes: 'manual',
    reconciled: false,
    ...over,
  };
}

test('a Clean row offers only importing it or leaving it', () => {
  const [row] = classify([src()], [], null);
  assert.deepEqual(availableActions(row!), ['import', 'leave']);
});

test('a Suspicious row adds correcting what it matched', () => {
  const [row] = classify([src()], [actual()], null);
  assert.deepEqual(availableActions(row!), ['import', 'correct', 'leave']);
});

test('a Skip row offers correcting, leaving, or forcing - never a plain import', () => {
  // Importing it again would create a row our own next run could not tell
  // apart from the first, so forcing is the only way to add a second copy.
  const [row] = classify(
    [src({ importedId: 'T-X' })],
    [actual({ imported_id: 'T-X' })],
    null,
  );
  assert.deepEqual(availableActions(row!), ['correct', 'leave', 'force']);
});

test('a Locked row still offers every action its evidence supports', () => {
  // A write inside the reconciled range is allowed on a confirmation for that
  // row - and only on one.
  const [row] = classify([src({ date: '2020-06-15' })], [], '2020-06-30');
  assert.deepEqual(availableActions(row!), ['import', 'leave']);
  const [matched] = classify(
    [src({ date: '2020-06-15' })],
    [actual({ date: '2020-06-15' })],
    '2020-06-30',
  );
  assert.deepEqual(availableActions(matched!), ['import', 'correct', 'leave']);
});

test('correction targets are de-duplicated across reasons', () => {
  const stored = actual({ id: 'same', imported_id: 'T-X' });
  const [row] = classify([src({ importedId: 'T-X' })], [stored], null);
  assert.deepEqual(
    correctionTargets(row!).map((t) => t.id),
    ['same'],
  );
});

test('the evidence names the payee, not just an id', () => {
  const [row] = classify([src()], [actual()], null);
  const [why] = explain(row!.reasons);
  assert.match(why!, /Coffee \(typed by hand\) \/ manual/);
});

test('the Tape line reads as one line per source transaction', () => {
  const [clean] = classify([src({ payee: 'MIGROS', amountCents: -2345 })], [], null);
  assert.equal(tapeLine(1, clean!), '  1 2031-03-10     -23.45 clean      MIGROS');
});

test('a declined row says what it matched, on the Tape itself', () => {
  const [row] = classify([src({ payee: 'CAFE LUGANO' })], [actual()], null);
  const rendered = tapeLine(6, row!);
  assert.match(rendered, /suspicious/);
  assert.match(rendered, /same amount within a day of 1 transaction\(s\)/);
  assert.match(rendered, /2031-03-10 -4.50 "Coffee \(typed by hand\) \/ manual"/);
});

test('the Tape marks a split and a reconciled match, because both change what a write means', () => {
  const [row] = classify(
    [src()],
    [actual({ is_parent: true, reconciled: true })],
    null,
  );
  assert.match(tapeLine(1, row!), /split reconciled/);
});

test('a row just after the boundary that matches a reconciled transaction is warned about', () => {
  // The boundary is the newest reconciled date, so a candidate one day earlier
  // can be exactly that transaction: the row is Suspicious, not Locked, and
  // correcting it would still reach into an attested range.
  const [row] = classify(
    [src({ date: '2020-07-01' })],
    [actual({ date: '2020-06-30', reconciled: true, id: 'attested' })],
    '2020-06-30',
  );
  assert.equal(row!.state, 'suspicious');
  const said = warnings(row!, '2020-06-30');
  assert.equal(said.length, 1);
  assert.match(said[0]!, /1 of the transaction\(s\) this could correct is reconciled/);
  assert.match(said[0]!, /Actual will not stop that patch/);
});

test('a Locked row is warned about even with nothing to correct', () => {
  const [row] = classify([src({ date: '2020-06-15' })], [], '2020-06-30');
  const said = warnings(row!, '2020-06-30');
  assert.equal(said.length, 1);
  assert.match(said[0]!, /inside the reconciled range \(boundary 2020-06-30\)/);
});

test('a Locked row matching the reconciled transaction is warned about twice', () => {
  const [row] = classify(
    [src({ date: '2020-06-30' })],
    [actual({ date: '2020-06-30', reconciled: true })],
    '2020-06-30',
  );
  assert.equal(warnings(row!, '2020-06-30').length, 2);
});

test('an ordinary row is warned about not at all', () => {
  const [row] = classify([src()], [actual()], null);
  assert.deepEqual(warnings(row!, null), []);
});

test('too many correction candidates withholds correcting, and says why', () => {
  // The prompt reads one keystroke, so a tenth choice could never be entered.
  // Offering nine of eleven would hide the rest; withholding says so out loud.
  const many = Array.from({ length: MAX_CORRECTION_CHOICES + 1 }, (_, i) =>
    actual({ id: `stored-${i}` }),
  );
  const [row] = classify([src()], many, null);
  assert.equal(correctionTargets(row!).length, MAX_CORRECTION_CHOICES + 1);
  assert.deepEqual(availableActions(row!), ['import', 'leave']);
  const said = warnings(row!, null);
  assert.match(said.join('\n'), /too many to choose between at a prompt/);
});

test('exactly the maximum number of candidates still offers correcting', () => {
  const many = Array.from({ length: MAX_CORRECTION_CHOICES }, (_, i) =>
    actual({ id: `stored-${i}` }),
  );
  const [row] = classify([src()], many, null);
  assert.deepEqual(availableActions(row!), ['import', 'correct', 'leave']);
  assert.deepEqual(warnings(row!, null), []);
});

test('every Tape header label sits at the start of the field it names', () => {
  const [row] = classify([src({ payee: 'MIGROS', amountCents: -2345 })], [], null);
  const line = tapeLine(1, row!);
  // The amount is right-aligned, so its label's right edge is what must line up.
  assert.equal(
    TAPE_HEADER.indexOf('amount') + 'amount'.length,
    line.indexOf('-23.45') + '-23.45'.length,
  );
  for (const [label, field] of [
    ['date', '2031-'],
    ['state', 'clean'],
    ['payee', 'MIGROS'],
  ] as const) {
    assert.equal(
      TAPE_HEADER.indexOf(label),
      line.indexOf(field),
      `the ${label} header is not above the ${label} column`,
    );
  }
});
