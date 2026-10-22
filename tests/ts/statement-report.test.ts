/**
 * The statement report's rendering: the counts and fixes up front, one line per
 * unpaired statement transaction, one block per reviewed one.
 *
 * Every line has to fit the terminal. A line that wraps puts its tail in
 * column 0, and from there on the columns stop meaning anything (#81).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  unpairedActual,
  type ActualTransaction,
} from '../../src/classify.ts';
import {
  block,
  detail,
  explain,
  fit,
  listHeader,
  listLine,
  noteTag,
  report,
  terminalWidth,
  wrap,
} from '../../src/statement-report.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';
import { isoDate } from './iso-date-fixture.ts';

let line = 10;
function src(over: Partial<SourceTransaction> = {}): SourceTransaction {
  line += 1;
  return {
    date: isoDate('2031-03-10'),
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
    date: isoDate('2031-03-09'),
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

const MARCH = { from: isoDate('2031-03-01'), to: isoDate('2031-03-31') };

/** Two coffees on the bank's side, one typed by hand in Actual. */
function coffeeTwins() {
  return classify(
    [src({ date: isoDate('2031-03-09') }), src({ date: isoDate('2031-03-09') })],
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

test('the report says what the statement holds and what Actual holds', () => {
  const classified = coffeeTwins();
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: isoDate('2020-06-30'),
      dropped: [],
      mode: 'review',
    },
    plain,
  );
  assert.deepEqual(lines.slice(0, 8), [
    '  Statement',
    '    - From 2031-03-01 to 2031-03-31',
    '    - 2 transactions found',
    '    - 1 already in Actual',
    '    - 1 to review',
    '  Actual',
    '    - Reconciled through 2020-06-30',
    '    - 0 not in the statement',
  ]);
});

test('the report lists only the statement transactions to review', () => {
  const classified = coffeeTwins();
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode: 'review',
    },
    plain,
  );
  assert.deepEqual(lines.slice(8), [
    '',
    '  # date           amount payee                                   note',
    "  2 2031-03-09      -4.50 CAFE LUGANO                             like #1's pair",
  ]);
});

test('with nothing to review the report says so, and lists nothing', () => {
  const classified = classify([src()], [actual({ date: isoDate('2031-03-10') })], null);
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode: 'review',
    },
    plain,
  );
  assert.deepEqual(lines, [
    '  Statement',
    '    - From 2031-03-01 to 2031-03-31',
    '    - 1 transaction found',
    '    - 1 already in Actual',
    '    - 0 to review',
    '  Actual',
    '    - Nothing reconciled yet',
    '    - 0 not in the statement',
  ]);
});

test('the report says what the file held unread', () => {
  const lines = report(
    {
      period: MARCH,
      classified: classify([src()], [], null),
      unpaired: [],
      reconciledThrough: null,
      dropped: [{ sourceLine: 14, reason: 'unreadable date 31.02.2020', raw: '' }],
      mode: 'review',
    },
    plain,
  );
  assert.deepEqual(lines.slice(4, 7), [
    '    - 1 to review',
    '    - 1 row in the file was not read as a transaction:',
    '        line 14: unreadable date 31.02.2020',
  ]);
});

/** The report for these, from the classifier, as a run makes it. */
function reportOf(
  sources: readonly SourceTransaction[],
  existing: readonly ActualTransaction[],
  style = plain,
): string[] {
  const classified = classify(sources, existing, null);
  const unpaired = unpairedActual(classified, existing, MARCH);
  return report(
    {
      period: MARCH,
      classified,
      unpaired,
      reconciledThrough: null,
      dropped: [],
      mode: 'review',
    },
    style,
  );
}

/** The lines of one titled section of the report. */
function section(lines: readonly string[], title: string): string[] {
  const start = lines.indexOf(title);
  assert.notEqual(start, -1, lines.join('\n'));
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

test('the Actual transactions the statement does not hold are listed, by date', () => {
  const lines = reportOf(
    [src({ date: isoDate('2031-03-02'), payee: 'GALAXUS', amountCents: -9010 })],
    [
      actual({ date: isoDate('2031-03-29'), amount: -6500, payeeName: 'Shell' }),
      actual({
        date: isoDate('2031-03-12'),
        amount: -1200,
        payeeName: 'Café Bern',
        reconciled: true,
      }),
      actual({ date: isoDate('2031-03-02'), amount: -9010, payeeName: 'Galaxus' }),
      actual({ date: isoDate('2031-03-03'), amount: -9010, payeeName: 'Galaxus' }),
    ],
  );
  assert.equal(lines[7], '    - 3 not in the statement');
  assert.deepEqual(section(lines, '  in Actual, not in the statement'), [
    '  ! 2031-03-02     -90.10  Galaxus                         duplicate, delete one',
    '  ! 2031-03-03     -90.10  Galaxus                         duplicate, delete one',
    '  ! 2031-03-12     -12.00  Café Bern',
    '      already reconciled, double check reconciliation balance',
    '  ! 2031-03-29     -65.00  Shell',
  ]);
});

test('a duplicate couple stays together, sorted by its earlier date', () => {
  const lines = reportOf(
    [src({ date: isoDate('2031-03-10'), importedId: 'X' })],
    [
      actual({ date: isoDate('2031-03-05'), amount: -100, payeeName: 'Before' }),
      actual({
        date: isoDate('2031-03-20'),
        imported_id: 'X',
        payeeName: 'Second copy',
      }),
      actual({ date: isoDate('2031-03-10'), imported_id: 'X', payeeName: 'Imported' }),
      actual({ date: isoDate('2031-03-15'), amount: -100, payeeName: 'Between' }),
    ],
  );
  assert.deepEqual(
    section(lines, '  in Actual, not in the statement').map((l) => l.split(/ {2,}/)[3]),
    ['Before', 'Imported', 'Second copy', 'Between'],
  );
});

test('a reconciled duplicate says so beside it', () => {
  const lines = reportOf(
    [src()],
    [
      actual({ date: isoDate('2031-03-10') }),
      actual({ date: isoDate('2031-03-10'), reconciled: true }),
    ],
  );
  assert.deepEqual(
    section(lines, '  in Actual, not in the statement').map(
      (l) => /duplicate.*/.exec(l)?.[0],
    ),
    ['duplicate, delete one', 'duplicate, delete one · reconciled'],
  );
});

test('an unpaired Actual transaction line never outgrows the terminal', () => {
  for (const width of [40, 60, 80, 120]) {
    const lines = reportOf(
      [src()],
      [
        actual({ date: isoDate('2031-03-10') }),
        actual({
          date: isoDate('2031-03-10'),
          payeeName: 'P'.repeat(90),
          reconciled: true,
        }),
        actual({
          date: isoDate('2031-03-20'),
          payeeName: 'Q'.repeat(90),
          reconciled: true,
        }),
      ],
      { colour: false, width },
    );
    for (const l of lines) assert.ok(l.length <= width, `${l.length} > ${width}: ${l}`);
  }
});

/** A statement report of `classified`, with nothing unpaired in Actual. */
function reportIn(
  classified: ReturnType<typeof classify>,
  mode: 'unattended' | 'review',
) {
  return report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode,
    },
    plain,
  );
}

/** A plain, a reconciled and a split pair, each held at -80.00 where the bank says -75.00. */
function threeCorrections() {
  return classify(
    [
      src(),
      src({ importedId: 'T-PLAIN', amountCents: -7500, payee: 'PRICE CHANGED' }),
      src({ importedId: 'T-RECON', amountCents: -7500, payee: 'SBB CFF FFS' }),
      src({ importedId: 'T-SPLIT', amountCents: -7500, payee: 'MIGROS' }),
    ],
    [
      actual({ imported_id: 'T-PLAIN', amount: -8000 }),
      actual({ imported_id: 'T-RECON', amount: -8000, reconciled: true }),
      actual({
        imported_id: 'T-SPLIT',
        amount: -8000,
        is_parent: true,
        subtransactions: [{ amount: -5000 }, { amount: -3000 }],
      }),
    ],
    null,
  );
}

test('unattended, a correction is listed as made, and a held one to fix in Actual', () => {
  const lines = reportIn(threeCorrections(), 'unattended');
  assert.deepEqual(section(lines, '  correcting in Actual'), [
    '  ~ #2 PRICE CHANGED: -80.00 → -75.00',
  ]);
  assert.deepEqual(section(lines, '  in Actual, but to fix there'), [
    '  ! #3 SBB CFF FFS: Actual holds -80.00, the bank says -75.00 (reconciled)',
    '  ! #4 MIGROS: Actual holds -80.00, the bank says -75.00 (split)',
  ]);
  assert.equal(lines[3], '    - 3 already in Actual');
});

test('under review, a reconciled correction is to review, and a split still to fix', () => {
  const lines = reportIn(threeCorrections(), 'review');
  assert.deepEqual(section(lines, '  correcting in Actual, if you confirm'), [
    '  ~ #2 PRICE CHANGED: -80.00 → -75.00',
    '  ~ #3 SBB CFF FFS: -80.00 → -75.00 (reconciled)',
  ]);
  assert.deepEqual(section(lines, '  in Actual, but to fix there'), [
    '  ! #4 MIGROS: Actual holds -80.00, the bank says -75.00 (split)',
  ]);
});

test('a transfer is listed to fix in Actual, in either mode', () => {
  const classified = classify(
    [src({ importedId: 'T-XFER', amountCents: -7500, payee: 'TO SAVINGS' })],
    [actual({ imported_id: 'T-XFER', amount: -8000, transfer_id: 'other-side' })],
    null,
  );
  for (const mode of ['unattended', 'review'] as const) {
    assert.deepEqual(
      section(reportIn(classified, mode), '  in Actual, but to fix there'),
      ['  ! #1 TO SAVINGS: Actual holds -80.00, the bank says -75.00 (transfer)'],
    );
  }
});

test('a pending statement transaction whose amount differs is not listed', () => {
  const classified = classify(
    [
      src({
        importedId: 'T-FX',
        amountCents: -1495,
        pending: { originalCurrency: 'USD', accountCurrency: 'CHF' },
      }),
    ],
    [actual({ imported_id: 'T-FX', amount: -1290 })],
    null,
  );
  const text = reportIn(classified, 'unattended').join('\n');
  assert.doesNotMatch(text, /correct|to fix there/);
});

test('a long payee is cut on a correction or a line to fix, never the amounts', () => {
  // A booked card purchase's text runs long (#48), and unattended there is no
  // [?] to read the amounts from.
  const payee = 'MERCHANT*7K2Q9X4M        NEWARK       USANJ';
  const classified = classify(
    [
      src({ importedId: 'T-FX', amountCents: -1290, payee }),
      src({ importedId: 'T-FY', amountCents: -1290, payee }),
    ],
    [
      actual({ imported_id: 'T-FX', amount: -1495 }),
      actual({ imported_id: 'T-FY', amount: -1495, is_parent: true }),
    ],
    null,
  );
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode: 'unattended',
    },
    { colour: false, width: 60 },
  );
  assert.deepEqual(section(lines, '  correcting in Actual'), [
    '  ~ #1 MERCHANT*7K2Q9X4M        NEWARK    …: -14.95 → -12.90',
  ]);
  assert.deepEqual(section(lines, '  in Actual, but to fix there'), [
    '  ! #2 M…: Actual holds -14.95, the bank says -12.90 (split)',
  ]);
});

test('a reviewed correction says what Actual holds and what the bank says', () => {
  const [, , reconciled] = threeCorrections();
  const lines = block(
    { position: 1, total: 2, classified: reconciled!, warnings: ['mind this'] },
    plain,
  );
  assert.deepEqual(lines.slice(1), [
    '  #3       2031-03-10     -75.00  SBB CFF FFS',
    '                                  Carte',
    "  in Actual at -80.00 · correct it to the bank's -75.00",
    '  ! mind this',
  ]);
});

test("a correction's detail shows the Actual transaction it corrects", () => {
  const [, , reconciled] = threeCorrections();
  const text = detail(reconciled!, plain).join('\n');
  assert.match(
    text,
    /^ {2}why {6}paired by imported ID, and the bank booked it at -75\.00$/m,
  );
  assert.match(text, /^ {2}actual {3}date {9}2031-03-09$/m);
  assert.match(text, /^ {11}amount {7}-80\.00$/m);
  assert.match(text, /^ {11}reconciled {3}yes$/m);
});

test('the note says the reconciled period, the lookalike, and the repeat', () => {
  const twin = { importedId: '', importedIdOrigin: 'absent' as const };
  const classified = classify(
    [
      src({ ...twin, date: isoDate('2020-06-29') }),
      src({ ...twin, date: isoDate('2020-06-29') }),
    ],
    [],
    isoDate('2020-06-30'),
  );
  assert.equal(noteTag(classified[0]!, 'review'), 'reconciled period');
  assert.equal(noteTag(classified[1]!, 'review'), 'reconciled period · same as #1');
  assert.equal(noteTag(coffeeTwins()[1]!, 'review'), "like #1's pair");
});

test('unattended, the note says one in the reconciled period is left out', () => {
  const [inside] = classify(
    [src({ date: isoDate('2020-06-29') })],
    [],
    isoDate('2020-06-30'),
  );
  assert.equal(noteTag(inside!, 'unattended'), 'left out: reconciled period');
  assert.equal(noteTag(coffeeTwins()[1]!, 'unattended'), "like #1's pair");
});

test("the note says a pending one is pending, and in which currency if not the account's", () => {
  // Unattended, nothing else says so before it is written.
  const [usd, chf] = classify(
    [
      src({ pending: { originalCurrency: 'USD', accountCurrency: 'CHF' } }),
      src({ pending: { originalCurrency: 'CHF', accountCurrency: 'CHF' } }),
    ],
    [],
    null,
  );
  for (const mode of ['unattended', 'review'] as const) {
    assert.equal(noteTag(usd!, mode), 'pending, in USD');
    assert.equal(noteTag(chf!, mode), 'pending');
  }
});

test('unattended, the report counts what it imports and what it leaves out', () => {
  const classified = classify(
    [
      src({ date: isoDate('2031-03-09') }),
      src({ date: isoDate('2020-06-29'), payee: 'KIOSK' }),
      src({ date: isoDate('2020-06-30'), payee: 'NEWSAGENT' }),
    ],
    [actual()],
    isoDate('2020-06-30'),
  );
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: isoDate('2020-06-30'),
      dropped: [],
      mode: 'unattended',
    },
    plain,
  );
  assert.deepEqual(lines, [
    '  Statement',
    '    - From 2031-03-01 to 2031-03-31',
    '    - 3 transactions found',
    '    - 1 already in Actual',
    '    - 1 to import',
    '    - 1 left out, in the reconciled period',
    '  Actual',
    '    - Reconciled through 2020-06-30',
    '    - 0 not in the statement',
    '',
    '  # date           amount payee                      note',
    '  2 2020-06-29      -4.50 KIOSK                      left out: reconciled period',
    '  3 2020-06-30      -4.50 NEWSAGENT',
  ]);
});

test('unattended with nothing left out, the report does not mention it', () => {
  const lines = report(
    {
      period: MARCH,
      classified: classify([src()], [], null),
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode: 'unattended',
    },
    plain,
  );
  assert.deepEqual(lines.slice(3, 6), [
    '    - 0 already in Actual',
    '    - 1 to import',
    '  Actual',
  ]);
});

test('every list header label sits at the start of the field it names', () => {
  const classified = coffeeTwins()[1]!;
  const header = listHeader(plain);
  const rendered = listLine(classified, 'review', plain);
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
    isoDate('2040-01-01'),
  );
  for (const width of [40, 60, 80, 120]) {
    const rendered = listLine(one!, 'review', { colour: false, width });
    assert.ok(rendered.length <= width, `${rendered.length} > ${width}: ${rendered}`);
  }
});

test('a wider terminal gives a long payee more room before it is cut', () => {
  const payee = 'EXAMPLE; Paiement UBS TWINT DE LA PART DE QUELQU UN';
  const [one] = classify([src({ payee })], [], isoDate('2040-01-01'));
  assert.ok(!listLine(one!, 'review', plain).includes(payee));
  assert.ok(
    listLine(one!, 'review', { colour: false, width: 120 }, 0).includes(
      payee.slice(0, 39),
    ),
  );
});

test('with no note anywhere, the header names no note column', () => {
  const classified = classify([src()], [], null);
  const lines = report(
    {
      period: MARCH,
      classified,
      unpaired: [],
      reconciledThrough: null,
      dropped: [],
      mode: 'review',
    },
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
    [
      src({
        payee: 'X'.repeat(90),
        notes: 'Y'.repeat(90),
        date: isoDate('2031-03-09'),
      }),
    ],
    [actual({ payeeName: 'Z'.repeat(90) })],
    null,
  );
  const [, twin] = classify(
    [
      src({ date: isoDate('2031-03-09') }),
      src({ payee: 'X'.repeat(90), date: isoDate('2031-03-09') }),
    ],
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
  const [alone] = classify(
    [src({ date: isoDate('2020-06-01') })],
    [],
    isoDate('2020-06-30'),
  );
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
    [src({ date: isoDate('2031-03-09') }), src({ date: isoDate('2031-03-09') })],
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

test('the detail says why a pending account row carries no imported ID', () => {
  const [one] = classify(
    [src({ importedId: '', importedIdOrigin: 'pending' })],
    [],
    null,
  );
  assert.match(
    detail(one!, plain).join(' ').replace(/\s+/g, ' '),
    /imported ID none: the bank has not booked it, and renumbers it when it does/,
  );
});

test('an extra holder of an imported ID is called a duplicate, never a pair', () => {
  const [, other] = classify(
    [
      src({ importedId: 'X' }),
      src({ importedId: 'OTHER', date: isoDate('2031-03-09') }),
    ],
    [
      actual({ imported_id: 'X', date: isoDate('2031-06-30') }),
      actual({ imported_id: 'X' }),
    ],
    null,
  );
  assert.equal(noteTag(other!, 'review'), "like #1's duplicate");
  const shown = block(
    { position: 1, total: 1, classified: other!, warnings: [] },
    plain,
  );
  assert.ok(shown.some((l) => l.includes("looks like #1's duplicate: 2031-03-09")));
  const text = detail(other!, plain).join('\n');
  assert.match(text, /in Actual, a second holder of #1's imported ID/);
  assert.doesNotMatch(text, /the pair of/);
});

test('with no note, a padded payee never ends a line in an ellipsis', () => {
  // The separator after the payee pushed a line one column past the terminal
  // whenever the payee had all the room, so its padding was cut with `…`.
  const [one] = classify([src()], [], null);
  for (const width of [60, 62, 66]) {
    const style = { colour: false, width };
    assert.equal(
      listLine(one!, 'review', style, 0),
      '  1 2031-03-10      -4.50 CAFE LUGANO',
    );
    assert.ok(!listHeader(style, 0).endsWith('…'), listHeader(style, 0));
  }
  const lines = reportOf(
    [],
    [actual({ date: isoDate('2031-03-20'), payeeName: 'Shell' })],
    {
      colour: false,
      width: 60,
    },
  );
  assert.deepEqual(section(lines, '  in Actual, not in the statement'), [
    '  ! 2031-03-20      -4.50  Shell',
  ]);
});

test('a hung note wraps rather than being cut', () => {
  const lines = reportOf(
    [],
    [actual({ date: isoDate('2031-03-20'), reconciled: true })],
    {
      colour: false,
      width: 40,
    },
  );
  assert.deepEqual(section(lines, '  in Actual, not in the statement').slice(1), [
    '      already reconciled, double check',
    '      reconciliation balance',
  ]);
});
