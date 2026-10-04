/**
 * One run: read a statement file, read Actual, pair once, review.
 *
 * The whole file is one batch. Pairing happens before the first prompt and is
 * never redone, because re-reading Actual between prompts would pair each
 * statement transaction with whatever the last import wrote - a cascade of
 * manufactured noise rather than a finding.
 */
import { classify, PAIRING_WINDOW_DAYS, type ActualTransaction } from './classify.ts';
import { resolveAccount } from './account-resolution.ts';
import { accountTargetFor, type Config } from './config.ts';
import { parseStatement } from './sources/index.ts';
import { review, type ReviewIo, type ReviewResult } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { SourceTransaction } from './sources/types.ts';
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

  if (statement.transactions.length === 0) {
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
  // as it would against the whole history.
  const reconciledThrough = await gateway.reconciledThroughDate(account.id);
  const byImportedId = await gateway.findByImportedIds(
    account.id,
    statement.transactions.map((tx) => tx.importedId),
  );
  const nearby = await gateway.getTransactions(
    account.id,
    ...pairingSpan(statement.transactions),
  );
  const existing = distinctById([...byImportedId, ...nearby]);

  const classified = classify(statement.transactions, existing, reconciledThrough);

  const result = await review({
    gateway,
    accountId: account.id,
    accountName,
    classified,
    dropped: statement.dropped,
    reconciledThrough,
    io,
    style: options.style,
  });
  return { ...result, accountName };
}

/**
 * The dates an amount-and-date pair of any of these transactions could sit on:
 * the statement's own span, widened by the pairing window at each end.
 *
 * A window is right here, and only here. Such a pair is *defined* by its date
 * being near the statement transaction's, whereas an imported ID has to be
 * found wherever the transaction now sits - which is why that read is
 * unbounded.
 */
function pairingSpan(sources: readonly SourceTransaction[]): [string, string] {
  // ISO dates sort as strings.
  const dates = sources.map((tx) => tx.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('a statement with no transactions has no span');
  }
  return [shiftDays(first, -PAIRING_WINDOW_DAYS), shiftDays(last, PAIRING_WINDOW_DAYS)];
}

function shiftDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** A transaction both reads returned would otherwise be a candidate twice. */
function distinctById(transactions: readonly ActualTransaction[]): ActualTransaction[] {
  return [...new Map(transactions.map((tx) => [tx.id, tx])).values()];
}
