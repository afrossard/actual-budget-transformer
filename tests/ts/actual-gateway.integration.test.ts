/**
 * The gateway's targeted reads, against a real Actual server (#67), and its one
 * patch, the correction (ADR 0007).
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

  describe('correctAmount', () => {
    async function seeded(label: string, reconciled: boolean, split = false) {
      const id = await account(label);
      await session.api.addTransactions(id, [
        {
          date: '2031-04-10',
          amount: -1495,
          imported_id: 'FX',
          payee_name: 'Renamed in Actual',
          ...(split ? { subtransactions: [{ amount: -995 }, { amount: -500 }] } : {}),
        },
      ]);
      await session.api.sync();
      if (reconciled) await reconcile(id, isoDate('2031-04-10'));
      const [tx] = await session.gateway.findByImportedIds(id, ['FX']);
      assert.ok(tx);
      return { id, tx };
    }

    async function stored(id: AccountId) {
      const [tx, ...rest] = await session.gateway.getAccountHistory(id);
      assert.equal(rest.length, 0);
      assert.ok(tx);
      return tx;
    }

    it('sets the amount alone', async () => {
      const { id, tx } = await seeded('correct', false);
      await session.gateway.correctAmount(id, tx, -1290, {
        reconciledConfirmed: false,
      });
      await session.gateway.sync();
      const after = await stored(id);
      assert.equal(after.amount, -1290);
      assert.equal(after.date, tx.date);
      assert.equal(after.payeeName, 'Renamed in Actual');
    });

    it('refuses a reconciled one unless review confirmed it', async () => {
      const { id, tx } = await seeded('correct-reconciled', true);
      await assert.rejects(
        session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: false }),
        /reconciled/,
      );
      assert.equal((await stored(id)).amount, -1495);

      await session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: true });
      await session.gateway.sync();
      assert.equal((await stored(id)).amount, -1290);
    });

    it('refuses a split, even confirmed', async () => {
      const { id, tx } = await seeded('correct-split', false, true);
      await assert.rejects(
        session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: true }),
        /split/,
      );
      assert.equal((await stored(id)).amount, -1495);
    });

    it('refuses a transfer, even confirmed', async () => {
      const id = await account('correct-transfer');
      const other = await account('correct-transfer-other');
      const payee = (await session.api.getPayees()).find(
        (p) => p.transfer_acct === other,
      )!;
      await session.api.addTransactions(
        id,
        [{ date: '2031-04-10', amount: -1495, imported_id: 'FX', payee: payee.id }],
        { runTransfers: true },
      );
      await session.api.sync();
      const [tx] = await session.gateway.findByImportedIds(id, ['FX']);
      assert.ok(tx?.transfer_id);
      await assert.rejects(
        session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: true }),
        /transfer/,
      );
      assert.equal((await stored(id)).amount, -1495);
    });

    it('refuses one whose amount has changed in Actual since it was read', async () => {
      // The human may fix it by hand while a review prompt waits.
      const { id, tx } = await seeded('correct-changed', false);
      await session.api.updateTransaction(tx.id, { amount: -1300 });
      await session.api.sync();
      await assert.rejects(
        session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: true }),
        /changed in Actual/,
      );
      assert.equal((await stored(id)).amount, -1300);
    });

    it('refuses one reconciled since it was read', async () => {
      // The guard is on what Actual holds now, not on the copy the run read.
      const { id, tx } = await seeded('correct-stale', false);
      await reconcile(id, isoDate('2031-04-10'));
      await assert.rejects(
        session.gateway.correctAmount(id, tx, -1290, { reconciledConfirmed: false }),
        /reconciled/,
      );
    });
  });
});
