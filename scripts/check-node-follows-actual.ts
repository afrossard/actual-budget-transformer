/**
 * Check that our Node version is the one Actual itself runs (#97).
 *
 * Usage:
 *   node scripts/check-node-follows-actual.ts
 *
 * Reads the `@actual-app/api` version from package.json, fetches
 * `actualbudget/actual`'s `.nvmrc` at that release tag, and fails with the
 * exact fix when ours differs. Renovate cannot follow another project's
 * `.nvmrc`, so its Node updates are off and this check says what to change on
 * the grouped Actual PR instead (AGENTS.md, "Versions: follow Actual").
 * `tests/ts/containerfile.test.ts` keeps the Containerfile's FROM on `.nvmrc`.
 */
import { readFileSync, realpathSync } from 'node:fs';

const root = new URL('../', import.meta.url);

export function nodeMismatch(versions: {
  actualVersion: string;
  actualNvmrc: string;
  ourNvmrc: string;
}): string | undefined {
  // Actual writes `v24.18.1`; ours cannot carry the `v`, because the
  // Containerfile's FROM repeats it as a `node:` image tag.
  const actualNode = versions.actualNvmrc.trim().replace(/^v/, '');
  const ourNode = versions.ourNvmrc.trim();
  if (ourNode === actualNode) return undefined;
  return (
    `Actual v${versions.actualVersion} runs Node ${actualNode}, ` +
    `but .nvmrc says ${ourNode}; ` +
    `set .nvmrc and the Containerfile FROM to ${actualNode}`
  );
}

async function main(): Promise<number> {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const actualVersion = pkg.dependencies?.['@actual-app/api'];
  if (actualVersion === undefined || !/^\d+\.\d+\.\d+$/.test(actualVersion)) {
    process.stderr.write(
      `@actual-app/api must be pinned to an exact version in package.json, ` +
        `got ${actualVersion ?? 'nothing'}\n`,
    );
    return 1;
  }

  const url = `https://raw.githubusercontent.com/actualbudget/actual/v${actualVersion}/.nvmrc`;
  const response = await fetch(url);
  if (!response.ok) {
    process.stderr.write(
      `could not read Actual's .nvmrc at v${actualVersion}: ` +
        `${response.status} ${response.statusText} from ${url}\n`,
    );
    return 1;
  }

  const ourNvmrc = readFileSync(new URL('.nvmrc', root), 'utf8');
  const mismatch = nodeMismatch({
    actualVersion,
    actualNvmrc: await response.text(),
    ourNvmrc,
  });
  if (mismatch !== undefined) {
    process.stderr.write(`${mismatch}\n`);
    return 1;
  }
  process.stdout.write(`Node follows Actual v${actualVersion}: ${ourNvmrc.trim()}\n`);
  return 0;
}

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
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
