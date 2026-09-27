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

const KEY: Record<string, Action> = {
  i: 'import',
  c: 'correct',
  l: 'leave',
  f: 'force',
};

/** Every stored transaction this row could correct, most relevant first. */
export function correctionTargets(row: ClassifiedRow): ActualTransaction[] {
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
 * Which actions this row offers.
 *
 * `import` is withheld only where it cannot mean anything: a Skip's imported ID
 * is already in Actual, so adding it again would create a row our own next run
 * could not tell apart. `force` is the override on exactly that case.
 */
export function availableActions(row: ClassifiedRow): Action[] {
  const actions: Action[] = [];
  if (row.state !== 'skip') actions.push('import');
  if (correctionTargets(row).length > 0) actions.push('correct');
  actions.push('leave');
  if (row.state === 'skip') actions.push('force');
  return actions;
}

function keyFor(action: Action): string {
  return Object.keys(KEY).find((k) => KEY[k] === action)!;
}

function promptFor(row: ClassifiedRow): string {
  const labels: Record<Action, string> = {
    import: '[i]mport',
    correct: '[c]orrect the matched transaction',
    leave: '[l]eave it',
    force: '[f]orce a separate transaction',
  };
  const offered = availableActions(row).map((a) => labels[a]);
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
  style?: TapeStyle;
};

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const { gateway, accountId, accountName, rows, io, boundary } = options;
  const style = options.style ?? { colour: false };
  const importedIds = new Set(
    options.existing.map((t) => t.imported_id ?? '').filter((id) => id !== ''),
  );

  printTape(options, style);

  const outcomes: RowOutcome[] = [];
  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    io.write('');
    io.write(tapeLine(number, row, style));
    if (row.state === 'locked') {
      io.write(
        `    this date is inside the reconciled range (boundary ${boundary}). ` +
          'Anything written here changes a range you have already attested to.',
      );
    }

    const actions = availableActions(row);
    const allowed = [...actions.map(keyFor), '?', 'q'];
    let answer = await io.ask(promptFor(row), allowed);
    while (answer === '?') {
      for (const line of detail(row)) io.write(`    ${line}`);
      answer = await io.ask(promptFor(row), allowed);
    }

    if (answer === 'q') {
      io.write(`    stopped. ${rows.length - index} row(s) left untouched.`);
      outcomes.push({ row, action: 'quit', wrote: 'nothing' });
      // A partial run still has to say what it wrote: re-running the file is
      // the resume mechanism, and that only works if what happened is legible.
      printSummary(outcomes, accountName, io);
      return { outcomes, stopped: true };
    }

    const action = KEY[answer]!;
    const outcome = await apply({
      action,
      row,
      gateway,
      accountId,
      importedIds,
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
  io: ReviewIo;
}): Promise<RowOutcome> {
  const { action, row, gateway, accountId, importedIds, io } = args;
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
  const targets = correctionTargets(row);
  let target = targets[0]!;
  if (targets.length > 1) {
    const allowed = targets.map((_, i) => String(i + 1));
    for (const [i, candidate] of targets.entries()) {
      io.write(`    ${i + 1}) ${describe(candidate)}`);
    }
    const choice = await io.ask(`    which one? [${allowed.join('/')}] > `, allowed);
    target = targets[Number(choice) - 1]!;
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

  await gateway.correct(target.id, {
    date: source.date,
    notes: source.notes,
    payeeName: source.payee,
    importedId: source.importedId === '' ? undefined : source.importedId,
  });
  await gateway.sync();
  if (source.importedId !== '') importedIds.add(source.importedId);
  io.write(
    `    corrected ${target.id} from the bank's data: date, payee, notes` +
      (source.importedId === '' ? '' : ', imported ID') +
      (target.is_parent ? '. The split parts were left untouched.' : '.'),
  );
  return { row, action, wrote: 'corrected' };
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
