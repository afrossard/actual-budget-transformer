/**
 * JSON-over-stdio bridge to @actual-app/api.
 *
 * Protocol: one JSON object per line on stdin, one JSON response per line on
 * stdout. All other output (logs, errors, the @actual-app/api banner) goes to
 * stderr so the wrapper can stay strict about parsing.
 *
 * Request:  { "id": <number>, "command": <string>, "params": <object> }
 * Response (ok):  { "id": <number>, "ok": true,  "result": <any> }
 * Response (err): { "id": <number>, "ok": false, "error": { "message": <string>, "stack"?: <string> } }
 *
 * Commands:
 *   open                 - init + locate budget by name + downloadBudget. Also
 *                          probes GET /info on the server and emits a version
 *                          log on stderr (version-skew "log, don't abort").
 *   get_accounts         - returns the loaded budget's accounts.
 *   get_transactions     - {account_id, start_date, end_date} (YYYY-MM-DD).
 *   import_transactions  - {account_id, transactions[]}. Each tx gets `account`
 *                          injected to satisfy 26.x ImportTransactionEntity.
 *                          Returns {added, updated, errors}.
 *   get_account_balance  - {account_id, cutoff_date?} (ISO date string).
 *                          Returns integer cents.
 *   get_categories       - all categories on the loaded budget.
 *   update_transaction   - {id, fields}. Patches an existing transaction via
 *                          updateTransaction(id, fields) — e.g. set `reconciled`.
 *   sync                 - flush pending changes to the server.
 *   shutdown             - api.shutdown() and exit.
 */
import { createInterface } from 'node:readline';
import { inspect } from 'node:util';

// @actual-app/api emits "[Breadcrumb] …" lines via console.log, which would
// poison stdout (reserved for protocol JSON). Reroute everything to stderr.
const fmt = (args: unknown[]): string =>
  args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
const toStderr =
  (level: string) =>
  (...args: unknown[]): void => {
    process.stderr.write(`[api ${level}] ${fmt(args)}\n`);
  };
console.log = toStderr('log');
console.info = toStderr('info');
console.warn = toStderr('warn');
console.error = toStderr('error');

// Kept in sync with package.json's @actual-app/api dep. Bundle-safe — a
// literal, no fs/JSON read at runtime. Update on every dep bump.
const PINNED_API_VERSION = '26.4.0';

type ActualApi = typeof import('@actual-app/api');

type Semver = [number, number, number];

function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ADR-007: abort if @actual-app/api is newer than the server, or if either
// version cannot be assessed. Newer API migrates the budget schema forward;
// the older server's bundled web client then refuses to load it. Recovery is
// a server upgrade — data is not lost.
function assertVersionCompatible(serverVersion: string | null): string {
  const apiVersion = process.env.ACTUAL_API_VERSION || PINNED_API_VERSION;
  if (!apiVersion) {
    throw new Error(
      'aborting: API version unset (PINNED_API_VERSION missing and ACTUAL_API_VERSION not set). Cannot assess version skew.',
    );
  }
  if (!serverVersion) {
    throw new Error(
      'aborting: could not determine server version from /info. Cannot assess version skew.',
    );
  }
  const apiSv = parseSemver(apiVersion);
  if (!apiSv) throw new Error(`aborting: cannot parse API version '${apiVersion}'`);
  const srvSv = parseSemver(serverVersion);
  if (!srvSv)
    throw new Error(`aborting: cannot parse server version '${serverVersion}'`);
  if (cmpSemver(apiSv, srvSv) > 0) {
    throw new Error(
      `aborting: @actual-app/api ${apiVersion} is newer than server ${serverVersion}. ` +
        `The newer API would migrate the budget schema forward; the older server's bundled web client would then refuse to load it ("Please update Actual!"). ` +
        `Upgrade the server to >= ${apiVersion}. Data is not lost. ` +
        `See docs/archive/adr-007-version-skew-policy.md.`,
    );
  }
  return apiVersion;
}

interface Budget {
  name: string;
  groupId: string;
}

interface Request {
  id: number;
  command: string;
  params?: Record<string, unknown>;
}

interface OkResponse {
  id: number;
  ok: true;
  result: unknown;
}

interface ErrResponse {
  id: number;
  ok: false;
  error: { message: string; stack?: string };
}

let api: ActualApi | undefined;

function log(msg: string): void {
  process.stderr.write(`[bridge] ${msg}\n`);
}

function send(resp: OkResponse | ErrResponse): void {
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) {
    throw new Error(`missing or invalid '${name}' (string)`);
  }
  return v;
}

async function probeServerVersion(serverURL: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverURL}/info`);
    const json = (await res.json()) as { build?: { version?: string } };
    return json.build?.version ?? null;
  } catch {
    return null;
  }
}

async function cmdOpen(params: Record<string, unknown>): Promise<unknown> {
  const serverURL = asString(params.server_url, 'server_url');
  const password = asString(params.password, 'password');
  const dataDir = asString(params.data_dir, 'data_dir');
  const budgetName = asString(params.budget_name, 'budget_name');

  // Gate before touching any state (api.init / downloadBudget would migrate the
  // schema and break the older server's bundled web client). See ADR-007.
  const serverVersion = await probeServerVersion(serverURL);
  const apiVersion = assertVersionCompatible(serverVersion);
  log(`api=${apiVersion} server=${serverVersion}`);

  api = (await import('@actual-app/api')) as ActualApi;
  await api.init({ serverURL, password, dataDir });

  const budgets = (await api.getBudgets()) as Budget[];
  const budget = budgets.find((b) => b.name === budgetName);
  if (!budget) {
    throw new Error(
      `budget '${budgetName}' not found on server. Available: ${budgets.map((b) => b.name).join(', ') || '(none)'}`,
    );
  }
  await api.downloadBudget(budget.groupId);

  return {
    server_version: serverVersion,
    api_version: apiVersion,
    budget: budget.name,
  };
}

function requireApi(): ActualApi {
  if (!api) throw new Error('not opened — call `open` first');
  return api;
}

async function cmdGetAccounts(): Promise<unknown> {
  return await requireApi().getAccounts();
}

async function cmdGetTransactions(p: Record<string, unknown>): Promise<unknown> {
  const accountId = asString(p.account_id, 'account_id');
  const startDate = asString(p.start_date, 'start_date');
  const endDate = asString(p.end_date, 'end_date');
  return await requireApi().getTransactions(accountId, startDate, endDate);
}

async function cmdImportTransactions(p: Record<string, unknown>): Promise<unknown> {
  const accountId = asString(p.account_id, 'account_id');
  const txs = p.transactions;
  if (!Array.isArray(txs)) throw new Error("'transactions' must be an array");
  const enriched = txs.map((t) => ({
    ...(t as Record<string, unknown>),
    account: accountId,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await requireApi().importTransactions(
    accountId,
    enriched as any,
  )) as {
    added: unknown;
    updated: unknown;
    errors?: unknown[];
  };
  return {
    added: result.added,
    updated: result.updated,
    errors: result.errors ?? [],
  };
}

async function cmdGetAccountBalance(p: Record<string, unknown>): Promise<unknown> {
  const accountId = asString(p.account_id, 'account_id');
  const cutoffRaw = p.cutoff_date;
  let cutoff: Date | undefined;
  if (cutoffRaw !== undefined && cutoffRaw !== null) {
    if (typeof cutoffRaw !== 'string') {
      throw new Error("'cutoff_date' must be a YYYY-MM-DD string when provided");
    }
    const parsed = new Date(cutoffRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`'cutoff_date' is not a valid date: ${cutoffRaw}`);
    }
    cutoff = parsed;
  }
  return await requireApi().getAccountBalance(accountId, cutoff);
}

async function cmdGetCategories(): Promise<unknown> {
  return await requireApi().getCategories();
}

async function cmdUpdateTransaction(p: Record<string, unknown>): Promise<unknown> {
  const id = asString(p.id, 'id');
  const fields = p.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new Error("'fields' must be an object");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await requireApi().updateTransaction(id, fields as any);
  return { ok: true };
}

async function cmdSync(): Promise<unknown> {
  await requireApi().sync();
  return { ok: true };
}

async function cmdShutdown(): Promise<unknown> {
  if (api) {
    await api.shutdown();
    api = undefined;
  }
  return { ok: true };
}

async function dispatch(req: Request): Promise<unknown> {
  switch (req.command) {
    case 'open':
      return cmdOpen(req.params ?? {});
    case 'get_accounts':
      return cmdGetAccounts();
    case 'get_transactions':
      return cmdGetTransactions(req.params ?? {});
    case 'import_transactions':
      return cmdImportTransactions(req.params ?? {});
    case 'get_account_balance':
      return cmdGetAccountBalance(req.params ?? {});
    case 'get_categories':
      return cmdGetCategories();
    case 'update_transaction':
      return cmdUpdateTransaction(req.params ?? {});
    case 'sync':
      return cmdSync();
    case 'shutdown':
      return cmdShutdown();
    default:
      throw new Error(`unknown command: ${req.command}`);
  }
}

async function handleLine(line: string): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch (err) {
    log(`bad JSON on stdin: ${(err as Error).message}`);
    return;
  }
  try {
    const result = await dispatch(req);
    send({ id: req.id, ok: true, result });
  } catch (err) {
    const e = err as Error;
    send({ id: req.id, ok: false, error: { message: e.message, stack: e.stack } });
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const line = queue.shift();
      if (line !== undefined) await handleLine(line);
    }
    draining = false;
  }

  rl.on('line', (line) => {
    queue.push(line);
    void drain();
  });

  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });

  // Stdin closed before shutdown command — best-effort cleanup.
  if (api) {
    try {
      await api.shutdown();
    } catch {
      /* swallow */
    }
  }
}

main().catch((err: unknown) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
