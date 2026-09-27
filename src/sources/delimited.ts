/**
 * Reading the bank's delimited files.
 *
 * Both UBS exports are semicolon-separated, quote fields that contain a
 * semicolon, and carry a preamble above the transaction table, so they are
 * parsed as raw rows and interpreted by the format's own parser rather than
 * via a header-aware reader.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

/** `utf8` for the account CSV (BOM-prefixed), `latin1` for the cards CSV. */
export type SourceEncoding = 'utf8' | 'latin1';

export function readRows(path: string, encoding: SourceEncoding): string[][] {
  const text = readFileSync(path).toString(encoding).replace(/^﻿/, '');
  return parse(text, {
    delimiter: ';',
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
