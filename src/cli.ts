#!/usr/bin/env node
/**
 * `abt-import` - read a bank statement file, propose what to do with each
 * transaction, and write only what the human confirms.
 *
 * One account at a time, one file at a time. A re-run of the same file is the
 * resume mechanism: everything already written comes back as Skip, so there is
 * no cursor to keep.
 */
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ActualGateway } from './actual-gateway.ts';
import { loadConfig, requireActualConfig } from './config.ts';
import { createTerminalIo } from './io.ts';
import { runImport } from './import-run.ts';

const USAGE = `usage: abt-import [-c <config.yml>] [--no-colour] <statement file>

  -c, --config   path to config.yml (default: $ACTUAL_BUDGET_TRANSFORMER_CONFIG)
      --no-colour  plain output, no ANSI styling

Server settings come from the config's actual_budget block, overridden by
ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD and ACTUAL_BUDGET_SYNC_ID.`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string', short: 'c' },
        'no-colour': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }

  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0) {
    process.stderr.write(`expected exactly one statement file\n${USAGE}\n`);
    return 2;
  }

  const config = loadConfig(parsed.values.config);
  const settings = requireActualConfig(config);
  const io = createTerminalIo();
  const style = {
    colour: !parsed.values['no-colour'] && process.stdout.isTTY === true,
  };

  const gateway = new ActualGateway(settings);
  try {
    // Inside the try: `open()` creates its temp data dir before it locates the
    // budget, so a wrong budget name would otherwise leave a downloaded budget
    // behind in $TMPDIR on every attempt.
    await gateway.open();
    const result = await runImport({
      path,
      config,
      gateway,
      io,
      style,
    });
    return result.stopped ? 1 : 0;
  } finally {
    io.close();
    await gateway.close();
  }
}

// Only when run as a program, so tests can import `main` without it firing.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === import.meta.filename;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
