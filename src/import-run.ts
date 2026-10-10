/**
 * One run: read a statement file, read Actual, pair once, review.
 *
 * The whole file is one batch. Pairing happens before the first prompt and is
 * never redone, because re-reading Actual between prompts would pair each
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
import { review, type ReviewIo, type ReviewResult } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { Period, SourceTransaction } from './sources/types.ts';
import { shiftDays, type IsoDate } from './iso-date.ts';
import type { ReportStyle } from './statement-report.ts';

export type RunOptions = {
  path: string;
  config: Config;
  gateway: ActualGateway;
  io: ReviewIo;
  style?: ReportStyle;
};

export type RunResult = ReviewResult & { accountName: string };

export async function runImport(options: RunOptions): Promise<RunResult> {
  const { path, config, gateway, io } = options;

  const statement = parseStatement(path, config.formats);
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
    return { accountName, outcomes: [], stopped: false };
  }

  const account = resolveAccount(target, await gateway.listAccounts());

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

  const result = await review({
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
  return { ...result, accountName };
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
