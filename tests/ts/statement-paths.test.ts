import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statementPaths } from '../../src/statement-paths.ts';

function tree(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'abt-paths-'));
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

test('files are taken in the order given', () => {
  const dir = tree(['b.csv', 'a.csv']);
  assert.deepEqual(statementPaths([join(dir, 'b.csv'), join(dir, 'a.csv')]), [
    join(dir, 'b.csv'),
    join(dir, 'a.csv'),
  ]);
});

test('a directory is read one level deep, sorted by name, subdirectories ignored', () => {
  const dir = tree(['2031-02.csv', '2031-01.csv', 'older/2030-12.csv', 'notes.txt']);
  assert.deepEqual(statementPaths([dir]), [
    join(dir, '2031-01.csv'),
    join(dir, '2031-02.csv'),
    join(dir, 'notes.txt'),
  ]);
});

test('a trailing slash reads the directory the same way', () => {
  const dir = tree(['a.csv']);
  assert.deepEqual(statementPaths([`${dir}/`]), [join(dir, 'a.csv')]);
});

test("a directory's hidden files are not statements", () => {
  // Finder leaves a .DS_Store in every directory it opens.
  const dir = tree(['.DS_Store', 'a.csv']);
  assert.deepEqual(statementPaths([dir]), [join(dir, 'a.csv')]);
});

test("a directory's link to a file is followed", () => {
  const dir = tree(['real/a.csv']);
  symlinkSync(join(dir, 'real', 'a.csv'), join(dir, 'linked.csv'));
  assert.deepEqual(statementPaths([dir]), [join(dir, 'linked.csv')]);
});

test("a directory's dangling link is kept, for the run to explain", () => {
  const dir = tree(['a.csv']);
  symlinkSync(join(dir, 'gone.csv'), join(dir, 'b.csv'));
  assert.deepEqual(statementPaths([dir]), [join(dir, 'a.csv'), join(dir, 'b.csv')]);
});

test('files and directories mix, and a missing path is kept for the run to explain', () => {
  const dir = tree(['one.csv', 'more/two.csv']);
  assert.deepEqual(
    statementPaths([join(dir, 'one.csv'), join(dir, 'more'), join(dir, 'gone.csv')]),
    [join(dir, 'one.csv'), join(dir, 'more', 'two.csv'), join(dir, 'gone.csv')],
  );
});
