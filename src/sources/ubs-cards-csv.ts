/**
 * UBS cards CSV: a `sep=;` line, the column header, the purchases, then a
 * per-currency footer.
 *
 * The format carries no bank reference at all, so every imported ID is
 * **minted** — deterministically, from the original-currency fields, which
 * are stable across exports in a way the converted CHF amount is not. A
 * per-group occurrence counter keeps n identical purchases in one file as n
 * distinct imported IDs: the bank's file is authoritative on the count, and
 * without the counter our own Skip bucket would drop the copies.
 */
import { cell, readRows } from './delimited.ts';
import { mintFromParts } from '../imported-id.ts';
import { signedAmountCents } from '../money.ts';
import type { DroppedRow, ParsedStatement, SourceTransaction } from './types.ts';

export const FORMAT = 'ubs-cards-csv';

const COLUMNS = [
  'Numéro de compte',
  'Numéro de carte',
  'Titulaire de compte/carte',
  "Date d'achat",
  'Texte comptable',
  'Secteur',
  'Montant',
  'Monnaie originale',
  'Cours',
  'Monnaie',
  'Débit',
  'Crédit',
  'Ecriture',
];

const COL = {
  accountNumber: 0,
  cardNumber: 1,
  date: 3,
  payee: 4,
  sector: 5,
  originalAmount: 6,
  originalCurrency: 7,
  debit: 10,
  credit: 11,
} as const;

const SEP_ROW = 0;
const HEADER_ROW = 1;
const FIRST_TRANSACTION_ROW = HEADER_ROW + 1;

function looksLikeThisFormat(rows: readonly string[][]): boolean {
  if (cell(rows[SEP_ROW] ?? [], 0) !== 'sep=') return false;
  const header = rows[HEADER_ROW] ?? [];
  return COLUMNS.every((name, i) => cell(header, i) === name);
}

export function canParse(path: string): boolean {
  if (!path.toLowerCase().endsWith('.csv')) return false;
  try {
    return looksLikeThisFormat(readRows(path, 'latin1'));
  } catch {
    return false;
  }
}

/** `24.02.2020` -> `2020-02-24`. */
function isoDate(swiss: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(swiss);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * The imported ID for a card purchase: the original-currency identity plus how
 * many identical purchases were already seen in this file.
 */
export function mintImportedId(
  parts: {
    date: string;
    payee: string;
    originalAmount: string;
    originalCurrency: string;
  },
  occurrence: number,
): string {
  return mintFromParts([
    parts.date,
    parts.payee,
    parts.originalAmount,
    parts.originalCurrency,
    occurrence,
  ]);
}

export function parse(path: string): ParsedStatement {
  const rows = readRows(path, 'latin1');
  if (!looksLikeThisFormat(rows)) {
    throw new Error(`${path} is not a UBS cards CSV`);
  }

  const transactions: SourceTransaction[] = [];
  const dropped: DroppedRow[] = [];
  const occurrences = new Map<string, number>();
  let accountKey = '';

  for (let i = FIRST_TRANSACTION_ROW; i < rows.length; i += 1) {
    const row = rows[i]!;
    const sourceLine = i + 1;
    const raw = row.join(';');
    if (raw.replace(/;/g, '').trim() === '') continue; // blank separator line

    // Not every purchase row carries the card number (some credit rows leave
    // it blank), so take the first one that does.
    const cardNumber = cell(row, COL.cardNumber);
    if (accountKey === '' && cardNumber !== '') accountKey = cardNumber;

    // The per-currency footer has no account number.
    if (cell(row, COL.accountNumber) === '') {
      dropped.push({ sourceLine, reason: 'footer row', raw });
      continue;
    }

    const date = isoDate(cell(row, COL.date));
    if (date === null) {
      dropped.push({
        sourceLine,
        reason: `unreadable date ${cell(row, COL.date)}`,
        raw,
      });
      continue;
    }

    // Pending purchases have neither a debit nor a credit: the converted
    // amount is not final yet. Out of scope for now (#47, #48).
    const amountCents = signedAmountCents(cell(row, COL.debit), cell(row, COL.credit));
    if (amountCents === null) {
      dropped.push({ sourceLine, reason: 'pending (not booked yet)', raw });
      continue;
    }

    const identity = {
      date,
      payee: cell(row, COL.payee),
      originalAmount: cell(row, COL.originalAmount),
      originalCurrency: cell(row, COL.originalCurrency),
    };
    const groupKey = Object.values(identity).join('|');
    const occurrence = occurrences.get(groupKey) ?? 0;
    occurrences.set(groupKey, occurrence + 1);

    transactions.push({
      date,
      amountCents,
      payee: identity.payee,
      notes: cell(row, COL.sector),
      importedId: mintImportedId(identity, occurrence),
      importedIdOrigin: 'minted',
      sourceLine,
    });
  }

  if (accountKey === '') {
    throw new Error(`no card number found in ${path}`);
  }

  return { format: FORMAT, accountKey, transactions, dropped };
}

export const parser = { format: FORMAT, canParse, parse };
