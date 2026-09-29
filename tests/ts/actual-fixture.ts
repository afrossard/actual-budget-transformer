/**
 * The integration suite's harness: a real Actual server, a fresh account per
 * run, and one seeded month that hits every bucket at once.
 *
 * The fixture design is carried over from the #38 prototype (`scenario_source`
 * + `seed_actual`): a pre-boundary transaction inside the reconciled range, a
 * Skip by imported ID, a blind duplicate against a hand entry, a *split* hand
 * entry, five equal-amount consecutive days, reference-less twins, and an
 * imported-ID match whose amount disagrees with the bank's.
 *
 * Each run creates its **own account**, which is why this suite needs none of
 * the date partitioning the Python suite adopted: the reconciliation boundary
 * is account-global server state, so owning the account makes it entirely ours
 * and leaves the Python suite's accounts alone.
 *
 * These helpers call `@actual-app/api` directly. That is deliberate: seeding
 * has to put Actual into states the gateway cannot produce - a reconciled
 * transaction, a split hand entry - and the whole point of testing against the
 * real server is that a mock would encode our assumptions instead of checking
 * them.
 */
import { ActualGateway, type GatewaySettings } from '../../src/actual-gateway.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';

export const SERVER_URL =
  process.env['ACTUAL_SERVER_URL'] ?? 'http://actual-server:5006';
const PASSWORD = process.env['ACTUAL_PASSWORD'] ?? 'test-password';
const BUDGET_NAME = process.env['ACTUAL_BUDGET_NAME'] ?? 'Test Budget';

export const SETTINGS: GatewaySettings = {
  serverUrl: SERVER_URL,
  password: PASSWORD,
  budgetName: BUDGET_NAME,
  dataDir: null,
};

export async function serverReachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/account/needs-bootstrap', SERVER_URL), {
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
        `\`docker compose -f .devcontainer/docker-compose.yml --profile actual up -d actual-server\` ` +
        `and \`npm run bootstrap\`.`;
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
  const gateway = new ActualGateway(SETTINGS);
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

export const BOUNDARY = '2030-06-30';

export type Scenario = {
  tag: string;
  boundary: string;
  source: SourceTransaction[];
  /** The reconciled transaction that defines the boundary. */
  reconciledId: string;
  /** The split hand entry the restaurant row is a blind duplicate of. */
  splitId: string;
  /** The imported-ID match whose stored amount disagrees with the bank's. */
  amountMismatchId: string;
};

/** Source transactions as a parser would hand them over. */
export function scenarioSource(tag: string): SourceTransaction[] {
  const rows: [string, string, string, number, string][] = [
    // Inside the already-reconciled range, and matching the reconciled
    // transaction exactly: the row the reconciled guard is proven on.
    [BOUNDARY, 'SUPERMARKET CORRECTION', 'Carte', -12000, 'T-9001'],
    ['2031-03-02', 'MIGROS', 'Carte', -2345, 'T-0001'],
    ['2031-03-03', 'SBB TICKET', 'Carte', -860, 'T-0002'],
    // Already written under this imported ID on an earlier run.
    ['2031-03-04', 'SALARY ACME SA', 'Virement', 650000, 'T-0003'],
    // A split hand entry sits on 03-06 in Actual: a blind duplicate.
    ['2031-03-05', 'RESTAURANT DES ALPES', 'Carte', -6400, 'T-0004'],
    // Five equal-amount consecutive days, with a hand entry on 03-09. Only the
    // first is near it, and confirming it must not flag the rest.
    ['2031-03-10', 'CAFE LUGANO', 'Carte', -450, 'T-0005'],
    ['2031-03-11', 'CAFE LUGANO', 'Carte', -450, 'T-0006'],
    ['2031-03-12', 'CAFE LUGANO', 'Carte', -450, 'T-0007'],
    ['2031-03-13', 'CAFE LUGANO', 'Carte', -450, 'T-0008'],
    ['2031-03-14', 'CAFE LUGANO', 'Carte', -450, 'T-0009'],
    // The bank now says -75.00 for a transaction already stored at -80.00.
    ['2031-03-15', 'PRICE CHANGED', 'Carte', -7500, 'T-0011'],
    // Two real purchases with identical attributes and no bank reference. The
    // bank's file says two, so the second must reach the human.
    ['2031-03-20', 'PHARMACIE CENTRALE', '', -1990, ''],
    ['2031-03-20', 'PHARMACIE CENTRALE', '', -1990, ''],
    ['2031-03-25', 'UBS TWINT', 'Motif: loyer', -15000, 'T-0010'],
  ];
  return rows.map(([date, payee, notes, amountCents, reference], index) => ({
    date,
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
      date: BOUNDARY,
      amount: -12000,
      imported_id: `${tag}-reconciled`,
      payee_name: 'OLD RECONCILED TX',
      notes: 'marked reconciled below, which sets the boundary',
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

  // Hand-entered rows carry no imported ID, which is what makes them blind
  // duplicates rather than Skips. The restaurant one is split, so a correction
  // can be watched against a split parent.
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
  const reconciled = stored.find((t) => t.imported_id === `${tag}-reconciled`);
  if (!reconciled)
    throw new Error('seeding failed: the boundary transaction is missing');
  await api.updateTransaction(reconciled.id, { reconciled: true });
  await api.sync();

  const split = stored.find((t) => t.date === '2031-03-06' && t.is_parent);
  const mismatch = stored.find((t) => t.imported_id === `${tag}-T-0011`);
  if (!split || !mismatch) throw new Error('seeding failed: hand entries are missing');

  return {
    tag,
    boundary: BOUNDARY,
    source: scenarioSource(tag),
    reconciledId: reconciled.id,
    splitId: split.id,
    amountMismatchId: mismatch.id,
  };
}
