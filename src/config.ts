/**
 * Configuration: the same `config.yml` the file-output path already uses, and
 * the same schema, so one file serves both.
 *
 * Three blocks are read. `account_names` maps a bank identifier to the
 * account's name in Actual, `actual_budget` says where the server is, and
 * `processors.*` describes each statement format - its column names, encoding,
 * separator and date format.
 *
 * That last one belongs here and not in the code: UBS changes its exports
 * without announcing it, and the column names are in the language of the user's
 * e-banking, so they move when that setting moves. Whoever hits that needs to
 * fix it by editing a file.
 */
import { readFileSync } from 'node:fs';
import { LineCounter, parse as parseYaml, YAMLParseError } from 'yaml';
import {
  DEFAULT_ACCOUNT_CSV,
  DEFAULT_CARDS_CSV,
  toEncoding,
  type AccountCsvFormat,
  type CardsCsvFormat,
  type Formats,
} from './sources/formats.ts';

export const CONFIG_PATH_ENV = 'ACTUAL_BUDGET_TRANSFORMER_CONFIG';

export type ActualConfig = {
  serverUrl: string;
  password: string;
  budgetName: string;
  /** Local SQLite cache. A fresh temp dir per run when unset. */
  dataDir: string | null;
};

export type Config = {
  /** Bank identifier (IBAN, card number) -> the account's name in Actual. */
  accountNames: Record<string, string>;
  actual: ActualConfig;
  formats: Formats;
};

type RawConfig = {
  account_names?: Record<string, unknown>;
  actual_budget?: Record<string, unknown>;
  processors?: Record<string, Record<string, unknown> | null>;
};

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  // The Python path's list carries a trailing pandas placeholder for the
  // statement's empty last column ("Unnamed: 14"). It names nothing, so drop it
  // rather than make the user delete it from a config that has to serve both.
  return value
    .map((v) => text(v))
    .filter((name) => name !== '' && !/^Unnamed:\s*\d+$/.test(name));
}

function integer(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function nonEmpty(value: unknown, fallback: string): string {
  const s = text(value);
  return s === '' ? fallback : s;
}

function accountCsvFormat(raw: Record<string, unknown>): AccountCsvFormat {
  const csv = (raw['csv_settings'] ?? {}) as Record<string, unknown>;
  const d = DEFAULT_ACCOUNT_CSV;
  return {
    encoding:
      csv['encoding'] === undefined ? d.encoding : toEncoding(text(csv['encoding'])),
    separator: nonEmpty(csv['separator'], d.separator),
    headerRows: integer(csv['header_rows'], d.headerRows),
    preambleLabels: strings(raw['expected_header_labels'], d.preambleLabels),
    transactionColumns: strings(
      raw['expected_transaction_labels'],
      d.transactionColumns,
    ),
    dateFormat: nonEmpty(raw['date_format'], d.dateFormat),
  };
}

function cardsCsvFormat(raw: Record<string, unknown>): CardsCsvFormat {
  const csv = (raw['csv_settings'] ?? {}) as Record<string, unknown>;
  const d = DEFAULT_CARDS_CSV;
  return {
    encoding:
      csv['encoding'] === undefined ? d.encoding : toEncoding(text(csv['encoding'])),
    separator: nonEmpty(csv['separator'], d.separator),
    headerRow: integer(csv['header_row'], d.headerRow),
    columns: strings(raw['expected_columns'], d.columns),
    dateFormat: nonEmpty(raw['date_format'], d.dateFormat),
    referenceColumns: strings(raw['reference_columns'], d.referenceColumns),
  };
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

/**
 * Read the config file, then let the environment win on the three sensitive
 * values so a committed config never has to hold a password.
 */
export function loadConfig(
  pathOverride?: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  const path = pathOverride ?? env[CONFIG_PATH_ENV];
  let raw: RawConfig = {};
  if (path) {
    // This file is meant to be edited - it is how a renamed bank column gets
    // fixed - so a typo in it has to read as a typo, not as a stack trace.
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Not the parser's pretty error: that quotes the broken line, and the line
    // may be the password. The bare reason and a position say where to look.
    const lineCounter = new LineCounter();
    try {
      raw =
        (parseYaml(text, { prettyErrors: false, lineCounter }) as RawConfig | null) ??
        {};
    } catch (error) {
      if (!(error instanceof YAMLParseError)) throw error;
      // -1 is the parser saying it has no position for this one.
      const offset = error.pos[0];
      let where = '';
      if (offset >= 0) {
        const { line, col } = lineCounter.linePos(offset);
        where = ` at line ${line}, column ${col}`;
      }
      throw new Error(`${path} is not valid YAML${where}: ${error.message}`);
    }
  }

  const accountNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.account_names ?? {})) {
    accountNames[configKey(key)] = text(value);
  }

  const block = raw.actual_budget ?? {};
  const actual: ActualConfig = {
    serverUrl: env['ACTUAL_BUDGET_URL'] || text(block['server_url']),
    password: env['ACTUAL_BUDGET_PASSWORD'] || text(block['password']),
    budgetName: env['ACTUAL_BUDGET_FILE'] || text(block['budget_name']),
    dataDir: text(block['data_dir']) || null,
  };

  const processors = raw.processors ?? {};
  const formats: Formats = {
    ubsAccountCsv: accountCsvFormat(processors['ubs_csv'] ?? {}),
    ubsCardsCsv: cardsCsvFormat(processors['ubs_cards'] ?? {}),
  };

  return { accountNames, actual, formats };
}

/** Fail before touching the server rather than halfway through a run. */
export function requireActualConfig(config: Config): ActualConfig {
  const missing = (
    [
      ['server_url', 'ACTUAL_BUDGET_URL', config.actual.serverUrl],
      ['password', 'ACTUAL_BUDGET_PASSWORD', config.actual.password],
      ['budget_name', 'ACTUAL_BUDGET_FILE', config.actual.budgetName],
    ] as const
  ).filter(([, , value]) => value === '');
  if (missing.length > 0) {
    throw new Error(
      'actual_budget config incomplete; missing ' +
        missing.map(([key, envVar]) => `${key} (or ${envVar})`).join(', '),
    );
  }
  return config.actual;
}

/** Which Actual account a statement's identifier points at, and why. */
export type AccountTarget = {
  /** The identifier as the statement carries it. */
  accountKey: string;
  /** The account's name in Actual. */
  name: string;
  /**
   * False when `account_names` has no entry and `name` is the identifier
   * itself. The two need opposite fixes when the name is not in the budget -
   * add a mapping, or correct one - so the error has to know which it is.
   */
  mapped: boolean;
};

/** Whatever the bank's spacing: the config's keys are stored without it. */
export function configKey(accountKey: string): string {
  return accountKey.replace(/\s/g, '');
}

/**
 * The account's name in Actual for a bank identifier. An unmapped identifier
 * falls back to itself, so an account named after it still matches.
 */
export function accountTargetFor(config: Config, accountKey: string): AccountTarget {
  const key = configKey(accountKey);
  return Object.hasOwn(config.accountNames, key)
    ? { accountKey, name: config.accountNames[key] ?? accountKey, mapped: true }
    : { accountKey, name: accountKey, mapped: false };
}
