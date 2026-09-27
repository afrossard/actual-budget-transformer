/**
 * The Tape: one line per source transaction, with the tool's proposal next to
 * it and, for anything it declined, the evidence for the decline.
 *
 * A decline is a decision. Skip and Locked rows get a line and a prompt like
 * every other row, because that is where the tool would be throwing bank data
 * away, and bank data is never dropped on a log line.
 */
import { formatCents } from './money.ts';
import type {
  ActualTransaction,
  ClassifiedRow,
  Evidence,
  RowState,
} from './classify.ts';

const ESC = `${String.fromCharCode(27)}[`;
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

const STYLE: Record<RowState, string> = {
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
      case 'already-imported':
        return [`already in Actual as ${describe(reason.matched)}`];
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

/** The Tape's own line for one classified row. */
export function tapeLine(
  index: number,
  row: ClassifiedRow,
  style: TapeStyle = { colour: false },
): string {
  const { source, state } = row;
  const head =
    `${String(index).padStart(3)} ` +
    `${source.date} ` +
    `${formatCents(source.amountCents)} ` +
    `${paint(state.padEnd(10), STYLE[state], style)} ` +
    source.payee.slice(0, 32).padEnd(32);
  const why = explain(row.reasons);
  if (why.length === 0) return head.trimEnd();
  return `${head} ${paint(`-> ${why.join(' | ')}`, DIM, style)}`;
}

export const TAPE_HEADER =
  '  # date          amount  state      payee                            why';
