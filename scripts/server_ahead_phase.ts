/**
 * Single phase of the server-ahead skew assessment.
 *
 * Mirrors plan-direct-actual-import.md "Server-ahead assessment methodology".
 * Three phases share a fixed input set; each asserts bit-for-bit readback,
 * cross-batch survival, idempotency, and account balance.
 *
 * Phases:
 *   baseline  V_OLD server, V_OLD API, fresh dataDir. Seeds 3 tx and validates.
 *   warm      V_NEW server (post-migration), V_OLD API, retained dataDir.
 *             Uses loadBudget + sync to exercise cross-migration delta sync.
 *             Imports 3 more tx, asserts seed survived bit-for-bit.
 *   cold      V_NEW server, V_OLD API, wiped dataDir.
 *             Uses downloadBudget to refetch the migrated budget fresh.
 *             Imports 3 more tx, asserts seed+warm survived bit-for-bit.
 *
 * Env:
 *   PHASE_MODE          baseline | warm | cold
 *   ACTUAL_DATA_DIR     local API data dir (caller controls retain/wipe)
 *   ACTUAL_API_VERSION  pin (selects @actual-app/api-* alias via api-loader)
 *   ACTUAL_SERVER_URL   default http://actual-server:5006
 *   ACTUAL_PASSWORD     default test-password
 */
import { mkdirSync } from 'node:fs';
import { loadApi, apiPackage } from './api-loader.ts';

const mode = process.env.PHASE_MODE;
const dataDir = process.env.ACTUAL_DATA_DIR;
const serverURL = process.env.ACTUAL_SERVER_URL || 'http://actual-server:5006';
const password = process.env.ACTUAL_PASSWORD || 'test-password';
const BUDGET_NAME = 'Test Budget';
const ACCOUNT_NAME = 'Test Checking';

if (mode !== 'baseline' && mode !== 'warm' && mode !== 'cold') {
  console.error(`PHASE_MODE must be baseline|warm|cold (got: ${mode ?? '<unset>'})`);
  process.exit(1);
}
if (!dataDir) {
  console.error('ACTUAL_DATA_DIR is required');
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });

interface SourceTx {
  date: string;
  amount: number;
  payee_name: string;
  imported_id: string;
  notes: string;
}

const SEED_TXS: SourceTx[] = [
  {
    date: '2026-01-15',
    amount: -2599,
    payee_name: 'Coffee Test',
    imported_id: 'seed-1',
    notes: 'baseline coffee',
  },
  {
    date: '2026-01-16',
    amount: -12345,
    payee_name: 'Grocery Test',
    imported_id: 'seed-2',
    notes: 'baseline groceries',
  },
  {
    date: '2026-01-31',
    amount: 250000,
    payee_name: 'Salary Test',
    imported_id: 'seed-3',
    notes: 'baseline salary',
  },
];

const WARM_TXS: SourceTx[] = [
  {
    date: '2026-02-15',
    amount: -3499,
    payee_name: 'Cafe Test',
    imported_id: 'warm-1',
    notes: 'warm cafe',
  },
  {
    date: '2026-02-16',
    amount: -7800,
    payee_name: 'Pharmacy Test',
    imported_id: 'warm-2',
    notes: 'warm pharmacy',
  },
  {
    date: '2026-02-28',
    amount: 250000,
    payee_name: 'Salary Test',
    imported_id: 'warm-3',
    notes: 'warm salary',
  },
];

const COLD_TXS: SourceTx[] = [
  {
    date: '2026-03-15',
    amount: -4200,
    payee_name: 'Restaurant Test',
    imported_id: 'cold-1',
    notes: 'cold restaurant',
  },
  {
    date: '2026-03-16',
    amount: -9999,
    payee_name: 'Bookstore Test',
    imported_id: 'cold-2',
    notes: 'cold bookstore',
  },
  {
    date: '2026-03-31',
    amount: 250000,
    payee_name: 'Salary Test',
    imported_id: 'cold-3',
    notes: 'cold salary',
  },
];

const sumAmounts = (txs: SourceTx[]): number =>
  txs.reduce((acc, t) => acc + t.amount, 0);

interface ImportResult {
  added: unknown[];
  updated?: unknown[];
  errors?: unknown[];
}

interface FetchedTx {
  id: string;
  date: string;
  amount: number;
  notes?: string | null;
  imported_id?: string | null;
  payee?: string | null;
  account?: string | null;
}

interface Budget {
  name: string;
  groupId: string;
}

interface Account {
  id: string;
  name: string;
}

function fail(msg: string): never {
  console.error(`[${mode}] FAIL: ${msg}`);
  process.exit(1);
}

function tag(): string {
  return `[${mode}]`;
}

function withAccount(txs: SourceTx[], accountId: string): unknown[] {
  return txs.map((t) => ({ ...t, account: accountId }));
}

function assertImportClean(result: ImportResult, expectedAdded: number): void {
  if (result.errors && result.errors.length > 0) {
    fail(`importTransactions returned errors: ${JSON.stringify(result.errors)}`);
  }
  if (!Array.isArray(result.added) || result.added.length !== expectedAdded) {
    fail(
      `expected ${expectedAdded} added, got ${
        Array.isArray(result.added) ? result.added.length : '?'
      } (result=${JSON.stringify(result)})`,
    );
  }
}

function assertIdempotent(result: ImportResult): void {
  if (result.errors && result.errors.length > 0) {
    fail(`re-import returned errors: ${JSON.stringify(result.errors)}`);
  }
  if (Array.isArray(result.added) && result.added.length !== 0) {
    fail(`re-import added ${result.added.length} (expected 0)`);
  }
}

function assertReadbackBitForBit(
  fetched: FetchedTx[],
  expected: SourceTx[],
  accountId: string,
): void {
  const byImportedId = new Map<string, FetchedTx>();
  for (const t of fetched) {
    if (t.imported_id) byImportedId.set(t.imported_id, t);
  }
  for (const src of expected) {
    const got = byImportedId.get(src.imported_id);
    if (!got) {
      fail(`missing imported_id ${src.imported_id} in readback`);
    }
    if (got.amount !== src.amount) {
      fail(
        `${src.imported_id}: amount ${got.amount} != ${src.amount}`,
      );
    }
    if (got.date !== src.date) {
      fail(`${src.imported_id}: date ${got.date} != ${src.date}`);
    }
    if ((got.notes ?? '') !== src.notes) {
      fail(
        `${src.imported_id}: notes ${JSON.stringify(got.notes)} != ${JSON.stringify(src.notes)}`,
      );
    }
    if (got.account !== accountId) {
      fail(
        `${src.imported_id}: account ${JSON.stringify(got.account)} != ${accountId}`,
      );
    }
  }
}

async function fetchAll(
  api: Awaited<ReturnType<typeof loadApi>>,
  accountId: string,
): Promise<FetchedTx[]> {
  return (await api.getTransactions(
    accountId,
    '2020-01-01',
    '2099-12-31',
  )) as FetchedTx[];
}

async function run(): Promise<void> {
  console.log(`${tag()} api=${apiPackage} server=${serverURL} dataDir=${dataDir}`);
  const api = await loadApi();
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const budget = budgets.find((b) => b.name === BUDGET_NAME);
  if (!budget) {
    fail(
      `budget '${BUDGET_NAME}' not found. Available: ${
        budgets.map((b) => b.name).join(', ') || '(none)'
      }`,
    );
  }

  // All modes use downloadBudget — loadBudget is offline-mode only and throws
  // when init was given a serverURL. The warm/cold distinction lives in the
  // ACTUAL_DATA_DIR state the orchestrator hands us (retained vs wiped).
  await api.downloadBudget(budget.groupId);

  // Phase 3 step 1 (warm) / step 2 (cold) — sync immediately.
  // For baseline this is a no-op against a fresh server.
  await api.sync();
  console.log(`${tag()} sync OK after open`);

  const accounts = (await api.getAccounts()) as Account[];
  const account = accounts.find((a) => a.name === ACCOUNT_NAME);
  if (!account) {
    fail(
      `account '${ACCOUNT_NAME}' not found. Available: ${
        accounts.map((a) => a.name).join(', ') || '(none)'
      }`,
    );
  }
  const accountId = account.id;

  if (mode === 'baseline') {
    const result = (await api.importTransactions(
      accountId,
      withAccount(SEED_TXS, accountId) as never,
    )) as ImportResult;
    assertImportClean(result, SEED_TXS.length);
    await api.sync();

    const fetched = await fetchAll(api, accountId);
    assertReadbackBitForBit(fetched, SEED_TXS, accountId);
    console.log(`${tag()} readback OK (${SEED_TXS.length} seed tx bit-for-bit)`);

    const reResult = (await api.importTransactions(
      accountId,
      withAccount(SEED_TXS, accountId) as never,
    )) as ImportResult;
    assertIdempotent(reResult);
    console.log(`${tag()} re-import idempotent`);

    const expectedBalance = sumAmounts(SEED_TXS);
    const balance = (await api.getAccountBalance(accountId)) as number;
    if (balance !== expectedBalance) {
      fail(`balance ${balance} != expected ${expectedBalance}`);
    }
    console.log(`${tag()} balance ${balance} matches expected`);
  } else if (mode === 'warm') {
    const before = await fetchAll(api, accountId);
    assertReadbackBitForBit(before, SEED_TXS, accountId);
    console.log(`${tag()} seed survived migration bit-for-bit`);

    const result = (await api.importTransactions(
      accountId,
      withAccount(WARM_TXS, accountId) as never,
    )) as ImportResult;
    assertImportClean(result, WARM_TXS.length);
    await api.sync();

    const fetched = await fetchAll(api, accountId);
    assertReadbackBitForBit(fetched, [...SEED_TXS, ...WARM_TXS], accountId);
    console.log(`${tag()} readback OK (seed+warm bit-for-bit)`);

    const reResult = (await api.importTransactions(
      accountId,
      withAccount(WARM_TXS, accountId) as never,
    )) as ImportResult;
    assertIdempotent(reResult);
    console.log(`${tag()} re-import idempotent`);

    const expectedBalance = sumAmounts([...SEED_TXS, ...WARM_TXS]);
    const balance = (await api.getAccountBalance(accountId)) as number;
    if (balance !== expectedBalance) {
      fail(`balance ${balance} != expected ${expectedBalance}`);
    }
    console.log(`${tag()} balance ${balance} matches expected`);
  } else if (mode === 'cold') {
    // Whether the warm batch is on the server depends on whether the warm
    // phase ran successfully. The orchestrator passes COLD_EXPECT_WARM=1 only
    // when warm passed.
    const expectWarm = process.env.COLD_EXPECT_WARM === '1';
    const priorTxs = expectWarm ? [...SEED_TXS, ...WARM_TXS] : SEED_TXS;
    const priorLabel = expectWarm ? 'seed+warm' : 'seed only';

    const before = await fetchAll(api, accountId);
    assertReadbackBitForBit(before, priorTxs, accountId);
    console.log(`${tag()} ${priorLabel} survived re-download bit-for-bit`);

    const result = (await api.importTransactions(
      accountId,
      withAccount(COLD_TXS, accountId) as never,
    )) as ImportResult;
    assertImportClean(result, COLD_TXS.length);
    await api.sync();

    const fetched = await fetchAll(api, accountId);
    assertReadbackBitForBit(fetched, [...priorTxs, ...COLD_TXS], accountId);
    console.log(`${tag()} readback OK (${priorLabel}+cold bit-for-bit)`);

    const reResult = (await api.importTransactions(
      accountId,
      withAccount(COLD_TXS, accountId) as never,
    )) as ImportResult;
    assertIdempotent(reResult);
    console.log(`${tag()} re-import idempotent`);

    const expectedBalance = sumAmounts([...priorTxs, ...COLD_TXS]);
    const balance = (await api.getAccountBalance(accountId)) as number;
    if (balance !== expectedBalance) {
      fail(`balance ${balance} != expected ${expectedBalance}`);
    }
    console.log(`${tag()} balance ${balance} matches expected`);
  }

  await api.shutdown();
  console.log(`${tag()} OK`);
}

run().catch((err: unknown) => {
  const e = err as Error;
  console.error(`${tag()} ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
