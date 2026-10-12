/**
 * The import summary: what the importer prints once, after every statement
 * report of a run - one line per statement file with what came of it, and why
 * for each file it did not import.
 */
import { complete } from './review.ts';
import type { RunResult } from './import-run.ts';
import { DEFAULT_WIDTH, wrap } from './statement-report.ts';

/** What came of one statement file. */
export type FileOutcome =
  | { path: string; kind: 'imported'; result: RunResult }
  /** Skipped before anything was written for it; the run went on. */
  | { path: string; kind: 'not-imported'; reason: string }
  /** Something failed once writing could have begun; the run stopped. */
  | { path: string; kind: 'failed'; reason: string }
  /** After a quit or a failure. */
  | { path: string; kind: 'not-reached' };

/**
 * Whether everything the files hold is in Actual, or was left by the human's
 * own answer: false for any file not imported, a failure, a quit, or a
 * statement transaction left out for being in the reconciled period.
 */
export function allInActual(outcomes: readonly FileOutcome[]): boolean {
  return outcomes.every((o) => o.kind === 'imported' && complete(o.result));
}

export function importSummary(
  outcomes: readonly FileOutcome[],
  width: number = DEFAULT_WIDTH,
): string[] {
  const body =
    outcomes.length > 0
      ? outcomes.flatMap((outcome) => lines(outcome, width))
      : ['  no statement files'];
  return ['', 'Import summary:', ...body];
}

function lines(outcome: FileOutcome, width: number): string[] {
  const head = `  ${outcome.path}: `;
  switch (outcome.kind) {
    case 'imported':
      return [head + cameOf(outcome.result)];
    case 'not-imported':
      return [head + 'not imported', ...indent(outcome.reason, width)];
    case 'failed':
      return [head + 'failed, the run stopped', ...indent(outcome.reason, width)];
    case 'not-reached':
      return [head + 'not reached'];
  }
}

function cameOf(result: RunResult): string {
  if (result.statementTransactions === 0) return 'no transactions';
  const imported = result.outcomes.filter((o) => o.wrote === 'added').length;
  const leftOut = result.outcomes.filter((o) => o.action === 'left-out').length;
  // Under review, everything not imported is left, answered or not.
  const left =
    result.statementTransactions - result.alreadyInActual - imported - leftOut;
  return [
    ...(result.stopped ? ['stopped'] : []),
    `${imported} imported`,
    ...(leftOut > 0 ? [`${leftOut} left out`] : []),
    ...(left > 0 ? [`${left} left`] : []),
    `${result.alreadyInActual} already in Actual`,
  ].join(', ');
}

/**
 * Under the file's line, each line wrapped to the terminal and keeping its own
 * indent; a blank line stays blank.
 */
function indent(text: string, width: number): string[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [''];
    const own = line.length - line.trimStart().length;
    const prefix = ' '.repeat(4 + own);
    return wrap(line.trimStart(), width - prefix.length).map((l) => prefix + l);
  });
}
