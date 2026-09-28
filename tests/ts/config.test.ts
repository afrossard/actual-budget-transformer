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

test('format settings default to the shipped UBS layout', () => {
  const config = loadConfig(undefined, {});
  assert.equal(config.formats.ubsAccountCsv.encoding, 'utf8');
  assert.equal(config.formats.ubsAccountCsv.headerRows, 8);
  assert.equal(config.formats.ubsCardsCsv.encoding, 'latin1');
  assert.equal(config.formats.ubsCardsCsv.headerRow, 2);
  assert.deepEqual(config.formats.ubsCardsCsv.referenceColumns, [
    "Date d'achat",
    'Texte comptable',
    'Montant',
    'Monnaie originale',
  ]);
});

test('the shipped template reproduces the defaults exactly', () => {
  // The template and the built-in defaults must not drift: a user who copies the
  // template must get the behaviour they would have got without one.
  const fromTemplate = loadConfig(REPO + 'config.template.yml', {});
  const builtIn = loadConfig(undefined, {});
  assert.deepEqual(fromTemplate.formats, builtIn.formats);
});

test("the config can rename the bank's columns, which is the point of it", () => {
  const config = loadConfig(REPO + 'tests/data/test_config_english.yml', {});
  assert.deepEqual(config.formats.ubsAccountCsv.preambleLabels[0], 'Account number:');
  assert.equal(config.formats.ubsAccountCsv.transactionColumns[5], 'Debit');
  assert.equal(config.formats.ubsAccountCsv.dateFormat, '%d.%m.%Y');
  assert.equal(config.formats.ubsCardsCsv.encoding, 'utf8');
  assert.equal(config.formats.ubsCardsCsv.separator, ',');
});

test('a partly-specified processor block keeps the defaults for the rest', () => {
  // Someone fixing one renamed column should not have to restate the whole
  // format, and should not silently lose the keys they left out.
  const config = loadConfig(REPO + 'tests/data/test_config_english.yml', {});
  assert.equal(config.formats.ubsAccountCsv.headerRows, 8, 'not restated, kept');
  assert.deepEqual(
    config.formats.ubsCardsCsv.referenceColumns,
    loadConfig(undefined, {}).formats.ubsCardsCsv.referenceColumns,
  );
});

test("the Python path's trailing pandas placeholder column is ignored", () => {
  // `expected_transaction_labels` ends with "Unnamed: 14" in the shared config,
  // which names nothing. One config file has to serve both readers.
  const config = loadConfig(REPO + 'config.template.yml', {});
  assert.equal(config.formats.ubsAccountCsv.transactionColumns.length, 14);
  assert.equal(
    config.formats.ubsAccountCsv.transactionColumns.at(-1),
    'Notes de bas de page',
  );
});

test('an unusable encoding is rejected by name rather than guessed', () => {
  assert.throws(
    () => loadConfig(REPO + 'tests/data/test_config_bad_encoding.yml', {}),
    /unsupported encoding "EBCDIC"/,
  );
});

test('a broken config says where it is broken, not how the parser failed', () => {
  // The file exists to be edited, so a typo has to read as a typo.
  assert.throws(
    () => loadConfig(REPO + 'tests/data/test_config_broken.yml', {}),
    /test_config_broken\.yml is not valid YAML at line 4: /,
  );
});

test('a missing config file is named rather than thrown from fs', () => {
  assert.throws(
    () => loadConfig(REPO + 'tests/data/does_not_exist.yml', {}),
    /cannot read config .*does_not_exist\.yml/,
  );
});
