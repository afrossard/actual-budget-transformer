/**
 * UBS cards CSV: a `sep=;` line, the column header, the purchases, then a
 * per-currency footer.
 *
 * The format carries no bank reference at all, so every imported ID is
 * **minted** - deterministically, from the configured reference columns, which
 * default to the original-currency fields because those are stable across
 * exports in a way the converted CHF amount is not. A per-group occurrence
 * counter keeps n identical purchases in one file as n distinct imported IDs:
 * the bank's file is authoritative on the count, and without the counter our own
 * Skip bucket would drop the copies.
 *
 * Column names, encoding, separator, date format and the reference columns all
 * come from the format settings - see `formats.ts` for why they are settings.
 */
import { cell, readRows } from './delimited.ts';
import { parseDate, type CardsCsvFormat } from './formats.ts';
import { mintFromParts } from '../imported-id.ts';
import { readAmount } from '../money.ts';
import type {
  DroppedRow,
  ParsedStatement,
  SourceTransaction,
  StatementParser,
} from './types.ts';

export const FORMAT = 'ubs-cards-csv';

/** Field positions within the purchase table. Positional, as above. */
const COL = {
  accountNumber: 0,
  cardNumber: 1,
  date: 3,
  payee: 4,
  sector: 5,
  debit: 10,
  credit: 11,
} as const;

const SEP_ROW = 0;

export function ubsCardsCsvParser(format: CardsCsvFormat): StatementParser {
  const headerRow = format.headerRow - 1; // config is 1-based
  const firstTransactionRow = headerRow + 1;

  const looksRight = (rows: readonly string[][]): boolean => {
    if (cell(rows[SEP_ROW] ?? [], 0) !== 'sep=') return false;
    const header = rows[headerRow] ?? [];
    return format.columns.every((name, i) => cell(header, i) === name);
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
        throw new Error(`${path} is not a UBS cards CSV`);
      }

      /** Index of each configured reference column within the header. */
      const referenceIndices = format.referenceColumns.map((name) => {
        const index = format.columns.indexOf(name);
        if (index === -1) {
          throw new Error(
            `reference column ${JSON.stringify(name)} is not one of the configured ` +
              `columns for the UBS cards CSV: ${format.columns.join(', ')}`,
          );
        }
        return index;
      });

      const transactions: SourceTransaction[] = [];
      const dropped: DroppedRow[] = [];
      const occurrences = new Map<string, number>();
      let accountKey = '';

      for (const [i, row] of rows.entries()) {
        if (i < firstTransactionRow) continue;
        const sourceLine = i + 1;
        const raw = row.join(format.separator);
        if (raw.split(format.separator).join('').trim() === '') continue;

        // Not every purchase row carries the card number (some credit rows leave
        // it blank), so take the first one that does.
        const cardNumber = cell(row, COL.cardNumber);
        if (accountKey === '' && cardNumber !== '') accountKey = cardNumber;

        // The per-currency footer has no account number.
        if (cell(row, COL.accountNumber) === '') {
          dropped.push({ sourceLine, reason: 'footer row', raw });
          continue;
        }

        const rawDate = cell(row, COL.date);
        const date = parseDate(rawDate, format.dateFormat);
        if (date === null) {
          dropped.push({ sourceLine, reason: `unreadable date ${rawDate}`, raw });
          continue;
        }

        // Pending purchases have neither a debit nor a credit: the converted
        // amount is not final yet. Out of scope for now (#47, #48).
        const amount = readAmount(cell(row, COL.debit), cell(row, COL.credit));
        if ('problem' in amount || 'empty' in amount) {
          dropped.push({
            sourceLine,
            reason: 'problem' in amount ? amount.problem : 'pending (not booked yet)',
            raw,
          });
          continue;
        }

        const identity = referenceIndices.map((index) => cell(row, index));
        const groupKey = identity.join('|');
        const occurrence = occurrences.get(groupKey) ?? 0;
        occurrences.set(groupKey, occurrence + 1);

        transactions.push({
          date,
          amountCents: amount.cents,
          payee: cell(row, COL.payee),
          notes: cell(row, COL.sector),
          importedId: mintFromParts([...identity, occurrence]),
          importedIdOrigin: 'minted',
          sourceLine,
        });
      }

      if (accountKey === '') {
        throw new Error(`no card number found in ${path}`);
      }

      return { format: FORMAT, accountKey, period: null, transactions, dropped };
    },
  };
}
