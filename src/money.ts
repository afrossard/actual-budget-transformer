/**
 * Money is integer cents everywhere past the parsers, which is Actual's own
 * representation. Amounts are parsed straight from the decimal strings the
 * bank writes rather than through a float, so `18.65` is exactly 1865 and not
 * 1864.9999999999998.
 */

/** Parse a bank-written decimal like `-186.65` or `41` into integer cents. */
export function parseCents(raw: string): number {
  const text = raw.trim().replace(/'/g, '').replace(/\s/g, '');
  if (text === '') return 0;
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(text);
  if (!m || (m[2] === '' && m[3] === undefined)) {
    throw new Error(`not a decimal amount: ${JSON.stringify(raw)}`);
  }
  const [, sign, whole, fraction = ''] = m;
  // Bank files carry at most two decimals; round anything longer half-up on
  // the magnitude so the sign never changes the rounding direction.
  const padded = (fraction + '00').slice(0, 3);
  const cents = Number(whole || '0') * 100 + Number(padded.slice(0, 2));
  const rounded = cents + (Number(padded[2]) >= 5 ? 1 : 0);
  return sign === '-' ? -rounded : rounded;
}

/**
 * Turn a bank's debit/credit column pair into one signed amount.
 *
 * A debit is an outflow and a credit is an inflow, whatever sign the file
 * puts on the number: the UBS account CSV writes its debits already negative
 * (`-186.65`) while the cards CSV writes them as bare magnitudes (`41`). Both
 * mean money left the account, so the column decides the sign and the value
 * only supplies the magnitude.
 *
 * `null` means neither column was filled in at all, which is a real state - a
 * card purchase whose converted amount is not final yet - and distinct from an
 * amount of zero.
 */
export function signedAmountCents(debit: string, credit: string): number | null {
  const hasDebit = debit.trim() !== '';
  const hasCredit = credit.trim() !== '';
  if (!hasDebit && !hasCredit) return null;
  const outflow = hasDebit ? Math.abs(parseCents(debit)) : 0;
  const inflow = hasCredit ? Math.abs(parseCents(credit)) : 0;
  if (outflow !== 0 && inflow !== 0) {
    throw new Error(`row carries both a debit (${debit}) and a credit (${credit})`);
  }
  return inflow - outflow;
}

/**
 * `signedAmountCents` as a result rather than an exception, so a parser can
 * record one unreadable row and carry on.
 *
 * Aborting the file would be worse on both counts: the message names neither the
 * file nor the line the reader has to go and look at, and one odd row is no
 * reason to abandon the other twenty.
 */
export type AmountReading =
  | { cents: number }
  /** Neither column was filled in. What that means is the format's to say. */
  | { empty: true }
  | { problem: string };

export function readAmount(debit: string, credit: string): AmountReading {
  try {
    const cents = signedAmountCents(debit, credit);
    return cents === null ? { empty: true } : { cents };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Right-aligned two-decimal rendering for the Tape, e.g. `   -186.65`. */
export function formatCents(cents: number, width = 10): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const text = `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return text.padStart(width);
}
