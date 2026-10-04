/**
 * The Actual gateway: the only module in this codebase that touches
 * `@actual-app/api`.
 *
 * It deliberately does **not** expose `importTransactions`. That call carries
 * Actual's own matcher — same amount within ±7 days against any row with no
 * imported ID — which merges instead of adding, and on a merge writes neither
 * the bank's amount nor the bank's date while always stamping its own imported
 * ID. Two matchers competing over one decision caused every surprise in #38.
 * This tool classifies, so it reads, adds, and patches: `getTransactions`,
 * `addTransactions`, `updateTransaction`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActualTransaction } from './classify.ts';
import {
  assertVersionCompatible,
  installedApiVersion,
  probeServerVersion,
} from './actual-version.ts';

export type GatewaySettings = {
  serverUrl: string;
  password: string;
  /** The budget's Sync ID (`groupId`), never its name: names are not unique. */
  syncId: string;
  /** A fresh temp directory is created and removed per run when null. */
  dataDir: string | null;
};

export type Account = { id: string; name: string; closed?: boolean };

/** A transaction to create. `importedId` may be blank, and then none is set. */
export type NewTransaction = {
  date: string;
  amountCents: number;
  payee: string;
  notes: string;
  importedId: string;
};

/** The fields a correction may patch. Never the amount — see `correct`. */
export type Patch = {
  date?: string | undefined;
  notes?: string | undefined;
  payeeName?: string | undefined;
  importedId?: string | undefined;
};

type Api = typeof import('@actual-app/api');

/** A transaction as the api hands it back, before narrowing. */
type TransactionRow = Awaited<ReturnType<Api['getTransactions']>>[number];

export class ActualGateway {
  #api: Api | null = null;
  #ownedDataDir: string | null = null;
  #payeeNames: Map<string, string> | null = null;

  readonly #settings: GatewaySettings;

  constructor(settings: GatewaySettings) {
    this.#settings = settings;
  }

  async open(): Promise<void> {
    const server = await probeServerVersion(this.#settings.serverUrl);
    assertVersionCompatible(installedApiVersion(), server);

    let dataDir = this.#settings.dataDir;
    if (dataDir === null) {
      dataDir = mkdtempSync(join(tmpdir(), 'abt-actual-'));
      this.#ownedDataDir = dataDir;
    }

    const api = await import('@actual-app/api');
    await api.init({
      serverURL: this.#settings.serverUrl,
      password: this.#settings.password,
      dataDir,
      // The api otherwise logs its own progress - "Syncing since ...", "Got
      // messages from server 0" - to stdout, in between the Tape's lines (#81).
      // Its warnings and errors go to stderr regardless.
      verbose: false,
    });
    this.#api = api;

    // By sync ID, never by name: a server can hold two budgets under one name,
    // and picking the first would write into whichever happened to list first.
    const { syncId, serverUrl } = this.#settings;
    const budgets = await api.getBudgets();
    if (!budgets.some((b) => b.groupId === syncId)) {
      // A budget held both locally and on the server lists twice.
      const available = new Map<string, string>();
      for (const b of budgets) if (b.groupId) available.set(b.groupId, b.name);
      const names = [...available].map(
        ([id, name]) => [id, JSON.stringify(name)] as const,
      );
      const width = Math.max(0, ...names.map(([, name]) => name.length));
      const lines = names.map(([id, name]) => `  ${name.padEnd(width)}  ${id}`);
      throw new Error(
        `no budget with sync ID ${JSON.stringify(syncId)} on ${serverUrl}. ` +
          (lines.length > 0 ? `Available:\n${lines.join('\n')}` : 'It has no budgets.'),
      );
    }
    await api.downloadBudget(syncId);
  }

  async close(): Promise<void> {
    // The temp dir holds a downloaded copy of the budget, so it goes whichever
    // way `shutdown()` ends.
    try {
      if (this.#api) {
        const api = this.#api;
        this.#api = null;
        await api.shutdown();
      }
    } finally {
      if (this.#ownedDataDir) {
        rmSync(this.#ownedDataDir, { recursive: true, force: true });
        this.#ownedDataDir = null;
      }
    }
  }

  /**
   * Every account, closed ones included: which one a statement goes into is
   * `resolveAccount`'s decision, and a closed exact match is worth naming.
   * Not cached: a stale account list is a silently wrong account.
   */
  async listAccounts(): Promise<Account[]> {
    const rows = await this.#require().getAccounts();
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      closed: a.closed ?? false,
    }));
  }

  /**
   * The account's transactions dated from `startDate` to `endDate`, both
   * inclusive. Splits come back as their parent, with the parts inside it.
   */
  async getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<ActualTransaction[]> {
    const rows = await this.#require().getTransactions(accountId, startDate, endDate);
    return this.#toActual(rows);
  }

  /**
   * Everything the account holds, whatever its date.
   *
   * The span is the whole calendar deliberately: Actual allows a transaction
   * dated in the future. The import itself never reads this - it asks the
   * targeted questions below - but a test asserting on what a run left behind
   * needs all of it.
   */
  async getAccountHistory(accountId: string): Promise<ActualTransaction[]> {
    return this.getTransactions(accountId, '1000-01-01', '9999-12-31');
  }

  /**
   * The reconciliation boundary: the date of the account's newest reconciled
   * transaction, or null if it has none.
   *
   * Actual has no such field, so it is derived - and from every row whatever
   * its date, because a lower boundary means a row inside an attested range is
   * not classified as if it were. The parts of a split are counted as well as
   * its parent: Actual dates them alike, and should only one side carry the
   * flag, the higher boundary is the safe error.
   */
  async reconciliationBoundary(accountId: string): Promise<string | null> {
    const api = this.#require();
    const result = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({ account: accountId, reconciled: true })
        .orderBy([{ date: 'desc' }])
        .limit(1)
        .select(['date'])
        .options({ splits: 'all' }),
    )) as { data: { date: string }[] };
    return result.data[0]?.date ?? null;
  }

  /**
   * Every transaction in the account holding one of these imported IDs,
   * whatever its date.
   *
   * Unbounded in date because an imported ID has to be recognised wherever the
   * transaction now sits: the cards parser dates a purchase by `Date d'achat`
   * while the bank books it weeks later, so re-dating it in Actual moves it a
   * long way from where this tool wrote it, and a missed ID turns the row into
   * a Clean that claims nothing in Actual looks like it. Bounded in rows
   * instead, which is what makes it cheap (#67).
   *
   * Every holder comes back, not one per ID: Actual does not enforce uniqueness.
   */
  async findByImportedIds(
    accountId: string,
    importedIds: readonly string[],
  ): Promise<ActualTransaction[]> {
    const wanted = [...new Set(importedIds)].filter((id) => id !== '');
    if (wanted.length === 0) return [];
    const api = this.#require();
    const result = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({
          account: accountId,
          // `$oneof` pastes each value into the SQL between single quotes and
          // escapes nothing, so the quote is doubled here. It is still the only
          // safe shape: a plain string is read as a field reference when it
          // starts with `$` and as a named parameter when it starts with `:`.
          // Pinned by the characterization tests, since a fix upstream would
          // turn this doubling into a silent miss.
          imported_id: { $oneof: wanted.map((id) => id.replaceAll("'", "''")) },
        })
        .select('*')
        .options({ splits: 'grouped' }),
    )) as { data: TransactionRow[] };
    // A split whose *part* carries the ID comes back as its parent, which may
    // not; keep only the rows that hold one of the IDs themselves, as a
    // whole-history read would have.
    const asked = new Set(wanted);
    return this.#toActual(result.data.filter((t) => asked.has(t.imported_id ?? '')));
  }

  async #toActual(rows: readonly TransactionRow[]): Promise<ActualTransaction[]> {
    const payees = await this.#payees();
    return rows.map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      imported_id: t.imported_id ?? null,
      payee: t.payee ?? null,
      payeeName: (t.payee ? payees.get(t.payee) : null) ?? t.imported_payee ?? null,
      notes: t.notes ?? null,
      reconciled: t.reconciled ?? false,
      is_parent: t.is_parent ?? false,
      subtransactions: (t.subtransactions ?? []).map((s) => ({
        id: s.id,
        amount: s.amount,
      })),
    }));
  }

  /** The payee's own name, so the Tape can show it rather than a raw string. */
  async payeeName(payeeId: string | null | undefined): Promise<string | null> {
    if (!payeeId) return null;
    return (await this.#payees()).get(payeeId) ?? null;
  }

  /** The id of the payee with this name, creating it if the budget has none. */
  async resolvePayeeId(name: string): Promise<string> {
    const payees = await this.#payees();
    for (const [id, existing] of payees) {
      if (existing === name) return id;
    }
    const id = await this.#require().createPayee({ name });
    payees.set(id, name);
    return id;
  }

  async #payees(): Promise<Map<string, string>> {
    if (this.#payeeNames === null) {
      const rows = await this.#require().getPayees();
      this.#payeeNames = new Map(rows.map((p) => [p.id, p.name]));
    }
    return this.#payeeNames;
  }

  /**
   * Create a transaction, and only ever create: `addTransactions` runs no
   * matcher, so a confirmed create creates.
   */
  async add(accountId: string, tx: NewTransaction): Promise<void> {
    await this.#require().addTransactions(accountId, [
      {
        date: tx.date,
        amount: tx.amountCents,
        payee_name: tx.payee,
        notes: tx.notes,
        ...(tx.importedId === '' ? {} : { imported_id: tx.importedId }),
      },
    ]);
    // `payee_name` makes Actual resolve or create the payee server-side, so the
    // cached list is now behind. Keeping it would make a later correction on the
    // same payee miss the one that was just created and create a second payee
    // with the same name.
    this.#payeeNames = null;
  }

  /**
   * Patch an existing transaction's fields. Never its amount: patching a split
   * parent's amount would leave the parts no longer summing to it, and what to
   * do when the bank disagrees on the amount is deliberately undecided (#49).
   *
   * Note that Actual enforces nothing here — `updateTransaction` patches a
   * reconciled transaction without complaint and leaves `reconciled` true. The
   * guard against writing inside the reconciled range is this tool's own, and
   * lives in the review loop.
   */
  async correct(transactionId: string, patch: Patch): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (patch.date !== undefined) fields['date'] = patch.date;
    if (patch.notes !== undefined) fields['notes'] = patch.notes;
    if (patch.importedId !== undefined) fields['imported_id'] = patch.importedId;
    if (patch.payeeName !== undefined) {
      // A blank name would resolve to a newly created payee called "", which
      // stays in the budget for good. The caller omits a payee it does not have.
      if (patch.payeeName === '') {
        throw new Error('refusing to set a blank payee; omit payeeName instead');
      }
      // Both: the payee link is what the UI shows, and `imported_payee` is the
      // raw name the bank wrote, which is what Actual's own import would set.
      fields['payee'] = await this.resolvePayeeId(patch.payeeName);
      fields['imported_payee'] = patch.payeeName;
    }
    if (Object.keys(fields).length === 0) return;
    await this.#require().updateTransaction(transactionId, fields);
  }

  async sync(): Promise<void> {
    await this.#require().sync();
  }

  #require(): Api {
    if (!this.#api) {
      throw new Error('ActualGateway is not open; call open() first');
    }
    return this.#api;
  }
}
