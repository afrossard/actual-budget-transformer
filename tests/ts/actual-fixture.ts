/**
 * The integration suite's harness: a real Actual server, a fresh account per
 * run, and one seeded month that reaches every case pairing has at once.
 *
 * The fixture design is carried over from the #38 prototype (`scenario_source`
 * + `seed_actual`) and reshaped for one-to-one pairing (ADR 0003): a pair with
 * the reconciled transaction, a statement transaction missing from Actual on
 * the reconciled-through date, a pair by imported ID, a pair on amount and
 * date against a *split* entry typed by hand, a same-day pair that leaves its
 * day-apart twin a lookalike, five equal-amount consecutive days,
 * reference-less twins, and an imported-ID pair whose amount disagrees with
 * the bank's.
 *
 * Each run creates its **own account**, which is why this suite needs no date
 * partitioning: the reconciled-through date is account-global server state, so
 * owning the account makes it entirely ours.
 *
 * These helpers call `@actual-app/api` directly. That is deliberate: seeding
 * has to put Actual into states the gateway cannot produce - a reconciled
 * transaction, a split hand entry - and the whole point of testing against the
 * real server is that a mock would encode our assumptions instead of checking
 * them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActualGateway, type GatewaySettings } from '../../src/actual-gateway.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';
import type { IsoDate } from '../../src/iso-date.ts';
import { isoDate } from './iso-date-fixture.ts';

export const SERVER_URL =
  process.env['ACTUAL_SERVER_URL'] ?? 'http://actual-server:5006';
const PASSWORD = process.env['ACTUAL_PASSWORD'] ?? 'test-password';
const BUDGET_NAME = process.env['ACTUAL_BUDGET_NAME'] ?? 'Test Budget';

let cachedSettings: GatewaySettings | null = null;

/**
 * Settings for the bootstrapped test budget.
 *
 * The gateway opens a budget only by sync ID, and the bootstrap cannot choose
 * one, so the harness looks it up by name - which it may, owning the server.
 * More than one budget under that name is refused rather than guessed at.
 */
export async function testSettings(): Promise<GatewaySettings> {
  if (cachedSettings) return cachedSettings;
  const api = await rawApi();
  const dataDir = mkdtempSync(join(tmpdir(), 'abt-fixture-'));
  let matches: string[];
  try {
    await api.init({ serverURL: SERVER_URL, password: PASSWORD, dataDir });
    const budgets = await api.getBudgets();
    matches = [
      ...new Set(budgets.filter((b) => b.name === BUDGET_NAME).map((b) => b.groupId)),
    ];
  } finally {
    await api.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const [syncId] = matches;
  if (matches.length !== 1 || syncId === undefined) {
    throw new Error(
      `expected one budget named ${JSON.stringify(BUDGET_NAME)} on ${SERVER_URL}, ` +
        `found ${matches.length}. Recreate the server and run \`npm run bootstrap\`.`,
    );
  }
  cachedSettings = { serverUrl: SERVER_URL, password: PASSWORD, syncId, dataDir: null };
  return cachedSettings;
}

export async function serverReachable(): Promise<boolean> {
  try {
    // Relative, not root-relative: `new URL('/x', 'https://host/actual/')` is
    // `https://host/x`, so a leading slash throws away the base path of a
    // server behind a subpath reverse proxy. The whole suite would then skip
    // itself as "unreachable" against a server that works perfectly well - the
    // same trap `infoUrl` in src/actual-version.ts documents and avoids.
    const base = SERVER_URL.endsWith('/') ? SERVER_URL : `${SERVER_URL}/`;
    const response = await fetch(new URL('account/needs-bootstrap', base), {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function skipReason(reachable: boolean): string | false {
  return reachable
    ? false
    : `Actual server unreachable at ${SERVER_URL}. Start it with ` +
        `\`npm run actual:up\` and \`npm run bootstrap\`.`;
}

/** The already-initialised api singleton behind an open gateway. */
export async function rawApi(): Promise<typeof import('@actual-app/api')> {
  return import('@actual-app/api');
}

export type Session = {
  gateway: ActualGateway;
  api: typeof import('@actual-app/api');
  close(): Promise<void>;
};

export async function openSession(): Promise<Session> {
  const gateway = new ActualGateway(await testSettings());
  await gateway.open();
  const api = await rawApi();
  return { gateway, api, close: () => gateway.close() };
}

/**
 * Close a session that `before` may never have opened.
 *
 * `node:test` runs `after` even when `before` threw - which is exactly what
 * happens when the server goes away mid-suite - and closing nothing beats a
 * TypeError stacked on top of the real failure. The suites hold their session
 * in a `let session: Session`, so this is where the "maybe" is stated.
 */
export async function closeSession(session: Session | undefined): Promise<void> {
  await session?.close();
}

let accountCounter = 0;

/** A fresh, uniquely named account, so this run owns its whole history. */
export async function createRunAccount(
  session: Session,
  label: string,
): Promise<{ id: string; name: string }> {
  accountCounter += 1;
  const name = `TS ${label} ${runTag()}-${accountCounter}`;
  const id = await session.api.createAccount({ name }, 0);
  await session.api.sync();
  return { id, name };
}

let cachedTag: string | null = null;

/** A per-process tag, so imported IDs and account names never collide. */
export function runTag(): string {
  cachedTag ??= `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .padStart(3, '0')}`;
  return cachedTag;
}

export const RECONCILED_THROUGH = isoDate('2030-06-30');

export type Scenario = {
  tag: string;
  reconciledThrough: IsoDate;
  source: SourceTransaction[];
  /** The reconciled transaction that sets the reconciled-through date. */
  reconciledId: string;
  /** The split entry typed by hand that the restaurant one pairs with. */
  splitId: string;
  /** The imported-ID pair whose amount in Actual disagrees with the bank's. */
  amountMismatchId: string;
};

/** Statement transactions as a parser would hand them over. */
export function scenarioSource(tag: string): SourceTransaction[] {
  const rows: [string, string, string, number, string][] = [
    // In the reconciled period, and the same as the reconciled transaction:
    // it pairs, and nothing is written for it.
    [RECONCILED_THROUGH, 'SUPERMARKET CORRECTION', 'Carte', -12000, 'T-9001'],
    // On the same day, and missing from Actual - as if deleted there to be
    // imported again. Reviewed, with a warning, never set aside (#82).
    [RECONCILED_THROUGH, 'KIOSK', 'Carte', -300, 'T-9002'],
    ['2031-03-02', 'MIGROS', 'Carte', -2345, 'T-0001'],
    ['2031-03-03', 'SBB TICKET', 'Carte', -860, 'T-0002'],
    // Already written under this imported ID on an earlier run.
    ['2031-03-04', 'SALARY ACME SA', 'Virement', 650000, 'T-0003'],
    // A split entry typed by hand sits on 03-06 in Actual: a pair a day off.
    ['2031-03-05', 'RESTAURANT DES ALPES', 'Carte', -6400, 'T-0004'],
    // An entry typed by hand on 03-09 pairs with this, on the same day...
    ['2031-03-09', 'CAFE LUGANO', 'Carte', -450, 'T-0012'],
    // ...so the first of five equal-amount consecutive days is reviewed, as
    // looking like that pair, and importing it must not pair the rest.
    ['2031-03-10', 'CAFE LUGANO', 'Carte', -450, 'T-0005'],
    ['2031-03-11', 'CAFE LUGANO', 'Carte', -450, 'T-0006'],
    ['2031-03-12', 'CAFE LUGANO', 'Carte', -450, 'T-0007'],
    ['2031-03-13', 'CAFE LUGANO', 'Carte', -450, 'T-0008'],
    ['2031-03-14', 'CAFE LUGANO', 'Carte', -450, 'T-0009'],
    // The bank now says -75.00 for a transaction already stored at -80.00.
    ['2031-03-15', 'PRICE CHANGED', 'Carte', -7500, 'T-0011'],
    // Two real purchases with identical attributes and no bank reference. The
    // bank's file says two, so both are reviewed.
    ['2031-03-20', 'PHARMACIE CENTRALE', '', -1990, ''],
    ['2031-03-20', 'PHARMACIE CENTRALE', '', -1990, ''],
    ['2031-03-25', 'UBS TWINT', 'Motif: loyer', -15000, 'T-0010'],
  ];
  return rows.map(([date, payee, notes, amountCents, reference], index) => ({
    date: isoDate(date),
    amountCents,
    payee,
    notes,
    importedId: reference === '' ? '' : `${tag}-${reference}`,
    importedIdOrigin:
      reference === '' ? ('absent' as const) : ('bank-reference' as const),
    sourceLine: index + 11,
  }));
}

/** Put the pre-existing Actual state in place on a fresh account. */
export async function seedScenario(
  session: Session,
  accountId: string,
): Promise<Scenario> {
  const tag = runTag();
  const { api } = session;

  await api.addTransactions(accountId, [
    {
      date: RECONCILED_THROUGH,
      amount: -12000,
      payee_name: 'OLD RECONCILED TX',
      notes: 'marked reconciled below, which sets the reconciled-through date',
    },
    {
      date: '2031-03-04',
      amount: 650000,
      imported_id: `${tag}-T-0003`,
      payee_name: 'SALARY ACME SA',
      notes: 'written on a previous run',
    },
    {
      date: '2031-03-15',
      amount: -8000,
      imported_id: `${tag}-T-0011`,
      payee_name: 'PRICE CHANGED',
      notes: 'stored at -80.00 while the bank now says -75.00',
    },
  ]);

  // Typed by hand, these carry no imported ID, so they pair on amount and date.
  // The restaurant one is split, so its pair is seen to leave it untouched.
  await api.addTransactions(accountId, [
    {
      date: '2031-03-06',
      amount: -6400,
      payee_name: 'Restaurant (typed by hand)',
      notes: 'manual',
      subtransactions: [{ amount: -4000 }, { amount: -2400 }],
    },
    {
      date: '2031-03-09',
      amount: -450,
      payee_name: 'Coffee (typed by hand)',
      notes: 'manual',
    },
  ]);
  await api.sync();

  const stored = await api.getTransactions(accountId, '2030-01-01', '2031-12-31');
  // Typed by hand: no imported ID, so it pairs on amount and date.
  const reconciled = stored.find((t) => t.date === RECONCILED_THROUGH);
  if (!reconciled)
    throw new Error('seeding failed: the reconciled transaction is missing');
  await api.updateTransaction(reconciled.id, { reconciled: true });
  await api.sync();

  const split = stored.find((t) => t.date === '2031-03-06' && t.is_parent);
  const mismatch = stored.find((t) => t.imported_id === `${tag}-T-0011`);
  if (!split || !mismatch) throw new Error('seeding failed: hand entries are missing');

  return {
    tag,
    reconciledThrough: RECONCILED_THROUGH,
    source: scenarioSource(tag),
    reconciledId: reconciled.id,
    splitId: split.id,
    amountMismatchId: mismatch.id,
  };
}
