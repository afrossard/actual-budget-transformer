/**
 * Characterization tests for `@actual-app/api`'s write path.
 *
 * These are the five probes from `prototype/38-interactive-import`, turned from
 * scripts that print into tests that assert. Everything the write path was
 * designed around is here: the whole reason `importTransactions` is bypassed,
 * the reason a correction does its own `updateTransaction`, the reason splits
 * are safe, and the reason the reconciled guard has to be ours.
 *
 * ADR-007 exists because Actual version skew has broken assumptions before, so
 * these are the assertions that should fail loudly on a version bump rather
 * than be rediscovered against a real budget. They describe the library, not
 * this tool, which is why they call the api directly.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunAccount,
  openSession,
  serverReachable,
  skipReason,
  type Session,
} from './actual-fixture.ts';

const skip = skipReason(await serverReachable());

describe('integration: what @actual-app/api actually does', { skip }, () => {
  let session: Session;
  let api: typeof import('@actual-app/api');

  before(async () => {
    session = await openSession();
    api = session.api;
  });

  after(async () => {
    await session?.close();
  });

  async function account(label: string): Promise<string> {
    return (await createRunAccount(session, `probe-${label}`)).id;
  }

  const WINDOW = ['2032-01-01', '2037-12-31'] as const;

  async function rows(accountId: string) {
    return api.getTransactions(accountId, WINDOW[0], WINDOW[1]);
  }

  /** Two leaf categories. `getCategories` returns groups too; only a leaf
   * carries a `group_id`. */
  async function twoCategories(): Promise<[string, string]> {
    const leaves = (await api.getCategories()).filter((c) => 'group_id' in c);
    assert.ok(leaves.length >= 2, 'the test budget needs at least two categories');
    return [leaves[0]!.id, leaves[1]!.id];
  }

  it('importTransactions merges where addTransactions adds', async () => {
    // A unique imported ID does NOT stop the merge: Actual's matcher keys on
    // the *candidate* row having none, not on ours. This is why the write path
    // bypasses importTransactions entirely.
    const id = await account('add');
    await api.addTransactions(id, [
      {
        date: '2032-05-10',
        amount: -2500,
        payee_name: 'Typed By Hand',
        notes: 'manual',
      },
    ]);
    await api.sync();

    const merged = await api.importTransactions(id, [
      {
        account: id,
        date: '2032-05-11',
        amount: -2500,
        imported_id: 'PROBE-IMP-1',
        payee_name: 'Bank Copy',
      },
    ]);
    assert.equal(merged.added.length, 0, 'importTransactions added nothing');
    assert.equal(merged.updated.length, 1, 'importTransactions merged instead');

    await api.addTransactions(id, [
      {
        date: '2032-05-12',
        amount: -2500,
        imported_id: 'PROBE-ADD-1',
        payee_name: 'Bank Copy',
      },
    ]);
    await api.sync();

    const stored = await rows(id);
    assert.equal(stored.length, 2, 'addTransactions created a row of its own');
    assert.deepEqual(
      stored.map((t) => t.imported_id).sort(),
      ['PROBE-ADD-1', 'PROBE-IMP-1'],
      'the merge stamped its imported ID onto the hand entry',
    );
  });

  it('on an imported_id match, never writes the amount or the date', async () => {
    // The two fields the bank is most authoritative on are the two Actual will
    // not take. That is why a correction is our own updateTransaction and not a
    // re-import.
    const id = await account('fields');
    const [catA, catB] = await twoCategories();

    await api.addTransactions(id, [
      {
        date: '2034-02-10',
        amount: -5000,
        imported_id: 'PF-FULL',
        payee_name: 'Old Payee',
        notes: 'old notes',
        category: catA,
        cleared: false,
      },
      {
        date: '2034-03-10',
        amount: -7000,
        imported_id: 'PF-EMPTY',
        payee_name: 'Old Payee 2',
        cleared: false,
      },
    ]);
    await api.sync();

    await api.importTransactions(id, [
      {
        account: id,
        date: '2034-02-14',
        amount: -5555,
        imported_id: 'PF-FULL',
        payee_name: 'Bank Payee',
        notes: 'bank notes',
        category: catB,
        cleared: true,
      },
      {
        account: id,
        date: '2034-03-14',
        amount: -7777,
        imported_id: 'PF-EMPTY',
        payee_name: 'Bank Payee',
        notes: 'bank notes',
        category: catB,
        cleared: true,
      },
    ]);
    await api.sync();

    const byId = new Map((await rows(id)).map((t) => [t.imported_id, t]));
    const full = byId.get('PF-FULL')!;
    const empty = byId.get('PF-EMPTY')!;

    for (const [label, tx, date, amount] of [
      ['full', full, '2034-02-10', -5000],
      ['empty', empty, '2034-03-10', -7000],
    ] as const) {
      assert.equal(tx.date, date, `${label}: the date is never written`);
      assert.equal(tx.amount, amount, `${label}: the amount is never written`);
      assert.equal(
        tx.imported_payee,
        'Bank Payee',
        `${label}: imported_payee is written`,
      );
      assert.equal(tx.cleared, true, `${label}: cleared is written`);
    }
    // notes and category are filled only where the existing row had none.
    assert.equal(full.notes, 'old notes', 'the human’s notes win');
    assert.equal(full.category, catA, 'the human’s category wins');
    assert.equal(empty.notes, 'bank notes', 'an empty note is filled');
    assert.equal(empty.category, catB, 'an empty category is filled');
  });

  it('splits survive a re-import and a parent patch', async () => {
    // The constraint that decides how a correction is allowed to work: a
    // split's parts must always still sum to their parent.
    const id = await account('splits');
    const [catA, catB] = await twoCategories();
    await api.addTransactions(id, [
      {
        date: '2033-04-10',
        amount: -10000,
        imported_id: 'PROBE-SPLIT-1',
        payee_name: 'Supermarket',
        subtransactions: [
          { amount: -6000, category: catA, notes: 'groceries' },
          { amount: -4000, category: catB, notes: 'household' },
        ],
      },
    ]);
    await api.sync();

    const reimported = await api.importTransactions(id, [
      {
        account: id,
        date: '2033-04-10',
        amount: -11000,
        imported_id: 'PROBE-SPLIT-1',
        payee_name: 'Supermarket SA',
      },
    ]);
    assert.equal(reimported.updated.length, 1);
    await api.sync();

    let parent = (await rows(id)).find((t) => t.imported_id === 'PROBE-SPLIT-1')!;
    assert.equal(parent.amount, -10000, 'a re-import cannot change the amount');
    assert.deepEqual(
      parent.subtransactions?.map((s) => s.amount),
      [-6000, -4000],
      'the parts are untouched',
    );

    await api.updateTransaction(parent.id, { date: '2033-04-12', notes: 'patched' });
    await api.sync();

    parent = (await rows(id)).find((t) => t.imported_id === 'PROBE-SPLIT-1')!;
    assert.equal(parent.date, '2033-04-12', 'a patch does take the date');
    assert.equal(parent.notes, 'patched');
    assert.equal(parent.amount, -10000);
    assert.deepEqual(
      parent.subtransactions?.map((s) => s.amount),
      [-6000, -4000],
      'patching the parent leaves the parts alone',
    );
  });

  it('importTransactions refuses a reconciled match and adds a second row instead', async () => {
    // So importing a pending card row trades a missing transaction for a
    // duplicate one until identity across booking is solved (#47, #48).
    const id = await account('reconciled');
    await api.addTransactions(id, [
      { date: '2036-07-10', amount: -2162, payee_name: 'Pending Intl Card' },
    ]);
    await api.sync();
    const pending = (await rows(id))[0]!;
    await api.updateTransaction(pending.id, { reconciled: true });
    await api.sync();

    const booked = await api.importTransactions(id, [
      {
        account: id,
        date: '2036-07-12',
        amount: -2210,
        imported_id: 'BOOKED-1',
        payee_name: 'Intl Card Booked',
      },
    ]);
    assert.equal(booked.added.length, 1, 'it created a second transaction');
    assert.equal(booked.updated.length, 0, 'it touched nothing reconciled');
    assert.equal((await rows(id)).length, 2);
  });

  it('updateTransaction has no reconciled guard, so the guard has to be ours', async () => {
    // ADR-002's keystone rule - never touch a reconciled transaction - is not
    // something Actual enforces on this path. The review loop's per-row
    // confirmation is the only thing standing in the way.
    const id = await account('patch');
    await api.addTransactions(id, [
      {
        date: '2037-01-10',
        amount: -1000,
        payee_name: 'Reconciled Row',
        notes: 'seed',
      },
    ]);
    await api.sync();
    const row = (await rows(id))[0]!;
    await api.updateTransaction(row.id, { reconciled: true });
    await api.sync();

    await api.updateTransaction(row.id, {
      date: '2037-01-12',
      amount: -1111,
      notes: 'patched',
    });
    await api.sync();

    const after = (await rows(id))[0]!;
    assert.equal(after.date, '2037-01-12', 'the patch went through');
    assert.equal(after.amount, -1111);
    assert.equal(after.notes, 'patched');
    assert.equal(after.reconciled, true, 'and reconciled stayed true');
  });
});
