/**
 * UBS account CSV: a preamble, a blank line, then the transaction table.
 *
 * Every row normally carries `No de transaction`, which becomes the imported ID
 * verbatim; where the bank leaves it empty the imported ID stays **blank** rather
 * than being minted, because a reference the bank could have written and did not
 * is a fact about the row, not something to paper over.
 *
 * A row with no booking date is **pending**, and its transaction number is
 * provisional: the bank gives the booked row another one (#147). So it too
 * keeps a blank imported ID, and the number is cut from its notes, where
 * `Description3` repeats it, rather than leave Actual a reference that no
 * longer exists.
 *
 * Column names, encoding, separator and date format all come from the format
 * settings - see `formats.ts` for why they are settings.
 */
import { cell, compare, joinNotes, likenessOf, readRows } from './delimited.ts';
import { parseDate, type AccountCsvFormat } from './formats.ts';
import type { IsoDate } from '../iso-date.ts';
import { readAmount } from '../money.ts';
import type {
  DroppedRow,
  Likeness,
  ParsedStatement,
  SourceTransaction,
  StatementParser,
} from './types.ts';

export const FORMAT = 'ubs-account-csv';

/**
 * Field positions within the transaction table.
 *
 * Positional, as the retired Python package was. So a column the bank
 * *renames* is handled by editing the configured names, while a column it
 * *reorders* makes the preamble check fail loudly rather than read the wrong
 * field.
 */
const COL = {
  date: 0,
  bookingDate: 2,
  currency: 4,
  debit: 5,
  credit: 6,
  reference: 9,
  payee: 10,
  note1: 11,
  note2: 12,
  footnote: 13,
  trailing: 14,
} as const;

const IBAN_ROW = 1;
/** The preamble's `Du:` and `Au:` rows: the period the statement covers. */
const FROM_ROW = 2;
const TO_ROW = 3;

/**
 * A preamble date, in the configured format or else ISO, which is how the
 * bank writes it whatever the transaction rows use. Null when it is neither.
 */
function preambleDate(value: string, format: string): IsoDate | null {
  return parseDate(value, format) ?? parseDate(value, '%Y-%m-%d');
}

/**
 * Notes with every occurrence of one exact value cut out. Only the value
 * itself: nothing around it is guessed at.
 */
function withoutValue(notes: string, value: string): string {
  return joinNotes(notes.split(value));
}

export function ubsAccountCsvParser(format: AccountCsvFormat): StatementParser {
  // Preamble occupies rows 0..headerRows-1, then a blank line, then the header.
  const tableHeaderRow = format.headerRows + 1;
  const firstTransactionRow = tableHeaderRow + 1;

  const expectations = (rows: readonly string[][]): Likeness => {
    const header = rows[tableHeaderRow] ?? [];
    return compare([
      ...format.preambleLabels.map(
        (label, i) => [label, cell(rows[i] ?? [], 0)] as const,
      ),
      ...format.transactionColumns.map((name, i) => [name, cell(header, i)] as const),
    ]);
  };
  const looksRight = (rows: readonly string[][]): boolean =>
    expectations(rows).missing.length === 0;
  const likeness = (path: string): Likeness | null =>
    likenessOf(path, format.encoding, format.separator, expectations);

  return {
    format: FORMAT,

    likeness,

    canParse(path: string): boolean {
      return likeness(path)?.missing.length === 0;
    },

    parse(path: string): ParsedStatement {
      const rows = readRows(path, format.encoding, format.separator);
      if (!looksRight(rows)) {
        throw new Error(`${path} is not a UBS account CSV`);
      }

      const accountKey = cell(rows[IBAN_ROW] ?? [], 1).replace(/\s/g, '');
      const transactions: SourceTransaction[] = [];
      const dropped: DroppedRow[] = [];

      for (const [i, row] of rows.entries()) {
        if (i < firstTransactionRow) continue;
        const sourceLine = i + 1;
        const raw = row.join(format.separator);
        // Only a wholly blank row is skipped unrecorded; one with an empty date
        // but an amount or a reference is bank data, and goes to `dropped`.
        if (row.every((value) => value.trim() === '')) continue;

        const rawDate = cell(row, COL.date);
        const date = parseDate(rawDate, format.dateFormat);
        if (date === null) {
          const reason = rawDate === '' ? 'no date' : `unreadable date ${rawDate}`;
          dropped.push({ sourceLine, reason, raw });
          continue;
        }

        // An unreadable amount is reported like an unreadable date rather than
        // aborting the file: the message would otherwise name neither the file
        // nor the line, and one odd row is no reason to abandon the others.
        const amount = readAmount(cell(row, COL.debit), cell(row, COL.credit));
        if ('problem' in amount || 'empty' in amount) {
          dropped.push({
            sourceLine,
            reason: 'problem' in amount ? amount.problem : 'no debit and no credit',
            raw,
          });
          continue;
        }

        const reference = cell(row, COL.reference);
        const pending = cell(row, COL.bookingDate) === '';
        const notes = joinNotes([
          cell(row, COL.note1),
          cell(row, COL.note2),
          cell(row, COL.footnote),
          cell(row, COL.trailing),
        ]);
        const currency = cell(row, COL.currency);
        transactions.push({
          date,
          amountCents: amount.cents,
          payee: cell(row, COL.payee),
          notes: pending && reference !== '' ? withoutValue(notes, reference) : notes,
          importedId: pending ? '' : reference,
          importedIdOrigin:
            reference === '' ? 'absent' : pending ? 'pending' : 'bank-reference',
          sourceLine,
          ...(pending && {
            pending: { originalCurrency: currency, accountCurrency: currency },
          }),
        });
      }

      // Unreadable, the period falls back to the transactions' own dates, as
      // for a format that states none: narrower, never wrong.
      const from = preambleDate(cell(rows[FROM_ROW] ?? [], 1), format.dateFormat);
      const to = preambleDate(cell(rows[TO_ROW] ?? [], 1), format.dateFormat);
      const period = from === null || to === null ? null : { from, to };

      return { format: FORMAT, accountKey, period, transactions, dropped };
    },
  };
}
