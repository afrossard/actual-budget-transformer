/**
 * The review loop.
 *
 * Classification has already happened, once, for the whole statement. This
 * prints the statement report, then asks about each unpaired statement
 * transaction in turn, and nothing reaches Actual without a confirmation for
 * that one - including in the reconciled period, where Actual itself enforces
 * nothing. A paired statement transaction is already in Actual and is never
 * asked about; nothing is written for it.
 *
 * Two actions and no more: import it, or leave it (ADR 0003). Correcting an
 * Actual transaction from the bank's data and forcing a second copy had
 * nothing left to act on once only unpaired statement transactions are
 * reviewed.
 */
import type { Classified, UnpairedActual } from './classify.ts';
import {
  block,
  detail,
  DEFAULT_WIDTH,
  report,
  type ReportStyle,
} from './statement-report.ts';
import { formatCents } from './money.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { DroppedRow, Period } from './sources/types.ts';

export type Action = 'import' | 'leave';

/** Every action review offers, in prompt order. */
export const ACTIONS: readonly Action[] = ['import', 'leave'];

/** What actually reached Actual for one statement transaction. */
export type Wrote = 'added' | 'nothing';

export type Outcome = {
  classified: Classified;
  action: Action | 'quit';
  wrote: Wrote;
};

export type ReviewIo = {
  write(line: string): void;
  /**
   * Say what came of the last answer - on the prompt's own line while it is
   * still open, so a decision and its outcome read as one line.
   */
  conclude(outcome: string): void;
  /** Resolves to one of `allowed`. */
  ask(prompt: string, allowed: readonly string[]): Promise<string>;
};

export type ReviewResult = {
  outcomes: Outcome[];
  /** True when the human stopped the run early; the rest is left untouched. */
  stopped: boolean;
};

/** The keystroke and the label for each action. Total, so none can lack one. */
const KEY: Record<Action, string> = { import: 'i', leave: 'l' };
const LABEL: Record<Action, string> = { import: '[i]mport', leave: '[l]eave' };

const PROMPT = `  ${ACTIONS.map((a) => LABEL[a]).join('  ')}  [?] detail  [q]uit > `;

export type ReviewOptions = {
  gateway: ActualGateway;
  accountId: string;
  /** The dates the statement covers. */
  period: Period;
  /** Every statement transaction, paired or not, as the classifier left it. */
  classified: readonly Classified[];
  /** The Actual transactions in the period the statement does not hold. */
  unpaired: readonly UnpairedActual[];
  /** Rows the parser did not turn into transactions, so the report can say so. */
  dropped?: readonly DroppedRow[];
  reconciledThrough: string | null;
  io: ReviewIo;
  style?: ReportStyle | undefined;
};

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const { gateway, accountId, classified, io, reconciledThrough } = options;
  const style = options.style ?? { colour: false, width: DEFAULT_WIDTH };

  io.write('');
  const statement = {
    period: options.period,
    classified,
    unpaired: options.unpaired,
    reconciledThrough,
    dropped: options.dropped ?? [],
  };
  for (const line of report(statement, style)) io.write(line);

  const toReview = classified.filter((c) => c.pair === null);
  const outcomes: Outcome[] = [];
  // Nothing to review: the report has said so, and there is nothing to sum up.
  if (toReview.length === 0) return { outcomes, stopped: false };

  const allowed = [...ACTIONS.map((a) => KEY[a]), '?', 'q'];
  for (const [index, current] of toReview.entries()) {
    io.write('');
    const reviewed = {
      position: index + 1,
      total: toReview.length,
      classified: current,
      warnings: warnings(current),
    };
    for (const line of block(reviewed, style)) io.write(line);

    let answer = await io.ask(PROMPT, allowed);
    while (answer === '?') {
      for (const line of detail(current, style)) io.write(line);
      answer = await io.ask(PROMPT, allowed);
    }

    if (answer === 'q') {
      const left = toReview.length - index;
      io.conclude(`stopped, ${left} left untouched`);
      outcomes.push({ classified: current, action: 'quit', wrote: 'nothing' });
      // A partial run still has to say what it wrote: re-running the file is
      // the resume mechanism, and that only works if what happened is legible.
      printSummary(outcomes, classified, io);
      return { outcomes, stopped: true };
    }

    const action = ACTIONS.find((a) => KEY[a] === answer);
    if (action === undefined) {
      throw new Error(
        `answer ${JSON.stringify(answer)} is not one of the offered actions`,
      );
    }
    outcomes.push(await apply(action, current, gateway, accountId, io));
  }

  printSummary(outcomes, classified, io);
  return { outcomes, stopped: false };
}

async function apply(
  action: Action,
  classified: Classified,
  gateway: ActualGateway,
  accountId: string,
  io: ReviewIo,
): Promise<Outcome> {
  const { source } = classified;
  if (action === 'leave') {
    io.conclude('left, nothing written');
    return { classified, action, wrote: 'nothing' };
  }
  await gateway.add(accountId, {
    date: source.date,
    amountCents: source.amountCents,
    payee: source.payee,
    notes: source.notes,
    importedId: source.importedId,
  });
  await gateway.sync();
  io.conclude(
    source.importedId === ''
      ? 'imported, with no imported ID: the bank wrote no reference'
      : `imported as ${source.importedId}`,
  );
  return { classified, action, wrote: 'added' };
}

/**
 * What has to be said out loud before this statement transaction is answered,
 * one short line each.
 *
 * Dates decide nothing (ADR 0003): a statement transaction dated in the
 * reconciled period is reviewed like any other, because it is most probably
 * one deleted from Actual to be imported again. It is only said out loud,
 * since importing it moves a balance the human has already attested.
 *
 * A pending one is reviewed like any other too (#47), but its amount is not
 * final, so it must not be confirmed as if it were: in another currency it is
 * not even an amount in the account's own.
 */
export function warnings(classified: Classified): string[] {
  const said: string[] = [];
  if (classified.inReconciledPeriod) {
    said.push(
      'dated in your reconciled period: importing it changes a reconciled balance',
    );
  }
  const { pending, amountCents } = classified.source;
  if (pending) {
    const { originalCurrency, accountCurrency } = pending;
    said.push(
      originalCurrency === accountCurrency
        ? 'pending, amount may change when booked'
        : `pending, amount is ${formatCents(Math.abs(amountCents), 0)} ` +
            `${originalCurrency}, not ${accountCurrency}`,
    );
  }
  return said;
}

function printSummary(
  outcomes: readonly Outcome[],
  classified: readonly Classified[],
  io: ReviewIo,
): void {
  const imported = outcomes.filter((o) => o.wrote === 'added').length;
  const already = classified.filter((c) => c.pair !== null).length;
  // Everything reviewed and not imported is left, whether answered or not.
  const left = classified.length - already - imported;
  io.write('');
  io.write(
    // No account name: the run opened with it, and a long one would wrap.
    `${imported} imported, ${left} left, ${already} already in Actual.`,
  );
}
