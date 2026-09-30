import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ubsAccountCsvParser } from '../../src/sources/ubs-account-csv.ts';
import { ubsCardsCsvParser } from '../../src/sources/ubs-cards-csv.ts';
import {
  DEFAULT_ACCOUNT_CSV,
  DEFAULT_CARDS_CSV,
  DEFAULT_FORMATS,
} from '../../src/sources/formats.ts';
import { mintFromParts } from '../../src/imported-id.ts';
import { parseStatement, pickParser } from '../../src/sources/index.ts';

const accountCsv = ubsAccountCsvParser(DEFAULT_ACCOUNT_CSV);
const cardsCsv = ubsCardsCsvParser(DEFAULT_CARDS_CSV);

const DATA = fileURLToPath(new URL('../data/', import.meta.url));

test('the account parser claims the account CSV and nothing else', () => {
  assert.equal(accountCsv.canParse(DATA + 'ubs_valid.csv'), true);
  assert.equal(accountCsv.canParse(DATA + 'ubs_cards_1.csv'), false);
  assert.equal(accountCsv.canParse(DATA + 'ubs_invalid_header.csv'), false);
  assert.equal(
    accountCsv.canParse(DATA + 'ubs_invalid_transaction_columns.csv'),
    false,
  );
  assert.equal(accountCsv.canParse(DATA + 'ubs_invalid_extension.txt'), false);
  assert.equal(accountCsv.canParse(DATA + 'camt_single_debit.xml'), false);
});

test('the cards parser claims the cards CSV and nothing else', () => {
  assert.equal(cardsCsv.canParse(DATA + 'ubs_cards_1.csv'), true);
  assert.equal(cardsCsv.canParse(DATA + 'ubs_valid.csv'), false);
  assert.equal(cardsCsv.canParse(DATA + 'ubs_invalid_extension.txt'), false);
});

test('neither parser throws on a file it cannot read', () => {
  assert.equal(accountCsv.canParse(DATA + 'does_not_exist.csv'), false);
  assert.equal(cardsCsv.canParse(DATA + 'does_not_exist.csv'), false);
  assert.equal(accountCsv.canParse(DATA + 'ubs_invalid_encoding.csv'), false);
});

test('the account CSV keeps the bank reference as the imported ID', () => {
  const statement = accountCsv.parse(DATA + 'ubs_valid.csv');
  assert.equal(statement.accountKey, 'CH4200120123A12345678');
  assert.equal(statement.transactions.length, 1);
  const [tx] = statement.transactions;
  assert.deepEqual(tx, {
    date: '2023-01-13',
    // The file writes its debit already negative; the outflow stays an outflow.
    amountCents: -18665,
    payee: 'EXAMPLE; Paiement UBS TWINT',
    notes: 'Motif du paiement: AWESOME',
    importedId: '1234563AB9269773',
    importedIdOrigin: 'bank-reference',
    sourceLine: 11,
  });
});

test('an account row with no transaction number keeps a blank imported ID', () => {
  const statement = accountCsv.parse(DATA + 'ubs_account_no_reference.csv');
  const byPayee = new Map(statement.transactions.map((t) => [t.payee, t]));
  const fee = byPayee.get('FRAIS DE TENUE DE COMPTE');
  assert.ok(fee);
  assert.equal(fee.importedId, '');
  assert.equal(fee.importedIdOrigin, 'absent');
  // The control row in the same file still carries its reference.
  assert.equal(byPayee.get('PAIEMENT CARTE')?.importedId, '99887766554433');
});

test('an account credit is an inflow', () => {
  const statement = accountCsv.parse(DATA + 'ubs_account_no_reference.csv');
  const salary = statement.transactions.find((t) => t.payee === 'SALAIRE');
  assert.equal(salary?.amountCents, 650000);
});

test('the cards CSV mints an imported ID per purchase', () => {
  const statement = cardsCsv.parse(DATA + 'ubs_cards_1.csv');
  assert.equal(statement.accountKey, '9659086893219337559');
  assert.deepEqual(
    statement.transactions.map((t) => [t.date, t.amountCents, t.payee, t.notes]),
    [
      ['2020-02-24', -4100, 'MERCHANT-57823B77', 'MERCHANT-9B929026'],
      ['2020-02-23', -2800, 'MERCHANT-30A2B4C6', 'MERCHANT-B048332E'],
      ['2020-01-06', 5000, 'MERCHANT-A5BC10A8', ''],
    ],
  );
  for (const tx of statement.transactions) {
    assert.equal(tx.importedIdOrigin, 'minted');
    assert.match(tx.importedId, /^abt1-[0-9a-f]{16}$/);
  }
});

test('two byte-identical card rows get two distinct imported IDs', () => {
  // The bank's file says two purchases, so two must reach Actual.
  const statement = cardsCsv.parse(DATA + 'ubs_cards_dupes.csv');
  assert.equal(statement.transactions.length, 2);
  const [a, b] = statement.transactions;
  assert.notEqual(a!.importedId, b!.importedId);
});

test('minted imported IDs are reproducible across runs and files', () => {
  const first = cardsCsv.parse(DATA + 'ubs_cards_1.csv');
  const again = cardsCsv.parse(DATA + 'ubs_cards_1.csv');
  assert.deepEqual(
    first.transactions.map((t) => t.importedId),
    again.transactions.map((t) => t.importedId),
  );
  // The same purchase in a file that also holds pending rows keeps its ID:
  // the identity is the original-currency fields, not the row's position.
  const withPending = cardsCsv.parse(DATA + 'ubs_cards_pending.csv');
  assert.deepEqual(
    withPending.transactions.map((t) => t.importedId),
    first.transactions.map((t) => t.importedId),
  );
});

test('the minted ID hashes the reference columns verbatim, not the parsed date', () => {
  // Verbatim matters: the ID must not depend on `date_format`. Correcting that
  // setting after a UBS change is exactly the kind of edit this config exists
  // for, and it must not silently renumber every transaction already written.
  const stable = mintFromParts(['23.02.2020', 'MERCHANT-30A2B4C6', '30', 'EUR', 0]);
  const fromFile = cardsCsv
    .parse(DATA + 'ubs_cards_1.csv')
    .transactions.find((t) => t.payee === 'MERCHANT-30A2B4C6');
  assert.ok(fromFile);
  assert.equal(fromFile.importedId, stable);
  // And the converted CHF amount (28) is not in it, because it moves with the
  // exchange rate between exports.
  assert.notEqual(
    fromFile.importedId,
    mintFromParts(['23.02.2020', 'MERCHANT-30A2B4C6', '28', 'CHF', 0]),
  );
});

test('a minted ID survives a change to date_format', () => {
  const statement = cardsCsv.parse(DATA + 'ubs_cards_1.csv');
  const relaxed = ubsCardsCsvParser({
    ...DEFAULT_CARDS_CSV,
    dateFormat: '%d.%m.%Y',
  }).parse(DATA + 'ubs_cards_1.csv');
  assert.deepEqual(
    statement.transactions.map((t) => t.importedId),
    relaxed.transactions.map((t) => t.importedId),
  );
});

test('pending card rows are dropped, and said so rather than logged away', () => {
  const statement = cardsCsv.parse(DATA + 'ubs_cards_pending.csv');
  assert.equal(statement.transactions.length, 3);
  const pending = statement.dropped.filter((d) => d.reason.startsWith('pending'));
  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map((d) => d.sourceLine),
    [3, 4],
  );
});

test('a cards file whose first row has no card number still finds the card', () => {
  const statement = cardsCsv.parse(
    DATA + 'ubs_cards_first_row_missing_card_number.csv',
  );
  assert.equal(statement.accountKey, '9659086893219337559');
  assert.equal(statement.transactions.length, 3);
});

test('pickParser routes each file to its own parser', () => {
  assert.equal(pickParser(DATA + 'ubs_valid.csv')?.format, 'ubs-account-csv');
  assert.equal(pickParser(DATA + 'ubs_cards_1.csv')?.format, 'ubs-cards-csv');
  assert.equal(pickParser(DATA + 'camt_single_debit.xml'), null);
});

test('parseStatement names the file it could not read', () => {
  assert.throws(
    () => parseStatement(DATA + 'camt_single_debit.xml'),
    /no parser recognises/,
  );
});

test('an unreadable amount is reported with its line, and the rest of the file still parses', () => {
  // Aborting the file would name neither the file nor the line the reader has to
  // go and look at, and one odd row is no reason to abandon the others.
  const statement = accountCsv.parse(DATA + 'ubs_account_bad_amount.csv');
  assert.deepEqual(
    statement.transactions.map((t) => [t.payee, t.amountCents]),
    [['READABLE ROW', -6000]],
  );
  assert.deepEqual(
    statement.dropped.map((d) => [d.sourceLine, d.reason]),
    [
      [11, 'not a decimal amount: "-50.00 CHF"'],
      [12, 'row carries both a debit (-10.00) and a credit (20.00)'],
    ],
  );
});

test('an account row with a blank date is dropped, not silently discarded', () => {
  // A row can carry a real amount and reference yet have no date - that is a
  // fact worth a Tape line, unlike a genuinely blank trailing line.
  const statement = accountCsv.parse(DATA + 'ubs_account_blank_date.csv');
  assert.deepEqual(
    statement.transactions.map((t) => t.payee),
    ['READABLE ROW'],
  );
  // The blank-date row is the file's only dropped row: the genuinely blank
  // trailing line does not appear in `transactions` or `dropped` either.
  assert.equal(statement.dropped.length, 1);
  const [blankDate] = statement.dropped;
  assert.ok(blankDate);
  assert.ok(blankDate.raw.includes('REF-NO-DATE'));
  assert.equal(blankDate.reason, 'no date');
});

test('a renamed, re-ordered-language export parses once the config is corrected', () => {
  // UBS labels are in the language of the user's e-banking, and UBS changes its
  // exports without announcing it. Both are fixed by editing config, which is
  // the whole reason these are settings and not constants.
  const english = {
    ...DEFAULT_ACCOUNT_CSV,
    preambleLabels: [
      'Account number:',
      'IBAN:',
      'From:',
      'To:',
      'Opening balance:',
      'Closing balance:',
      'Evaluated in:',
      'Number of transactions in this period:',
    ],
    transactionColumns: [
      'Trade date',
      'Trade time',
      'Booking date',
      'Value date',
      'Currency',
      'Debit',
      'Credit',
      'Subtotal',
      'Balance',
      'Transaction no.',
      'Description1',
      'Description2',
      'Description3',
      'Footnotes',
    ],
    dateFormat: '%d.%m.%Y',
  };

  // The shipped defaults do not recognise it at all.
  assert.equal(accountCsv.canParse(DATA + 'ubs_account_english.csv'), false);

  const corrected = ubsAccountCsvParser(english);
  assert.equal(corrected.canParse(DATA + 'ubs_account_english.csv'), true);
  const statement = corrected.parse(DATA + 'ubs_account_english.csv');
  assert.deepEqual(statement.transactions, [
    {
      date: '2031-07-15',
      amountCents: -15000,
      payee: 'RENT PAYMENT',
      notes: 'Motif: juillet',
      importedId: 'ENGLISH-REF-1',
      importedIdOrigin: 'bank-reference',
      sourceLine: 11,
    },
  ]);
  // And it does not start claiming the French file it was not configured for.
  assert.equal(corrected.canParse(DATA + 'ubs_valid.csv'), false);
});

test('a broken cards reference_columns setting does not block the account CSV', () => {
  // A half-finished repair of the cards block - columns renamed, reference_columns
  // left stale - must only fail once a cards file is actually parsed. It must not
  // take down the unrelated account path, whose file this broken setting never
  // touches.
  const brokenFormats = {
    ...DEFAULT_FORMATS,
    ubsCardsCsv: {
      ...DEFAULT_CARDS_CSV,
      referenceColumns: ['Not A Configured Column'],
    },
  };
  assert.doesNotThrow(() => parseStatement(DATA + 'ubs_valid.csv', brokenFormats));
  assert.throws(
    () => parseStatement(DATA + 'ubs_cards_1.csv', brokenFormats),
    /reference column "Not A Configured Column" is not one of the configured columns for the UBS cards CSV/,
  );
});
