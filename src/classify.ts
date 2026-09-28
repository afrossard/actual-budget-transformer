/**
 * The classifier: source transactions plus what Actual already holds in, four
 * states out. Pure — no server, no I/O, no clock.
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
 * What the tool proposes to do with a source transaction.
 *
 * - `clean` — nothing in Actual looks like it.
 * - `suspicious` — something does, but not confidently enough to pair.
 * - `skip` — its imported ID is already in Actual; nothing left to do.
 * - `locked` — dated on or before the reconciliation boundary.
 */
export type RowState = 'clean' | 'suspicious' | 'skip' | 'locked';

/**
 * Why a row is in its state. The classifier returns this rather than only the
 * state: a decline is a decision, and the human cannot make it without seeing
 * what the tool matched and on what basis.
 */
export type Evidence =
  | { kind: 'already-imported'; matched: ActualTransaction }
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
  state: RowState;
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
  const byImportedId = new Map<string, ActualTransaction>();
  for (const tx of existing) {
    if (tx.imported_id) byImportedId.set(tx.imported_id, tx);
  }

  const byAmount = new Map<number, ActualTransaction[]>();
  for (const tx of existing) {
    const bucket = byAmount.get(tx.amount);
    if (bucket) bucket.push(tx);
    else byAmount.set(tx.amount, [tx]);
  }

  const firstSeen = new Map<string, number>();
  const rows: ClassifiedRow[] = [];

  for (const source of sources) {
    const reasons: Evidence[] = [];

    const alreadyImported =
      source.importedId === '' ? undefined : byImportedId.get(source.importedId);

    // A blind duplicate is a transaction we could *not* confidently pair, so
    // the one already paired by imported ID is not one of them - listing it
    // again would name the same row twice in the evidence.
    const candidates = (byAmount.get(source.amountCents) ?? []).filter(
      (tx) =>
        tx.id !== alreadyImported?.id &&
        daysApart(tx.date, source.date) <= BLIND_DUPLICATE_WINDOW_DAYS,
    );

    const key = identityKey(source);
    const repeatOf = firstSeen.get(key);
    if (repeatOf === undefined) firstSeen.set(key, source.sourceLine);

    let state: RowState;
    if (alreadyImported) {
      state = 'skip';
      reasons.push({ kind: 'already-imported', matched: alreadyImported });
    } else if (boundary !== null && source.date <= boundary) {
      state = 'locked';
      reasons.push({
        kind: 'inside-reconciled-range',
        boundary,
        matched: candidates[0] ?? null,
      });
    } else if (candidates.length > 0 || repeatOf !== undefined) {
      state = 'suspicious';
    } else {
      state = 'clean';
    }

    if (candidates.length > 0) {
      reasons.push({ kind: 'same-amount-within-one-day', candidates });
    }
    if (repeatOf !== undefined) {
      reasons.push({ kind: 'repeated-in-this-file', firstSeenLine: repeatOf });
    }
    if (reasons.length === 0) reasons.push({ kind: 'no-match' });

    rows.push({ source, state, reasons });
  }

  return rows;
}

/** Count rows per state, for the Tape's header and the run's closing line. */
export function tally(rows: readonly ClassifiedRow[]): Record<RowState, number> {
  const counts: Record<RowState, number> = {
    clean: 0,
    suspicious: 0,
    skip: 0,
    locked: 0,
  };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}
