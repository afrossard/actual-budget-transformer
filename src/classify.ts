/**
 * The classifier: statement transactions plus what Actual already holds in,
 * each statement transaction's pair out. Pure - no server, no I/O, no clock.
 *
 * Pairing is one to one (ADR 0003). A statement transaction pairs with the
 * Actual transaction that shares its imported ID, or failing that with one of
 * the same amount within a day, and each Actual transaction pairs at most once.
 * A paired statement transaction is already in Actual and is never reviewed;
 * every unpaired one is, whatever its date.
 *
 * Classification happens **once per batch**. Re-reading Actual before each
 * prompt would make every import pair the next statement transaction with what
 * was just written, which is a cascade of manufactured noise rather than a
 * finding (#50).
 */
import { MINTED_PREFIX } from './imported-id.ts';
import type { Period, SourceTransaction } from './sources/types.ts';

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

/** The Actual transaction a statement transaction is taken to be, and why. */
export type Pair = {
  by: 'imported-id' | 'amount-and-date';
  actual: ActualTransaction;
};

/**
 * An Actual transaction alike to an unpaired one - the same amount within a
 * day, or holding its imported ID - that is not its pair, and why not.
 */
export type Lookalike =
  | {
      actual: ActualTransaction;
      /**
       * `pair`: it is the pair of statement transaction `#of`. `extra-holder`:
       * it holds `#of`'s imported ID beside its pair, a duplicate the
       * statement report lists among the unpaired Actual transactions.
       */
      role: 'pair' | 'extra-holder';
      /** The `#` of the statement transaction it belongs to. */
      of: number;
    }
  | {
      actual: ActualTransaction;
      /** It carries another bank reference, so it is a different transaction. */
      role: 'other-reference';
      of: null;
    };

export type Classified = {
  source: SourceTransaction;
  /** Its position in the statement, counted from 1: the `#` the CLI shows. */
  number: number;
  /** Null when unpaired, which is what sends it to review. */
  pair: Pair | null;
  /**
   * For an unpaired statement transaction, the Actual transactions of the same
   * amount within a day that went to other statement transactions. Saying so
   * is what lets the human tell a genuine second purchase from a pairing that
   * picked the other twin.
   */
  lookalikes: readonly Lookalike[];
  /**
   * The `#` of an earlier statement transaction in this file it is identical
   * to, or null. Both are still reviewed if unpaired: the bank's file is
   * authoritative on the count.
   */
  repeatOf: number | null;
  /** Dated on or before the reconciled-through date. Decides nothing; warns. */
  inReconciledPeriod: boolean;
};

/**
 * Something about a pair that Actual needs fixed, there rather than here.
 * Only an imported-ID pair can have one: an amount pair has the same amount by
 * definition. A second holder of the imported ID is not one of these but a
 * duplicate, listed with the unpaired Actual transactions.
 */
export type ToFix = { kind: 'amount-differs'; actualAmount: number };

/**
 * Whether both carry a reference from the bank, and they differ. The bank says
 * these are two transactions, so they never pair on amount and date (#82).
 *
 * Only bank references count. A minted ID is derived by this tool and can
 * shift between two exports of one purchase (the cards occurrence counter),
 * and a transaction typed by hand carries no ID at all.
 */
function otherBankReference(source: SourceTransaction, tx: ActualTransaction): boolean {
  return (
    source.importedIdOrigin === 'bank-reference' &&
    source.importedId !== '' &&
    !!tx.imported_id &&
    !tx.imported_id.startsWith(MINTED_PREFIX) &&
    tx.imported_id !== source.importedId
  );
}

/**
 * Whether two Actual transactions carry two different bank references, which
 * makes them two transactions however alike they are, as `otherBankReference`
 * does for a pair.
 */
function twoBankReferences(a: ActualTransaction, b: ActualTransaction): boolean {
  const bank = (tx: ActualTransaction): boolean =>
    !!tx.imported_id && !tx.imported_id.startsWith(MINTED_PREFIX);
  return bank(a) && bank(b) && a.imported_id !== b.imported_id;
}

/** How many days apart two amounts may be and still pair. */
export const PAIRING_WINDOW_DAYS = 1;

const DAY_MS = 86_400_000;

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

/**
 * The key under which two statement transactions in one file count as the
 * same one: the bank's reference when there is one, otherwise the content.
 */
function identityKey(tx: SourceTransaction): string {
  if (tx.importedId !== '') return `id:${tx.importedId}`;
  // JSON-encoded, not joined on a separator: a plain join cannot tell
  // `payee="A|B", notes="C"` from `payee="A", notes="B|C"`.
  return `content:${JSON.stringify([tx.date, tx.amountCents, tx.payee, tx.notes])}`;
}

export function classify(
  sources: readonly SourceTransaction[],
  /**
   * Every Actual transaction a statement transaction could pair with: each
   * holder of one of their imported IDs, wherever it is dated, and everything
   * dated within the pairing window of them. More is harmless - the account's
   * whole history pairs the same - but less is a silent miss.
   */
  existing: readonly ActualTransaction[],
  /** The reconciled-through date, or null if nothing is reconciled. */
  reconciledThrough: string | null,
): Classified[] {
  const pairs: (Pair | null)[] = sources.map(() => null);
  // Actual id -> index of the statement transaction it is paired with.
  const taken = new Map<string, number>();

  // First by imported ID, so an amount pair can never take an Actual
  // transaction that a statement transaction names outright.
  const holdersOf = new Map<string, ActualTransaction[]>();
  for (const tx of existing) {
    if (!tx.imported_id) continue;
    const held = holdersOf.get(tx.imported_id);
    if (held) held.push(tx);
    else holdersOf.set(tx.imported_id, [tx]);
  }
  const carried = new Set(sources.map((s) => s.importedId).filter((id) => id !== ''));
  for (const [i, source] of sources.entries()) {
    const holders = holdersOf.get(source.importedId);
    if (source.importedId === '' || holders === undefined) continue;
    const free = holders.find((tx) => !taken.has(tx.id));
    if (free === undefined) continue;
    taken.set(free.id, i);
    pairs[i] = { by: 'imported-id', actual: free };
  }
  // Every holder of an imported ID in this file is accounted for by that ID: a
  // second holder paired on amount would hide the duplicate it is.
  const reserved = new Set(
    existing
      .filter((tx) => tx.imported_id && carried.has(tx.imported_id))
      .map((tx) => tx.id),
  );

  const alike = (source: SourceTransaction): ActualTransaction[] =>
    existing
      .filter(
        (tx) =>
          tx.amount === source.amountCents &&
          daysApart(tx.date, source.date) <= PAIRING_WINDOW_DAYS,
      )
      .sort(
        (a, b) =>
          daysApart(a.date, source.date) - daysApart(b.date, source.date) ||
          a.date.localeCompare(b.date),
      );

  // Then on amount and date, as a maximum matching (Kuhn's augmenting paths):
  // a statement transaction may move one paired earlier to its next candidate
  // to make room. Greedy would leave a run of entries typed a day late half
  // unpaired. Same-day pairs are made first, and the day-apart phase starts
  // from them, so a pair is a day off only where the count needs it to be.
  const candidates = sources.map((source, i) =>
    pairs[i] === null
      ? alike(source).filter(
          (tx) => !reserved.has(tx.id) && !otherBankReference(source, tx),
        )
      : [],
  );
  const byAmount = new Map<string, number>();
  const tryPair = (i: number, maxDays: number, visited: Set<string>): boolean => {
    const source = sources[i];
    if (source === undefined) return false;
    for (const tx of candidates[i] ?? []) {
      if (visited.has(tx.id) || daysApart(tx.date, source.date) > maxDays) continue;
      visited.add(tx.id);
      const holder = byAmount.get(tx.id);
      if (holder === undefined || tryPair(holder, maxDays, visited)) {
        byAmount.set(tx.id, i);
        return true;
      }
    }
    return false;
  };
  for (const maxDays of [0, PAIRING_WINDOW_DAYS]) {
    const paired = new Set(byAmount.values());
    for (const i of sources.keys()) {
      if (pairs[i] === null && !paired.has(i)) tryPair(i, maxDays, new Set());
    }
  }
  const byId = new Map(existing.map((tx) => [tx.id, tx]));
  for (const [id, i] of byAmount) {
    const actual = byId.get(id);
    if (actual === undefined) continue;
    taken.set(id, i);
    pairs[i] = { by: 'amount-and-date', actual };
  }

  const firstSeen = new Map<string, number>();
  return sources.map((source, i) => {
    const number = i + 1;
    const key = identityKey(source);
    const repeatOf = firstSeen.get(key) ?? null;
    if (repeatOf === null) firstSeen.set(key, number);

    const pair = pairs[i] ?? null;
    const lookalikes = new Map<string, Lookalike>();
    if (pair === null) {
      // Holders of its own imported ID first: each went to an earlier copy of
      // the same reference, wherever it is dated.
      const own =
        source.importedId === '' ? [] : (holdersOf.get(source.importedId) ?? []);
      for (const tx of [...own, ...alike(source)]) {
        const paired = taken.get(tx.id);
        const holderOf = reservedFor(tx, sources);
        if (paired !== undefined) {
          lookalikes.set(tx.id, { actual: tx, of: paired + 1, role: 'pair' });
        } else if (holderOf !== undefined && !lookalikes.has(tx.id)) {
          lookalikes.set(tx.id, { actual: tx, of: holderOf + 1, role: 'extra-holder' });
        } else if (otherBankReference(source, tx)) {
          lookalikes.set(tx.id, { actual: tx, of: null, role: 'other-reference' });
        }
      }
    }
    return {
      source,
      number,
      pair,
      lookalikes: [...lookalikes.values()],
      repeatOf,
      inReconciledPeriod:
        reconciledThrough !== null && source.date <= reconciledThrough,
    };
  });
}

/** The first statement transaction carrying the imported ID this one holds. */
function reservedFor(
  tx: ActualTransaction,
  sources: readonly SourceTransaction[],
): number | undefined {
  if (!tx.imported_id) return undefined;
  const i = sources.findIndex((s) => s.importedId === tx.imported_id);
  return i < 0 ? undefined : i;
}

/** What Actual needs fixed about this pair, if anything; never prompted. */
export function toFixInActual(classified: Classified): ToFix[] {
  const { pair, source } = classified;
  if (pair === null || pair.actual.amount === source.amountCents) return [];
  return [{ kind: 'amount-differs', actualAmount: pair.actual.amount }];
}

/**
 * An Actual transaction in the statement's account, dated within its period or
 * holding one of its imported IDs, that no statement transaction pairs with:
 * the bank does not hold it as Actual does.
 */
export type UnpairedActual = {
  actual: ActualTransaction;
  /**
   * The paired Actual transaction it duplicates, or null: one holding the same
   * imported ID, or else one of the same amount within a day. Which of the two
   * the pairing took is arbitrary, so the human is shown both.
   */
  twin: ActualTransaction | null;
};

/**
 * Pairing the other way round: every Actual transaction dated within the
 * period that no statement transaction took, and every holder of an imported
 * ID the file carries that none took, wherever it is dated (#119). Nothing is
 * ever written for one; the statement report lists it to be fixed in Actual.
 */
export function unpairedActual(
  classified: readonly Classified[],
  /**
   * What `classify` was given; only those dated within `period` count, and
   * the holders of an imported ID the file carries.
   */
  existing: readonly ActualTransaction[],
  period: Period,
): UnpairedActual[] {
  const paired = classified.flatMap((c) => (c.pair === null ? [] : [c.pair.actual]));
  const taken = new Set(paired.map((tx) => tx.id));
  const twinOf = (tx: ActualTransaction): ActualTransaction | null =>
    paired.find((p) => !!tx.imported_id && p.imported_id === tx.imported_id) ??
    paired
      .filter(
        (p) =>
          p.amount === tx.amount &&
          daysApart(p.date, tx.date) <= PAIRING_WINDOW_DAYS &&
          !twoBankReferences(p, tx),
      )
      .sort((a, b) => daysApart(a.date, tx.date) - daysApart(b.date, tx.date))[0] ??
    null;
  // A holder re-dated far from the file (a card purchase moved to its booking
  // date) is still a duplicate, so the period does not bound it.
  const carried = new Set(
    classified.map((c) => c.source.importedId).filter((id) => id !== ''),
  );
  const listed = (tx: ActualTransaction): boolean =>
    (tx.date >= period.from && tx.date <= period.to) ||
    (!!tx.imported_id && carried.has(tx.imported_id));
  return existing
    .filter((tx) => !taken.has(tx.id) && listed(tx))
    .map((actual) => ({ actual, twin: twinOf(actual) }));
}

/** How many are already in Actual and how many go to review. */
export function tally(classified: readonly Classified[]): {
  paired: number;
  toReview: number;
} {
  const paired = classified.filter((c) => c.pair !== null).length;
  return { paired, toReview: classified.length - paired };
}
