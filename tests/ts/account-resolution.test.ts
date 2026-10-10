import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { resolveAccount } from '../../src/account-resolution.ts';
import type { Account, AccountId } from '../../src/actual-gateway.ts';
import type { AccountTarget } from '../../src/config.ts';

const IBAN = 'CH4200120123A12345678';

// Resolution reads only the name; the ID is carried, never inspected.
const accountId = (value: string): AccountId => value as AccountId;

function accounts(...names: string[]): Account[] {
  return names.map((name, i) => ({ id: accountId(`id-${i}`), name, closed: false }));
}

function mapped(name: string): AccountTarget {
  return { accountKey: IBAN, name, mapped: true };
}

const UNMAPPED: AccountTarget = { accountKey: IBAN, name: IBAN, mapped: false };

function failure(target: AccountTarget, budget: readonly Account[]): string {
  try {
    resolveAccount(target, budget);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the account not to resolve');
}

test('an exact name among the open accounts resolves', () => {
  const budget = accounts('Savings', 'Checking');
  assert.equal(resolveAccount(mapped('Checking'), budget).id, 'id-1');
});

test('an unmapped identifier still resolves to an open account named after it', () => {
  const budget = accounts('Savings', IBAN);
  assert.equal(resolveAccount(UNMAPPED, budget).id, 'id-1');
});

test('matching stays exact: a case or whitespace difference does not resolve', () => {
  const budget = accounts('Test Checking');
  assert.throws(() => resolveAccount(mapped('test checking'), budget));
  assert.throws(() => resolveAccount(mapped(' Test Checking'), budget));
});

test('an unmapped identifier says so, and shows the line to add', () => {
  const message = failure(UNMAPPED, accounts('Checking'));
  assert.match(message, new RegExp(`^${IBAN} is not in account_names\\.`));
  assert.ok(
    message.includes(`\n  "${IBAN}": "<the account's name in Actual>"\n`),
    message,
  );
  assert.doesNotMatch(message, /maps/);
});

test('the suggested key is the one the config looks up, without the bank spacing', () => {
  const target = {
    accountKey: 'CH42 0012 0123',
    name: 'CH42 0012 0123',
    mapped: false,
  };
  assert.match(failure(target, []), /\n {2}"CH4200120123": /);
});

test('a mapped name the budget lacks names the mapping', () => {
  const message = failure(mapped('My Checking'), accounts('Savings'));
  assert.match(
    message,
    new RegExp(
      `^account_names maps ${IBAN} to "My Checking", but the budget has no open account with that name\\.`,
    ),
  );
  assert.doesNotMatch(message, /is not in account_names/);
  assert.doesNotMatch(message, /Did you mean/);
});

test('a case or whitespace difference is suggested, never substituted', () => {
  const message = failure(
    mapped('test  checking '),
    accounts('Savings', 'Test Checking'),
  );
  assert.match(message, /Did you mean "Test Checking"\?/);
});

test('several near matches are all suggested', () => {
  const message = failure(mapped('checking'), accounts('CHECKING', 'Checking '));
  assert.match(message, /Did you mean "CHECKING" or "Checking "\?/);
});

test('an accent difference is not a near match: it is a different word', () => {
  const message = failure(mapped('Epargne'), accounts('Épargne'));
  assert.doesNotMatch(message, /Did you mean/);
});

test('a closed account with the exact name is reported as closed', () => {
  const budget: Account[] = [
    { id: accountId('old'), name: 'My Checking', closed: true },
    ...accounts('Savings'),
  ];
  const message = failure(mapped('My Checking'), budget);
  assert.match(
    message,
    /maps CH\w+ to "My Checking", which exists in the budget but is closed\./,
  );
  assert.doesNotMatch(message, /no open account/);
});

test('a closed near match is not suggested', () => {
  const budget: Account[] = [
    { id: accountId('old'), name: 'My Checking', closed: true },
  ];
  assert.doesNotMatch(failure(mapped('my checking'), budget), /Did you mean/);
});

test('the open accounts are listed sorted, closed ones left out', () => {
  const budget: Account[] = [
    ...accounts('savings', 'Checking', 'Brokerage'),
    { id: accountId('old'), name: 'Archive', closed: true },
  ];
  const message = failure(mapped('Nope'), budget);
  assert.ok(
    message.endsWith(
      [
        '  Open accounts in the budget (3):',
        '    "Brokerage"',
        '    "Checking"',
        '    "savings"',
      ].join('\n'),
    ),
    message,
  );
});

test('the list is capped, and says how many it left out', () => {
  const names = Array.from(
    { length: 23 },
    (_, i) => `Account ${String(i).padStart(2, '0')}`,
  );
  const message = failure(mapped('Nope'), accounts(...names.reverse()));
  const lines = message.split('\n');
  assert.ok(lines.includes('  Open accounts in the budget (23):'), message);
  assert.ok(lines.includes('    "Account 19"'));
  assert.ok(!lines.includes('    "Account 20"'));
  assert.equal(lines.at(-1), '    … and 3 more');
});

test('a budget with no open accounts says so', () => {
  assert.match(failure(mapped('Nope'), []), /The budget has no open accounts\.$/);
});

test('the suggested entry, pasted under an existing account_names, maps the identifier', () => {
  const message = failure(UNMAPPED, []);
  const entry = message.split('\n').find((line) => line.includes('<the account'));
  assert.ok(entry, message);
  const yaml = `account_names:\n  CH0000000000: personal_checking\n${entry.replace("<the account's name in Actual>", 'Checking')}\n`;
  const config = parseYaml(yaml) as { account_names: Record<string, string> };
  assert.deepEqual(config.account_names, {
    CH0000000000: 'personal_checking',
    [IBAN]: 'Checking',
  });
});
