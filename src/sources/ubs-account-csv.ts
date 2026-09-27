/**
 * UBS account CSV: an eight-line preamble, a blank line, then the transaction
 * table. Every row normally carries `N° de transaction`, which becomes the
 * imported ID verbatim; where the bank leaves it empty the imported ID stays
 * **blank** rather than being minted, because a reference the bank could have
 * written and did not is a fact about the row, not something to paper over.
 */
import { cell, joinNotes, readRows } from './delimited.ts';
import { signedAmountCents } from '../money.ts';
import type { DroppedRow, ParsedStatement, SourceTransaction } from './types.ts';

export const FORMAT = 'ubs-account-csv';

/** The preamble's row labels, in order, as the bank writes them. */
const PREAMBLE_LABELS = [
  'Numéro de compte:',
  'IBAN:',
  'Du:',
  'Au:',
  'Solde initial:',
  'Solde final:',
  'Évaluation en:',
  'Nombre de transactions dans cette période:',
];

/** The transaction table's columns, in order. */
const COLUMNS = [
  'Date de transaction',
  'Heure de transaction',
  'Date de comptabilisation',
  'Date de valeur',
  'Monnaie',
  'Débit',
  'Crédit',
  'Sous-montant',
  'Solde',
  'N° de transaction',
  'Description1',
  'Description2',
  'Description3',
  'Notes de bas de page',
];

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
const TABLE_HEADER_ROW = 9;
const FIRST_TRANSACTION_ROW = TABLE_HEADER_ROW + 1;

function looksLikeThisFormat(rows: readonly string[][]): boolean {
  if (rows.length <= TABLE_HEADER_ROW) return false;
  for (const [i, label] of PREAMBLE_LABELS.entries()) {
    if (cell(rows[i] ?? [], 0) !== label) return false;
  }
  const header = rows[TABLE_HEADER_ROW] ?? [];
  return COLUMNS.every((name, i) => cell(header, i) === name);
}

export function canParse(path: string): boolean {
  if (!path.toLowerCase().endsWith('.csv')) return false;
  try {
    return looksLikeThisFormat(readRows(path, 'utf8'));
  } catch {
    return false;
  }
}

export function parse(path: string): ParsedStatement {
  const rows = readRows(path, 'utf8');
  if (!looksLikeThisFormat(rows)) {
    throw new Error(`${path} is not a UBS account CSV`);
  }

  const accountKey = cell(rows[IBAN_ROW] ?? [], 1).replace(/\s/g, '');
  const transactions: SourceTransaction[] = [];
  const dropped: DroppedRow[] = [];

  for (let i = FIRST_TRANSACTION_ROW; i < rows.length; i += 1) {
    const row = rows[i]!;
    const sourceLine = i + 1;
    const date = cell(row, COL.date);
    if (date === '') continue; // trailing blank line
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dropped.push({
        sourceLine,
        reason: `unreadable date ${date}`,
        raw: row.join(';'),
      });
      continue;
    }

    const amountCents = signedAmountCents(cell(row, COL.debit), cell(row, COL.credit));
    if (amountCents === null) {
      dropped.push({
        sourceLine,
        reason: 'no debit and no credit',
        raw: row.join(';'),
      });
      continue;
    }

    const reference = cell(row, COL.reference);
    transactions.push({
      date,
      amountCents,
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
}

export const parser = { format: FORMAT, canParse, parse };
