/**
 * Writing what the statement holds and Actual does not, unattended or under
 * review: the corrections, then the unpaired statement transactions.
 *
 * Classification has already happened, once, for the whole statement. This
 * prints the statement report, then makes each correction (ADR 0007) and
 * writes each unpaired statement transaction. Unattended, it does both without
 * asking, except where a balance already reconciled would change: a statement
 * transaction dated before the reconciled-through date is left out (ADR 0005),
 * and a reconciled Actual transaction is left uncorrected, since Actual itself
 * enforces nothing there. Under review it asks about each one in turn, those
 * included, and writes only what the human confirms. A split is never
 * corrected, either way: which part absorbs the difference is the human's
 * choice. A paired statement transaction is otherwise already in Actual, and
 * nothing is written for it.
 *
 * Review offers two actions for each and no more: import or correct it, or
 * leave it (ADR 0003, ADR 0007).
 */
import {
  correctionOf,
  type Classified,
  type Correction,
  type UnpairedActual,
} from './classify.ts';
import {
  block,
  corrects,
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

export type Action = 'import' | 'correct' | 'leave';

/**
 * What one outcome is about: writing an unpaired statement transaction, or
 * correcting a paired one's amount in Actual.
 */
export type Kind = 'write' | 'correction';

/** The actions review offers for each kind, in prompt order. */
export const OFFERED: Record<Kind, readonly Action[]> = {
  write: ['import', 'leave'],
  correction: ['correct', 'leave'],
};

/** What actually reached Actual for one statement transaction. */
export type Wrote = 'added' | 'corrected' | 'nothing';

export type Outcome = {
  classified: Classified;
  kind: Kind;
  /**
   * `left-out`: not asked about. A write unattended and dated in the
   * reconciled period; a correction of a split, or unattended of a reconciled
   * Actual transaction.
   */
  action: Action | 'quit' | 'left-out';
  wrote: Wrote;
  /** Why a correction was left out, so the summary need not work it out again. */
  held?: NonNullable<Correction['hold']>;
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
 * Whether every statement transaction is in Actual as the bank has it, or is
 * missing from it by the human's own answer: false after a quit, with one left
 * out for being in the reconciled period, or with a correction not made for
 * whatever reason, a human leaving it included - Actual's balance then
 * disagrees with the bank's (ADR 0007), where a write left only lacks a
 * transaction the human chose not to have.
 */
export function complete(result: ImportResult): boolean {
  return (
    !result.stopped &&
    result.outcomes.every(
      (o) =>
        o.action !== 'left-out' && !(o.kind === 'correction' && o.wrote === 'nothing'),
    )
  );
}

/** The keystroke and the label for each action. Total, so none can lack one. */
const KEY: Record<Action, string> = { import: 'i', correct: 'c', leave: 'l' };
const LABEL: Record<Action, string> = {
  import: '[i]mport',
  correct: '[c]orrect',
  leave: '[l]eave',
};

const prompt = (kind: Kind): string =>
  `  ${OFFERED[kind].map((a) => LABEL[a]).join('  ')}  [?] detail  [q]uit > `;

/** One thing to do: write a statement transaction, or correct its pair. */
type Step = { kind: Kind; classified: Classified };

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

export async function importStatement(options: ImportOptions): Promise<ImportResult> {
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

  const outcomes: Outcome[] = [];
  const steps: Step[] = [];
  // Corrections first, as the report lists them first.
  for (const c of classified) {
    const correction = correctionOf(c);
    if (correction === null) continue;
    if (correction.hold === null || corrects(correction, mode))
      steps.push({ kind: 'correction', classified: c });
    else
      outcomes.push({
        classified: c,
        kind: 'correction',
        action: 'left-out',
        wrote: 'nothing',
        held: correction.hold,
      });
  }
  for (const c of classified) {
    if (c.pair === null) steps.push({ kind: 'write', classified: c });
  }
  // Nothing to do: the report has said so, and there is nothing to sum up.
  if (steps.length === 0 && outcomes.length === 0) return { outcomes, stopped: false };

  const context = { gateway, accountId, mode, io };
  try {
    let stopped = false;
    if (mode === 'review') stopped = await reviewEach(steps, outcomes, context, style);
    else await doUnattended(steps, outcomes, context);
    printSummary(outcomes, classified, mode, io);
    return { outcomes, stopped };
  } catch (error) {
    // A failed write stops the run, and what was written before it still has
    // to be said: re-running the file is the resume mechanism.
    printSummary(outcomes, classified, mode, io);
    throw error;
  }
}

/** What a step needs to reach Actual. */
type StepContext = {
  gateway: ActualGateway;
  accountId: AccountId;
  mode: Mode;
  io: ReviewIo;
};

/** Do every step, except a write in the reconciled period. */
async function doUnattended(
  steps: readonly Step[],
  outcomes: Outcome[],
  context: StepContext,
): Promise<void> {
  for (const { kind, classified } of steps) {
    if (kind === 'write' && classified.inReconciledPeriod) {
      outcomes.push({ classified, kind, action: 'left-out', wrote: 'nothing' });
      continue;
    }
    outcomes.push(
      await apply(kind === 'write' ? 'import' : 'correct', kind, classified, context),
    );
  }
}

/** Ask about each step in turn; true when the human quit. */
async function reviewEach(
  steps: readonly Step[],
  outcomes: Outcome[],
  context: StepContext,
  style: ReportStyle,
): Promise<boolean> {
  const { io } = context;
  for (const [index, { kind, classified }] of steps.entries()) {
    io.write('');
    const reviewed = {
      position: index + 1,
      total: steps.length,
      classified,
      warnings: warnings(classified),
    };
    for (const line of block(reviewed, style)) io.write(line);

    const offered = OFFERED[kind];
    const allowed = [...offered.map((a) => KEY[a]), '?', 'q'];
    let answer = await io.ask(prompt(kind), allowed);
    while (answer === '?') {
      for (const line of detail(classified, style)) io.write(line);
      answer = await io.ask(prompt(kind), allowed);
    }

    if (answer === 'q') {
      const left = steps.length - index;
      io.conclude(`stopped, ${left} left untouched`);
      outcomes.push({ classified, kind, action: 'quit', wrote: 'nothing' });
      // A correction not reached is still one Actual needs, and is counted so.
      for (const rest of steps.slice(index + 1)) {
        if (rest.kind === 'correction') {
          outcomes.push({ ...rest, action: 'quit', wrote: 'nothing' });
        }
      }
      return true;
    }

    const action = offered.find((a) => KEY[a] === answer);
    if (action === undefined) {
      throw new Error(
        `answer ${JSON.stringify(answer)} is not one of the offered actions`,
      );
    }
    outcomes.push(await apply(action, kind, classified, context));
  }
  return false;
}

async function apply(
  action: Action,
  kind: Kind,
  classified: Classified,
  { gateway, accountId, mode, io }: StepContext,
): Promise<Outcome> {
  const { source, pair } = classified;
  if (action === 'leave') {
    io.conclude('left, nothing written');
    return { classified, kind, action, wrote: 'nothing' };
  }
  if (action === 'correct') {
    if (pair === null) throw new Error(`#${classified.number} has no pair to correct`);
    await gateway.correctAmount(accountId, pair.actual, source.amountCents, {
      // Under review a correction is made only once the human confirmed it.
      reconciledConfirmed: mode === 'review',
    });
    await gateway.sync();
    if (mode === 'review')
      io.conclude(`corrected to ${formatCents(source.amountCents).trim()}`);
    return { classified, kind, action, wrote: 'corrected' };
  }
  await gateway.add(accountId, {
    date: source.date,
    amountCents: source.amountCents,
    payee: source.payee,
    notes: source.notes,
    importedId: source.importedId,
  });
  await gateway.sync();
  if (mode === 'review') {
    io.conclude(
      source.importedId === ''
        ? 'imported, with no imported ID: the bank wrote no reference'
        : `imported as ${source.importedId}`,
    );
  }
  return { classified, kind, action, wrote: 'added' };
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
 *
 * A paired one is reviewed only for its correction, which never comes from a
 * pending one; correcting a reconciled Actual transaction is said out loud for
 * the same reason as importing into the reconciled period.
 */
export function warnings(classified: Classified): string[] {
  if (classified.pair !== null) {
    return classified.pair.actual.reconciled === true
      ? ['reconciled in Actual: correcting it changes a reconciled balance']
      : [];
  }
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

/**
 * What came of a statement's outcomes, counted the way the summaries say it.
 * `paired` is how many statement transactions paired; a corrected one and one
 * still to fix are counted as such rather than as already in Actual, so the
 * counts add up to the statement's.
 */
export function counted(
  outcomes: readonly Outcome[],
  paired: number,
): {
  imported: number;
  corrected: number;
  /** Writes left out for being in the reconciled period. */
  leftOut: number;
  /** Corrections not made, for whatever reason: Actual still needs fixing. */
  toFix: number;
  /** Paired, and nothing about them to correct. */
  already: number;
} {
  const count = (keep: (o: Outcome) => boolean): number => outcomes.filter(keep).length;
  const corrected = count((o) => o.wrote === 'corrected');
  const toFix = count((o) => o.kind === 'correction' && o.wrote === 'nothing');
  return {
    imported: count((o) => o.wrote === 'added'),
    corrected,
    leftOut: count((o) => o.kind === 'write' && o.action === 'left-out'),
    toFix,
    already: paired - corrected - toFix,
  };
}

function printSummary(
  outcomes: readonly Outcome[],
  classified: readonly Classified[],
  mode: Mode,
  io: ReviewIo,
): void {
  const paired = classified.filter((c) => c.pair !== null).length;
  const { imported, corrected, leftOut, toFix, already } = counted(outcomes, paired);
  // Under review, everything not imported is left, whether answered or not.
  const left = classified.length - paired - imported;
  io.write('');
  // No account name: the run opened with it, and a long one would wrap.
  io.write(
    [
      `${imported} imported`,
      ...(corrected > 0 ? [`${corrected} corrected`] : []),
      ...(mode === 'review'
        ? [`${left} left`]
        : leftOut > 0
          ? [`${leftOut} left out`]
          : []),
      ...(toFix > 0 ? [`${toFix} to fix in Actual`] : []),
      `${already} already in Actual.`,
    ].join(', '),
  );
  if (mode === 'review') return;
  if (leftOut > 0) io.write('Run again with --review to import what was left out.');
  if (outcomes.some((o) => o.held === 'reconciled'))
    io.write('Run again with --review to correct what is reconciled.');
}
