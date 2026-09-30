/**
 * UBS account CSV: a preamble, a blank line, then the transaction table.
 *
 * Every row normally carries `N° de transaction`, which becomes the imported ID
 * verbatim; where the bank leaves it empty the imported ID stays **blank** rather
 * than being minted, because a reference the bank could have written and did not
 * is a fact about the row, not something to paper over.
 *
 * Column names, encoding, separator and date format all come from the format
 * settings - see `formats.ts` for why they are settings.
 */
import { cell, joinNotes, readRows } from './delimited.ts';
import { parseDate, type AccountCsvFormat } from './formats.ts';
import { readAmount } from '../money.ts';
import type {
  DroppedRow,
  ParsedStatement,
  SourceTransaction,
  StatementParser,
} from './types.ts';

export const FORMAT = 'ubs-account-csv';

/**
 * Field positions within the transaction table.
 *
 * Positional, like the Python path, which renames the columns by position too.
 * So a column the bank *renames* is handled by editing the configured names,
 * while a column it *reorders* breaks both paths equally - no regression, and
 * the preamble check fails loudly rather than reading the wrong field.
 */
const COL = {
  date: 0,
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

export function ubsAccountCsvParser(format: AccountCsvFormat): StatementParser {
  // Preamble occupies rows 0..headerRows-1, then a blank line, then the header.
  const tableHeaderRow = format.headerRows + 1;
  const firstTransactionRow = tableHeaderRow + 1;

  const looksRight = (rows: readonly string[][]): boolean => {
    if (rows.length <= tableHeaderRow) return false;
    for (const [i, label] of format.preambleLabels.entries()) {
      if (cell(rows[i] ?? [], 0) !== label) return false;
    }
    const header = rows[tableHeaderRow] ?? [];
    return format.transactionColumns.every((name, i) => cell(header, i) === name);
  };

  return {
    format: FORMAT,

    canParse(path: string): boolean {
      if (!path.toLowerCase().endsWith('.csv')) return false;
      try {
        return looksRight(readRows(path, format.encoding, format.separator));
      } catch {
        return false;
      }
    },

    parse(path: string): ParsedStatement {
      const rows = readRows(path, format.encoding, format.separator);
      if (!looksRight(rows)) {
        throw new Error(`${path} is not a UBS account CSV`);
      }

      const accountKey = cell(rows[IBAN_ROW] ?? [], 1).replace(/\s/g, '');
      const transactions: SourceTransaction[] = [];
      const dropped: DroppedRow[] = [];

      for (let i = firstTransactionRow; i < rows.length; i += 1) {
        const row = rows[i]!;
        const sourceLine = i + 1;
        const raw = row.join(format.separator);
        if (raw.split(format.separator).join('').trim() === '') continue; // trailing blank line

        const rawDate = cell(row, COL.date);
        const date = parseDate(rawDate, format.dateFormat);
        if (date === null) {
          dropped.push({ sourceLine, reason: `unreadable date ${rawDate}`, raw });
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
        transactions.push({
          date,
          amountCents: amount.cents,
          payee: cell(row, COL.payee),
          notes: joinNotes([
            cell(row, COL.note1),
            cell(row, COL.note2),
            cell(row, COL.footnote),
            cell(row, COL.trailing),
          ]),
          importedId: reference,
          importedIdOrigin: reference === '' ? 'absent' : 'bank-reference',
          sourceLine,
        });
      }

      return { format: FORMAT, accountKey, transactions, dropped };
    },
  };
}
