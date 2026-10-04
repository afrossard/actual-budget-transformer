/**
 * Imported IDs this tool mints.
 *
 * Minted IDs are **preventive and reproducible**: the same input always yields
 * the same ID, so a re-run pairs each statement transaction with its own
 * earlier write, and re-running a file is a resume mechanism rather than a
 * data loss. Every minted ID carries
 * a prefix so it is distinguishable from a bank's own reference, and the `1` in
 * that prefix versions the scheme: changing how IDs are derived must be
 * visible, not silent.
 */
import { createHash } from 'node:crypto';
import type { SourceTransaction } from './sources/types.ts';

export const MINTED_PREFIX = 'abt1-';

/**
 * Hash the parts into a minted ID.
 *
 * The parts are JSON-encoded rather than joined on a separator, because a plain
 * join is ambiguous: `['A|B', 'C']` and `['A', 'B|C']` both flatten to `A|B|C`
 * and so mint the *same* ID for different transactions. That is not a
 * theoretical worry in the wrong direction - the ID is written to Actual, so a
 * collision means two genuinely different transactions share an `imported_id`,
 * and the next run pairs the second with the first, "already in Actual". A human
 * would then decline a real transaction on the tool's false evidence, which is
 * precisely the silent loss the rest of this design exists to prevent.
 */
export function mintFromParts(parts: readonly (string | number)[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts.map((p) => String(p))))
    .digest('hex');
  return MINTED_PREFIX + digest.slice(0, 16);
}

/**
 * A minted ID derived from a statement transaction's content, for one whose
 * format normally carries a reference and which arrived without one.
 */
export function contentImportedId(tx: SourceTransaction): string {
  return mintFromParts([tx.date, tx.amountCents, tx.payee, tx.notes]);
}
