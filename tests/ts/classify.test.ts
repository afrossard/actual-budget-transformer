import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ActualTransaction } from '../../src/classify.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

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

let seq = 0;
function actual(over: Partial<ActualTransaction> = {}): ActualTransaction {
  seq += 1;
  return {
    id: `uuid-${seq}`,
    date: '2031-03-10',
    amount: -450,
    imported_id: null,
    payee: null,
    notes: null,
    reconciled: false,
    ...over,
  };
}

test('a source transaction nothing matches is Clean', () => {
  const [row] = classify([src()], [], null);
  assert.equal(row!.bucket, 'clean');
  assert.deepEqual(
    row!.reasons.map((r) => r.kind),
    ['no-match'],
  );
});

test('an imported ID already in Actual is Skip, and names the row it matched', () => {
  const stored = actual({ imported_id: 'T-BANK-1', id: 'stored-1' });
  const [row] = classify([src({ importedId: 'T-BANK-1' })], [stored], null);
  assert.equal(row!.bucket, 'skip');
  const [reason] = row!.reasons;
  assert.ok(reason);
  assert.equal(reason.kind, 'already-imported');
  assert.deepEqual(
    reason.matched.map((t) => t.id),
    ['stored-1'],
  );
});

test('a blank imported ID never matches a blank stored one', () => {
  // Actual rows entered by hand have no imported_id. A reference-less source
  // row must not be silently paired with one of them.
  const handEntry = actual({ imported_id: null });
  const [row] = classify(
    [src({ importedId: '', importedIdOrigin: 'absent', amountCents: -1990 })],
    [handEntry],
    null,
  );
  assert.notEqual(row!.bucket, 'skip');
});

test('same amount within one day is Suspicious, and carries every candidate', () => {
  const near = actual({ date: '2031-03-09', amount: -450, id: 'hand-1' });
  const also = actual({ date: '2031-03-11', amount: -450, id: 'hand-2' });
  const far = actual({ date: '2031-03-13', amount: -450, id: 'hand-3' });
  const other = actual({ date: '2031-03-10', amount: -999, id: 'hand-4' });
  const [row] = classify([src()], [near, also, far, other], null);
  assert.equal(row!.bucket, 'suspicious');
  const reason = row!.reasons.find((r) => r.kind === 'same-amount-within-one-day');
  assert.ok(reason);
  assert.deepEqual(
    reason.candidates.map((c) => c.id),
    ['hand-1', 'hand-2'],
  );
});

test('a candidate that already holds a different imported ID still counts', () => {
  // The cards occurrence counter shifts across overlapping exports, so the
  // same purchase can arrive under a new reference. Our own amount+date check
  // is the only thing that catches it.
  const reExported = actual({ date: '2031-03-10', imported_id: 'OLD-REF', id: 'prev' });
  const [row] = classify([src({ importedId: 'NEW-REF' })], [reExported], null);
  assert.equal(row!.bucket, 'suspicious');
});

test('dated on or before the boundary is Locked', () => {
  const rows = classify(
    [
      src({ date: '2020-06-14' }),
      src({ date: '2020-06-15' }),
      src({ date: '2020-06-16' }),
    ],
    [],
    '2020-06-15',
  );
  assert.deepEqual(
    rows.map((r) => r.bucket),
    ['locked', 'locked', 'clean'],
  );
  const reason = rows[0]!.reasons.find((r) => r.kind === 'inside-reconciled-range');
  assert.ok(reason);
  assert.equal(reason.boundary, '2020-06-15');
});

test('Locked still carries the match evidence a write would touch', () => {
  const stored = actual({ date: '2020-06-15', amount: -450, id: 'locked-match' });
  const [row] = classify([src({ date: '2020-06-15' })], [stored], '2020-06-30');
  assert.equal(row!.bucket, 'locked');
  assert.deepEqual(
    row!.reasons.map((r) => r.kind),
    ['inside-reconciled-range', 'same-amount-within-one-day'],
  );
});

test('Skip wins over Locked, so a re-run of an old file stays quiet', () => {
  const stored = actual({ date: '2020-06-15', imported_id: 'T-OLD' });
  const [row] = classify(
    [src({ date: '2020-06-15', importedId: 'T-OLD' })],
    [stored],
    '2020-06-30',
  );
  assert.equal(row!.bucket, 'skip');
});

test('a source row repeated inside one file is Suspicious, not a silent drop', () => {
  // Two real purchases with identical attributes and no bank reference. The
  // bank's file says two, so the second must reach the human rather than be
  // absorbed by our own dedup.
  const twin = {
    importedId: '',
    importedIdOrigin: 'absent' as const,
    date: '2031-03-20',
    amountCents: -1990,
    payee: 'PHARMACIE CENTRALE',
    notes: '',
  };
  const rows = classify(
    [src({ ...twin, sourceLine: 11 }), src({ ...twin, sourceLine: 12 })],
    [],
    null,
  );
  assert.equal(rows[0]!.bucket, 'clean');
  assert.equal(rows[1]!.bucket, 'suspicious');
  const reason = rows[1]!.reasons.find((r) => r.kind === 'repeated-in-this-file');
  assert.ok(reason);
  assert.equal(reason.firstSeenLine, 11);
});

test('classification does not shift as earlier rows are confirmed', () => {
  // Classify once per batch: five equal-amount consecutive days, with Actual
  // already holding one on 03-09. Only the 03-10 row is near it, and nothing
  // the human does to 03-10 may make 03-11 suspicious.
  const stored = actual({ date: '2031-03-09', amount: -450, id: 'hand-coffee' });
  const days = ['2031-03-10', '2031-03-11', '2031-03-12', '2031-03-13', '2031-03-14'];
  const rows = classify(
    days.map((date) => src({ date })),
    [stored],
    null,
  );
  assert.deepEqual(
    rows.map((r) => r.bucket),
    ['suspicious', 'clean', 'clean', 'clean', 'clean'],
  );
});

test('classify never mutates its inputs', () => {
  const sources = [src()];
  const existing = [actual()];
  const snapshot = JSON.stringify({ sources, existing });
  classify(sources, existing, '2020-01-01');
  assert.equal(JSON.stringify({ sources, existing }), snapshot);
});

test('the row paired by imported ID is not also listed as a blind duplicate', () => {
  // Otherwise a Skip's evidence names the same transaction twice.
  const stored = actual({ imported_id: 'T-X', id: 'stored-x' });
  const [row] = classify([src({ importedId: 'T-X' })], [stored], null);
  assert.equal(row!.bucket, 'skip');
  assert.deepEqual(
    row!.reasons.map((r) => r.kind),
    ['already-imported'],
  );
});

test('a different transaction on the same day is still a blind duplicate of a Skip', () => {
  const paired = actual({ imported_id: 'T-X', id: 'stored-x' });
  const other = actual({ imported_id: null, id: 'stored-y' });
  const [row] = classify([src({ importedId: 'T-X' })], [paired, other], null);
  assert.equal(row!.bucket, 'skip');
  const reason = row!.reasons.find((r) => r.kind === 'same-amount-within-one-day');
  assert.deepEqual(
    reason?.kind === 'same-amount-within-one-day' && reason.candidates.map((c) => c.id),
    ['stored-y'],
  );
});

test('an imported ID is recognised however far the transaction has been moved', () => {
  // The cards parser dates a purchase by `Date d'achat` while the bank books it
  // weeks later, so someone re-dating it in Actual to its booking date puts it a
  // long way from where this tool wrote it. Matching by ID must not care.
  const moved = actual({ date: '2031-06-30', imported_id: 'T-FAR', id: 'moved' });
  const [row] = classify(
    [src({ date: '2031-03-10', importedId: 'T-FAR' })],
    [moved],
    null,
  );
  assert.equal(row!.bucket, 'skip');
});

test('two stored transactions sharing an imported ID are both named, not collapsed', () => {
  // Actual has no uniqueness constraint on imported_id, so this state is
  // reachable, and it is exactly the corruption this tool exists to prevent.
  // Reporting only one of them would let the human decline on half the facts.
  const first = actual({ imported_id: 'SHARED-ID', id: 'first', date: '2031-08-01' });
  const second = actual({ imported_id: 'SHARED-ID', id: 'second', date: '2031-08-02' });
  const [row] = classify([src({ importedId: 'SHARED-ID' })], [first, second], null);
  assert.equal(row!.bucket, 'skip');
  const reason = row!.reasons.find((r) => r.kind === 'already-imported');
  assert.deepEqual(
    reason?.kind === 'already-imported' && reason.matched.map((t) => t.id),
    ['first', 'second'],
  );
});

test('neither of two rows sharing an imported ID is also listed as a blind duplicate', () => {
  const first = actual({ imported_id: 'SHARED-ID', id: 'first' });
  const second = actual({ imported_id: 'SHARED-ID', id: 'second' });
  const [row] = classify([src({ importedId: 'SHARED-ID' })], [first, second], null);
  assert.deepEqual(
    row!.reasons.map((r) => r.kind),
    ['already-imported'],
  );
});
