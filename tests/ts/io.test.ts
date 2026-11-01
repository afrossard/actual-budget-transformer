import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askPassword } from '../../src/io.ts';

// A terminal as far as the prompt can tell: raw mode is a flag it flips, and
// each `type` is one chunk of keystrokes arriving.
function terminal(isTTY = true): {
  stdin: NodeJS.ReadStream;
  type(keys: string): void;
  rawModes: boolean[];
} {
  const stream = new PassThrough();
  const rawModes: boolean[] = [];
  const stdin = Object.assign(stream, {
    isTTY,
    isRaw: false,
    setRawMode(mode: boolean) {
      stdin.isRaw = mode;
      rawModes.push(mode);
      return stdin;
    },
  }) as unknown as NodeJS.ReadStream;
  return { stdin, type: (keys) => stream.write(keys), rawModes };
}

function output(): { stream: NodeJS.WriteStream; text(): string } {
  let written = '';
  const stream = {
    write(chunk: string) {
      written += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => written };
}

const PROMPT = 'Actual password for https://budget.example.ch: ';

test('reads the password without echoing it, and leaves raw mode as it was', async () => {
  const { stdin, type, rawModes } = terminal();
  const out = output();

  const answer = askPassword(PROMPT, stdin, out.stream);
  type('hunter');
  type('2\r');

  assert.equal(await answer, 'hunter2');
  assert.equal(out.text(), `${PROMPT}\n`);
  assert.deepEqual(rawModes, [true, false]);
});

test('takes a pasted password and its Enter in one chunk, and honours backspace', async () => {
  const { stdin, type } = terminal();
  const out = output();

  const answer = askPassword(PROMPT, stdin, out.stream);
  type('p@ss wordx\x7f\n');

  assert.equal(await answer, 'p@ss word');
});

test('edits the line as a terminal does, a character split across chunks included', async () => {
  const { stdin, type } = terminal();
  const out = output();

  const answer = askPassword(PROMPT, stdin, out.stream);
  // a, b, Left, x, then an ä whose two bytes arrive apart, typed before the b.
  type('ab\x1b[Dx');
  stdin.push(Buffer.from([0xc3]));
  stdin.push(Buffer.from([0xa4, 0x0d]));

  assert.equal(await answer, 'axäb');
  assert.equal(out.text(), `${PROMPT}\n`);
});

for (const [name, keys] of [
  ['an empty answer', '\r'],
  ['Ctrl-C', 'hun\x03'],
  ['Ctrl-D', '\x04'],
] as const) {
  test(`${name} gives no password`, async () => {
    const { stdin, type, rawModes } = terminal();
    const out = output();

    const answer = askPassword(PROMPT, stdin, out.stream);
    type(keys);

    assert.equal(await answer, null);
    assert.equal(out.text(), `${PROMPT}\n`);
    assert.deepEqual(rawModes, [true, false]);
  });
}

test('does not ask without a terminal', async () => {
  const { stdin } = terminal(false);
  const out = output();

  assert.equal(await askPassword(PROMPT, stdin, out.stream), null);
  assert.equal(out.text(), '');
});
