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
import { forcedCopyIds, forcedImportedId } from './imported-id.ts';
import { formatCents } from './money.ts';
import {
  block,
  DEFAULT_WIDTH,
  explain,
  matches,
  numbering,
  overview,
  type NumberOf,
  type TapeStyle,
} from './tape.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { DroppedRow, SourceTransaction } from './sources/types.ts';

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
  /**
   * Say what came of the last answer - on the prompt's own line while it is
   * still open, so a row's decision and its outcome read as one line.
   */
  conclude(outcome: string): void;
  /** Resolves to one of `allowed`. */
  ask(prompt: string, allowed: readonly string[]): Promise<string>;
};

export type ReviewResult = {
  outcomes: RowOutcome[];
  /** True when the human stopped the run early; the rest is left untouched. */
  stopped: boolean;
};

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
  return matches(row).filter((tx) => !corrected.has(tx.id));
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
    correct: '[c]orrect',
    leave: '[l]eave',
    force: '[f]orce',
  };
  const offered = availableActions(row, corrected).map((a) => labels[a]);
  return `  ${offered.join('  ')}  [?] detail  [q]uit > `;
}

export type ReviewOptions = {
  gateway: ActualGateway;
  accountId: string;
  accountName: string;
  rows: readonly ClassifiedRow[];
  /** Rows the parser did not turn into transactions, so the Tape can say so. */
  dropped?: readonly DroppedRow[];
  boundary: string | null;
  io: ReviewIo;
  style?: TapeStyle | undefined;
};

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const { gateway, accountId, accountName, rows, io, boundary } = options;
  const style = options.style ?? { colour: false, width: DEFAULT_WIDTH };
  const numberOf = numbering(rows);
  // Stored transactions corrected so far in this run; see `correctionTargets`.
  const corrected = new Set<string>();

  io.write('');
  const batch = { accountName, rows, boundary, dropped: options.dropped ?? [] };
  for (const line of overview(batch, style)) io.write(line);

  const outcomes: RowOutcome[] = [];
  for (const [index, row] of rows.entries()) {
    io.write('');
    const reviewed = {
      number: index + 1,
      total: rows.length,
      row,
      corrected,
      warnings: warnings(row, corrected),
    };
    for (const line of block(reviewed, style, numberOf)) io.write(line);

    const actions = availableActions(row, corrected);
    const allowed = [...actions.map(keyFor), '?', 'q'];
    let answer = await io.ask(promptFor(row, corrected), allowed);
    while (answer === '?') {
      for (const line of detail(row, numberOf)) io.write(`    ${line}`);
      answer = await io.ask(promptFor(row, corrected), allowed);
    }

    if (answer === 'q') {
      const left = rows.length - index;
      io.conclude(`stopped, ${left} row${left === 1 ? '' : 's'} left untouched`);
      outcomes.push({ row, action: 'quit', wrote: 'nothing' });
      // A partial run still has to say what it wrote: re-running the file is
      // the resume mechanism, and that only works if what happened is legible.
      printSummary(outcomes, rows, accountName, io);
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
      corrected,
      io,
    });
    outcomes.push(outcome);
  }

  printSummary(outcomes, rows, accountName, io);
  return { outcomes, stopped: false };
}

/** How many forced IDs to ask Actual about at once; one is almost always enough. */
const FORCED_LOOKUP_BATCH = 10;

/**
 * The forced ID for this row: the lowest copy number the account does not
 * hold, checked against Actual at the moment of writing.
 *
 * Asked here rather than taken from what the batch was classified against,
 * because that read only holds the rows the classifier could match, and an
 * earlier forced copy re-dated out of the statement's span is not one of them.
 * Missing it would write a second row under the same imported ID. Reading at
 * write time also sees every copy forced earlier in this run, since a write
 * lands in the local budget at once.
 */
async function freeForcedImportedId(
  gateway: ActualGateway,
  accountId: string,
  source: SourceTransaction,
): Promise<string> {
  for (let count = FORCED_LOOKUP_BATCH; ; count += FORCED_LOOKUP_BATCH) {
    const candidates = forcedCopyIds(source, count);
    const held = await gateway.findByImportedIds(accountId, candidates);
    const importedId = forcedImportedId(
      source,
      held.map((t) => t.imported_id ?? ''),
    );
    if (candidates.includes(importedId)) return importedId;
  }
}

async function apply(args: {
  action: Action;
  row: ClassifiedRow;
  gateway: ActualGateway;
  accountId: string;
  corrected: Set<string>;
  io: ReviewIo;
}): Promise<RowOutcome> {
  const { action, row, gateway, accountId, corrected, io } = args;
  const { source } = row;

  if (action === 'leave') {
    io.conclude('left, nothing written');
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
    io.conclude(
      source.importedId === ''
        ? 'added, with no imported ID: the bank wrote no reference'
        : `added as ${source.importedId}`,
    );
    return { row, action, wrote: 'added' };
  }

  if (action === 'force') {
    const importedId = await freeForcedImportedId(gateway, accountId, source);
    await gateway.add(accountId, {
      date: source.date,
      amountCents: source.amountCents,
      payee: source.payee,
      notes: source.notes,
      importedId,
    });
    await gateway.sync();
    io.conclude(`forced a separate transaction as ${importedId}`);
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
    // The numbers are the ones the row's block put on its `actual` lines.
    const byChoice = new Map(targets.map((tx, i) => [String(i + 1), tx]));
    const choices = [...byChoice.keys()];
    // `q` backs out of the choice, not out of the run: on a terminal this prompt
    // reads a single raw keystroke, so without a way out a change of mind here
    // would be a loop that Ctrl-C cannot break either.
    const choice = await io.ask(
      `  correct which? [${choices.join('/')}, q to cancel] > `,
      [...choices, 'q'],
    );
    const chosen = byChoice.get(choice);
    if (chosen === undefined) {
      io.conclude('cancelled, nothing written');
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
    io.conclude('not applied: the amounts differ (see the end of the run)');
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
  const written = [
    'date',
    ...(patch.payeeName === undefined ? [] : ['payee']),
    ...(patch.notes === undefined ? [] : ['notes']),
    ...(patch.importedId === undefined ? [] : ['imported ID']),
  ];
  io.conclude(
    `corrected ${written.join(', ')}` +
      (target.is_parent ? '; the split parts were left untouched' : ''),
  );
  return { row, action, wrote: 'corrected' };
}

/**
 * What has to be said out loud before this row is answered, one short line
 * each. The row's block already names every match, so these never do.
 *
 * A row dated after the boundary can still match a transaction inside the
 * reconciled range - the boundary is the newest reconciled date, so a candidate
 * one day earlier can be exactly that transaction. The row is then Suspicious
 * rather than Locked, and correcting it would reach into an attested range with
 * nothing but a `reconciled` tag to say so. Hence the warning. On a Locked row
 * the reconciled-range warning already says it, and is not repeated.
 *
 * A candidate an earlier row already corrected is withheld (see
 * `correctionTargets`), and that is said too, so a row whose `correct` has gone
 * does not simply look as if it never matched anything.
 */
export function warnings(
  row: ClassifiedRow,
  corrected: ReadonlySet<string> = new Set(),
): string[] {
  const lines: string[] = [];
  const targets = correctionTargets(row, corrected);
  if (row.bucket === 'locked') {
    lines.push('inside the reconciled range: writing here changes it');
  } else if (targets.some((t) => t.reconciled)) {
    lines.push('a match is reconciled: correcting it changes an attested range');
  }
  if (matches(row).some((tx) => corrected.has(tx.id))) {
    // A second correction would overwrite that row's imported ID.
    lines.push('already corrected by an earlier row in this run, so not offered again');
  }
  if (targets.length > MAX_CORRECTION_CHOICES) {
    lines.push(
      `${targets.length} matches, too many to choose from here: resolve it in Actual`,
    );
  }
  return lines;
}

/** The raw source row and every stored transaction behind the evidence, uncut. */
export function detail(row: ClassifiedRow, numberOf: NumberOf): string[] {
  const { source } = row;
  const lines = [
    `source line ${source.sourceLine}: ${source.date} ${formatCents(source.amountCents).trim()}`,
    `payee "${source.payee}"  notes "${source.notes}"`,
    `imported ID ${source.importedId === '' ? '(none - the bank wrote no reference)' : source.importedId} (${source.importedIdOrigin})`,
  ];
  for (const why of explain(row.reasons, numberOf)) lines.push(why);
  return lines;
}

function printSummary(
  outcomes: readonly RowOutcome[],
  rows: readonly ClassifiedRow[],
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
      io.write(`  #${rows.indexOf(outcome.row) + 1}: ${outcome.refusal}`);
    }
  }
}
