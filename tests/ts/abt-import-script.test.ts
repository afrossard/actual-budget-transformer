import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/abt-import` only assembles an `msb run` command line, so a stub
// msb that records its arguments is enough to check it. Whether msb then runs
// the image as intended is not something a test here can reach: it needs KVM.
const script = fileURLToPath(new URL('../../scripts/abt-import', import.meta.url));

function run(
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number | null; stderr: string; msb: string[] | null } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abt-script-')));
  const record = join(dir, 'msb-args');
  const stub = join(dir, 'msb');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > '${record}'\n`);
  chmodSync(stub, 0o755);

  const result = spawnSync(script, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
  });
  let msb: string[] | null = null;
  try {
    msb = readFileSync(record, 'utf8').split('\0').slice(0, -1);
  } catch {
    // msb was never called.
  }
  return { status: result.status, stderr: result.stderr, msb };
}

function files(dir: string, names: readonly string[]): string[] {
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, '');
    return path;
  });
}

function id(flag: '-u' | '-g'): string {
  return spawnSync('id', [flag], { encoding: 'utf8' }).stdout.trim();
}

test('mounts the config and the statement read-only and passes their in-sandbox paths', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abt-files-')));
  const [config, statement] = files(dir, ['my config.yaml', 'cards 2031.csv']);

  const { status, msb } = run(['-c', config!, '--no-colour', statement!]);

  assert.equal(status, 0);
  assert.deepEqual(msb, [
    'run',
    '--user',
    `${id('-u')}:${id('-g')}`,
    '--mount-file',
    `${config}:/abt/config.yaml:ro`,
    '--mount-file',
    `${statement}:/abt/statement/cards 2031.csv:ro`,
    'ghcr.io/afrossard/actual-budget-transformer:main',
    '--',
    '--no-colour',
    '-c',
    '/abt/config.yaml',
    '/abt/statement/cards 2031.csv',
  ]);
});

test('reads the config from ACTUAL_BUDGET_TRANSFORMER_CONFIG and forwards only the server settings that are set', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abt-files-')));
  const [config, statement] = files(dir, ['config.yaml', 'account.csv']);

  const { msb } = run([statement!], {
    ACTUAL_BUDGET_TRANSFORMER_CONFIG: config!,
    ACTUAL_BUDGET_PASSWORD: 'p@ss word',
    ACTUAL_BUDGET_SYNC_ID: '',
    ABT_IMAGE: 'abt:dev',
  });

  assert.ok(msb);
  assert.ok(msb.includes(`${config}:/abt/config.yaml:ro`));
  const envs = msb.flatMap((arg, i) => (msb[i - 1] === '-e' ? [arg] : []));
  assert.deepEqual(envs, ['ACTUAL_BUDGET_PASSWORD=p@ss word']);
  assert.equal(msb[msb.indexOf('--') - 1], 'abt:dev');
});

test('with no arguments, still runs the image, so the CLI prints its usage', () => {
  const { status, msb } = run([]);

  assert.equal(status, 0);
  assert.equal(msb?.at(-1), '--');
});

test('reads -c joined to its path, as the CLI does', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abt-files-')));
  const [config] = files(dir, ['config.yaml']);

  const { msb } = run([`-c${config!}`]);

  assert.ok(msb);
  assert.ok(msb.includes(`${config}:/abt/config.yaml:ro`));
  assert.ok(!msb.includes(`-c${config!}`));
});

test('refuses a path with a colon, which would split the mount spec', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abt-files-')));
  const [statement] = files(dir, ['export 10:30.csv']);

  const { status, stderr, msb } = run([statement!]);

  assert.equal(status, 2);
  assert.match(stderr, /its path contains a colon/);
  assert.equal(msb, null);
});

test('stops before msb when a file is missing', () => {
  const missingStatement = run(['nope.csv']);
  assert.equal(missingStatement.status, 2);
  assert.match(missingStatement.stderr, /no statement file at nope\.csv/);
  assert.equal(missingStatement.msb, null);

  const missingConfig = run(['-c', 'nope.yaml']);
  assert.equal(missingConfig.status, 2);
  assert.match(missingConfig.stderr, /no config file at nope\.yaml/);
  assert.equal(missingConfig.msb, null);
});
