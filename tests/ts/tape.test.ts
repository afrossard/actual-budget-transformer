/**
 * The Tape's rendering: one line per row up front, one block per reviewed row.
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
  wrap,
  explain,
  fit,
  matchTag,
  overview,
  terminalWidth,
  tapeHeader,
  tapeLine,
} from '../../src/tape.ts';
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

const plain = { colour: false, width: 80 };
const noNumbers = (): undefined => undefined;

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

test('a Tape line is one short line per source transaction', () => {
  const [clean] = classify([src({ payee: 'MIGROS', amountCents: -2345 })], [], null);
  assert.equal(
    tapeLine(1, clean!, plain, noNumbers),
    '  1 2031-03-10     -23.45 clean      MIGROS',
  );
});

test('a Tape line never outgrows the terminal, however long the payee', () => {
  const [row] = classify(
    [src({ payee: 'A PAYEE NAME FAR LONGER THAN ANY COLUMN WOULD EVER HOLD' })],
    [actual({ reconciled: true, is_parent: true })],
    null,
  );
  for (const width of [40, 60, 80, 120]) {
    const rendered = tapeLine(1, row!, { colour: false, width }, noNumbers);
    assert.ok(rendered.length <= width, `${rendered.length} > ${width}: ${rendered}`);
  }
});

test('every Tape header label sits at the start of the field it names', () => {
  const [row] = classify([src({ payee: 'CAFE LUGANO' })], [actual()], null);
  const header = tapeHeader(plain);
  const rendered = tapeLine(1, row!, plain, noNumbers);
  // The amount is right-aligned, so its label's right edge is what must line up.
  assert.equal(
    header.indexOf('amount') + 'amount'.length,
    rendered.indexOf('-4.50') + '-4.50'.length,
  );
  for (const [label, field] of [
    ['date', '2031-'],
    ['bucket', 'suspicious'],
    ['payee', 'CAFE'],
    ['match', 'same day'],
  ] as const) {
    assert.equal(
      header.indexOf(label),
      rendered.indexOf(field),
      `the ${label} header is not above the ${label} column`,
    );
  }
});

test('the match tag says on what basis, in a few words', () => {
  const tag = (stored: ActualTransaction[], over: Partial<SourceTransaction> = {}) => {
    const [row] = classify([src(over)], stored, null);
    return matchTag(row!, noNumbers);
  };
  assert.equal(tag([]), '');
  assert.equal(tag([actual()]), 'same day');
  assert.equal(tag([actual({ date: '2031-03-11' })]), '±1 day');
  assert.equal(tag([actual({ reconciled: true })]), 'reconciled, same day');
  assert.equal(tag([actual({ is_parent: true })]), 'split, same day');
  assert.equal(
    tag([actual(), actual({ id: 'stored-2', date: '2031-03-11' })]),
    '2 matches, ±1 day',
  );
  assert.equal(
    tag([actual({ imported_id: 'T-X', date: '2030-01-01' })], { importedId: 'T-X' }),
    'imported ID',
  );
  assert.equal(
    tag(
      [actual({ imported_id: 'T-X' }), actual({ id: 'stored-2', imported_id: 'T-X' })],
      { importedId: 'T-X' },
    ),
    'imported ID ×2',
  );
});

test('a repeated row is referred to by its # on the Tape, not by its CSV line', () => {
  const first = src({ importedId: '', importedIdOrigin: 'absent' });
  const second = { ...first, sourceLine: first.sourceLine + 7 };
  const rows = classify([src(), first, second], [], null);
  const numberOf = (sourceLine: number): number | undefined =>
    rows.findIndex((r) => r.source.sourceLine === sourceLine) + 1 || undefined;
  assert.equal(matchTag(rows[2]!, numberOf), 'same as #2');
  // The CSV line stays available in the detail, beside the #.
  assert.deepEqual(explain(rows[2]!.reasons, numberOf), [
    `identical to #2 (line ${first.sourceLine} of this file)`,
  ]);
});

test('the overview says the account, the boundary, and the count per bucket', () => {
  const rows = classify(
    [src({ date: '2020-06-01' }), src(), src({ date: '2031-03-12' })],
    [actual()],
    '2020-06-30',
  );
  const lines = overview(
    { accountName: 'Checking', rows, boundary: '2020-06-30', dropped: [] },
    plain,
  );
  assert.equal(lines[0], 'Checking: 3 transactions · reconciled through 2020-06-30');
  assert.equal(lines[1], '  1 clean · 1 suspicious · 0 skip · 1 locked');
  // The match column is only as wide as the longest tag, so the header and
  // every row are laid out with that one width and still line up.
  const header = lines.find((l) => l.includes('bucket'))!;
  assert.equal(header.indexOf('match'), lines.at(-2)!.indexOf('same day'));
  assert.equal(lines.at(-1), '  3 2031-03-12      -4.50 clean      CAFE LUGANO');
});

test('the overview says when nothing is reconciled, and what the file held unread', () => {
  const rows = classify([src()], [], null);
  const lines = overview(
    {
      accountName: 'Checking',
      rows,
      boundary: null,
      dropped: [{ sourceLine: 14, reason: 'pending (not booked yet)', raw: '' }],
    },
    plain,
  );
  assert.equal(lines[0], 'Checking: 1 transaction · nothing reconciled yet');
  assert.ok(lines.includes('  1 row in the file was not read as a transaction:'));
  assert.ok(lines.includes('    line 14: pending (not booked yet)'));
});

test("a reviewed row's block lines up the bank's version and Actual's", () => {
  const [row] = classify(
    [src({ date: '2030-06-30', amountCents: -12000, payee: 'SUPERMARKET CORRECTION' })],
    [
      actual({
        date: '2030-06-30',
        amount: -12000,
        payeeName: 'OLD RECONCILED TX',
        notes: 'marked reconciled below, which sets the boundary',
        reconciled: true,
      }),
    ],
    '2030-06-30',
  );
  const lines = block(
    {
      number: 1,
      total: 14,
      row: row!,
      corrected: new Set(),
      warnings: ['inside the reconciled range: writing here changes it'],
    },
    { colour: false, width: 70 },
    noNumbers,
  );
  assert.deepEqual(lines, [
    '── 1 of 14 · locked ──────────────────────────────────────────────────',
    '  bank     2030-06-30    -120.00  SUPERMARKET CORRECTION',
    '                                  Carte',
    '  actual   2030-06-30    -120.00  OLD RECONCILED TX         reconciled',
    '                                  marked reconciled below, which sets…',
    '  ! inside the reconciled range: writing here changes it',
  ]);
});

test('a block names each stored transaction once, however many reasons point at it', () => {
  const stored = actual({ date: '2020-06-30', reconciled: true });
  const [row] = classify([src({ date: '2020-06-30' })], [stored], '2020-06-30');
  // Both the boundary evidence and the blind-duplicate evidence name it.
  assert.equal(row!.reasons.length, 2);
  const lines = block(
    { number: 1, total: 1, row: row!, corrected: new Set(), warnings: [] },
    plain,
    noNumbers,
  );
  assert.equal(lines.filter((l) => l.includes('Coffee')).length, 1);
});

test('several matches are numbered for the which-one prompt; a corrected one is not', () => {
  const [row] = classify(
    [src()],
    [
      actual({ id: 'taken' }),
      actual({ id: 'a', date: '2031-03-09', payeeName: 'First' }),
      actual({ id: 'b', date: '2031-03-11', payeeName: 'Second' }),
    ],
    null,
  );
  const lines = block(
    { number: 2, total: 3, row: row!, corrected: new Set(['taken']), warnings: [] },
    plain,
    noNumbers,
  );
  const labelOf = (payee: string): string | undefined =>
    lines
      .find((l) => l.includes(payee))
      ?.slice(2, 10)
      .trimEnd();
  assert.equal(labelOf('Coffee'), 'actual');
  assert.ok(lines.find((l) => l.includes('Coffee'))!.endsWith('corrected above'));
  assert.equal(labelOf('First'), 'actual 1');
  assert.equal(labelOf('Second'), 'actual 2');
});

test('a block marks what makes a match matter: split, reconciled, imported ID', () => {
  const [row] = classify(
    [src({ importedId: 'T-X', amountCents: -7500 })],
    [actual({ imported_id: 'T-X', amount: -8000, is_parent: true, reconciled: true })],
    null,
  );
  const lines = block(
    { number: 1, total: 1, row: row!, corrected: new Set(), warnings: [] },
    { colour: false, width: 120 },
    noNumbers,
  );
  const stored = lines.find((l) => l.startsWith('  actual'))!;
  assert.match(stored, /-80\.00/);
  assert.ok(stored.endsWith('imported ID, split, reconciled'), stored);
});

test('a block never outgrows the terminal', () => {
  const [row] = classify(
    [src({ payee: 'X'.repeat(90), notes: 'Y'.repeat(90) })],
    [actual({ payeeName: 'Z'.repeat(90), notes: 'W'.repeat(90), reconciled: true })],
    null,
  );
  for (const width of [40, 80]) {
    const lines = block(
      {
        number: 1,
        total: 1,
        row: row!,
        corrected: new Set(),
        warnings: ['V'.repeat(90)],
      },
      { colour: false, width },
      noNumbers,
    );
    for (const l of lines) assert.ok(l.length <= width, `${l.length} > ${width}: ${l}`);
  }
});

test('a wider terminal gives a long payee more room before it is cut', () => {
  const payee = 'EXAMPLE; Paiement UBS TWINT';
  const [row] = classify([src({ payee })], [], null);
  assert.ok(!tapeLine(1, row!, plain, noNumbers).includes(payee));
  assert.ok(
    tapeLine(1, row!, { colour: false, width: 120 }, noNumbers).includes(payee),
  );
  const header = tapeHeader({ colour: false, width: 120 });
  const rendered = tapeLine(1, row!, { colour: false, width: 120 }, noNumbers);
  assert.equal(header.indexOf('payee'), rendered.indexOf('EXAMPLE'));
});

test('on a narrow terminal the payee gives way, so a tag is never cut to nothing', () => {
  const [row] = classify(
    [src({ importedId: 'T-X', payee: 'EXAMPLE; Paiement UBS TWINT' })],
    [actual({ imported_id: 'T-X', payeeName: 'EXAMPLE; Paiement UBS TWINT' })],
    null,
  );
  const narrow = { colour: false, width: 60 };
  const lines = block(
    { number: 1, total: 1, row: row!, corrected: new Set(), warnings: [] },
    narrow,
    noNumbers,
  );
  assert.ok(lines.find((l) => l.startsWith('  actual'))!.endsWith(' imported ID'));
  assert.ok(
    tapeLine(
      1,
      row!,
      { colour: false, width: 64 },
      noNumbers,
      'imported ID'.length,
    ).endsWith(' imported ID'),
  );
});

test('with no match anywhere, the header names no match column', () => {
  const rows = classify([src(), src({ date: '2031-03-20' })], [], null);
  const lines = overview(
    { accountName: 'Checking', rows, boundary: null, dropped: [] },
    plain,
  );
  const header = lines.find((l) => l.includes('bucket'))!;
  assert.ok(header.endsWith('payee'), header);
});

test('tags too long to share a line with the payee get a line of their own, uncut', () => {
  const [row] = classify(
    [src({ importedId: 'T-X' })],
    [actual({ imported_id: 'T-X', is_parent: true, reconciled: true })],
    null,
  );
  const lines = block(
    { number: 1, total: 1, row: row!, corrected: new Set(['stored-1']), warnings: [] },
    // Too narrow for the payee and all four tags, wide enough for the tags alone.
    { colour: false, width: 90 },
    noNumbers,
  );
  assert.ok(
    lines.some((l) => l.trim() === 'imported ID, split, reconciled, corrected above'),
    lines.join('\n'),
  );
  // The payee is what gives way.
  assert.ok(lines.some((l) => l.includes('Coffee (typ…')));
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

test('the detail names each match once, in full, and never outgrows the terminal', () => {
  const notes =
    'marked reconciled below, which sets the boundary, and then some more words';
  const [row] = classify(
    [src({ date: '2030-06-30', amountCents: -12000, payee: 'SUPERMARKET CORRECTION' })],
    [actual({ date: '2030-06-30', amount: -12000, notes, reconciled: true })],
    '2030-06-30',
  );
  const lines = detail({ row: row!, corrected: new Set() }, plain, noNumbers);
  for (const l of lines) assert.ok(l.length <= 80, `${l.length} > 80: ${l}`);
  assert.ok(!lines.some((l) => l.includes('…')), lines.join('\n'));
  // Wrapped, not cut: every word of the notes is there, once.
  const text = lines.join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes(notes), text);
  assert.equal(text.split('Coffee (typed by hand)').length - 1, 1, text);
  assert.match(text, /dated on or before the reconciliation boundary 2030-06-30/);
  assert.match(text, /same amount within a day of 1 transaction\b/);
  assert.match(text, new RegExp(`line ${row!.source.sourceLine} of the file`));
  assert.match(text, /imported ID T-\d+, the bank's reference/);
});

test('the detail labels matches as the block does, so the numbers agree', () => {
  const [row] = classify(
    [src()],
    [actual({ id: 'a', payeeName: 'First' }), actual({ id: 'b', payeeName: 'Second' })],
    null,
  );
  const reviewed = { row: row!, corrected: new Set<string>() };
  const lines = detail(reviewed, plain, noNumbers);
  assert.ok(
    lines.some((l) => /^ {2}actual 1 +payee +First$/.test(l)),
    lines.join('\n'),
  );
  assert.ok(
    lines.some((l) => /^ {2}actual 2 +payee +Second$/.test(l)),
    lines.join('\n'),
  );
});

test('the detail shows what a split is made of', () => {
  const [row] = classify(
    [src({ amountCents: -6400 })],
    [
      actual({
        amount: -6400,
        is_parent: true,
        subtransactions: [{ amount: -4000 }, { amount: -2400 }],
      }),
    ],
    null,
  );
  const text = detail({ row: row!, corrected: new Set() }, plain, noNumbers).join('\n');
  assert.match(text, /split into +-40\.00, -24\.00/);
});
