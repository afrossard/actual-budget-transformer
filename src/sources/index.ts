/**
 * The statement parsers, and which one claims a file.
 *
 * Parsers are built from the format settings rather than imported ready-made, so
 * the column names and encodings a user has corrected in `config.yml` are the
 * ones actually used. Each one inspects a file cheaply and never raises while
 * deciding, so a directory of mixed downloads can be walked without
 * special-casing.
 */
import { existsSync } from 'node:fs';
import { ubsAccountCsvParser } from './ubs-account-csv.ts';
import { ubsCardsCsvParser } from './ubs-cards-csv.ts';
import { DEFAULT_FORMATS, type Formats } from './formats.ts';
import type { Likeness, ParsedStatement, StatementParser } from './types.ts';

/** Enough to see what changed, few enough to read on one line. */
const LISTED_MISSING = 5;

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
  if (!parser) throw new Error(notRecognised(path, parsers));
  return parser.parse(path);
}

/**
 * Why no parser claims a file. A CSV that comes close to a format names it and
 * what it expected and did not find, so a changed UBS export reads as a
 * missing column rather than as an unknown file.
 */
function notRecognised(path: string, parsers: readonly StatementParser[]): string {
  if (!existsSync(path)) return 'no such file';
  let closest: { format: string; likeness: Likeness } | null = null;
  for (const parser of parsers) {
    const likeness = parser.likeness(path);
    if (likeness === null || likeness.found === 0) continue;
    if (closest === null || nearer(likeness, closest.likeness)) {
      closest = { format: parser.format, likeness };
    }
  }
  if (closest === null) {
    const known = parsers.map((p) => p.format).join(', ');
    return `not recognised as a statement (known formats: ${known})`;
  }
  const { missing } = closest.likeness;
  const listed = missing.slice(0, LISTED_MISSING).map((m) => JSON.stringify(m));
  const rest = missing.length - listed.length;
  return (
    `not recognised: closest is ${closest.format}, which expected ` +
    listed.join(', ') +
    (rest > 0 ? ` and ${rest} more` : '') +
    ` and did not find ${missing.length === 1 ? 'it' : 'them'}. ` +
    'If the bank changed its export, correct the column names under ' +
    'processors.* in your config.'
  );
}

/** The larger share of what it expects found. */
function nearer(a: Likeness, b: Likeness): boolean {
  const share = (l: Likeness) => l.found / (l.found + l.missing.length);
  return share(a) > share(b);
}
