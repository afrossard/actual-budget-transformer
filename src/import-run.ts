/**
 * One run: read a statement file, read Actual, classify once, review.
 *
 * The whole file is one batch. Classification happens before the first prompt
 * and is never redone, because re-reading Actual between prompts makes each
 * confirmation flag the next transaction - a cascade of manufactured noise
 * rather than a finding.
 */
import { classify, tally, type ActualTransaction } from './classify.ts';
import { accountNameFor, type Config } from './config.ts';
import { parseStatement } from './sources/index.ts';
import { review, type ReviewIo, type ReviewResult } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { TapeStyle } from './tape.ts';

/**
 * How far either side of the file's own date range Actual is read.
 *
 * The blind-duplicate check only needs a day, but a transaction this tool wrote
 * earlier may since have been moved by a few days in the UI, and it still has to
 * be recognised by its imported ID rather than imported twice. A week matches
 * the width of Actual's own matcher.
 */
export const READ_MARGIN_DAYS = 7;

function shift(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export type RunOptions = {
  path: string;
  config: Config;
  gateway: ActualGateway;
  io: ReviewIo;
  style?: TapeStyle;
};

export type RunResult = ReviewResult & { accountName: string };

export async function runImport(options: RunOptions): Promise<RunResult> {
  const { path, config, gateway, io } = options;

  const statement = parseStatement(path);
  const accountName = accountNameFor(config, statement.accountKey);
  io.write(
    `${path}: ${statement.format}, account ${statement.accountKey} -> ${JSON.stringify(accountName)}`,
  );

  if (statement.transactions.length === 0) {
    io.write('no transactions in this file.');
    for (const row of statement.dropped) {
      io.write(`    line ${row.sourceLine}: ${row.reason}`);
    }
    return { accountName, outcomes: [], stopped: false };
  }

  const account = await gateway.findAccount(accountName);
  const boundary = await gateway.reconciliationBoundary(account.id);

  const dates = statement.transactions.map((t) => t.date).sort();
  const existing: ActualTransaction[] = await gateway.getTransactions(
    account.id,
    shift(dates[0]!, -READ_MARGIN_DAYS),
    shift(dates[dates.length - 1]!, READ_MARGIN_DAYS),
  );

  const rows = classify(statement.transactions, existing, boundary);
  const counts = tally(rows);
  io.write(
    `classified once: ${counts.clean} clean, ${counts.suspicious} suspicious, ` +
      `${counts.skip} skip, ${counts.locked} locked`,
  );

  const result = await review({
    gateway,
    accountId: account.id,
    accountName,
    rows,
    existing,
    dropped: statement.dropped,
    boundary,
    io,
    style: options.style,
  });
  return { ...result, accountName };
}
