import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The Python bridge is deleted in one commit once the TypeScript CLI
    // reaches parity (#41), so linting it is work thrown away.
    ignores: ['src/actual_budget_transformer/**'],
  },
  {
    // The same scope `npm run typecheck` and `npm run format:check` cover.
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/ts/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Every rule below needs type information, which makes a lint run a
        // real type check. Slow-ish, and fine for a repo this size.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The reason this linter is here, and the one rule neither `tsc` nor
      // grep can stand in for. Every write goes through `await gateway.add()`
      // / `correct()` / `sync()`, and a missed await on a write is a silently
      // skipped write or a race, in a tool whose whole premise is that nothing
      // reaches Actual without a confirmation for that row.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `node:test`'s own functions return a promise the runner owns, and
          // not awaiting `test(…)` is how every test file here is written.
          // typescript-eslint documents this exact case as the option's
          // reason to exist. All 116 hits before this were these; none were
          // in src/, which is the finding, not a workaround for one.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'after',
                'afterEach',
                'before',
                'beforeEach',
                'describe',
                'it',
                'suite',
                'test',
              ],
            },
          ],
        },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // Free today - there is no explicit `any` in the TypeScript we write.
      // These four keep it that way, including where a value crosses an
      // untyped boundary and `strict` alone would let the `any` spread.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      // A warning, not an error: 12 of these exist and each one is a claim
      // the compiler cannot check, worth seeing when the count grows.
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
  {
    files: ['tests/ts/**/*.ts'],
    rules: {
      // 90 of the 102 non-null assertions are here, and `foo!` after a
      // `find()` is ordinary test shorthand. Left on, the warning is a wall
      // nobody reads - which is worse than no warning, because it hides the
      // 12 in src/ and scripts/ that are worth a look.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
