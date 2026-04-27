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
import { loadApi, apiPackage } from './api-loader.ts';

const serverURL = process.env.ACTUAL_SERVER_URL || 'http://actual-server:5006';
const password = process.env.ACTUAL_PASSWORD || 'test-password';
const dataDir = process.env.ACTUAL_DATA_DIR;

if (!dataDir) {
  console.error('ACTUAL_DATA_DIR environment variable is required');
  process.exit(1);
}

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

async function bootstrap(dataDir: string): Promise<void> {
  console.log(`Using API package: ${apiPackage}`);
  const api = await loadApi();
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

  // Step 2: Connect and create budget
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const existing = budgets.find((b) => b.name === 'Test Budget');
  let needsCreate = !existing;
  if (existing) {
    console.log('Test Budget already exists, downloading...');
    try {
      await api.downloadBudget(existing.groupId);
    } catch (err) {
      // Server was wiped (e.g. tmpfs /data, fresh container) but local cache
      // still lists the budget. Reset the local data dir and recreate.
      if ((err as { reason?: string }).reason !== 'file-not-found') throw err;
      console.log(
        'Server has no copy of Test Budget; resetting local cache and recreating.',
      );
      await api.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      await api.init({ serverURL, password, dataDir });
      needsCreate = true;
    }
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
