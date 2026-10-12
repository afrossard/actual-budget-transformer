/**
 * Writing the unpaired statement transactions, unattended or under review.
 *
 * Classification has already happened, once, for the whole statement. This
 * prints the statement report, then writes each unpaired statement
 * transaction. Unattended, it writes every one without asking except one dated
 * before the reconciled-through date, which it leaves out: Actual itself
 * enforces nothing there, and writing it changes a balance already reconciled
 * (ADR 0005). Under review it asks about each one in turn, those included, and
 * writes only what the human confirms. A paired statement transaction is
 * already in Actual and nothing is written for it either way.
 *
 * Review has two actions and no more: import it, or leave it (ADR 0003).
 * Correcting an Actual transaction from the bank's data and forcing a second
 * copy had nothing left to act on once only unpaired statement transactions
 * are reviewed.
 */
import type { Classified, UnpairedActual } from './classify.ts';
import {
  block,
  detail,
  DEFAULT_WIDTH,
  report,
  type Mode,
  type ReportStyle,
} from './statement-report.ts';
import { formatCents } from './money.ts';
import type { AccountId, ActualGateway } from './actual-gateway.ts';
import type { DroppedRow, Period } from './sources/types.ts';
import type { IsoDate } from './iso-date.ts';

export type Action = 'import' | 'leave';

/** Every action review offers, in prompt order. */
export const ACTIONS: readonly Action[] = ['import', 'leave'];

/** What actually reached Actual for one statement transaction. */
export type Wrote = 'added' | 'nothing';

export type Outcome = {
  classified: Classified;
  /** `left-out`: unattended, and dated in the reconciled period. */
  action: Action | 'quit' | 'left-out';
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

export type ImportResult = {
  outcomes: Outcome[];
  /** True when the human stopped the run early; the rest is left untouched. */
  stopped: boolean;
};

/**
 * Whether every statement transaction is in Actual or was left by the human's
 * own answer: false after a quit, or with one left out for being in the
 * reconciled period, which only a run under review can write.
 */
export function complete(result: ImportResult): boolean {
  return !result.stopped && result.outcomes.every((o) => o.action !== 'left-out');
}

/** The keystroke and the label for each action. Total, so none can lack one. */
const KEY: Record<Action, string> = { import: 'i', leave: 'l' };
const LABEL: Record<Action, string> = { import: '[i]mport', leave: '[l]eave' };

const PROMPT = `  ${ACTIONS.map((a) => LABEL[a]).join('  ')}  [?] detail  [q]uit > `;

export type ImportOptions = {
  /** Unattended, or asking about each one. */
  mode: Mode;
  gateway: ActualGateway;
  accountId: AccountId;
  /** The dates the statement covers. */
  period: Period;
  /** Every statement transaction, paired or not, as the classifier left it. */
  classified: readonly Classified[];
  /** The Actual transactions in the period, or holding one of its imported IDs, that the statement does not hold. */
  unpaired: readonly UnpairedActual[];
  /** Rows the parser did not turn into transactions, so the report can say so. */
  dropped?: readonly DroppedRow[];
  reconciledThrough: IsoDate | null;
  io: ReviewIo;
  style?: ReportStyle | undefined;
};

export async function importUnpaired(options: ImportOptions): Promise<ImportResult> {
  const { gateway, accountId, classified, io, reconciledThrough, mode } = options;
  const style = options.style ?? { colour: false, width: DEFAULT_WIDTH };

  io.write('');
  const statement = {
    period: options.period,
    classified,
    unpaired: options.unpaired,
    reconciledThrough,
    dropped: options.dropped ?? [],
    mode,
  };
  for (const line of report(statement, style)) io.write(line);

  const notInActual = classified.filter((c) => c.pair === null);
  const outcomes: Outcome[] = [];
  // Nothing to write: the report has said so, and there is nothing to sum up.
  if (notInActual.length === 0) return { outcomes, stopped: false };

  try {
    let stopped = false;
    if (mode === 'review')
      stopped = await reviewEach(notInActual, outcomes, gateway, accountId, io, style);
    else await writeUnattended(notInActual, outcomes, gateway, accountId);
    printSummary(outcomes, classified, mode, io);
    return { outcomes, stopped };
  } catch (error) {
    // A failed write stops the run, and what was written before it still has
    // to be said: re-running the file is the resume mechanism.
    printSummary(outcomes, classified, mode, io);
    throw error;
  }
}

/** Write every one, except one in the reconciled period. */
async function writeUnattended(
  notInActual: readonly Classified[],
  outcomes: Outcome[],
  gateway: ActualGateway,
  accountId: AccountId,
): Promise<void> {
  for (const current of notInActual) {
    if (current.inReconciledPeriod) {
      outcomes.push({ classified: current, action: 'left-out', wrote: 'nothing' });
      continue;
    }
    await add(current, gateway, accountId);
    outcomes.push({ classified: current, action: 'import', wrote: 'added' });
  }
}

/** Ask about each one in turn; true when the human quit. */
async function reviewEach(
  toReview: readonly Classified[],
  outcomes: Outcome[],
  gateway: ActualGateway,
  accountId: AccountId,
  io: ReviewIo,
  style: ReportStyle,
): Promise<boolean> {
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
      return true;
    }

    const action = ACTIONS.find((a) => KEY[a] === answer);
    if (action === undefined) {
      throw new Error(
        `answer ${JSON.stringify(answer)} is not one of the offered actions`,
      );
    }
    outcomes.push(await apply(action, current, gateway, accountId, io));
  }
  return false;
}

async function apply(
  action: Action,
  classified: Classified,
  gateway: ActualGateway,
  accountId: AccountId,
  io: ReviewIo,
): Promise<Outcome> {
  const { source } = classified;
  if (action === 'leave') {
    io.conclude('left, nothing written');
    return { classified, action, wrote: 'nothing' };
  }
  await add(classified, gateway, accountId);
  io.conclude(
    source.importedId === ''
      ? 'imported, with no imported ID: the bank wrote no reference'
      : `imported as ${source.importedId}`,
  );
  return { classified, action, wrote: 'added' };
}

async function add(
  { source }: Classified,
  gateway: ActualGateway,
  accountId: AccountId,
): Promise<void> {
  await gateway.add(accountId, {
    date: source.date,
    amountCents: source.amountCents,
    payee: source.payee,
    notes: source.notes,
    importedId: source.importedId,
  });
  await gateway.sync();
}

/**
 * What has to be said out loud before this statement transaction is answered,
 * one short line each.
 *
 * Under review, a statement transaction dated in the reconciled period is
 * asked about like any other, because it is most probably one deleted from
 * Actual to be imported again. It is said out loud, since importing it moves a
 * balance the human has already attested.
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
  mode: Mode,
  io: ReviewIo,
): void {
  const imported = outcomes.filter((o) => o.wrote === 'added').length;
  const already = classified.filter((c) => c.pair !== null).length;
  io.write('');
  // No account name: the run opened with it, and a long one would wrap.
  if (mode === 'review') {
    // Everything reviewed and not imported is left, whether answered or not.
    const left = classified.length - already - imported;
    io.write(`${imported} imported, ${left} left, ${already} already in Actual.`);
    return;
  }
  const leftOut = outcomes.filter((o) => o.action === 'left-out').length;
  io.write(
    `${imported} imported, ` +
      (leftOut > 0 ? `${leftOut} left out, ` : '') +
      `${already} already in Actual.`,
  );
  if (leftOut > 0) io.write('Run again with --review to import what was left out.');
}
