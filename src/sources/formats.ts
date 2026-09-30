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
 * `processors.ubs_csv` / `processors.ubs_cards` overrides them, key by key, and
 * the schema is deliberately the same one the Python path already reads so a
 * single config file serves both.
 */

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

/** Python's encoding names, which is what the shared config file uses. */
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
 * not read at all.
 */
export function parseDate(value: string, format: string): string | null {
  const groups: string[] = [];
  let pattern = '';
  const chars = [...format];
  let skipNext = false;
  for (const [i, char] of chars.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (char !== '%') {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    const token = chars[i + 1];
    skipNext = true;
    if (token === 'Y') {
      groups.push('Y');
      pattern += '(\\d{4})';
    } else if (token === 'm') {
      groups.push('m');
      pattern += '(\\d{2})';
    } else if (token === 'd') {
      groups.push('d');
      pattern += '(\\d{2})';
    } else if (token === '%') {
      pattern += '%';
    } else {
      throw new Error(
        `unsupported date format ${JSON.stringify(format)}: %${token ?? ''} is not one of %Y, %m, %d`,
      );
    }
  }
  const match = new RegExp(`^${pattern}$`).exec(value.trim());
  if (!match) return null;
  const parts: Record<string, string> = {};
  groups.forEach((g, i) => {
    // `groups` has exactly as many entries as capturing groups in `pattern`,
    // built together in the loop above, so group i+1 always exists here.
    parts[g] = match[i + 1]!;
  });
  if (!parts['Y'] || !parts['m'] || !parts['d']) {
    throw new Error(
      `date format ${JSON.stringify(format)} must use all of %Y, %m and %d`,
    );
  }
  return `${parts['Y']}-${parts['m']}-${parts['d']}`;
}
