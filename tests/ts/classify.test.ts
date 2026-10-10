import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  tally,
  toFixInActual,
  unpairedActual,
  type ActualTransaction,
  type Classified,
} from '../../src/classify.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';
import { isoDate } from './iso-date-fixture.ts';

let line = 0;
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
    id: `uuid-${seq}`,
    date: isoDate('2031-03-10'),
    amount: -450,
    imported_id: null,
    payee: null,
    notes: null,
    reconciled: false,
    ...over,
  };
}

const MARCH = { from: isoDate('2031-03-01'), to: isoDate('2031-03-31') };

/** Each statement transaction's pair, by Actual id, or null when unpaired. */
function pairs(classified: readonly Classified[]): (string | null)[] {
  return classified.map((c) => c.pair?.actual.id ?? null);
}

test('a statement transaction nothing in Actual is alike to is unpaired', () => {
  const [one] = classify([src()], [], null);
  assert.equal(one!.pair, null);
  assert.deepEqual(one!.lookalikes, []);
  assert.equal(one!.repeatOf, null);
  assert.equal(one!.inReconciledPeriod, false);
});

test('each statement transaction is numbered by its position in the file', () => {
  const classified = classify([src(), src(), src()], [], null);
  assert.deepEqual(
    classified.map((c) => c.number),
    [1, 2, 3],
  );
});

test('a shared imported ID pairs, wherever the Actual transaction is dated', () => {
  // The cards parser dates a purchase by `Date d'achat` while the bank books it
  // weeks later, so re-dating it in Actual moves it a long way from where this
  // tool wrote it. Pairing by imported ID must not care.
  const moved = actual({
    date: isoDate('2031-06-30'),
    imported_id: 'T-FAR',
    id: 'moved',
  });
  const [one] = classify([src({ importedId: 'T-FAR' })], [moved], null);
  assert.equal(one!.pair?.by, 'imported-id');
  assert.equal(one!.pair.actual.id, 'moved');
});

test('a blank imported ID never pairs with a blank Actual one', () => {
  // Typed by hand, an Actual transaction has no imported ID. A statement
  // transaction without one must pair on amount and date or not at all.
  const typed = actual({ imported_id: null, amount: -9999 });
  const [one] = classify(
    [src({ importedId: '', importedIdOrigin: 'absent', amountCents: -1990 })],
    [typed],
    null,
  );
  assert.equal(one!.pair, null);
});

test('the same amount within one day pairs; two days apart does not', () => {
  const classified = classify(
    [src({ date: isoDate('2031-03-10') }), src({ date: isoDate('2031-03-20') })],
    [
      actual({ date: isoDate('2031-03-11'), id: 'next-day' }),
      actual({ date: isoDate('2031-03-22'), id: 'two-days-on' }),
    ],
    null,
  );
  assert.deepEqual(pairs(classified), ['next-day', null]);
  assert.equal(classified[0]!.pair?.by, 'amount-and-date');
});

test('a different amount never pairs, however close the date', () => {
  const [one] = classify([src()], [actual({ amount: -451 })], null);
  assert.equal(one!.pair, null);
});

test('two different bank references never pair, however alike', () => {
  // The bank gave them different references, so they are two transactions: a
  // second coffee the day after one already imported must reach review.
  const imported = actual({
    imported_id: 'REF-A',
    id: 'yesterday',
    date: isoDate('2031-03-09'),
  });
  const [one] = classify([src({ importedId: 'REF-B' })], [imported], null);
  assert.equal(one!.pair, null);
  // Still shown, so the human can tell the two apart.
  assert.deepEqual(
    one!.lookalikes.map((l) => [l.actual.id, l.of, l.role]),
    [['yesterday', null, 'other-reference']],
  );
});

test('a minted imported ID that differs still pairs on amount and date', () => {
  // The cards occurrence counter shifts across overlapping exports, so the same
  // purchase can arrive under a new minted ID.
  const minted = { importedIdOrigin: 'minted' as const };
  const reExported = actual({ imported_id: 'abt1-0000000000000001', id: 'prev' });
  const [one] = classify(
    [src({ ...minted, importedId: 'abt1-0000000000000002' })],
    [reExported],
    null,
  );
  assert.equal(one!.pair?.actual.id, 'prev');
});

test('a bank reference pairs with an Actual transaction holding a minted or no ID', () => {
  const classified = classify(
    [
      src({ importedId: 'REF-B' }),
      src({ importedId: 'REF-C', date: isoDate('2031-03-20') }),
    ],
    [
      actual({ imported_id: 'abt1-0000000000000001', id: 'minted' }),
      actual({ imported_id: null, id: 'typed', date: isoDate('2031-03-20') }),
    ],
    null,
  );
  assert.deepEqual(pairs(classified), ['minted', 'typed']);
});

test('pairing is one to one: of two identical, one pairs and the other is reviewed', () => {
  const twin = { importedId: '', importedIdOrigin: 'absent' as const };
  const classified = classify(
    [src(twin), src(twin)],
    [actual({ id: 'only-one' })],
    null,
  );
  assert.deepEqual(pairs(classified), ['only-one', null]);
  // The unpaired one says which statement transaction took its lookalike.
  assert.deepEqual(
    classified[1]!.lookalikes.map((l) => [l.actual.id, l.of]),
    [['only-one', 1]],
  );
});

test('of five identical transactions with two in Actual, two pair and three are reviewed', () => {
  // ADR 0003: the group no longer goes to review as a whole.
  const classified = classify(
    Array.from({ length: 5 }, () =>
      src({ importedId: '', importedIdOrigin: 'absent' }),
    ),
    [actual({ id: 'a' }), actual({ id: 'b' })],
    null,
  );
  assert.equal(tally(classified).paired, 2);
  assert.equal(tally(classified).toReview, 3);
});

test('the same day is preferred over a day apart', () => {
  const [one] = classify(
    [src({ date: isoDate('2031-03-10') })],
    [
      actual({ date: isoDate('2031-03-09'), id: 'day-before' }),
      actual({ id: 'same-day' }),
    ],
    null,
  );
  assert.equal(one!.pair?.actual.id, 'same-day');
});

test('the same day is preferred even for one listed after a day-off lookalike', () => {
  const classified = classify(
    [src({ date: isoDate('2031-03-10') }), src({ date: isoDate('2031-03-09') })],
    [actual({ date: isoDate('2031-03-09'), id: 'typed' })],
    null,
  );
  assert.deepEqual(pairs(classified), [null, 'typed']);
});

test('pairing finds the most pairs when every entry in Actual is a day late', () => {
  // Typed by hand on the booking date, each a day after the bank's own date.
  // Pairing the 11th with the same-day entry first would leave the 10th with
  // nothing and review a transaction Actual already holds.
  const classified = classify(
    ['2031-03-10', '2031-03-11', '2031-03-12'].map((date) =>
      src({ date: isoDate(date) }),
    ),
    ['2031-03-11', '2031-03-12', '2031-03-13'].map((date) =>
      actual({ date: isoDate(date), id: `typed-${date}` }),
    ),
    null,
  );
  assert.deepEqual(pairs(classified), [
    'typed-2031-03-11',
    'typed-2031-03-12',
    'typed-2031-03-13',
  ]);
});

test('an imported ID pair takes its Actual transaction before any amount pair can', () => {
  // The first statement transaction is a lookalike of the second's
  // counterpart, and comes first in the file; the imported ID still wins.
  const held = actual({ imported_id: 'T-HELD', id: 'held' });
  const classified = classify(
    [src({ importedId: 'T-OTHER' }), src({ importedId: 'T-HELD' })],
    [held],
    null,
  );
  assert.deepEqual(pairs(classified), [null, 'held']);
  assert.deepEqual(
    classified[0]!.lookalikes.map((l) => l.of),
    [2],
  );
});

test('dates decide nothing: an unpaired one in the reconciled period is still reviewed', () => {
  // Reported from a real run: two transactions deleted from Actual, on the
  // same day as the last reconciled one, were set aside as "locked".
  const classified = classify(
    [
      src({ date: isoDate('2020-06-14') }),
      src({ date: isoDate('2020-06-15'), amountCents: -100 }),
      src({ date: isoDate('2020-06-16') }),
    ],
    [
      actual({
        date: isoDate('2020-06-15'),
        amount: -100,
        reconciled: true,
        id: 'attested',
      }),
    ],
    isoDate('2020-06-15'),
  );
  assert.deepEqual(pairs(classified), [null, 'attested', null]);
  assert.deepEqual(
    classified.map((c) => c.inReconciledPeriod),
    [true, true, false],
  );
});

test('a statement transaction repeated in one file names the first, and both are reviewed', () => {
  // The bank's file is authoritative on the count, so the second must reach
  // the human rather than be absorbed by our own dedup.
  const twin = {
    importedId: '',
    importedIdOrigin: 'absent' as const,
    date: isoDate('2031-03-20'),
    amountCents: -1990,
    payee: 'PHARMACIE CENTRALE',
    notes: '',
  };
  const classified = classify([src(), src(twin), src(twin)], [], null);
  assert.deepEqual(
    classified.map((c) => c.repeatOf),
    [null, null, 2],
  );
  assert.deepEqual(pairs(classified), [null, null, null]);
});

test('the pairs do not shift as earlier statement transactions are imported', () => {
  // Classify once per batch: five equal-amount consecutive days, with Actual
  // already holding one on 03-09. Only the 03-10 one is near it.
  const classified = classify(
    ['2031-03-10', '2031-03-11', '2031-03-12', '2031-03-13', '2031-03-14'].map((date) =>
      src({ date: isoDate(date) }),
    ),
    [actual({ date: isoDate('2031-03-09'), id: 'typed' })],
    null,
  );
  assert.deepEqual(pairs(classified), ['typed', null, null, null, null]);
  assert.deepEqual(
    classified.map((c) => c.lookalikes.length),
    [0, 0, 0, 0, 0],
  );
});

test('classify never mutates its inputs', () => {
  const sources = [src(), src()];
  const existing = [actual(), actual({ imported_id: 'X' })];
  const snapshot = JSON.stringify({ sources, existing });
  classify(sources, existing, isoDate('2020-01-01'));
  assert.equal(JSON.stringify({ sources, existing }), snapshot);
});

test('a pair whose amounts differ is something to fix in Actual', () => {
  const classified = classify(
    [src({ importedId: 'T-X', amountCents: -7500 })],
    [actual({ imported_id: 'T-X', amount: -8000, id: 'stored' })],
    null,
  );
  assert.equal(classified[0]!.pair?.actual.id, 'stored');
  assert.deepEqual(toFixInActual(classified[0]!), [
    { kind: 'amount-differs', actualAmount: -8000 },
  ]);
});

test('two Actual transactions sharing one imported ID are a duplicate, not a fix', () => {
  // Actual has no uniqueness constraint on imported_id, so this is reachable,
  // and it is the corruption this tool exists to prevent.
  const first = actual({
    imported_id: 'SHARED',
    id: 'first',
    date: isoDate('2031-03-01'),
  });
  const second = actual({
    imported_id: 'SHARED',
    id: 'second',
    date: isoDate('2031-03-02'),
  });
  const classified = classify([src({ importedId: 'SHARED' })], [first, second], null);
  assert.equal(classified[0]!.pair?.actual.id, 'first');
  assert.deepEqual(toFixInActual(classified[0]!), []);
  assert.deepEqual(unpairedActual(classified, [first, second], MARCH), [
    { actual: second, twin: first },
  ]);
});

test('a second holder of an imported ID is never paired on amount and date', () => {
  // Pairing it with another statement transaction would hide the duplicate.
  const first = actual({ imported_id: 'SHARED', id: 'first' });
  const second = actual({ imported_id: 'SHARED', id: 'second' });
  const classified = classify(
    [src({ importedId: 'SHARED' }), src({ importedId: 'OTHER' })],
    [first, second],
    null,
  );
  assert.deepEqual(pairs(classified), ['first', null]);
});

test('a reference the bank itself repeats pairs each copy, and is no duplicate', () => {
  const existing = [
    actual({ imported_id: 'TWICE', id: 'a' }),
    actual({ imported_id: 'TWICE', id: 'b' }),
  ];
  const classified = classify(
    [src({ importedId: 'TWICE' }), src({ importedId: 'TWICE' })],
    existing,
    null,
  );
  assert.deepEqual(pairs(classified), ['a', 'b']);
  assert.deepEqual(classified.flatMap(toFixInActual), []);
  assert.deepEqual(unpairedActual(classified, existing, MARCH), []);
});

test('a pair made on amount and date is nothing to fix', () => {
  const [one] = classify([src()], [actual({ date: isoDate('2031-03-11') })], null);
  assert.deepEqual(toFixInActual(one!), []);
});

test('a second holder of an imported ID is a lookalike as a duplicate, not as a pair', () => {
  const first = actual({ imported_id: 'X', id: 'first', date: isoDate('2031-06-30') });
  const second = actual({ imported_id: 'X', id: 'second' });
  const classified = classify(
    [src({ importedId: 'X' }), src({ importedId: 'OTHER' })],
    [first, second],
    null,
  );
  assert.deepEqual(
    classified[1]!.lookalikes.map((l) => [l.actual.id, l.of, l.role]),
    [['second', 1, 'extra-holder']],
  );
});

test('the holder of its own imported ID, paired with an earlier copy, is a lookalike', () => {
  // The bank lists reference X twice and Actual holds one, re-dated far away.
  // The second copy must not be told nothing in Actual holds X.
  const moved = actual({ imported_id: 'X', id: 'moved', date: isoDate('2031-06-30') });
  const classified = classify(
    [src({ importedId: 'X' }), src({ importedId: 'X' })],
    [moved],
    null,
  );
  assert.equal(classified[1]!.pair, null);
  assert.deepEqual(
    classified[1]!.lookalikes.map((l) => [l.actual.id, l.of, l.role]),
    [['moved', 1, 'pair']],
  );
});

/** The unpaired Actual transactions, as `id` or `id~twin`. */
function unpaired(
  sources: readonly SourceTransaction[],
  existing: readonly ActualTransaction[],
  period = MARCH,
): string[] {
  const classified = classify(sources, existing, null);
  return unpairedActual(classified, existing, period).map((u) =>
    u.twin === null ? u.actual.id : `${u.actual.id}~${u.twin.id}`,
  );
}

test('an Actual transaction in the period that nothing pairs with is unpaired', () => {
  assert.deepEqual(
    unpaired(
      [src()],
      [actual({ id: 'paired' }), actual({ id: 'other', amount: -900 })],
    ),
    ['other'],
  );
});

test('an Actual transaction outside the period is not unpaired, its edges included', () => {
  assert.deepEqual(
    unpaired(
      [],
      [
        actual({ id: 'before', date: isoDate('2031-02-28') }),
        actual({ id: 'first', date: isoDate('2031-03-01') }),
        actual({ id: 'last', date: isoDate('2031-03-31') }),
        actual({ id: 'after', date: isoDate('2031-04-01') }),
      ],
    ),
    ['first', 'last'],
  );
});

test('a second copy of a paired Actual transaction is its duplicate, payee ignored', () => {
  assert.deepEqual(
    unpaired(
      [src()],
      [
        actual({ id: 'paired', payeeName: 'Coop' }),
        actual({ id: 'copy', date: isoDate('2031-03-11'), payeeName: 'Migros' }),
      ],
    ),
    ['copy~paired'],
  );
});

test('a second holder of a paired imported ID is its duplicate, whatever its amount', () => {
  assert.deepEqual(
    unpaired(
      [src({ importedId: 'X' })],
      [
        actual({ id: 'paired', imported_id: 'X' }),
        actual({
          id: 'copy',
          imported_id: 'X',
          amount: -999,
          date: isoDate('2031-03-20'),
        }),
      ],
    ),
    ['copy~paired'],
  );
});

test('a second holder of a paired imported ID is its duplicate, whatever its date', () => {
  // A cards statement's period is only the span of its transactions, and a
  // copy re-dated to its booking date can sit weeks outside it.
  assert.deepEqual(
    unpaired(
      [src({ importedId: 'X' })],
      [
        actual({ id: 'paired', imported_id: 'X' }),
        actual({ id: 'booked', imported_id: 'X', date: isoDate('2031-04-20') }),
        actual({ id: 'other', imported_id: 'Y', date: isoDate('2031-04-20') }),
      ],
    ),
    ['booked~paired'],
  );
});

test('the same amount two days from a paired one is no duplicate', () => {
  assert.deepEqual(
    unpaired(
      [src()],
      [actual({ id: 'paired' }), actual({ id: 'far', date: isoDate('2031-03-12') })],
    ),
    ['far'],
  );
});

test('a duplicate names the twin holding its imported ID before one alike in amount', () => {
  assert.deepEqual(
    unpaired(
      [src({ importedId: 'A' }), src({ importedId: 'B' })],
      [
        actual({ id: 'by-amount', imported_id: 'A' }),
        actual({ id: 'by-id', imported_id: 'B' }),
        actual({ id: 'copy', imported_id: 'B' }),
      ],
    ),
    ['copy~by-id'],
  );
});

test('a duplicate names the closest twin in date', () => {
  assert.deepEqual(
    unpaired(
      [src({ date: isoDate('2031-03-09') }), src({ date: isoDate('2031-03-10') })],
      [
        actual({ id: 'day-before', date: isoDate('2031-03-09') }),
        actual({ id: 'same-day', date: isoDate('2031-03-10') }),
        actual({ id: 'copy', date: isoDate('2031-03-10') }),
      ],
    ),
    ['copy~same-day'],
  );
});

test('a paired Actual transaction outside the period still has its duplicates found', () => {
  // An imported-ID pair is found wherever it is dated.
  assert.deepEqual(
    unpaired(
      [src({ importedId: 'X' })],
      [
        actual({ id: 'moved', imported_id: 'X', date: isoDate('2031-06-30') }),
        actual({ id: 'copy', imported_id: 'X' }),
      ],
    ),
    ['copy~moved'],
  );
});

test('an Actual transaction under another bank reference is no duplicate', () => {
  // The bank says these are two transactions, as it does for pairing (#82).
  assert.deepEqual(
    unpaired(
      [src({ importedId: 'R1' })],
      [
        actual({ id: 'paired', imported_id: 'R1' }),
        actual({ id: 'other', imported_id: 'R2' }),
      ],
    ),
    ['other'],
  );
});
