/**
 * The gateway's targeted reads, against a real Actual server (#67).
 *
 * Each read answers one question about one account, and each must answer it
 * completely: a read that misses a row is a classification that is silently
 * wrong. So these pin what each read must *not* drop - a far-away date, a
 * future date, a quote in an imported ID - as much as what it returns.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSession,
  createRunAccount,
  openSession,
  SERVER_URL,
  serverReachable,
  skipReason,
  testSettings,
  type Session,
} from './actual-fixture.ts';
import { ActualGateway, type AccountId } from '../../src/actual-gateway.ts';
import { isoDate } from './iso-date-fixture.ts';
import type { IsoDate } from '../../src/iso-date.ts';

const skip = skipReason(await serverReachable());

// Its own suite, ahead of the one below: `open` initialises the api singleton,
// so a second gateway opened beside a live session would swap its budget out.
describe('integration: the gateway opens a budget by sync ID', { skip }, () => {
  it('refuses an unknown sync ID, listing each budget by name and sync ID', async () => {
    const settings = await testSettings();
    const gateway = new ActualGateway({ ...settings, syncId: 'no-such-id' });
    try {
      await assert.rejects(gateway.open(), (error: Error) => {
        assert.match(
          error.message,
          new RegExp(`^no budget with sync ID "no-such-id" on ${SERVER_URL}\\.`),
        );
        assert.match(
          error.message,
          new RegExp(`\\n  "Test Budget" {2,}${settings.syncId}(\\n|$)`),
        );
        return true;
      });
    } finally {
      await gateway.close();
    }
  });
});

describe('integration: the gateway reads only what a question needs', { skip }, () => {
  let session: Session;

  before(async () => {
    session = await openSession();
  });

  after(async () => {
    await closeSession(session);
  });

  async function account(label: string): Promise<AccountId> {
    return (await createRunAccount(session, `gateway-${label}`)).id;
  }

  async function reconcile(accountId: AccountId, date: IsoDate): Promise<void> {
    const stored = await session.gateway.getTransactions(accountId, date, date);
    for (const tx of stored) {
      await session.api.updateTransaction(tx.id, { reconciled: true });
    }
    await session.api.sync();
  }

  describe('reconciledThroughDate', () => {
    it('is the newest reconciled date, ignoring newer unreconciled rows', async () => {
      const id = await account('boundary');
      await session.api.addTransactions(id, [
        { date: '2031-01-10', amount: -100, payee_name: 'Old' },
        { date: '2031-02-10', amount: -200, payee_name: 'Newest reconciled' },
        { date: '2031-03-10', amount: -300, payee_name: 'Not reconciled' },
      ]);
      await session.api.sync();
      await reconcile(id, isoDate('2031-01-10'));
      await reconcile(id, isoDate('2031-02-10'));

      assert.equal(await session.gateway.reconciledThroughDate(id), '2031-02-10');
    });

    it('is null when the account has never been reconciled', async () => {
      const id = await account('never');
      await session.api.addTransactions(id, [
        { date: '2031-01-10', amount: -100, payee_name: 'Unreconciled' },
      ]);
      await session.api.sync();

      assert.equal(await session.gateway.reconciledThroughDate(id), null);
    });

    it('finds a reconciled transaction dated in the future', async () => {
      const id = await account('future');
      await session.api.addTransactions(id, [
        { date: '2099-12-31', amount: -100, payee_name: 'Future' },
      ]);
      await session.api.sync();
      await reconcile(id, isoDate('2099-12-31'));

      assert.equal(await session.gateway.reconciledThroughDate(id), '2099-12-31');
    });

    it("ignores another account's reconciled transactions", async () => {
      const mine = await account('mine');
      const other = await account('other');
      await session.api.addTransactions(other, [
        { date: '2031-05-10', amount: -100, payee_name: 'Elsewhere' },
      ]);
      await session.api.sync();
      await reconcile(other, isoDate('2031-05-10'));

      assert.equal(await session.gateway.reconciledThroughDate(mine), null);
    });
  });

  describe('findByImportedIds', () => {
    it('finds every holder of each ID, whatever its date', async () => {
      const id = await account('ids');
      await session.api.addTransactions(id, [
        { date: '1999-01-01', amount: -100, imported_id: 'FAR-PAST', payee_name: 'A' },
        {
          date: '2099-01-01',
          amount: -200,
          imported_id: 'FAR-FUTURE',
          payee_name: 'B',
        },
        { date: '2031-01-01', amount: -300, imported_id: 'SHARED', payee_name: 'C' },
        { date: '2031-01-02', amount: -300, imported_id: 'SHARED', payee_name: 'D' },
        { date: '2031-01-03', amount: -400, imported_id: 'NOT-ASKED', payee_name: 'E' },
      ]);
      await session.api.sync();

      const found = await session.gateway.findByImportedIds(id, [
        'FAR-PAST',
        'FAR-FUTURE',
        'SHARED',
        'ABSENT',
      ]);
      assert.deepEqual(found.map((t) => `${t.date} ${t.imported_id}`).sort(), [
        '1999-01-01 FAR-PAST',
        '2031-01-01 SHARED',
        '2031-01-02 SHARED',
        '2099-01-01 FAR-FUTURE',
      ]);
    });

    it('matches an ID holding characters ActualQL would otherwise interpret', async () => {
      // `$oneof` inlines its values into SQL without escaping, so a quote must
      // still match, and must not be able to break or widen the query.
      const id = await account('quoted');
      const awkward = ["O'Brien", "x') OR 1=1 --", '$amount', ':param', 'back\\slash'];
      await session.api.addTransactions(
        id,
        awkward.map((importedId, i) => ({
          date: `2031-01-1${i}`,
          amount: -100 - i,
          imported_id: importedId,
          payee_name: 'Awkward',
        })),
      );
      await session.api.addTransactions(id, [
        { date: '2031-02-01', amount: -999, imported_id: 'BYSTANDER', payee_name: 'B' },
      ]);
      await session.api.sync();

      for (const importedId of awkward) {
        const found = await session.gateway.findByImportedIds(id, [importedId]);
        assert.deepEqual(
          found.map((t) => t.imported_id),
          [importedId],
          `exactly the row holding ${JSON.stringify(importedId)}`,
        );
      }
    });

    it('asks nothing for no IDs, and ignores a blank one', async () => {
      const id = await account('blank');
      await session.api.addTransactions(id, [
        { date: '2031-01-01', amount: -100, payee_name: 'No imported ID' },
      ]);
      await session.api.sync();

      assert.deepEqual(await session.gateway.findByImportedIds(id, []), []);
      assert.deepEqual(await session.gateway.findByImportedIds(id, ['']), []);
    });

    it('returns a split as its parent, with its parts', async () => {
      const id = await account('split');
      await session.api.addTransactions(id, [
        {
          date: '2031-01-01',
          amount: -1000,
          imported_id: 'SPLIT',
          payee_name: 'Split',
          subtransactions: [{ amount: -600 }, { amount: -400 }],
        },
      ]);
      await session.api.sync();

      const [parent, ...rest] = await session.gateway.findByImportedIds(id, ['SPLIT']);
      assert.equal(rest.length, 0);
      assert.ok(parent);
      assert.equal(parent.is_parent, true);
      assert.equal(parent.amount, -1000);
      assert.deepEqual(
        parent.subtransactions?.map((s) => s.amount),
        [-600, -400],
      );
    });
  });
});
