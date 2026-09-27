/**
 * The statement parsers, and which one claims a file.
 *
 * Parsers are built from the format settings rather than imported ready-made, so
 * the column names and encodings a user has corrected in `config.yml` are the
 * ones actually used. Each one inspects a file cheaply and never raises while
 * deciding, so a directory of mixed downloads can be walked without
 * special-casing.
 */
import { ubsAccountCsvParser } from './ubs-account-csv.ts';
import { ubsCardsCsvParser } from './ubs-cards-csv.ts';
import { DEFAULT_FORMATS, type Formats } from './formats.ts';
import type { ParsedStatement, StatementParser } from './types.ts';

export function createParsers(formats: Formats = DEFAULT_FORMATS): StatementParser[] {
  return [
    ubsAccountCsvParser(formats.ubsAccountCsv),
    ubsCardsCsvParser(formats.ubsCardsCsv),
  ];
}

export function pickParser(
  path: string,
  formats: Formats = DEFAULT_FORMATS,
): StatementParser | null {
  return createParsers(formats).find((p) => p.canParse(path)) ?? null;
}

export function parseStatement(
  path: string,
  formats: Formats = DEFAULT_FORMATS,
): ParsedStatement {
  const parsers = createParsers(formats);
  const parser = parsers.find((p) => p.canParse(path));
  if (!parser) {
    throw new Error(
      `no parser recognises ${path} (known formats: ${parsers.map((p) => p.format).join(', ')}). ` +
        `If the bank changed its export, correct the column names under processors.* in your config.`,
    );
  }
  return parser.parse(path);
}
