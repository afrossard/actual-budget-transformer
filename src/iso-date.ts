/**
 * A calendar date written `YYYY-MM-DD`: Actual's own representation, and one
 * that sorts chronologically under `<` (#111).
 *
 * A string rather than a `Date`, because a statement date is a day, not an
 * instant, and a `Date` would force a timezone decision the data does not
 * contain. Branded so that the compiler refuses a date string nobody checked:
 * `toIsoDate` is the only way to make one.
 */
export type IsoDate = string & { readonly __isoDate: unique symbol };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The value as an IsoDate, or null when it is not one: the wrong shape, or a
 * day the calendar does not have. `2031-02-30` is refused rather than rolled
 * over to 2 March, because a date read wrongly is worse than a date not read.
 */
export function toIsoDate(value: string): IsoDate | null {
  const match = ISO_DATE.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(0);
  // Not `Date.UTC`, which reads years 0-99 as 1900-1999.
  date.setUTCFullYear(year, month - 1, day);
  return formatUtc(date) === value ? (value as IsoDate) : null;
}

/** The date `days` later, or earlier when negative. */
export function shiftDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return formatUtc(shifted) as IsoDate;
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}
