#!/usr/bin/env node
/**
 * `abt-import` - read bank statement files and write every transaction Actual
 * does not hold, except one dated before the reconciled-through date, which is
 * left out (ADR 0005). Under `--review` it asks about each one instead, those
 * included, and writes only what the human confirms.
 *
 * Any mix of files and directories, each directory one level deep, one file
 * at a time in the order given, and an import summary at the end. A re-run of
 * the same files is the resume mechanism: everything already written pairs and
 * is not written or asked about again, so there is no cursor to keep.
 */
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ActualGateway } from './actual-gateway.ts';
import { loadConfig, requireActualConfig } from './config.ts';
import { createTerminalIo } from './io.ts';
import { runImports } from './import-run.ts';
import { allInActual } from './import-summary.ts';
import { statementPaths } from './statement-paths.ts';
import { terminalWidth } from './statement-report.ts';

const USAGE = `usage: abt-import [-c <config.yml>] [--review] [--no-colour]
                  <statement file or directory>...

  -c, --config     path to config.yml (default: $ACTUAL_BUDGET_TRANSFORMER_CONFIG)
      --review     ask before writing each transaction, including one dated
                   before the reconciled-through date, which is otherwise left out
      --no-colour  plain output, no ANSI styling

A directory is read one level deep, its files in name order.

Exits non-zero unless everything is in Actual: a file not imported, a failure,
a quit, or a transaction left out makes it 1.

Server settings come from the config's actual_budget block, overridden by
ACTUAL_BUDGET_URL, ACTUAL_BUDGET_PASSWORD and ACTUAL_BUDGET_SYNC_ID.`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string', short: 'c' },
        review: { type: 'boolean', default: false },
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
  if (parsed.positionals.length === 0) {
    process.stderr.write(`expected a statement file or directory\n${USAGE}\n`);
    return 2;
  }
  const paths = statementPaths(parsed.positionals);

  const config = loadConfig(parsed.values.config);
  const settings = requireActualConfig(config);
  const io = createTerminalIo();
  const style = {
    colour: !parsed.values['no-colour'] && process.stdout.isTTY === true,
    width: terminalWidth(process.stdout),
  };

  const gateway = new ActualGateway(settings);
  try {
    // Inside the try: `open()` creates its temp data dir before it locates the
    // budget, so a wrong budget name would otherwise leave a downloaded budget
    // behind in $TMPDIR on every attempt.
    await gateway.open();
    const outcomes = await runImports({
      paths,
      config,
      mode: parsed.values.review ? 'review' : 'unattended',
      gateway,
      io,
      style,
    });
    return allInActual(outcomes) ? 0 : 1;
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
