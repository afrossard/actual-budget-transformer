/**
 * Configuration.
 *
 * The same `config.yml` the file-output path already uses, but only the two
 * blocks that are genuinely the user's: `account_names`, which maps a bank
 * identifier to the account's name in Actual, and `actual_budget`, which says
 * where the server is. The bank's column names, encodings and date formats are
 * facts about the export format rather than settings, so they live in the
 * parsers.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

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
};

type RawConfig = {
  account_names?: Record<string, unknown>;
  actual_budget?: Record<string, unknown>;
};

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
    raw = (parseYaml(readFileSync(path, 'utf8')) as RawConfig | null) ?? {};
  }

  const accountNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.account_names ?? {})) {
    accountNames[key.replace(/\s/g, '')] = text(value);
  }

  const block = raw.actual_budget ?? {};
  const actual: ActualConfig = {
    serverUrl: env['ACTUAL_BUDGET_URL'] || text(block['server_url']),
    password: env['ACTUAL_BUDGET_PASSWORD'] || text(block['password']),
    budgetName: env['ACTUAL_BUDGET_FILE'] || text(block['budget_name']),
    dataDir: text(block['data_dir']) || null,
  };

  return { accountNames, actual };
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

/**
 * The account's name in Actual for a bank identifier. Unmapped identifiers
 * fall back to themselves, which surfaces as "account not found in budget"
 * naming the identifier the file carried.
 */
export function accountNameFor(config: Config, accountKey: string): string {
  return config.accountNames[accountKey.replace(/\s/g, '')] ?? accountKey;
}
