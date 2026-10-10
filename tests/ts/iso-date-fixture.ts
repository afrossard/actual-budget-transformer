import assert from 'node:assert/strict';
import { toIsoDate, type IsoDate } from '../../src/iso-date.ts';

/** A date a test writes by hand, checked: a typo fails the test, not the type. */
export function isoDate(value: string): IsoDate {
  const date = toIsoDate(value);
  assert.ok(date !== null, `${value} is not a YYYY-MM-DD calendar date`);
  return date;
}
