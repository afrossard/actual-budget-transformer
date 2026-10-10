/**
 * What each statement format looks like - as settings, not constants.
 *
 * These were briefly hard-coded on the grounds that a bank's column names are
 * facts about its export rather than user preferences. That was wrong twice
 * over: UBS changes its exports without announcing it, and the column names are
 * in the language of the user's e-banking, so they change when that setting
 * changes. Either way the person hitting the problem needs to fix it by editing
 * a file, not by waiting for a release.
 *
 * The values below are defaults. Anything in `config.yml` under
 * `processors.ubs_csv` / `processors.ubs_cards` overrides them, key by key, in
 * the schema the retired Python package read, so an existing config file keeps
 * working.
 */

import { toIsoDate, type IsoDate } from '../iso-date.ts';

/** Node's name for the encodings the config can ask for. */
export type Encoding = 'utf8' | 'latin1';

export type AccountCsvFormat = {
  encoding: Encoding;
  separator: string;
  /** Lines of preamble above the blank line and the transaction table. */
  headerRows: number;
  /** The preamble's row labels, in order, as the bank writes them. */
  preambleLabels: string[];
  /** The transaction table's columns, in order. */
  transactionColumns: string[];
  /** strftime-style, limited to the `%Y` / `%m` / `%d` tokens. */
  dateFormat: string;
};

export type CardsCsvFormat = {
  encoding: Encoding;
  separator: string;
  /** 1-based line holding the column header. */
  headerRow: number;
  columns: string[];
  dateFormat: string;
  /**
   * The columns whose values are hashed into a card transaction's imported ID.
   *
   * Changing these changes every minted ID, so transactions already written
   * stop matching and come back as new. Change them only on a fresh account, or
   * expect to work through a run of duplicates by hand.
   */
  referenceColumns: string[];
};

export const DEFAULT_ACCOUNT_CSV: AccountCsvFormat = {
  encoding: 'utf8',
  separator: ';',
  headerRows: 8,
  preambleLabels: [
    'Numéro de compte:',
    'IBAN:',
    'Du:',
    'Au:',
    'Solde initial:',
    'Solde final:',
    'Évaluation en:',
    'Nombre de transactions dans cette période:',
  ],
  transactionColumns: [
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
  ],
  dateFormat: '%Y-%m-%d',
};

export const DEFAULT_CARDS_CSV: CardsCsvFormat = {
  encoding: 'latin1',
  separator: ';',
  headerRow: 2,
  columns: [
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
  ],
  dateFormat: '%d.%m.%Y',
  referenceColumns: ["Date d'achat", 'Texte comptable', 'Montant', 'Monnaie originale'],
};

export type Formats = {
  ubsAccountCsv: AccountCsvFormat;
  ubsCardsCsv: CardsCsvFormat;
};

export const DEFAULT_FORMATS: Formats = {
  ubsAccountCsv: DEFAULT_ACCOUNT_CSV,
  ubsCardsCsv: DEFAULT_CARDS_CSV,
};

/** Python's encoding names, which is what existing config files use. */
const ENCODINGS: Record<string, Encoding> = {
  'utf-8': 'utf8',
  'utf-8-sig': 'utf8',
  utf8: 'utf8',
  'iso-8859-1': 'latin1',
  latin1: 'latin1',
  'latin-1': 'latin1',
  cp1252: 'latin1',
};

export function toEncoding(name: string): Encoding {
  const found = ENCODINGS[name.trim().toLowerCase()];
  if (!found) {
    throw new Error(
      `unsupported encoding ${JSON.stringify(name)}; expected one of ${Object.keys(ENCODINGS).join(', ')}`,
    );
  }
  return found;
}

/**
 * Turn a bank date into `YYYY-MM-DD` using a strftime-style pattern.
 *
 * Only `%Y`, `%m` and `%d` are supported, which covers every ordering and
 * separator a bank actually writes. Anything else is rejected by name rather
 * than silently mis-parsed, because a date read wrongly is worse than a date
 * not read at all. For the same reason a day the calendar does not have, such as
 * `30.02.2031`, is null rather than rolled over.
 */
export function parseDate(value: string, format: string): IsoDate | null {
  const pattern = datePattern(format);
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) return null;
  // Anchored, so a match replaces the whole value and nothing else survives.
  return toIsoDate(trimmed.replace(pattern, '$<Y>-$<m>-$<d>'));
}

const DATE_FIELDS = new Map([
  ['Y', '(?<Y>\\d{4})'],
  ['m', '(?<m>\\d{2})'],
  ['d', '(?<d>\\d{2})'],
]);

/** The regex a strftime-style date format describes, with a named group per field. */
function datePattern(format: string): RegExp {
  const seen = new Set<string>();
  let source = '';
  // Each piece is either a directive (`%` plus one character, or a lone `%` at
  // the end) or a run of literal text.
  for (const [, directive, literal] of format.matchAll(/%(.?)|([^%]+)/gsu)) {
    const field = directive === undefined ? undefined : DATE_FIELDS.get(directive);
    if (literal !== undefined) {
      source += literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (directive === '%') {
      source += '%';
    } else if (directive !== undefined && field !== undefined) {
      if (seen.has(directive)) {
        throw new Error(
          `date format ${JSON.stringify(format)} uses %${directive} more than once`,
        );
      }
      seen.add(directive);
      source += field;
    } else {
      throw new Error(
        `unsupported date format ${JSON.stringify(format)}: %${directive ?? ''} is not one of %Y, %m, %d`,
      );
    }
  }
  if (seen.size !== DATE_FIELDS.size) {
    throw new Error(
      `date format ${JSON.stringify(format)} must use all of %Y, %m and %d`,
    );
  }
  return new RegExp(`^${source}$`, 'u');
}
