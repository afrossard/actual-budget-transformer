/**
 * The Actual gateway: the only module in this codebase that touches
 * `@actual-app/api`.
 *
 * It deliberately does **not** expose `importTransactions`. That call carries
 * Actual's own matcher — same amount within ±7 days against any row with no
 * imported ID — which merges instead of adding, and on a merge writes neither
 * the bank's amount nor the bank's date while always stamping its own imported
 * ID. Two matchers competing over one decision caused every surprise in #38.
 * This tool pairs, so it reads and adds: `getTransactions`, `aqlQuery`,
 * `addTransactions`. It never patches an Actual transaction: a paired one is
 * already in Actual, and nothing is written for it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActualTransaction } from './classify.ts';
import { toIsoDate, type IsoDate } from './iso-date.ts';
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

/**
 * An account's ID in Actual. Branded so that an IBAN, a card number or an
 * account name cannot reach a read or a write in its place: the gateway is the
 * only module that makes one, from an account Actual listed.
 */
export type AccountId = string & { readonly __accountId: unique symbol };

export type Account = { id: AccountId; name: string; closed?: boolean };

/** A transaction to create. `importedId` may be blank, and then none is set. */
export type NewTransaction = {
  date: IsoDate;
  amountCents: number;
  payee: string;
  notes: string;
  importedId: string;
};

type Api = typeof import('@actual-app/api');

// The whole calendar Actual can store. Literals, so cast rather than checked.
const FIRST_DAY = '1000-01-01' as IsoDate;
const LAST_DAY = '9999-12-31' as IsoDate;

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
      // messages from server 0" - to stdout, in between the statement report's
      // lines (#81).
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
      id: a.id as AccountId,
      name: a.name,
      closed: a.closed ?? false,
    }));
  }

  /**
   * The account's transactions dated from `startDate` to `endDate`, both
   * inclusive. Splits come back as their parent, with the parts inside it.
   */
  async getTransactions(
    accountId: AccountId,
    startDate: IsoDate,
    endDate: IsoDate,
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
  async getAccountHistory(accountId: AccountId): Promise<ActualTransaction[]> {
    return this.getTransactions(accountId, FIRST_DAY, LAST_DAY);
  }

  /**
   * The reconciled-through date: the date of the account's newest reconciled
   * transaction, or null if it has none.
   *
   * Actual has no such field (its `last_reconciled` records when the reconcile
   * flow was last completed, not up to which date), so it is derived - and
   * from every transaction whatever its date, because a date too early would
   * leave out the warning on a statement transaction in the reconciled period.
   * The parts of a split are counted as well as its parent: Actual dates them
   * alike, and should only one side carry the flag, the later date is the safe
   * error.
   */
  async reconciledThroughDate(accountId: AccountId): Promise<IsoDate | null> {
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
    const date = result.data[0]?.date;
    return date === undefined ? null : actualDate(date);
  }

  /**
   * Every transaction in the account holding one of these imported IDs,
   * whatever its date.
   *
   * Unbounded in date because an imported ID has to be recognised wherever the
   * transaction now sits: the cards parser dates a purchase by `Date d'achat`
   * while the bank books it weeks later, so re-dating it in Actual moves it a
   * long way from where this tool wrote it, and a missed ID sends the
   * statement transaction to review as if Actual did not hold it. Bounded in
   * rows instead, which is what makes it cheap (#67).
   *
   * Every holder comes back, not one per ID: Actual does not enforce uniqueness.
   */
  async findByImportedIds(
    accountId: AccountId,
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
      date: actualDate(t.date),
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
  async add(accountId: AccountId, tx: NewTransaction): Promise<void> {
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
    // cached list is now behind, and a later read would show the new
    // transaction's payee as its raw imported name.
    this.#payeeNames = null;
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

/**
 * A date Actual handed back, checked. Actual stores `YYYY-MM-DD` and nothing
 * else, so anything other than a calendar date means the api has changed under
 * us; pairing on it would decide on a date read wrongly, so it stops the run.
 */
function actualDate(value: string): IsoDate {
  const date = toIsoDate(value);
  if (date === null) {
    throw new Error(
      `Actual returned the date ${JSON.stringify(value)}, which is not a YYYY-MM-DD calendar date`,
    );
  }
  return date;
}
