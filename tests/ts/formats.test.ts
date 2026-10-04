import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../../src/sources/formats.ts';

test('parseDate reads every ordering and separator the formats use', () => {
  assert.equal(parseDate('2031-04-05', '%Y-%m-%d'), '2031-04-05');
  assert.equal(parseDate('05.04.2031', '%d.%m.%Y'), '2031-04-05');
  assert.equal(parseDate(' 04/05/2031 ', '%m/%d/%Y'), '2031-04-05');
});

test('parseDate treats a format character as a literal, not a regex', () => {
  // `.` must match a dot only, or 05x04x2031 would be read as a date.
  assert.equal(parseDate('05x04x2031', '%d.%m.%Y'), null);
  assert.equal(parseDate('2031%04%05', '%Y%%%m%%%d'), '2031-04-05');
});

test('parseDate returns null for a value the format does not describe', () => {
  assert.equal(parseDate('', '%Y-%m-%d'), null);
  assert.equal(parseDate('2031-4-5', '%Y-%m-%d'), null);
  assert.equal(parseDate('2031-04-05 12:00', '%Y-%m-%d'), null);
});

test('parseDate rejects an unsupported directive by name', () => {
  assert.throws(
    () => parseDate('2031-04-05', '%Y-%m-%e'),
    /%e is not one of %Y, %m, %d/,
  );
  assert.throws(() => parseDate('2031-04-05%', '%Y-%m-%d%'), /% is not one of/);
});

test('parseDate rejects a format missing a field', () => {
  assert.throws(() => parseDate('2031-04', '%Y-%m'), /must use all of %Y, %m and %d/);
});

test('parseDate rejects a broken format even when the value does not match it', () => {
  // A config mistake has to surface on the first row, not only on a row that
  // happens to fit the broken format.
  assert.throws(() => parseDate('', '%Y-%m'), /must use all of %Y, %m and %d/);
});

test('parseDate rejects a field used twice rather than silently keeping one', () => {
  assert.throws(
    () => parseDate('2031-2032-04-05', '%Y-%Y-%m-%d'),
    /uses %Y more than once/,
  );
});
