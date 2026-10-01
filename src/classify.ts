/**
 * The classifier: source transactions plus what Actual already holds in, four
 * buckets out. Pure — no server, no I/O, no clock.
 *
 * Classification happens **once per batch**. Re-reading Actual before each
 * prompt would make every confirmation flag the next transaction, which is a
 * cascade of manufactured noise rather than a finding (#50).
 */
import type { SourceTransaction } from './sources/types.ts';

/** A transaction as Actual hands it back, narrowed to the fields we read. */
export type ActualTransaction = {
  id: string;
  date: string;
  amount: number;
  imported_id?: string | null;
  /** Actual stores the payee as an id; the gateway resolves it to its name. */
  payee?: string | null;
  payeeName?: string | null;
  notes?: string | null;
  reconciled?: boolean;
  is_parent?: boolean;
  subtransactions?: { id?: string; amount: number }[] | null;
};

/**
 * The bucket a source transaction lands in - `CONTEXT.md`'s term, which the
 * glossary prefers over "state", "status" and especially "category" (that means
 * something else in Actual). This is a sorting outcome, not a budget category.
 *
 * What the tool proposes to do with a source transaction:
 *
 * - `clean` — nothing in Actual looks like it.
 * - `suspicious` — something does, but not confidently enough to pair.
 * - `skip` — its imported ID is already in Actual; nothing left to do.
 * - `locked` — dated on or before the reconciliation boundary.
 */
export type Bucket = 'clean' | 'suspicious' | 'skip' | 'locked';

/**
 * Why a row is in its bucket. The classifier returns this rather than only the
 * bucket: a decline is a decision, and the human cannot make it without seeing
 * what the tool matched and on what basis.
 */
export type Evidence =
  /**
   * Every stored transaction holding this imported ID. Usually one; more is a
   * finding in its own right - Actual does not enforce uniqueness, so two rows
   * sharing an ID is reachable, and it is the corruption this tool exists to
   * prevent.
   */
  | { kind: 'already-imported'; matched: [ActualTransaction, ...ActualTransaction[]] }
  | {
      kind: 'inside-reconciled-range';
      boundary: string;
      matched: ActualTransaction | null;
    }
  | { kind: 'same-amount-within-one-day'; candidates: ActualTransaction[] }
  | { kind: 'repeated-in-this-file'; firstSeenLine: number }
  | { kind: 'no-match' };

export type ClassifiedRow = {
  source: SourceTransaction;
  bucket: Bucket;
  /** Every reason that applies, most decisive first. */
  reasons: Evidence[];
};

/**
 * The reconciliation boundary: the date of the newest reconciled transaction.
 *
 * Actual has no such field, so it is derived. Pass the account's whole history -
 * a window would silently lower the boundary, and a lower boundary means a row
 * inside an attested range is not classified as if it were.
 */
export function reconciliationBoundary(
  history: readonly ActualTransaction[],
): string | null {
  let newest: string | null = null;
  for (const tx of history) {
    if (tx.reconciled && (newest === null || tx.date > newest)) newest = tx.date;
  }
  return newest;
}

/** How many days apart two amounts may be and still look like the same event. */
const BLIND_DUPLICATE_WINDOW_DAYS = 1;

const DAY_MS = 86_400_000;

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

/**
 * The key under which two source rows in one file count as the same row: the
 * bank's reference when there is one, otherwise the content. The bank's file
 * is authoritative on the count, so a genuine second copy has to reach the
 * human rather than be absorbed by our own dedup.
 */
function identityKey(tx: SourceTransaction): string {
  if (tx.importedId !== '') return `id:${tx.importedId}`;
  // JSON-encoded, not joined on a separator: a plain join cannot tell
  // `payee="A|B", notes="C"` from `payee="A", notes="B|C"`. A collision here is
  // only ever an extra prompt rather than a lost row, but it costs nothing to
  // make impossible - and it is the same mistake that would matter in
  // `mintFromParts`, where the result is written.
  return `content:${JSON.stringify([tx.date, tx.amountCents, tx.payee, tx.notes])}`;
}

export function classify(
  sources: readonly SourceTransaction[],
  existing: readonly ActualTransaction[],
  /** ISO date of the newest reconciled transaction, or null if there is none. */
  boundary: string | null,
): ClassifiedRow[] {
  // A list, not one transaction: nothing in Actual stops two rows sharing an
  // imported ID, and keeping only the last would hide exactly that from the
  // human.
  const byImportedId = new Map<string, [ActualTransaction, ...ActualTransaction[]]>();
  for (const tx of existing) {
    if (!tx.imported_id) continue;
    const sameId = byImportedId.get(tx.imported_id);
    if (sameId) sameId.push(tx);
    else byImportedId.set(tx.imported_id, [tx]);
  }

  const byAmount = new Map<number, ActualTransaction[]>();
  for (const tx of existing) {
    const sameAmount = byAmount.get(tx.amount);
    if (sameAmount) sameAmount.push(tx);
    else byAmount.set(tx.amount, [tx]);
  }

  const firstSeen = new Map<string, number>();
  const rows: ClassifiedRow[] = [];

  for (const source of sources) {
    const reasons: Evidence[] = [];

    const alreadyImported =
      source.importedId === '' ? undefined : byImportedId.get(source.importedId);
    const paired = new Set((alreadyImported ?? []).map((tx) => tx.id));

    // A blind duplicate is a transaction we could *not* confidently pair, so
    // those already paired by imported ID are not among them - listing them
    // again would name the same row twice in the evidence.
    const candidates = (byAmount.get(source.amountCents) ?? []).filter(
      (tx) =>
        !paired.has(tx.id) &&
        daysApart(tx.date, source.date) <= BLIND_DUPLICATE_WINDOW_DAYS,
    );

    const key = identityKey(source);
    const repeatOf = firstSeen.get(key);
    if (repeatOf === undefined) firstSeen.set(key, source.sourceLine);

    let bucket: Bucket;
    if (alreadyImported) {
      bucket = 'skip';
      reasons.push({ kind: 'already-imported', matched: alreadyImported });
    } else if (boundary !== null && source.date <= boundary) {
      bucket = 'locked';
      reasons.push({
        kind: 'inside-reconciled-range',
        boundary,
        matched: candidates[0] ?? null,
      });
    } else if (candidates.length > 0 || repeatOf !== undefined) {
      bucket = 'suspicious';
    } else {
      bucket = 'clean';
    }

    if (candidates.length > 0) {
      reasons.push({ kind: 'same-amount-within-one-day', candidates });
    }
    if (repeatOf !== undefined) {
      reasons.push({ kind: 'repeated-in-this-file', firstSeenLine: repeatOf });
    }
    if (reasons.length === 0) reasons.push({ kind: 'no-match' });

    rows.push({ source, bucket, reasons });
  }

  return rows;
}

/** Count rows per bucket, for the Tape's header and the run's closing line. */
export function tally(rows: readonly ClassifiedRow[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = {
    clean: 0,
    suspicious: 0,
    skip: 0,
    locked: 0,
  };
  for (const row of rows) counts[row.bucket] += 1;
  return counts;
}
