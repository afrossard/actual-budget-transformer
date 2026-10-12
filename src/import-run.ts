/**
 * One run: for each statement file in turn, read it, read Actual, pair once,
 * write what is not in Actual, unattended or under review - then the import
 * summary.
 *
 * The budget is opened once for the run, and each file is paired against a
 * fresh read of it, so an export overlapping an earlier one pairs with what
 * that one wrote. A file that fails before anything is written for it - not
 * recognised, unparseable, its account not resolved - is explained and the run
 * goes on; any other failure, or a quit, stops it.
 *
 * Within a file, the whole file is one batch. Pairing happens before the first write and is
 * never redone, because re-reading Actual between writes would pair each
 * statement transaction with whatever the last import wrote - a cascade of
 * manufactured noise rather than a finding.
 */
import {
  classify,
  PAIRING_WINDOW_DAYS,
  unpairedActual,
  type ActualTransaction,
} from './classify.ts';
import { resolveAccount } from './account-resolution.ts';
import { accountTargetFor, type Config } from './config.ts';
import { parseStatement } from './sources/index.ts';
import { importUnpaired, type ImportResult, type ReviewIo } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { Period, SourceTransaction } from './sources/types.ts';
import { shiftDays, type IsoDate } from './iso-date.ts';
import { DEFAULT_WIDTH, type Mode, type ReportStyle } from './statement-report.ts';
import { importSummary, type FileOutcome } from './import-summary.ts';

export type RunOptions = {
  path: string;
  config: Config;
  mode: Mode;
  gateway: ActualGateway;
  io: ReviewIo;
  style?: ReportStyle;
};

export type RunResult = ImportResult & {
  accountName: string;
  /** How many statement transactions the file holds. */
  statementTransactions: number;
  /** How many of them paired: already in Actual, so nothing was written. */
  alreadyInActual: number;
};

export type BatchOptions = Omit<RunOptions, 'path'> & { paths: readonly string[] };

/**
 * A statement file skipped before anything was written for it. The message is
 * the whole explanation, for the import summary.
 */
export class NotImported extends Error {}

/** Every file in turn, then the import summary; what came of each. */
export async function runImports(options: BatchOptions): Promise<FileOutcome[]> {
  const { paths, io } = options;
  const outcomes: FileOutcome[] = [];
  let stopped = false;
  for (const [index, path] of paths.entries()) {
    if (stopped) {
      outcomes.push({ path, kind: 'not-reached' });
      continue;
    }
    if (index > 0) io.write('');
    try {
      const result = await runImport({ ...options, path });
      outcomes.push({ path, kind: 'imported', result });
      stopped = result.stopped;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof NotImported) {
        io.write(`${path}: not imported, see the import summary.`);
        outcomes.push({ path, kind: 'not-imported', reason });
      } else {
        outcomes.push({ path, kind: 'failed', reason });
        stopped = true;
      }
    }
  }
  const width = options.style?.width ?? DEFAULT_WIDTH;
  for (const line of importSummary(outcomes, width)) io.write(line);
  return outcomes;
}

export async function runImport(options: RunOptions): Promise<RunResult> {
  const { path, config, gateway, io } = options;

  const statement = beforeWriting(() => parseStatement(path, config.formats));
  const target = accountTargetFor(config, statement.accountKey);
  const accountName = target.name;
  io.write(
    `${path}: ${statement.format}, account ${statement.accountKey}` +
      (target.mapped ? ` -> ${JSON.stringify(accountName)}` : ''),
  );

  // A file with no transactions still has a period when it states one, and
  // what Actual holds in it is listed (#121). One that states none - a cards
  // CSV - has no dates to bound one, so there is nothing to compare.
  const span = transactionSpan(statement.transactions);
  const period = statement.period ?? span;
  if (period === null) {
    io.write('no transactions in this file.');
    for (const row of statement.dropped) {
      io.write(`    line ${row.sourceLine}: ${row.reason}`);
    }
    return {
      accountName,
      outcomes: [],
      stopped: false,
      statementTransactions: 0,
      alreadyInActual: 0,
    };
  }

  const accounts = await gateway.listAccounts();
  const account = beforeWriting(() => resolveAccount(target, accounts));

  // Three targeted reads instead of the account's whole history (#67), each
  // answering one question the classifier asks. Their union is every Actual
  // transaction a statement transaction could pair with, so it pairs exactly
  // as it would against the whole history, and every one in the period or
  // holding one of the file's imported IDs.
  const reconciledThrough = await gateway.reconciledThroughDate(account.id);
  const byImportedId = await gateway.findByImportedIds(
    account.id,
    statement.transactions.map((tx) => tx.importedId),
  );
  const nearby = await gateway.getTransactions(account.id, ...readSpan(span, period));
  const existing = distinctById([...byImportedId, ...nearby]);

  const classified = classify(statement.transactions, existing, reconciledThrough);
  const unpaired = unpairedActual(classified, existing, period);

  const result = await importUnpaired({
    mode: options.mode,
    gateway,
    accountId: account.id,
    period,
    classified,
    unpaired,
    dropped: statement.dropped,
    reconciledThrough,
    io,
    style: options.style,
  });
  return {
    ...result,
    accountName,
    statementTransactions: classified.length,
    alreadyInActual: classified.filter((c) => c.pair !== null).length,
  };
}

/** A failure in `step` skips the file rather than stopping the run. */
function beforeWriting<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw new NotImported(error instanceof Error ? error.message : String(error));
  }
}

/** The first to last statement transaction date, or null when there is none. */
function transactionSpan(sources: readonly SourceTransaction[]): Period | null {
  // ISO dates sort as strings.
  const dates = sources.map((tx) => tx.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * The dates to read: wherever an amount-and-date pair of a statement
 * transaction could sit - its span, widened by the pairing window at each end -
 * and the whole period, where every Actual transaction is either paired or
 * unpaired. A statement with no transactions has no span, only its period.
 *
 * A window is right here, and only here. Such a pair is *defined* by its date
 * being near the statement transaction's, whereas an imported ID has to be
 * found wherever the transaction now sits - which is why that read is
 * unbounded.
 */
function readSpan(span: Period | null, period: Period): [IsoDate, IsoDate] {
  if (span === null) return [period.from, period.to];
  const from = shiftDays(span.from, -PAIRING_WINDOW_DAYS);
  const to = shiftDays(span.to, PAIRING_WINDOW_DAYS);
  return [period.from < from ? period.from : from, period.to > to ? period.to : to];
}

/** A transaction both reads returned would otherwise be a candidate twice. */
function distinctById(transactions: readonly ActualTransaction[]): ActualTransaction[] {
  return [...new Map(transactions.map((tx) => [tx.id, tx])).values()];
}
