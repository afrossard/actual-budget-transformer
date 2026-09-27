/**
 * The statement parsers, and which one claims a file.
 *
 * Each parser inspects the file cheaply and never raises while deciding, so a
 * directory of mixed downloads can be walked without special-casing.
 */
import { parser as ubsAccountCsv } from './ubs-account-csv.ts';
import { parser as ubsCardsCsv } from './ubs-cards-csv.ts';
import type { ParsedStatement, StatementParser } from './types.ts';

export const PARSERS: readonly StatementParser[] = [ubsAccountCsv, ubsCardsCsv];

export function pickParser(path: string): StatementParser | null {
  return PARSERS.find((p) => p.canParse(path)) ?? null;
}

export function parseStatement(path: string): ParsedStatement {
  const parser = pickParser(path);
  if (!parser) {
    throw new Error(
      `no parser recognises ${path} (known formats: ${PARSERS.map((p) => p.format).join(', ')})`,
    );
  }
  return parser.parse(path);
}
