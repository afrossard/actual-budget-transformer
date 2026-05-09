/**
 * Bootstrap a test budget on a fresh Actual Budget server.
 *
 * Usage:
 *   ACTUAL_DATA_DIR=/tmp/actual-data npx tsx scripts/bootstrap_test_budget.ts
 *
 * Environment:
 *   ACTUAL_SERVER_URL  - server URL (default: http://actual-server:5006)
 *   ACTUAL_DATA_DIR    - local data directory for the API (required)
 *   ACTUAL_PASSWORD    - server password (default: test-password)
 */
import { mkdirSync, rmSync } from 'node:fs';

const serverURL = process.env.ACTUAL_SERVER_URL || 'http://actual-server:5006';
const password = process.env.ACTUAL_PASSWORD || 'test-password';
const dataDir = process.env.ACTUAL_DATA_DIR;

if (!dataDir) {
  console.error('ACTUAL_DATA_DIR environment variable is required');
  process.exit(1);
}

// Always start with a fresh local cache. @actual-app/api keeps process-global
// state that survives shutdown(); recovering from a stale local cache mid-run
// can leave the API referencing a budget the server no longer has, triggering
// background syncs that crash the script. Wiping up-front is simpler than
// in-process recovery, and the test budget is small enough that re-downloading
// on every bootstrap is cheap.
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

interface BootstrapResponse {
  data: { bootstrapped: boolean };
}

interface ApiResponse {
  status: string;
}

interface Budget {
  name: string;
  groupId: string;
}

interface Account {
  id: string;
  name: string;
}

interface CategoryGroup {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
  group_id: string;
}

async function bootstrap(dataDir: string): Promise<void> {
  const api = await import('@actual-app/api');
  // Step 1: Bootstrap server password if needed
  const needsBootstrap = await fetch(`${serverURL}/account/needs-bootstrap`);
  const { data } = (await needsBootstrap.json()) as BootstrapResponse;

  if (!data.bootstrapped) {
    console.log('Bootstrapping server password...');
    const resp = await fetch(`${serverURL}/account/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const result = (await resp.json()) as ApiResponse;
    if (result.status !== 'ok') {
      throw new Error(`Bootstrap failed: ${JSON.stringify(result)}`);
    }
    console.log('Server bootstrapped.');
  } else {
    console.log('Server already bootstrapped.');
  }

  // Step 2: Connect and create budget. Local cache was wiped at startup, so
  // getBudgets() returns only what the server has.
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const existing = budgets.find((b) => b.name === 'Test Budget');
  const needsCreate = !existing;
  if (existing) {
    console.log('Test Budget already exists on server, downloading...');
    await api.downloadBudget(existing.groupId);
  }
  if (needsCreate) {
    console.log('Creating Test Budget...');
    await api.runImport('Test Budget', async () => {
      // Create accounts inside runImport — budget is only available within this callback
      for (const name of ['Test Checking', 'Test Savings', 'Test Credit Card']) {
        const id = await api.createAccount({ name }, 0);
        console.log(`Created account: ${name} (${id})`);
      }
    });
  }

  // Step 3: Ensure all accounts exist (idempotent for re-runs)
  const accounts = (await api.getAccounts()) as Account[];
  const accountNames = accounts.map((a) => a.name);

  for (const name of ['Test Checking', 'Test Savings', 'Test Credit Card']) {
    if (!accountNames.includes(name)) {
      const id = await api.createAccount({ name }, 0);
      console.log(`Created account: ${name} (${id})`);
    } else {
      console.log(`Account already exists: ${name}`);
    }
  }

  // Step 4: Ensure the "Review" group + "To Review" category exist. Used by
  // the direct-import bucket classification (ADR-006) to flag uncertain
  // matches for human review.
  const groups = (await api.getCategoryGroups()) as CategoryGroup[];
  let reviewGroup = groups.find((g) => g.name === 'Review');
  if (!reviewGroup) {
    const id = await api.createCategoryGroup({ name: 'Review' });
    reviewGroup = { id, name: 'Review' };
    console.log(`Created category group: Review (${id})`);
  } else {
    console.log('Category group already exists: Review');
  }

  const cats = (await api.getCategories()) as Category[];
  const haveReview = cats.some(
    (c) => c.name === 'To Review' && c.group_id === reviewGroup!.id,
  );
  if (!haveReview) {
    const id = await api.createCategory({
      name: 'To Review',
      group_id: reviewGroup.id,
    });
    console.log(`Created category: To Review (${id})`);
  } else {
    console.log('Category already exists: To Review');
  }

  await api.sync();

  // Summary
  const finalAccounts = (await api.getAccounts()) as Account[];
  console.log('\nAccounts:');
  for (const a of finalAccounts) {
    console.log(`  - ${a.name} (${a.id})`);
  }

  await api.shutdown();
  console.log('\nDone. Budget is ready on the server.');
}

bootstrap(dataDir).catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
