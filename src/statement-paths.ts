/**
 * The statement files a run reads, from the paths it was given.
 *
 * A file is taken as given, in the order given. A directory is read one level
 * deep, its entries sorted by name, so a folder of monthly downloads is
 * imported oldest first when the bank dates their names. Its subdirectories
 * and hidden files are not statements and are passed over. A path that does
 * not exist is kept, a directory's dangling link included, so the import
 * summary says so beside everything else.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function statementPaths(paths: readonly string[]): string[] {
  return paths.flatMap((path) => (isDirectory(path) ? filesIn(path) : [path]));
}

function filesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => !isDirectory(path));
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
