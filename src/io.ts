/**
 * Terminal input and output for the review loop.
 *
 * On a real terminal the prompt takes a single keystroke, so reviewing a month
 * is a row of keypresses rather than a row of Enters. Anywhere else - a pipe, a
 * test, a CI log - it falls back to reading whole lines, which keeps the loop
 * drivable without a TTY.
 */
import { createInterface } from 'node:readline/promises';
import type { ReviewIo } from './review.ts';
import { terminalWidth } from './tape.ts';

const CTRL_C = 3;
const CTRL_D = 4;

/** What separates an answer from its outcome on the prompt's line. */
const OUTCOME_GAP = '   ';

function isAllowed(key: string, allowed: readonly string[]): boolean {
  return allowed.includes(key);
}

/** A `ReviewIo` plus the teardown its input needs. */
export type TerminalIo = ReviewIo & { close(): void };

export function createTerminalIo(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): TerminalIo {
  // A prompt's line stays open after the answer, so `conclude` can say on that
  // same line what came of it. Anything else written first ends the line.
  // This is the column the open line has reached, or null when none is open.
  let column: number | null = null;
  const endLine = (): void => {
    if (column !== null) stdout.write('\n');
    column = null;
  };
  const write = (line: string): void => {
    endLine();
    stdout.write(`${line}\n`);
  };
  const conclude = (outcome: string): void => {
    const width = terminalWidth(stdout);
    // An outcome that would wrap goes on a line of its own instead: cutting it
    // could cut off the imported ID it names.
    if (column !== null && column + OUTCOME_GAP.length + outcome.length <= width) {
      stdout.write(`${OUTCOME_GAP}${outcome}\n`);
    } else {
      endLine();
      stdout.write(`    ${outcome}\n`);
    }
    column = null;
  };

  if (stdin.isTTY) {
    return {
      write,
      conclude,
      close() {
        endLine();
        stdin.pause();
      },
      async ask(prompt, allowed) {
        endLine();
        stdout.write(prompt);
        for (;;) {
          const key = await readKey(stdin);
          // Ctrl-C and Ctrl-D stop the run rather than killing it mid-write.
          const code = key.charCodeAt(0);
          const answer = code === CTRL_C || code === CTRL_D ? 'q' : key.toLowerCase();
          if (isAllowed(answer, allowed)) {
            stdout.write(answer);
            column = prompt.length + answer.length;
            return answer;
          }
        }
      },
    };
  }

  // One interface and one iterator over it for the whole run: asking readline
  // for a second async iterator gets a second consumer of the same stream, and
  // the two then fight over every line.
  const lines = createInterface({ input: stdin, terminal: false });
  const pending = lines[Symbol.asyncIterator]();
  return {
    write,
    conclude,
    close() {
      endLine();
      lines.close();
    },
    async ask(prompt, allowed) {
      endLine();
      for (;;) {
        stdout.write(prompt);
        column = prompt.length;
        const line = await pending.next();
        if (line.done) {
          // Input ran out mid-review: stop rather than guess an answer.
          lines.close();
          stdout.write('q');
          column += 1;
          return 'q';
        }
        const answer = line.value.trim().toLowerCase();
        if (isAllowed(answer, allowed)) {
          stdout.write(answer);
          column += answer.length;
          return answer;
        }
        write(`  expected one of ${allowed.join(', ')}`);
      }
    },
  };
}

function readKey(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (chunk: Buffer) => {
      stdin.pause();
      stdin.setRawMode(wasRaw);
      resolve(chunk.toString('utf8'));
    });
  });
}

/** An io that answers from a fixed script, for tests and for `--answers`. */
export function createScriptedIo(
  answers: readonly string[],
  sink: (line: string) => void = () => {},
): ReviewIo & { transcript: string[]; remaining(): number } {
  const queue = [...answers];
  const transcript: string[] = [];
  // Whether the transcript's last line is an answered prompt, still open.
  let open = false;
  return {
    transcript,
    remaining: () => queue.length,
    write(line) {
      open = false;
      transcript.push(line);
      sink(line);
    },
    conclude(outcome) {
      const last = transcript.length - 1;
      if (open) transcript[last] = `${transcript[last]}${OUTCOME_GAP}${outcome}`;
      else transcript.push(outcome);
      open = false;
      sink(outcome);
    },
    async ask(prompt, allowed) {
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error(
          `the script ran out of answers at ${JSON.stringify(prompt)} (allowed: ${allowed.join(', ')})`,
        );
      }
      if (!allowed.includes(answer)) {
        throw new Error(
          `scripted answer ${JSON.stringify(answer)} is not offered here (allowed: ${allowed.join(', ')})`,
        );
      }
      transcript.push(`${prompt}${answer}`);
      open = true;
      return answer;
    },
  };
}
