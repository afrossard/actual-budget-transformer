/**
 * One run: read a statement file, read Actual, classify once, review.
 *
 * The whole file is one batch. Classification happens before the first prompt
 * and is never redone, because re-reading Actual between prompts makes each
 * confirmation flag the next transaction - a cascade of manufactured noise
 * rather than a finding.
 */
import {
  BLIND_DUPLICATE_WINDOW_DAYS,
  classify,
  type ActualTransaction,
} from './classify.ts';
import { resolveAccount } from './account-resolution.ts';
import { accountTargetFor, type Config } from './config.ts';
import { parseStatement } from './sources/index.ts';
import { review, type ReviewIo, type ReviewResult } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
import type { SourceTransaction } from './sources/types.ts';
import type { TapeStyle } from './tape.ts';

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
  // answering one question the classifier asks. Their union is every stored
  // transaction the classifier could match, so it classifies exactly as it
  // would against the whole history.
  const boundary = await gateway.reconciliationBoundary(account.id);
  const byImportedId = await gateway.findByImportedIds(
    account.id,
    statement.transactions.map((tx) => tx.importedId),
  );
  const nearby = await gateway.getTransactions(
    account.id,
    ...blindDuplicateSpan(statement.transactions),
  );
  const existing = distinctById([...byImportedId, ...nearby]);

  const rows = classify(statement.transactions, existing, boundary);

  const result = await review({
    gateway,
    accountId: account.id,
    accountName,
    rows,
    dropped: statement.dropped,
    boundary,
    io,
    style: options.style,
  });
  return { ...result, accountName };
}

/**
 * The dates a blind duplicate of any of these transactions could sit on: the
 * statement's own span, widened by the classifier's window at each end.
 *
 * A window is right here, and only here. A blind duplicate is *defined* by its
 * date being near the source row's, whereas an imported ID has to be found
 * wherever the transaction now sits - which is why that read is unbounded.
 */
function blindDuplicateSpan(sources: readonly SourceTransaction[]): [string, string] {
  // ISO dates sort as strings.
  const dates = sources.map((tx) => tx.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('a statement with no transactions has no span');
  }
  return [
    shiftDays(first, -BLIND_DUPLICATE_WINDOW_DAYS),
    shiftDays(last, BLIND_DUPLICATE_WINDOW_DAYS),
  ];
}

function shiftDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** A transaction both reads returned would otherwise be matched twice. */
function distinctById(transactions: readonly ActualTransaction[]): ActualTransaction[] {
  return [...new Map(transactions.map((tx) => [tx.id, tx])).values()];
}
