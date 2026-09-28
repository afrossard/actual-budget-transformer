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
  budgetName: string;
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
  date?: string;
  notes?: string;
  payeeName?: string;
  importedId?: string;
};

type Api = typeof import('@actual-app/api');

export class ActualGateway {
  #api: Api | null = null;
  #ownedDataDir: string | null = null;
  #payeeNames: Map<string, string> | null = null;

  readonly #settings: GatewaySettings;

  constructor(settings: GatewaySettings) {
    this.#settings = settings;
  }

  async open(): Promise<void> {
    const serverVersion = await probeServerVersion(this.#settings.serverUrl);
    assertVersionCompatible(installedApiVersion(), serverVersion);

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
    });
    this.#api = api;

    const budgets = await api.getBudgets();
    const budget = budgets.find((b) => b.name === this.#settings.budgetName);
    if (!budget?.groupId) {
      throw new Error(
        `budget ${JSON.stringify(this.#settings.budgetName)} not found on ${this.#settings.serverUrl}. ` +
          `Available: ${budgets.map((b) => JSON.stringify(b.name)).join(', ') || '(none)'}`,
      );
    }
    await api.downloadBudget(budget.groupId);
  }

  async close(): Promise<void> {
    if (this.#api) {
      await this.#api.shutdown();
      this.#api = null;
    }
    if (this.#ownedDataDir) {
      rmSync(this.#ownedDataDir, { recursive: true, force: true });
      this.#ownedDataDir = null;
    }
  }

  async findAccount(name: string): Promise<Account> {
    const accounts = await this.listAccounts();
    const open = accounts.filter((a) => !a.closed);
    const match = open.find((a) => a.name === name);
    if (!match) {
      throw new Error(
        `account ${JSON.stringify(name)} not found in budget. ` +
          `Available: ${open.map((a) => JSON.stringify(a.name)).join(', ') || '(none)'}`,
      );
    }
    return match;
  }

  /** Not cached: a stale account list is a silently wrong account. */
  async listAccounts(): Promise<Account[]> {
    const rows = await this.#require().getAccounts();
    return rows.map((a) => ({
      id: a.id ?? '',
      name: a.name,
      closed: a.closed ?? false,
    }));
  }

  async getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<ActualTransaction[]> {
    const rows = await this.#require().getTransactions(accountId, startDate, endDate);
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

  /**
   * Everything the account holds, whatever its date.
   *
   * The span is the whole calendar deliberately. Capping it at today would miss
   * a transaction dated in the future - Actual allows them - and both things
   * this feeds need the complete set: the reconciliation boundary is the newest
   * reconciled date wherever it sits, and an imported ID has to be recognised
   * wherever the transaction now sits.
   */
  async getAccountHistory(accountId: string): Promise<ActualTransaction[]> {
    return this.getTransactions(accountId, '1000-01-01', '9999-12-31');
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
      this.#payeeNames = new Map(rows.map((p) => [p.id ?? '', p.name]));
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
