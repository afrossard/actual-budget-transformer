/**
 * The review loop.
 *
 * Classification has already happened, once, for the whole batch. This walks
 * the Tape and prompts on **every** row, and nothing reaches Actual without a
 * confirmation for that row - including inside the reconciled range, where
 * Actual itself enforces nothing (`updateTransaction` patches a reconciled
 * transaction without complaint and leaves `reconciled` true, so the guard is
 * ours).
 *
 * Four actions and no more: import, correct the matched transaction in place,
 * leave it, force a separate transaction.
 */
import type { ActualTransaction, ClassifiedRow } from './classify.ts';
import { forcedImportedId } from './imported-id.ts';
import { formatCents } from './money.ts';
import { describe, explain, tapeLine, TAPE_HEADER, type TapeStyle } from './tape.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { DroppedRow } from './sources/types.ts';

export type Action = 'import' | 'correct' | 'leave' | 'force';

/** What actually reached Actual for one row. */
export type Wrote = 'added' | 'corrected' | 'forced' | 'nothing';

export type RowOutcome = {
  row: ClassifiedRow;
  action: Action | 'quit';
  wrote: Wrote;
  /** Set when the human asked for a write and the tool declined to make it. */
  refusal?: string;
};

export type ReviewIo = {
  write(line: string): void;
  /** Resolves to one of `allowed`. */
  ask(prompt: string, allowed: readonly string[]): Promise<string>;
};

export type ReviewResult = {
  outcomes: RowOutcome[];
  /** True when the human stopped the run early; the rest is left untouched. */
  stopped: boolean;
};

/** Every stored transaction the evidence names, most relevant first. */
function candidates(row: ClassifiedRow): ActualTransaction[] {
  const seen = new Set<string>();
  const targets: ActualTransaction[] = [];
  const add = (tx: ActualTransaction | null): void => {
    if (tx && !seen.has(tx.id)) {
      seen.add(tx.id);
      targets.push(tx);
    }
  };
  for (const reason of row.reasons) {
    if (reason.kind === 'already-imported') add(reason.matched);
    if (reason.kind === 'inside-reconciled-range') add(reason.matched);
    if (reason.kind === 'same-amount-within-one-day') reason.candidates.forEach(add);
  }
  return targets;
}

/**
 * Every stored transaction this row could correct, most relevant first.
 *
 * `corrected` holds what earlier rows in this run have already corrected, and
 * those are not offered again. A second correction would overwrite the first
 * row's imported ID, and that row would come back Clean on the next run and be
 * written as a duplicate. Classification runs once per batch, so the evidence
 * cannot know about this run's own writes; this is where they are counted.
 */
export function correctionTargets(
  row: ClassifiedRow,
  corrected: ReadonlySet<string> = new Set(),
): ActualTransaction[] {
  return candidates(row).filter((tx) => !corrected.has(tx.id));
}

/**
 * How many candidates a correction can still be pointed at.
 *
 * The prompt takes a single keystroke, so `10` cannot be typed. Rather than
 * silently showing nine of eleven candidates, `correct` is withheld above this
 * and the row says why - a row with that many equal-amount neighbours on one day
 * is not one to resolve from a one-line prompt anyway.
 */
export const MAX_CORRECTION_CHOICES = 9;

/**
 * Which actions this row offers.
 *
 * `import` is withheld only where it cannot mean anything: a Skip's imported ID
 * is already in Actual, so adding it again would create a row our own next run
 * could not tell apart. `force` is the override on exactly that case.
 */
export function availableActions(
  row: ClassifiedRow,
  corrected: ReadonlySet<string> = new Set(),
): Action[] {
  const actions: Action[] = [];
  if (row.bucket !== 'skip') actions.push('import');
  const targets = correctionTargets(row, corrected).length;
  if (targets > 0 && targets <= MAX_CORRECTION_CHOICES) actions.push('correct');
  actions.push('leave');
  if (row.bucket === 'skip') actions.push('force');
  return actions;
}

/** The keystroke for each action. Total, so no action can lack one. */
const KEY: Record<Action, string> = {
  import: 'i',
  correct: 'c',
  leave: 'l',
  force: 'f',
};

function keyFor(action: Action): string {
  return KEY[action];
}

function promptFor(row: ClassifiedRow, corrected: ReadonlySet<string>): string {
  const labels: Record<Action, string> = {
    import: '[i]mport',
    correct: '[c]orrect the matched transaction',
    leave: '[l]eave it',
    force: '[f]orce a separate transaction',
  };
  const offered = availableActions(row, corrected).map((a) => labels[a]);
  return `${offered.join('  ')}  [?]detail  [q]uit > `;
}

export type ReviewOptions = {
  gateway: ActualGateway;
  accountId: string;
  accountName: string;
  rows: readonly ClassifiedRow[];
  /** What Actual held when the batch was classified, for forced-ID numbering. */
  existing: readonly ActualTransaction[];
  /** Rows the parser did not turn into transactions, so the Tape can say so. */
  dropped?: readonly DroppedRow[];
  boundary: string | null;
  io: ReviewIo;
  style?: TapeStyle | undefined;
};

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const { gateway, accountId, accountName, rows, io, boundary } = options;
  const style = options.style ?? { colour: false };
  const importedIds = new Set(
    options.existing.map((t) => t.imported_id ?? '').filter((id) => id !== ''),
  );
  // Stored transactions corrected so far in this run; see `correctionTargets`.
  const corrected = new Set<string>();

  printTape(options, style);

  const outcomes: RowOutcome[] = [];
  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    io.write('');
    io.write(tapeLine(number, row, style));
    for (const warning of warnings(row, boundary, corrected)) {
      io.write(`    ${warning}`);
    }

    const actions = availableActions(row, corrected);
    const allowed = [...actions.map(keyFor), '?', 'q'];
    let answer = await io.ask(promptFor(row, corrected), allowed);
    while (answer === '?') {
      for (const line of detail(row)) io.write(`    ${line}`);
      answer = await io.ask(promptFor(row, corrected), allowed);
    }

    if (answer === 'q') {
      io.write(`    stopped. ${rows.length - index} row(s) left untouched.`);
      outcomes.push({ row, action: 'quit', wrote: 'nothing' });
      // A partial run still has to say what it wrote: re-running the file is
      // the resume mechanism, and that only works if what happened is legible.
      printSummary(outcomes, accountName, io);
      return { outcomes, stopped: true };
    }

    const action = actions.find((a) => keyFor(a) === answer);
    if (action === undefined) {
      throw new Error(
        `answer ${JSON.stringify(answer)} is not one of the offered actions`,
      );
    }
    const outcome = await apply({
      action,
      row,
      gateway,
      accountId,
      importedIds,
      corrected,
      io,
    });
    outcomes.push(outcome);
  }

  printSummary(outcomes, accountName, io);
  return { outcomes, stopped: false };
}

async function apply(args: {
  action: Action;
  row: ClassifiedRow;
  gateway: ActualGateway;
  accountId: string;
  importedIds: Set<string>;
  corrected: Set<string>;
  io: ReviewIo;
}): Promise<RowOutcome> {
  const { action, row, gateway, accountId, importedIds, corrected, io } = args;
  const { source } = row;

  if (action === 'leave') {
    io.write('    left. Nothing written.');
    return { row, action, wrote: 'nothing' };
  }

  if (action === 'import') {
    await gateway.add(accountId, {
      date: source.date,
      amountCents: source.amountCents,
      payee: source.payee,
      notes: source.notes,
      importedId: source.importedId,
    });
    await gateway.sync();
    if (source.importedId !== '') importedIds.add(source.importedId);
    io.write(
      `    added ${source.date} ${formatCents(source.amountCents).trim()}` +
        (source.importedId === ''
          ? ' with no imported ID, because the bank wrote no reference'
          : ` as ${source.importedId}`),
    );
    return { row, action, wrote: 'added' };
  }

  if (action === 'force') {
    const importedId = forcedImportedId(source, importedIds);
    await gateway.add(accountId, {
      date: source.date,
      amountCents: source.amountCents,
      payee: source.payee,
      notes: source.notes,
      importedId,
    });
    await gateway.sync();
    importedIds.add(importedId);
    io.write(`    forced a separate transaction as ${importedId}`);
    return { row, action, wrote: 'forced' };
  }

  // action === 'correct'
  const targets = correctionTargets(row, corrected);
  const [first] = targets;
  if (first === undefined) {
    throw new Error('correct was answered on a row that offers no target');
  }
  let target = first;
  if (targets.length > 1) {
    const byChoice = new Map(targets.map((tx, i) => [String(i + 1), tx]));
    const choices = [...byChoice.keys()];
    for (const [i, candidate] of targets.entries()) {
      io.write(`    ${i + 1}) ${describe(candidate)}`);
    }
    // `q` backs out of the choice, not out of the run: on a terminal this prompt
    // reads a single raw keystroke, so without a way out a change of mind here
    // would be a loop that Ctrl-C cannot break either.
    const choice = await io.ask(
      `    which one? [${choices.join('/')}, q to cancel] > `,
      [...choices, 'q'],
    );
    const chosen = byChoice.get(choice);
    if (chosen === undefined) {
      io.write('    cancelled. Nothing written.');
      return { row, action: 'leave', wrote: 'nothing' };
    }
    target = chosen;
  }

  if (target.amount !== source.amountCents) {
    const refusal =
      `the bank says ${formatCents(source.amountCents).trim()} and Actual holds ` +
      `${formatCents(target.amount).trim()}. Correcting cannot change an amount ` +
      `(a split's parts must still sum to their parent), so nothing was applied. ` +
      `Resolve the amount in Actual.`;
    io.write(`    not applied: ${refusal}`);
    return { row, action, wrote: 'nothing', refusal };
  }

  // A field the bank left blank is not sent: it would wipe what the human
  // typed, and a blank payee name would create a payee called "".
  const patch = {
    date: source.date,
    notes: source.notes === '' ? undefined : source.notes,
    payeeName: source.payee === '' ? undefined : source.payee,
    importedId: source.importedId === '' ? undefined : source.importedId,
  };
  await gateway.correct(target.id, patch);
  await gateway.sync();
  corrected.add(target.id);
  if (patch.importedId !== undefined) importedIds.add(patch.importedId);
  const written = [
    'date',
    ...(patch.payeeName === undefined ? [] : ['payee']),
    ...(patch.notes === undefined ? [] : ['notes']),
    ...(patch.importedId === undefined ? [] : ['imported ID']),
  ];
  io.write(
    `    corrected ${target.id} from the bank's data: ${written.join(', ')}` +
      (target.is_parent ? '. The split parts were left untouched.' : '.'),
  );
  return { row, action, wrote: 'corrected' };
}

/**
 * What has to be said out loud before this row is answered.
 *
 * A row dated after the boundary can still match a transaction inside the
 * reconciled range - the boundary is the newest reconciled date, so a candidate
 * one day earlier can be exactly that transaction. The row is then Suspicious
 * rather than Locked, and correcting it would reach into an attested range with
 * nothing but the evidence line to say so. Hence the second warning.
 *
 * A candidate an earlier row already corrected is withheld (see
 * `correctionTargets`), and that is said too, so a row whose `correct` has gone
 * does not simply look as if it never matched anything.
 */
export function warnings(
  row: ClassifiedRow,
  boundary: string | null,
  corrected: ReadonlySet<string> = new Set(),
): string[] {
  const lines: string[] = [];
  if (row.bucket === 'locked') {
    lines.push(
      `this date is inside the reconciled range (boundary ${boundary}). ` +
        'Anything written here changes a range you have already attested to.',
    );
  }
  const taken = candidates(row).filter((tx) => corrected.has(tx.id));
  if (taken.length > 0) {
    lines.push(
      `already corrected by an earlier row in this run, so not offered again: ` +
        `${taken.map(describe).join('; ')}. A second correction would overwrite ` +
        "that row's imported ID.",
    );
  }
  const targets = correctionTargets(row, corrected);
  const reconciled = targets.filter((t) => t.reconciled);
  if (reconciled.length > 0) {
    lines.push(
      `${reconciled.length} of the transaction(s) this could correct ` +
        `${reconciled.length === 1 ? 'is' : 'are'} reconciled: ` +
        `${reconciled.map(describe).join('; ')}. Actual will not stop that patch.`,
    );
  }
  if (targets.length > MAX_CORRECTION_CHOICES) {
    lines.push(
      `${targets.length} transactions here could be the same one, which is too ` +
        'many to choose between at a prompt. Correcting is not offered; leave the ' +
        'row and resolve it in Actual.',
    );
  }
  return lines;
}

/** The raw source row and every stored transaction behind the evidence. */
export function detail(row: ClassifiedRow): string[] {
  const { source } = row;
  const lines = [
    `source line ${source.sourceLine}: ${source.date} ${formatCents(source.amountCents).trim()}`,
    `payee "${source.payee}"  notes "${source.notes}"`,
    `imported ID ${source.importedId === '' ? '(none - the bank wrote no reference)' : source.importedId} (${source.importedIdOrigin})`,
  ];
  for (const why of explain(row.reasons)) lines.push(why);
  return lines;
}

function printTape(options: ReviewOptions, style: TapeStyle): void {
  const { io, rows, accountName, boundary, dropped = [] } = options;
  io.write('');
  io.write(`${accountName}: ${rows.length} source transaction(s)`);
  io.write(
    boundary === null
      ? 'no reconciled transaction in this account, so nothing is locked'
      : `reconciliation boundary ${boundary}: anything dated on or before it is locked`,
  );
  if (dropped.length > 0) {
    io.write(`${dropped.length} row(s) in the file were not read as transactions:`);
    for (const row of dropped) io.write(`    line ${row.sourceLine}: ${row.reason}`);
  }
  io.write('');
  io.write(TAPE_HEADER);
  for (const [index, row] of rows.entries()) {
    io.write(tapeLine(index + 1, row, style));
  }
}

function printSummary(
  outcomes: readonly RowOutcome[],
  accountName: string,
  io: ReviewIo,
): void {
  const count = (wrote: Wrote): number =>
    outcomes.filter((o) => o.wrote === wrote).length;
  io.write('');
  io.write(
    `${accountName}: ${count('added')} added, ${count('forced')} forced, ` +
      `${count('corrected')} corrected, ${count('nothing')} left.`,
  );
  const refused = outcomes.filter((o) => o.refusal !== undefined);
  if (refused.length > 0) {
    io.write(`${refused.length} request(s) were not applied:`);
    for (const outcome of refused) {
      io.write(`    line ${outcome.row.source.sourceLine}: ${outcome.refusal}`);
    }
  }
}
