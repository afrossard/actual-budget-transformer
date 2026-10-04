/**
 * The statement report's rendering: the counts and fixes up front, one line per
 * statement transaction to review, one block per reviewed one.
 *
 * Every line has to fit the terminal. A line that wraps puts its tail in
 * column 0, and from there on the columns stop meaning anything (#81).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ActualTransaction } from '../../src/classify.ts';
import {
  block,
  detail,
  explain,
  fit,
  fixLines,
  listHeader,
  listLine,
  noteTag,
  report,
  terminalWidth,
  wrap,
} from '../../src/statement-report.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

let line = 10;
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

let seq = 0;
function actual(over: Partial<ActualTransaction> = {}): ActualTransaction {
  seq += 1;
  return {
    id: `stored-${seq}`,
    date: '2031-03-09',
    amount: -450,
    imported_id: null,
    payee: null,
    payeeName: 'Coffee (typed by hand)',
    notes: 'manual',
    reconciled: false,
    ...over,
  };
}

const plain = { colour: false, width: 80 };

/** Two coffees on the bank's side, one typed by hand in Actual. */
function coffeeTwins() {
  return classify(
    [src({ date: '2031-03-09' }), src({ date: '2031-03-09' })],
    [actual()],
    null,
  );
}

test('fit leaves a short line alone and cuts a long one with an ellipsis', () => {
  assert.equal(fit([{ text: 'short' }], 10, plain), 'short');
  assert.equal(fit([{ text: 'exactly10!' }], 10, plain), 'exactly10!');
  assert.equal(fit([{ text: 'one character too long' }], 10, plain), 'one chara…');
});

test('fit cuts across segments, and drops trailing padding', () => {
  assert.equal(fit([{ text: 'abc   ' }, { text: 'defgh' }], 8, plain), 'abc   d…');
  assert.equal(fit([{ text: 'abc   ' }, { text: '' }], 80, plain), 'abc');
});

test('fit measures the text, never the colour codes around it', () => {
  const coloured = fit([{ text: 'abcdef', code: '\u001b[32m' }, { text: 'ghij' }], 8, {
    colour: true,
  });
  assert.equal(coloured.replace(/\u001b\[\d+m/g, ''), 'abcdefg…');
});

test('the report counts what is already in Actual and what is to review', () => {
  const classified = coffeeTwins();
  const lines = report(
    {
      accountName: 'Checking',
      classified,
      reconciledThrough: '2020-06-30',
      dropped: [],
    },
    plain,
  );
  assert.deepEqual(lines.slice(0, 3), [
    'Checking',
    '  2 transactions · reconciled through 2020-06-30',
    '  1 already in Actual · 1 to review',
  ]);
});

test('the report lists only the statement transactions to review', () => {
  const classified = coffeeTwins();
  const lines = report(
    { accountName: 'Checking', classified, reconciledThrough: null, dropped: [] },
    plain,
  );
  assert.deepEqual(lines.slice(3), [
    '',
    '  # date           amount payee                                   note',
    "  2 2031-03-09      -4.50 CAFE LUGANO                             like #1's pair",
  ]);
});

test('with nothing to review the report says so, and lists nothing', () => {
  const classified = classify([src()], [actual({ date: '2031-03-10' })], null);
  const lines = report(
    { accountName: 'Checking', classified, reconciledThrough: null, dropped: [] },
    plain,
  );
  assert.deepEqual(lines, [
    'Checking',
    '  1 transaction · nothing reconciled yet',
    '  1 already in Actual · nothing to review',
  ]);
});

test('the report says what the file held unread', () => {
  const lines = report(
    {
      accountName: 'Checking',
      classified: classify([src()], [], null),
      reconciledThrough: null,
      dropped: [{ sourceLine: 14, reason: 'pending (not booked yet)', raw: '' }],
    },
    plain,
  );
  assert.ok(lines.includes('  1 row in the file was not read as a transaction:'));
  assert.ok(lines.includes('    line 14: pending (not booked yet)'));
});

test('a pair whose amount Actual holds differently is listed, to fix in Actual', () => {
  const classified = classify(
    [src(), src({ importedId: 'T-PRICE', amountCents: -7500, payee: 'PRICE CHANGED' })],
    [actual({ imported_id: 'T-PRICE', amount: -8000, date: '2031-03-15' })],
    null,
  );
  assert.deepEqual(fixLines(classified[1]!), [
    '#2 PRICE CHANGED: Actual holds -80.00, the bank says -75.00',
  ]);
  const lines = report(
    { accountName: 'Checking', classified, reconciledThrough: null, dropped: [] },
    plain,
  );
  assert.ok(
    lines.includes('  ! #2 PRICE CHANGED: Actual holds -80.00, the bank says -75.00'),
    lines.join('\n'),
  );
  assert.equal(lines[2], '  1 already in Actual · 1 to review');
});

test('two Actual transactions sharing an imported ID are listed, to fix in Actual', () => {
  const classified = classify(
    [src({ importedId: 'SHARED', payee: 'SALARY' })],
    [actual({ imported_id: 'SHARED' }), actual({ imported_id: 'SHARED' })],
    null,
  );
  assert.deepEqual(fixLines(classified[0]!), [
    '#1 SALARY: 2 Actual transactions hold its imported ID',
  ]);
});

test('the note says the reconciled period, the lookalike, and the repeat', () => {
  const twin = { importedId: '', importedIdOrigin: 'absent' as const };
  const classified = classify(
    [src({ ...twin, date: '2020-06-30' }), src({ ...twin, date: '2020-06-30' })],
    [],
    '2020-06-30',
  );
  assert.equal(noteTag(classified[0]!), 'reconciled period');
  assert.equal(noteTag(classified[1]!), 'reconciled period · same as #1');
  assert.equal(noteTag(coffeeTwins()[1]!), "like #1's pair");
});

test('every list header label sits at the start of the field it names', () => {
  const classified = coffeeTwins()[1]!;
  const header = listHeader(plain);
  const rendered = listLine(classified, plain);
  // The amount is right-aligned, so its label's right edge is what must line up.
  assert.equal(
    header.indexOf('amount') + 'amount'.length,
    rendered.indexOf('-4.50') + '-4.50'.length,
  );
  for (const [label, field] of [
    ['date', '2031-'],
    ['payee', 'CAFE'],
    ['note', 'like'],
  ] as const) {
    assert.equal(header.indexOf(label), rendered.indexOf(field), label);
  }
});

test('a list line never outgrows the terminal, however long the payee', () => {
  const [one] = classify(
    [src({ payee: 'A PAYEE NAME FAR LONGER THAN ANY COLUMN WOULD EVER HOLD' })],
    [],
    '2040-01-01',
  );
  for (const width of [40, 60, 80, 120]) {
    const rendered = listLine(one!, { colour: false, width });
    assert.ok(rendered.length <= width, `${rendered.length} > ${width}: ${rendered}`);
  }
});

test('a wider terminal gives a long payee more room before it is cut', () => {
  const payee = 'EXAMPLE; Paiement UBS TWINT DE LA PART DE QUELQU UN';
  const [one] = classify([src({ payee })], [], '2040-01-01');
  assert.ok(!listLine(one!, plain).includes(payee));
  assert.ok(
    listLine(one!, { colour: false, width: 120 }, 0).includes(payee.slice(0, 39)),
  );
});

test('with no note anywhere, the header names no note column', () => {
  const classified = classify([src()], [], null);
  const lines = report(
    { accountName: 'Checking', classified, reconciledThrough: null, dropped: [] },
    plain,
  );
  assert.ok(lines.at(-2)!.endsWith('payee'), lines.at(-2));
});

test("a reviewed block counts only the reviewed, and names a lookalike's pair", () => {
  const lines = block(
    { position: 3, total: 5, classified: coffeeTwins()[1]!, warnings: [] },
    plain,
  );
  assert.deepEqual(lines, [
    '── 3 of 5 ──────────────────────────────────────────────────────────────────────',
    '  #2       2031-03-09      -4.50  CAFE LUGANO',
    '                                  Carte',
    "  not in Actual · looks like #1's pair: 2031-03-09 -4.50 Coffee (typed by hand)",
  ]);
});

test('a block with nothing alike in Actual says only that, then its warnings', () => {
  const [one] = classify([src({ notes: '' })], [], null);
  const lines = block(
    { position: 1, total: 1, classified: one!, warnings: ['mind this'] },
    plain,
  );
  assert.deepEqual(lines.slice(1), [
    '  #1       2031-03-10      -4.50  CAFE LUGANO',
    '  not in Actual',
    '  ! mind this',
  ]);
});

test('a block never shows a bucket name', () => {
  const lines = block(
    { position: 1, total: 1, classified: coffeeTwins()[1]!, warnings: [] },
    plain,
  ).join('\n');
  assert.doesNotMatch(lines, /clean|suspicious|skip|locked/i);
});

test('a block never outgrows the terminal', () => {
  const [one] = classify(
    [src({ payee: 'X'.repeat(90), notes: 'Y'.repeat(90), date: '2031-03-09' })],
    [actual({ payeeName: 'Z'.repeat(90) })],
    null,
  );
  const [, twin] = classify(
    [src({ date: '2031-03-09' }), src({ payee: 'X'.repeat(90), date: '2031-03-09' })],
    [actual({ payeeName: 'Z'.repeat(90) })],
    null,
  );
  for (const width of [40, 80]) {
    for (const classified of [one!, twin!]) {
      const lines = block(
        { position: 1, total: 1, classified, warnings: ['V'.repeat(90)] },
        { colour: false, width },
      );
      for (const l of lines)
        assert.ok(l.length <= width, `${l.length} > ${width}: ${l}`);
    }
  }
});

test('a terminal that reports no width is treated as the default width', () => {
  assert.equal(terminalWidth({ isTTY: true, columns: 0 }), 80);
  assert.equal(terminalWidth({ isTTY: true, columns: 132 }), 132);
  assert.equal(terminalWidth({ isTTY: false, columns: 132 }), 80);
});

test('wrap breaks at spaces, and only inside a word too long for a line', () => {
  assert.deepEqual(wrap('short', 10), ['short']);
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.deepEqual(wrap('', 5), ['']);
});

test('the explanation says why it is reviewed, without naming an Actual transaction', () => {
  const [alone] = classify([src({ date: '2020-06-01' })], [], '2020-06-30');
  assert.deepEqual(explain(alone!), [
    'not in Actual: no Actual transaction holds its imported ID or has its amount ' +
      'within a day of it',
    'dated 2020-06-01, in your reconciled period',
  ]);
  assert.deepEqual(explain(coffeeTwins()[1]!), [
    'not in Actual: an Actual transaction alike to it belongs to another ' +
      'statement transaction',
  ]);
});

test('the detail shows every lookalike in full, and never outgrows the terminal', () => {
  const notes = 'typed by hand on the day, and then some more words to wrap';
  const [, twin] = classify(
    [src({ date: '2031-03-09' }), src({ date: '2031-03-09' })],
    [
      actual({
        notes,
        reconciled: true,
        is_parent: true,
        subtransactions: [{ amount: -300 }, { amount: -150 }],
      }),
    ],
    null,
  );
  const lines = detail(twin!, plain);
  for (const l of lines) assert.ok(l.length <= 80, `${l.length} > 80: ${l}`);
  assert.ok(!lines.some((l) => l.includes('…')), lines.join('\n'));
  const text = lines.join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes(notes), text);
  assert.match(text, /in Actual, the pair of #1/);
  assert.match(text, /split into -3\.00, -1\.50/);
  assert.match(text, /reconciled yes/);
  assert.match(text, new RegExp(`line ${twin!.source.sourceLine} of the file`));
  assert.match(text, /imported ID T-\d+, the bank's reference/);
});

test('an extra holder of an imported ID is called a duplicate, never a pair', () => {
  const [, other] = classify(
    [src({ importedId: 'X' }), src({ importedId: 'OTHER', date: '2031-03-09' })],
    [actual({ imported_id: 'X', date: '2031-06-30' }), actual({ imported_id: 'X' })],
    null,
  );
  assert.equal(noteTag(other!), "like #1's duplicate");
  const shown = block(
    { position: 1, total: 1, classified: other!, warnings: [] },
    plain,
  );
  assert.ok(shown.some((l) => l.includes("looks like #1's duplicate: 2031-03-09")));
  const text = detail(other!, plain).join('\n');
  assert.match(text, /in Actual, a second holder of #1's imported ID/);
  assert.doesNotMatch(text, /the pair of/);
});

test('an Actual transaction under another bank reference is shown as such', () => {
  const [one] = classify(
    [src({ importedId: 'REF-B' })],
    [actual({ imported_id: 'REF-A' })],
    null,
  );
  assert.equal(noteTag(one!), 'like REF-A');
  const shown = block({ position: 1, total: 1, classified: one!, warnings: [] }, plain);
  assert.ok(
    shown.includes(
      '  not in Actual · looks like REF-A: 2031-03-09 -4.50 Coffee (typed by hand)',
    ),
    shown.join('\n'),
  );
  assert.deepEqual(explain(one!), [
    'not in Actual: an Actual transaction alike to it carries another bank ' +
      'reference, so it is a different transaction',
  ]);
  assert.match(detail(one!, plain).join('\n'), /in Actual under bank reference REF-A/);
});
