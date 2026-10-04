/**
 * End-to-end smoke test: import transactions into a live Actual Budget server
 * and read them back.
 *
 * Preconditions:
 *   - Actual server reachable (`actual-up`)
 *   - "Test Budget" bootstrapped with a "Test Checking" account (`npm run bootstrap`)
 *
 * Usage:
 *   npm run test:actual
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApi, apiPackage } from '../../scripts/api-loader.ts';

console.log(`Using API package: ${apiPackage}`);

const serverURL = process.env.ACTUAL_SERVER_URL || 'http://actual-server:5006';
const password = process.env.ACTUAL_PASSWORD || 'test-password';

interface Budget {
  name: string;
  groupId: string;
}

interface Account {
  id: string;
  name: string;
}

interface Transaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee_name?: string;
  imported_id?: string | null;
  notes?: string | null;
}

let dataDir: string;
let accountId: string;
let api: Awaited<ReturnType<typeof loadApi>>;
const runTag = `roundtrip-${Date.now()}`;

before(async () => {
  api = await loadApi();
  dataDir = mkdtempSync(join(tmpdir(), 'actual-test-'));
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const budget = budgets.find((b) => b.name === 'Test Budget');
  if (!budget) {
    throw new Error('Test Budget not found on server. Run `npm run bootstrap` first.');
  }
  await api.downloadBudget(budget.groupId);

  const accounts = (await api.getAccounts()) as Account[];
  const checking = accounts.find((a) => a.name === 'Test Checking');
  if (!checking) {
    throw new Error('Test Checking account not found. Run `npm run bootstrap` first.');
  }
  accountId = checking.id;
});

after(async () => {
  await api.shutdown();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('importTransactions round-trip: written rows come back intact', async () => {
  const txs = [
    {
      account: accountId,
      date: '2026-01-05',
      amount: -1234,
      payee_name: 'Coffee Shop',
      imported_id: `${runTag}-1`,
      notes: 'morning latte',
    },
    {
      account: accountId,
      date: '2026-01-06',
      amount: -8900,
      payee_name: 'Grocery Store',
      imported_id: `${runTag}-2`,
      notes: 'weekly shop',
    },
    {
      account: accountId,
      date: '2026-01-07',
      amount: 250000,
      payee_name: 'Employer',
      imported_id: `${runTag}-3`,
      notes: 'salary',
    },
  ];

  const result = await api.importTransactions(accountId, txs);
  assert.equal(
    result.errors?.length ?? 0,
    0,
    `import errors: ${JSON.stringify(result.errors)}`,
  );
  assert.equal(result.added.length, txs.length, 'all rows should be newly added');

  const fetched = (await api.getTransactions(
    accountId,
    '2026-01-01',
    '2026-01-31',
  )) as Transaction[];

  const mine = fetched.filter((t) => t.imported_id?.startsWith(runTag));
  assert.equal(
    mine.length,
    txs.length,
    'should read back exactly the rows we imported',
  );

  for (const source of txs) {
    const match = mine.find((t) => t.imported_id === source.imported_id);
    assert.ok(match, `missing imported_id ${source.imported_id}`);
    assert.equal(match.amount, source.amount, 'amount mismatch');
    assert.equal(match.date, source.date, 'date mismatch');
    assert.equal(match.notes, source.notes, 'notes mismatch');
  }
});
