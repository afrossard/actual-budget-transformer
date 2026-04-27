/**
 * Single phase of the staggered-upgrade test.
 *
 * Opens the existing Test Budget, asserts that every prior phase's tagged
 * transactions are still present, then imports a fresh batch tagged with this
 * phase's label. The orchestrator (scripts/test_staggered_upgrade.sh) restarts
 * the server with different image tags and runs this script under different
 * @actual-app/api versions between phases, so the budget volume is the only
 * state crossing the version boundary.
 *
 * Env:
 *   PHASE_NAME          - label for this phase's imported_id prefix (e.g. p1)
 *   PHASE_PRIOR_NAMES   - comma-separated prior labels expected to survive
 *   PHASE_INDEX         - 1-based phase number; used to pick a unique month
 *   PHASE_TX_COUNT      - tx count to import this phase (default 3)
 *   ACTUAL_DATA_DIR     - local API data dir
 *   ACTUAL_SERVER_URL   - default http://actual-server:5006
 *   ACTUAL_PASSWORD     - default test-password
 *   ACTUAL_API_VERSION  - selects which @actual-app/api alias (api-loader.ts)
 */
import { mkdirSync } from 'node:fs';
import { loadApi, apiPackage } from './api-loader.ts';

const phaseName = process.env.PHASE_NAME;
const priorNames = (process.env.PHASE_PRIOR_NAMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const phaseIndex = Number(process.env.PHASE_INDEX || '1');
const txCount = Number(process.env.PHASE_TX_COUNT || '3');
const dataDir = process.env.ACTUAL_DATA_DIR;
const serverURL = process.env.ACTUAL_SERVER_URL || 'http://actual-server:5006';
const password = process.env.ACTUAL_PASSWORD || 'test-password';

if (!phaseName || !dataDir) {
  console.error('PHASE_NAME and ACTUAL_DATA_DIR are required');
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });

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
  date: string;
  amount: number;
  imported_id?: string | null;
}

async function run(phaseName: string, dataDir: string): Promise<void> {
  console.log(`[${phaseName}] api=${apiPackage} server=${serverURL}`);
  const api = await loadApi();
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const budget = budgets.find((b) => b.name === 'Test Budget');
  if (!budget) {
    throw new Error(
      'Test Budget missing — bootstrap_test_budget.ts must run before this phase',
    );
  }
  await api.downloadBudget(budget.groupId);

  const accounts = (await api.getAccounts()) as Account[];
  const checking = accounts.find((a) => a.name === 'Test Checking');
  if (!checking) {
    throw new Error(
      'Test Checking missing — bootstrap_test_budget.ts must run before this phase',
    );
  }
  const accountId = checking.id;

  const all = (await api.getTransactions(
    accountId,
    '2020-01-01',
    '2099-12-31',
  )) as Transaction[];

  for (const prior of priorNames) {
    const found = all.filter((t) => t.imported_id?.startsWith(`${prior}-`));
    if (found.length === 0) {
      throw new Error(
        `expected prior phase '${prior}' transactions to survive — none found on server`,
      );
    }
    console.log(`[${phaseName}] prior '${prior}' survived: ${found.length} tx`);
  }

  const month = String(((phaseIndex - 1) % 12) + 1).padStart(2, '0');
  const tag = `${phaseName}-${Date.now()}`;
  const txs = Array.from({ length: txCount }, (_, i) => ({
    account: accountId,
    date: `2026-${month}-${String(i + 1).padStart(2, '0')}`,
    amount: -1000 * (i + 1) - phaseIndex,
    payee_name: `${phaseName} payee ${i}`,
    imported_id: `${tag}-${i}`,
    notes: `${phaseName}`,
  }));

  const result = await api.importTransactions(accountId, txs);
  if (result.errors?.length) {
    throw new Error(`import errors: ${JSON.stringify(result.errors)}`);
  }
  if (result.added.length !== txs.length) {
    throw new Error(`expected ${txs.length} added, got ${result.added.length}`);
  }
  console.log(`[${phaseName}] imported ${txs.length} new tx (tag=${tag})`);

  const after = (await api.getTransactions(
    accountId,
    '2020-01-01',
    '2099-12-31',
  )) as Transaction[];
  const mine = after.filter((t) => t.imported_id?.startsWith(`${tag}-`));
  if (mine.length !== txs.length) {
    throw new Error(
      `round-trip failed: imported ${txs.length} but read back ${mine.length} for tag ${tag}`,
    );
  }
  for (const prior of priorNames) {
    const stillThere = after.filter((t) => t.imported_id?.startsWith(`${prior}-`));
    if (stillThere.length === 0) {
      throw new Error(`prior phase '${prior}' transactions vanished after import`);
    }
  }

  await api.sync();
  await api.shutdown();
  console.log(`[${phaseName}] OK`);
}

run(phaseName, dataDir).catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
