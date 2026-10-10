import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftDays, toIsoDate } from '../../src/iso-date.ts';

test('toIsoDate accepts a calendar date written YYYY-MM-DD', () => {
  assert.equal(toIsoDate('2031-04-05'), '2031-04-05');
  assert.equal(toIsoDate('2032-02-29'), '2032-02-29');
  assert.equal(toIsoDate('1000-01-01'), '1000-01-01');
  assert.equal(toIsoDate('9999-12-31'), '9999-12-31');
});

test('toIsoDate rejects a value of the wrong shape', () => {
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate('05.04.2031'), null);
  assert.equal(toIsoDate('2031-4-5'), null);
  assert.equal(toIsoDate(' 2031-04-05'), null);
  assert.equal(toIsoDate('2031-04-05T00:00:00Z'), null);
});

test('toIsoDate rejects a date that does not exist rather than rolling it over', () => {
  assert.equal(toIsoDate('2031-13-45'), null);
  assert.equal(toIsoDate('2031-02-30'), null);
  assert.equal(toIsoDate('2031-02-29'), null);
  assert.equal(toIsoDate('2031-04-00'), null);
  assert.equal(toIsoDate('2031-00-10'), null);
});

test('shiftDays moves a date across month and year ends', () => {
  const date = toIsoDate('2031-12-30')!;
  assert.equal(shiftDays(date, 3), '2032-01-02');
  assert.equal(shiftDays(date, -30), '2031-11-30');
  assert.equal(shiftDays(toIsoDate('2032-03-01')!, -1), '2032-02-29');
});
