/**
 * Both CSV inputs, end to end against a real Actual server: parse the file the
 * bank actually produces, classify against Actual, walk the Tape, write what is
 * confirmed - and then prove a second run of the same file writes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config.ts';
import { DEFAULT_FORMATS } from '../../src/sources/formats.ts';
import { createScriptedIo } from '../../src/io.ts';
import { runImport } from '../../src/import-run.ts';
import {
  closeSession,
  createRunAccount,
  openSession,
  serverReachable,
  skipReason,
  type Session,
} from './actual-fixture.ts';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const skip = skipReason(await serverReachable());

describe('integration: a whole run from a statement file', { skip }, () => {
  let session: Session;

  before(async () => {
    session = await openSession();
  });

  after(async () => {
    await closeSession(session);
  });

  /** A fresh account, plus a config that points the file's identifier at it. */
  async function arrange(
    label: string,
    accountKey: string,
  ): Promise<{ config: Config; accountId: string }> {
    const account = await createRunAccount(session, label);
    return {
      accountId: account.id,
      config: {
        accountNames: { [accountKey]: account.name },
        actual: {
          serverUrl: '',
          password: '',
          budgetName: '',
          dataDir: null,
        },
        formats: DEFAULT_FORMATS,
      },
    };
  }

  async function run(
    config: Config,
    path: string,
    answer: (index: number) => string,
    count: number,
  ) {
    const io = createScriptedIo(Array.from({ length: count }, (_, i) => answer(i)));
    const result = await runImport({ path, config, gateway: session.gateway, io });
    return { result, io };
  }

  it('imports a UBS account CSV, then writes nothing on a second run', async () => {
    const { config, accountId } = await arrange('account-csv', 'CH4200120123A12345678');
    const path = DATA + 'ubs_valid.csv';

    const first = await run(config, path, () => 'i', 1);
    assert.equal(first.result.outcomes.length, 1);
    assert.equal(first.result.outcomes[0]!.wrote, 'added');

    const stored = await session.gateway.getTransactions(
      accountId,
      '2022-01-01',
      '2024-12-31',
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.date, '2023-01-13');
    assert.equal(stored[0]!.amount, -18665, 'the debit stayed an outflow');
    assert.equal(stored[0]!.imported_id, '1234563AB9269773');

    const second = await run(config, path, () => 'l', 1);
    assert.equal(second.result.outcomes[0]!.row.bucket, 'skip');
    assert.equal(second.result.outcomes[0]!.wrote, 'nothing');
    assert.equal(
      (await session.gateway.getTransactions(accountId, '2022-01-01', '2024-12-31'))
        .length,
      1,
    );
  });

  it('imports a UBS cards CSV, then writes nothing on a second run', async () => {
    const { config, accountId } = await arrange('cards-csv', '9659086893219337559');
    const path = DATA + 'ubs_cards_1.csv';

    const first = await run(config, path, () => 'i', 3);
    assert.deepEqual(
      first.result.outcomes.map((o) => o.wrote),
      ['added', 'added', 'added'],
    );

    const stored = await session.gateway.getTransactions(
      accountId,
      '2019-12-01',
      '2020-03-31',
    );
    assert.deepEqual(
      stored.map((t) => t.amount).sort((a, b) => a - b),
      [-4100, -2800, 5000].sort((a, b) => a - b),
    );
    assert.equal(
      stored.every((t) => t.imported_id?.startsWith('abt1-')),
      true,
      'every card imported ID is minted and says so',
    );

    const second = await run(config, path, () => 'l', 3);
    assert.deepEqual(
      second.result.outcomes.map((o) => o.row.bucket),
      ['skip', 'skip', 'skip'],
    );
    assert.equal(
      second.result.outcomes.every((o) => o.wrote === 'nothing'),
      true,
    );
    assert.equal(
      (await session.gateway.getTransactions(accountId, '2019-12-01', '2020-03-31'))
        .length,
      3,
    );
  });

  it('recognises its own earlier write after the transaction has been re-dated', async () => {
    // The cards parser dates a purchase by `Date d'achat` while the bank books
    // it weeks later, so re-dating it in Actual to its booking date moves it a
    // long way from where this tool wrote it. Reading only a window around the
    // file's dates would miss the imported ID, report the row as Clean - "nothing
    // in Actual looks like it" - and have the human confirm a duplicate.
    const { config, accountId } = await arrange('re-dated', '9659086893219337559');
    const path = DATA + 'ubs_cards_1.csv';

    await run(config, path, () => 'i', 3);
    const stored = await session.gateway.getAccountHistory(accountId);
    assert.equal(stored.length, 3);

    // Move one of them to its booking date, months away and well outside any
    // window around the statement's own dates.
    const moved = stored.find((t) => t.date === '2020-02-24')!;
    await session.api.updateTransaction(moved.id, { date: '2026-03-16' });
    await session.api.sync();

    const second = await run(config, path, () => 'l', 3);
    assert.deepEqual(
      second.result.outcomes.map((o) => o.row.bucket),
      ['skip', 'skip', 'skip'],
      'the re-dated transaction is still recognised by its imported ID',
    );
    assert.equal((await session.gateway.getAccountHistory(accountId)).length, 3);
  });

  it('numbers a forced copy past an earlier one that has since been re-dated', async () => {
    // A forced copy's number is the lowest one the account does not hold yet,
    // wherever that earlier copy now sits. Missing it would write a second row
    // under the same imported ID - the corruption forcing exists to avoid.
    const { config, accountId } = await arrange(
      'force-re-dated',
      '9659086893219337559',
    );
    const path = DATA + 'ubs_cards_1.csv';

    await run(config, path, () => 'i', 3);
    const second = await run(config, path, (i) => (i === 0 ? 'f' : 'l'), 3);
    const base = second.result.outcomes[0]!.row.source.importedId;
    const firstCopy = (
      await session.gateway.findByImportedIds(accountId, [`${base}~dup1`])
    )[0]!;
    await session.api.updateTransaction(firstCopy.id, { date: '2026-03-16' });
    await session.api.sync();

    await run(config, path, (i) => (i === 0 ? 'f' : 'l'), 3);
    const copies = await session.gateway.findByImportedIds(accountId, [
      `${base}~dup1`,
      `${base}~dup2`,
    ]);
    assert.deepEqual(copies.map((t) => t.imported_id).sort(), [
      `${base}~dup1`,
      `${base}~dup2`,
    ]);
  });

  it('names both stored transactions when two share the imported ID of a row', async () => {
    // Actual enforces no uniqueness on imported_id, so a hand-edit or an
    // interrupted write can leave two rows under one ID. Naming only one of them
    // would let the human decline on half the facts and never see the duplicate.
    const { config, accountId } = await arrange('shared-id', 'CH4200120123A12345678');
    const path = DATA + 'ubs_valid.csv';

    await run(config, path, () => 'i', 1);
    await session.gateway.add(accountId, {
      date: '2023-03-01',
      amountCents: -18665,
      payee: 'Second copy',
      notes: '',
      importedId: '1234563AB9269773',
    });
    await session.api.sync();

    const { result, io } = await run(config, path, () => 'l', 1);
    assert.equal(result.outcomes[0]!.row.bucket, 'skip');
    const transcript = io.transcript.join('\n');
    assert.match(
      transcript,
      /already in Actual as 2 transactions sharing this imported ID: /,
    );
    assert.match(transcript, /2023-01-13 -186.65 "EXAMPLE; Paiement UBS TWINT/);
    assert.match(transcript, /2023-03-01 -186.65 "Second copy"/);
  });

  it('says on the Tape which rows the file held but the parser did not read', async () => {
    const { config } = await arrange('cards-pending', '9659086893219337559');
    const { io } = await run(config, DATA + 'ubs_cards_pending.csv', () => 'l', 3);
    const transcript = io.transcript.join('\n');
    assert.match(transcript, /row\(s\) in the file were not read as transactions/);
    assert.match(transcript, /pending \(not booked yet\)/);
  });

  it('names the account the file asks for when the budget has no such account', async () => {
    const config: Config = {
      accountNames: { CH4200120123A12345678: 'No Such Account' },
      actual: { serverUrl: '', password: '', budgetName: '', dataDir: null },
      formats: DEFAULT_FORMATS,
    };
    await assert.rejects(
      () =>
        runImport({
          path: DATA + 'ubs_valid.csv',
          config,
          gateway: session.gateway,
          io: createScriptedIo([]),
        }),
      /account "No Such Account" not found in budget/,
    );
  });
});
