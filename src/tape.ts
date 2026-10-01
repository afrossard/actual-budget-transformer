/**
 * The Tape: one line per source transaction, with the tool's proposal next to
 * it and, for anything it declined, the evidence for the decline.
 *
 * A decline is a decision. Skip and Locked rows get a line and a prompt like
 * every other row, because that is where the tool would be throwing bank data
 * away, and bank data is never dropped on a log line.
 */
import { formatCents } from './money.ts';
import type { ActualTransaction, ClassifiedRow, Evidence, Bucket } from './classify.ts';

const ESC = `${String.fromCharCode(27)}[`;
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

const STYLE: Record<Bucket, string> = {
  clean: `${ESC}32m`, // green: nothing in the way
  suspicious: `${ESC}33m`, // yellow: something is
  skip: DIM, // dim: already done
  locked: `${ESC}35m`, // magenta: inside the reconciled range
};

export type TapeStyle = { colour: boolean };

function paint(text: string, code: string, style: TapeStyle): string {
  return style.colour ? `${code}${text}${RESET}` : text;
}

/** How a stored transaction is named in evidence: enough to recognise it. */
export function describe(tx: ActualTransaction): string {
  const flags = [tx.is_parent ? 'split' : '', tx.reconciled ? 'reconciled' : '']
    .filter((f) => f !== '')
    .join(' ');
  const label = [tx.payeeName ?? '', tx.notes ?? '']
    .filter((p) => p !== '')
    .join(' / ');
  return (
    `${tx.date} ${formatCents(tx.amount).trim()}` +
    (flags === '' ? '' : ` ${flags}`) +
    (label === '' ? '' : ` "${label}"`)
  );
}

/** One phrase per reason, in the order the classifier ranked them. */
export function explain(reasons: readonly Evidence[]): string[] {
  return reasons.flatMap((reason) => {
    switch (reason.kind) {
      case 'already-imported': {
        const [only, ...more] = reason.matched;
        if (more.length === 0) return [`already in Actual as ${describe(only)}`];
        // Not a tie to break: one imported ID held twice is corruption in
        // Actual, and fixing it there is likely the right action.
        return [
          `already in Actual as ${reason.matched.length} transactions sharing this imported ID: ` +
            reason.matched.map(describe).join('; '),
        ];
      }
      case 'inside-reconciled-range':
        return [
          `on or before the reconciliation boundary ${reason.boundary}` +
            (reason.matched ? `, near ${describe(reason.matched)}` : ''),
        ];
      case 'same-amount-within-one-day':
        return [
          `same amount within a day of ${reason.candidates.length} transaction(s): ` +
            reason.candidates.map(describe).join('; '),
        ];
      case 'repeated-in-this-file':
        return [`identical to the row on line ${reason.firstSeenLine} of this file`];
      case 'no-match':
        return [];
    }
  });
}

/**
 * The Tape's column widths, single-sourced.
 *
 * The header is built from these rather than written out, because a header whose
 * labels sit a column off the fields they name is the kind of thing that stays
 * wrong for a long time.
 */
const WIDTH = {
  index: 3,
  date: 10,
  /** Right-aligned, so `formatCents`'s own width has to match. */
  amount: 10,
  bucket: 10,
  payee: 32,
} as const;

/** The Tape's own line for one classified row. */
export function tapeLine(
  index: number,
  row: ClassifiedRow,
  style: TapeStyle = { colour: false },
): string {
  const { source, bucket } = row;
  const head = [
    String(index).padStart(WIDTH.index),
    source.date.padEnd(WIDTH.date),
    formatCents(source.amountCents, WIDTH.amount),
    paint(bucket.padEnd(WIDTH.bucket), STYLE[bucket], style),
    source.payee.slice(0, WIDTH.payee).padEnd(WIDTH.payee),
  ].join(' ');
  const why = explain(row.reasons);
  if (why.length === 0) return head.trimEnd();
  return `${head} ${paint(`-> ${why.join(' | ')}`, DIM, style)}`;
}

export const TAPE_HEADER = [
  '#'.padStart(WIDTH.index),
  'date'.padEnd(WIDTH.date),
  'amount'.padStart(WIDTH.amount),
  'bucket'.padEnd(WIDTH.bucket),
  'payee'.padEnd(WIDTH.payee),
  'why',
].join(' ');
