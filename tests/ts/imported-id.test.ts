import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentImportedId,
  forcedImportedId,
  mintFromParts,
  MINTED_PREFIX,
} from '../../src/imported-id.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

const tx: SourceTransaction = {
  date: '2031-03-20',
  amountCents: -1990,
  payee: 'PHARMACIE CENTRALE',
  notes: '',
  importedId: '',
  importedIdOrigin: 'absent',
  sourceLine: 11,
};

test('a minted ID says it was minted', () => {
  assert.match(contentImportedId(tx), new RegExp(`^${MINTED_PREFIX}[0-9a-f]{16}$`));
});

test('minting is reproducible and content-sensitive', () => {
  assert.equal(contentImportedId(tx), contentImportedId({ ...tx, sourceLine: 99 }));
  assert.notEqual(
    contentImportedId(tx),
    contentImportedId({ ...tx, amountCents: -1991 }),
  );
  assert.notEqual(
    contentImportedId(tx),
    contentImportedId({ ...tx, date: '2031-03-21' }),
  );
});

test('forcing builds on the bank reference when there is one', () => {
  const withRef = {
    ...tx,
    importedId: 'T-0004',
    importedIdOrigin: 'bank-reference' as const,
  };
  assert.equal(forcedImportedId(withRef, []), 'T-0004~dup1');
});

test('forcing builds on the content hash when there is no reference', () => {
  assert.equal(forcedImportedId(tx, []), `${contentImportedId(tx)}~dup1`);
});

test('forcing takes the lowest copy index the account does not hold', () => {
  const withRef = {
    ...tx,
    importedId: 'T-0004',
    importedIdOrigin: 'bank-reference' as const,
  };
  assert.equal(forcedImportedId(withRef, ['T-0004', 'T-0004~dup1']), 'T-0004~dup2');
  assert.equal(
    forcedImportedId(withRef, ['T-0004', 'T-0004~dup1', 'T-0004~dup2']),
    'T-0004~dup3',
  );
});

test('a re-run does not force a second copy, because the base ID is the match', () => {
  // After forcing once, Actual holds T-0004 and T-0004~dup1. The next run sees
  // the row's own T-0004 and reports Skip; nothing re-forces on its own.
  const withRef = {
    ...tx,
    importedId: 'T-0004',
    importedIdOrigin: 'bank-reference' as const,
  };
  assert.equal(forcedImportedId(withRef, ['T-0004', 'T-0004~dup1']), 'T-0004~dup2');
});

test('a separator inside a field cannot collide two different transactions', () => {
  // A plain join on "|" flattens ['A|B','C'] and ['A','B|C'] to the same string,
  // so two different transactions would mint one imported ID - and the second
  // would then come back as Skip, "already in Actual", on a later run.
  assert.notEqual(mintFromParts(['A|B', 'C']), mintFromParts(['A', 'B|C']));
  assert.notEqual(mintFromParts(['', 'A']), mintFromParts(['A', '']));
  assert.notEqual(mintFromParts(['A"B']), mintFromParts(['A\\"B']));
});

test('a separator inside a payee cannot collide two source transactions', () => {
  const base = {
    date: '2031-03-20',
    amountCents: -1990,
    importedId: '',
    importedIdOrigin: 'absent' as const,
    sourceLine: 1,
  };
  assert.notEqual(
    contentImportedId({ ...base, payee: 'A|B', notes: 'C' }),
    contentImportedId({ ...base, payee: 'A', notes: 'B|C' }),
  );
});

test('minting stays stable for the ordinary case', () => {
  // A regression guard on the encoding itself: if this changes, every minted ID
  // changes, every transaction already written stops matching, and a re-run
  // proposes the lot again. Only ever change it deliberately.
  assert.equal(
    mintFromParts(['23.02.2020', 'MERCHANT-30A2B4C6', '30', 'EUR', 0]),
    'abt1-1567b00a76b98372',
  );
});
