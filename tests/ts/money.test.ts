import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCents,
  parseCents,
  readAmount,
  signedAmountCents,
} from '../../src/money.ts';

test('parseCents reads bank decimals exactly', () => {
  assert.equal(parseCents('186.65'), 18665);
  assert.equal(parseCents('-186.65'), -18665);
  assert.equal(parseCents('41'), 4100);
  assert.equal(parseCents('0.05'), 5);
  assert.equal(parseCents('21.62'), 2162);
  assert.equal(parseCents(''), 0);
  assert.equal(parseCents('  1234.55 '), 123455);
});

test('parseCents avoids float drift', () => {
  // 18.65 * 100 is 1864.9999999999998 in binary floating point.
  assert.equal(parseCents('18.65'), 1865);
  assert.equal(parseCents('0.29'), 29);
  assert.equal(parseCents('1.005'), 101);
  assert.equal(parseCents('-1.005'), -101);
});

test('parseCents rejects what is not an amount', () => {
  assert.throws(() => parseCents('abc'), /not a decimal amount/);
  assert.throws(() => parseCents('1.2.3'), /not a decimal amount/);
});

test('signedAmountCents lets the column decide the sign', () => {
  // UBS account CSV: the debit already carries its minus.
  assert.equal(signedAmountCents('-186.65', ''), -18665);
  // UBS cards CSV: the debit is a bare magnitude.
  assert.equal(signedAmountCents('41', ''), -4100);
  assert.equal(signedAmountCents('', '50'), 5000);
  assert.equal(signedAmountCents('', '6500.00'), 650000);
});

test('signedAmountCents reports a row with no amount rather than calling it zero', () => {
  assert.equal(signedAmountCents('', ''), null);
  // An explicit zero is an amount, and a filled column is what "filled" means.
  assert.equal(signedAmountCents('0', ''), 0);
  assert.equal(signedAmountCents('', '0.00'), 0);
});

test('signedAmountCents refuses a row that is both', () => {
  assert.throws(() => signedAmountCents('10', '20'), /both a debit/);
});

test('formatCents right-aligns two decimals', () => {
  assert.equal(formatCents(-18665), '   -186.65');
  assert.equal(formatCents(5), '      0.05');
  assert.equal(formatCents(650000), '   6500.00');
});

test('readAmount reports an unreadable amount instead of throwing', () => {
  assert.deepEqual(readAmount('-186.65', ''), { cents: -18665 });
  assert.deepEqual(readAmount('', ''), { empty: true });
  assert.deepEqual(readAmount('186.65 CHF', ''), {
    problem: 'not a decimal amount: "186.65 CHF"',
  });
  assert.match((readAmount('10', '20') as { problem: string }).problem, /both a debit/);
});

test('parseCents agrees with Actual on every amount a bank writes', () => {
  // Actual's own `api.utils.amountToInteger` is `Math.round(amount * 100)`. This
  // pins the agreement without importing the api into a parser test: if the two
  // ever diverge on bank-shaped input, the divergence should be deliberate.
  const actualAmountToInteger = (amount: number): number => Math.round(amount * 100);
  for (const written of [
    '186.65',
    '-186.65',
    '18.65',
    '0.29',
    '41',
    '0.05',
    '1234.55',
    '6500.00',
    '21.62',
    '0',
  ]) {
    assert.equal(
      parseCents(written),
      actualAmountToInteger(Number(written)),
      `disagreed on ${written}`,
    );
  }
});
