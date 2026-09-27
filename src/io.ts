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

const CTRL_C = 3;
const CTRL_D = 4;

function isAllowed(key: string, allowed: readonly string[]): boolean {
  return allowed.includes(key);
}

/** A `ReviewIo` plus the teardown its input needs. */
export type TerminalIo = ReviewIo & { close(): void };

export function createTerminalIo(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): TerminalIo {
  const write = (line: string): void => {
    stdout.write(`${line}\n`);
  };

  if (stdin.isTTY) {
    return {
      write,
      close() {
        stdin.pause();
      },
      async ask(prompt, allowed) {
        stdout.write(prompt);
        for (;;) {
          const key = await readKey(stdin);
          // Ctrl-C and Ctrl-D stop the run rather than killing it mid-write.
          const code = key.charCodeAt(0);
          const answer = code === CTRL_C || code === CTRL_D ? 'q' : key.toLowerCase();
          if (isAllowed(answer, allowed)) {
            stdout.write(`${answer}\n`);
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
    close() {
      lines.close();
    },
    async ask(prompt, allowed) {
      for (;;) {
        stdout.write(prompt);
        const line = await pending.next();
        if (line.done) {
          // Input ran out mid-review: stop rather than guess an answer.
          lines.close();
          stdout.write('q\n');
          return 'q';
        }
        const answer = line.value.trim().toLowerCase();
        if (isAllowed(answer, allowed)) {
          stdout.write(`${answer}\n`);
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
  return {
    transcript,
    remaining: () => queue.length,
    write(line) {
      transcript.push(line);
      sink(line);
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
      return answer;
    },
  };
}
