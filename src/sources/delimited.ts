/**
 * Reading the bank's delimited files.
 *
 * Both UBS exports quote fields that contain the separator and carry a preamble
 * above the transaction table, so they are parsed as raw rows and interpreted by
 * the format's own parser rather than via a header-aware reader. The separator
 * and encoding come from the format settings.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { Encoding } from './formats.ts';

const BOM = String.fromCharCode(0xfeff);

/** The account CSV is BOM-prefixed; the BOM is not part of the first label. */
function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

export function readRows(
  path: string,
  encoding: Encoding,
  delimiter: string,
): string[][] {
  const text = stripBom(readFileSync(path).toString(encoding));
  return parse(text, {
    delimiter,
    // The bank's rows are ragged: the preamble has 3 columns, the table 15,
    // and the footer fewer again.
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: false,
  }) as string[][];
}

/** A cell that may be absent from a short row, trimmed. */
export function cell(row: readonly string[], index: number): string {
  return (row[index] ?? '').trim();
}

/** Join the non-empty parts of a row's free-text columns into one note. */
export function joinNotes(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join(' ');
}
