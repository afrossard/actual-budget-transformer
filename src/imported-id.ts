/**
 * Imported IDs this tool mints.
 *
 * Minted IDs are **preventive and reproducible**: the same input always yields
 * the same ID, so a re-run recognises its own earlier writes and our Skip
 * bucket is a resume mechanism rather than a data loss. Every minted ID carries
 * a prefix so it is distinguishable from a bank's own reference, and the `1` in
 * that prefix versions the scheme: changing how IDs are derived must be
 * visible, not silent.
 */
import { createHash } from 'node:crypto';
import type { SourceTransaction } from './sources/types.ts';

export const MINTED_PREFIX = 'abt1-';

/** Marker between a base ID and the copy index a forced write appends. */
const FORCED_SEPARATOR = '~dup';

/**
 * Hash the parts into a minted ID.
 *
 * The parts are JSON-encoded rather than joined on a separator, because a plain
 * join is ambiguous: `['A|B', 'C']` and `['A', 'B|C']` both flatten to `A|B|C`
 * and so mint the *same* ID for different transactions. That is not a
 * theoretical worry in the wrong direction - the ID is written to Actual, so a
 * collision means two genuinely different transactions share an `imported_id`,
 * and the next run reports the second as Skip, "already in Actual". A human
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
 * A minted ID derived from a source transaction's content, for rows whose
 * format normally carries a reference and which arrived without one.
 */
export function contentImportedId(tx: SourceTransaction): string {
  return mintFromParts([tx.date, tx.amountCents, tx.payee, tx.notes]);
}

/**
 * The ID for a forced separate transaction: the row's own base ID plus the
 * lowest copy index the account does not already hold.
 *
 * Forcing is the override on a Skip the human disagrees with, so it must be
 * reproducible in the same sense as minting: a re-run of the same file finds
 * the row's base ID already in Actual, reports it as Skip, and adds nothing.
 */
export function forcedImportedId(
  tx: SourceTransaction,
  existingImportedIds: Iterable<string>,
): string {
  const base = tx.importedId === '' ? contentImportedId(tx) : tx.importedId;
  const taken = new Set(existingImportedIds);
  for (let copy = 1; ; copy += 1) {
    const candidate = `${base}${FORCED_SEPARATOR}${copy}`;
    if (!taken.has(candidate)) return candidate;
  }
}
