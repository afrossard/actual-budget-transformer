/**
 * One run: read a statement file, read Actual, classify once, review.
 *
 * The whole file is one batch. Classification happens before the first prompt
 * and is never redone, because re-reading Actual between prompts makes each
 * confirmation flag the next transaction - a cascade of manufactured noise
 * rather than a finding.
 */
import { classify, reconciliationBoundary, tally } from './classify.ts';
import { accountNameFor, type Config } from './config.ts';
import { parseStatement } from './sources/index.ts';
import { review, type ReviewIo, type ReviewResult } from './review.ts';
import type { ActualGateway } from './actual-gateway.ts';
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

  // The account's whole history, in one read, for everything: the boundary, the
  // imported-ID match, and the amount-and-date match.
  //
  // A window around the file's own dates would be enough for the second of
  // those - it looks a day either side - but not for the first. An imported ID
  // has to be recognised wherever the transaction now sits, and a transaction
  // can sit a long way from where this tool wrote it: the cards parser dates a
  // purchase by `Date d'achat` while the bank books it weeks later, so someone
  // re-dating it in Actual to its booking date moves it outside any sensible
  // window. Miss that and the row comes back as Clean, which claims nothing in
  // Actual looks like it, and the human confirms a duplicate.
  const existing = await gateway.getAccountHistory(account.id);
  const boundary = reconciliationBoundary(existing);

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
