import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { accountNameFor, loadConfig, requireActualConfig } from '../../src/config.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

test('the shipped template loads', () => {
  const config = loadConfig(REPO + 'config.template.yml', {});
  assert.equal(config.accountNames['CH0000000000'], 'personal_checking');
  assert.equal(config.actual.serverUrl, 'http://actual-server:5006');
});

test('account identifiers match however the bank spaces them', () => {
  const config = loadConfig(REPO + 'tests/data/test_config.yml', {});
  assert.equal(accountNameFor(config, 'CH9DDD C4D8 456C 5AFF ACD'), 'test_account');
  assert.equal(accountNameFor(config, '9659086893219337559'), 'test_card');
});

test('an unmapped identifier falls back to itself', () => {
  const config = loadConfig(REPO + 'tests/data/test_config.yml', {});
  assert.equal(accountNameFor(config, 'CH-UNKNOWN'), 'CH-UNKNOWN');
});

test('the environment wins over the file on the sensitive values', () => {
  const config = loadConfig(REPO + 'config.template.yml', {
    ACTUAL_BUDGET_URL: 'http://localhost:5006',
    ACTUAL_BUDGET_PASSWORD: 'from-env',
    ACTUAL_BUDGET_FILE: 'Test Budget',
  });
  assert.deepEqual(requireActualConfig(config), {
    serverUrl: 'http://localhost:5006',
    password: 'from-env',
    budgetName: 'Test Budget',
    dataDir: null,
  });
});

test('an incomplete config fails before the server is touched, naming what is missing', () => {
  const config = loadConfig(REPO + 'config.template.yml', {});
  assert.throws(
    () => requireActualConfig(config),
    /missing password \(or ACTUAL_BUDGET_PASSWORD\), budget_name/,
  );
});

test('no config file at all is an incomplete config, not a crash', () => {
  const config = loadConfig(undefined, {});
  assert.deepEqual(config.accountNames, {});
  assert.throws(() => requireActualConfig(config), /server_url/);
});
