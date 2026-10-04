/**
 * Both CSV inputs, end to end against a real Actual server: parse the file the
 * bank actually produces, pair against Actual, review the rest, write what is
 * confirmed - and then prove a second run of the same file has nothing to
 * review.
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
          syncId: '',
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

    const second = await run(config, path, () => 'l', 0);
    assert.deepEqual(second.result.outcomes, []);
    assert.match(
      second.io.transcript.join('\n'),
      /1 already in Actual · nothing to review/,
    );
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

    const second = await run(config, path, () => 'l', 0);
    assert.deepEqual(second.result.outcomes, []);
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
    // file's dates would miss the imported ID, send it to review as "not in
    // Actual", and have the human confirm a duplicate.
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

    const second = await run(config, path, () => 'l', 0);
    assert.deepEqual(
      second.result.outcomes,
      [],
      'the re-dated transaction still pairs by its imported ID',
    );
    assert.equal((await session.gateway.getAccountHistory(accountId)).length, 3);
  });

  it('reviews one missing from Actual on the reconciled-through date', async () => {
    // Reported from a real run (#82): a transaction deleted from Actual on the
    // same day as the last reconciled one came up "locked".
    const { config, accountId } = await arrange(
      'reconciled-period',
      'CH4200120123A12345678',
    );
    await session.api.addTransactions(accountId, [
      { date: '2023-01-13', amount: -5000, payee_name: 'Groceries (typed by hand)' },
    ]);
    const [typed] = await session.api.getTransactions(
      accountId,
      '2023-01-13',
      '2023-01-13',
    );
    await session.api.updateTransaction(typed!.id, { reconciled: true });
    await session.api.sync();

    const { result, io } = await run(config, DATA + 'ubs_valid.csv', () => 'i', 1);
    assert.deepEqual(
      result.outcomes.map((o) => o.wrote),
      ['added'],
    );
    const transcript = io.transcript.join('\n');
    assert.match(transcript, /reconciled through 2023-01-13/);
    assert.match(transcript, /0 already in Actual · 1 to review/);
    assert.match(transcript, /! dated in your reconciled period/);
    assert.doesNotMatch(transcript, /locked/);
    const stored = await session.gateway.getAccountHistory(accountId);
    assert.deepEqual(stored.map((t) => t.amount).sort(), [-18665, -5000]);
  });

  it('reviews one whose lookalike in Actual carries another bank reference', async () => {
    // A second purchase of the same amount the day after one already imported:
    // the bank gave them two references, so they are two transactions and the
    // second must not be taken as already in Actual (#82's review).
    const { config, accountId } = await arrange(
      'other-reference',
      'CH4200120123A12345678',
    );
    await session.gateway.add(accountId, {
      date: '2023-01-12',
      amountCents: -18665,
      payee: 'Yesterday',
      notes: '',
      importedId: 'REF-YESTERDAY',
    });
    await session.api.sync();

    const { result, io } = await run(config, DATA + 'ubs_valid.csv', () => 'i', 1);
    assert.deepEqual(
      result.outcomes.map((o) => o.wrote),
      ['added'],
    );
    assert.match(
      io.transcript.join('\n'),
      /^ {2}not in Actual · looks like REF-YESTERDAY: 2023-01-12 -186\.65 Yesterday$/m,
    );
    assert.equal((await session.gateway.getAccountHistory(accountId)).length, 2);
  });

  it('lists, to fix in Actual, two Actual transactions sharing one imported ID', async () => {
    // Actual enforces no uniqueness on imported_id, so a hand-edit or an
    // interrupted write can leave two transactions under one ID. The fix is
    // made in Actual, so it is listed and never prompted.
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

    const { result, io } = await run(config, path, () => 'l', 0);
    assert.deepEqual(result.outcomes, []);
    assert.match(
      io.transcript.join('\n'),
      /^ {2}! #1 EXAMPLE; Paiement UBS TWINT: 2 Actual transactions hold its imported ID$/m,
    );
  });

  it('says in the statement report which rows the file held but the parser did not read', async () => {
    const { config } = await arrange('cards-pending', '9659086893219337559');
    const { io } = await run(config, DATA + 'ubs_cards_pending.csv', () => 'l', 3);
    const transcript = io.transcript.join('\n');
    assert.match(transcript, /4 rows in the file were not read as transactions/);
    assert.match(transcript, /pending \(not booked yet\)/);
  });

  describe('when the budget has no account to import into', () => {
    /** The message a run fails with, after asserting it fails. */
    async function failure(accountNames: Record<string, string>): Promise<string> {
      const config: Config = {
        accountNames,
        actual: { serverUrl: '', password: '', syncId: '', dataDir: null },
        formats: DEFAULT_FORMATS,
      };
      let message = '';
      await assert.rejects(
        () =>
          runImport({
            path: DATA + 'ubs_valid.csv',
            config,
            gateway: session.gateway,
            io: createScriptedIo([]),
          }),
        (error: Error) => {
          message = error.message;
          return true;
        },
      );
      return message;
    }

    it('says the identifier is not mapped, and shows the line to add', async () => {
      assert.match(
        await failure({}),
        /^CH4200120123A12345678 is not in account_names\. Add this entry to that block in your config:\n\n {2}"CH4200120123A12345678": /,
      );
    });

    it('says what the identifier is mapped to, and suggests a near match', async () => {
      const account = await createRunAccount(session, 'near-match');
      const message = await failure({
        CH4200120123A12345678: account.name.toLowerCase(),
      });
      assert.match(
        message,
        /^account_names maps CH4200120123A12345678 to "ts near-match .*", but the budget has no open account with that name\./,
      );
      assert.ok(
        message.includes(`Did you mean ${JSON.stringify(account.name)}?`),
        message,
      );
    });

    it('says the account is closed rather than missing', async () => {
      const account = await createRunAccount(session, 'closed');
      // Actual deletes an account with no transactions instead of closing it.
      await session.api.addTransactions(account.id, [
        { date: '2030-01-01', amount: 0 },
      ]);
      await session.api.closeAccount(account.id);
      await session.api.sync();
      assert.match(
        await failure({ CH4200120123A12345678: account.name }),
        /, which exists in the budget but is closed\./,
      );
    });
  });
});
