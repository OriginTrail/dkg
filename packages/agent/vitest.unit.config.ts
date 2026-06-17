import { defineConfig } from 'vitest/config';

// generic-sql-source.test.ts uses `import('node:sqlite')`, which is
// `--experimental-sqlite`-gated on Node 22.5–23.x. The flag is a
// process-level toggle, so mirror `vitest.config.ts`: switch to the
// `forks` pool and pass execArgv there. See the long comment in
// `vitest.config.ts` for the full rationale.
const SQLITE_EXEC_ARGV = ['--experimental-sqlite', '--no-warnings=ExperimentalWarning'];

export default defineConfig({
  test: {
    include: [
      'test/endorse.test.ts',
      'test/e2e-dht-dial.test.ts',
      'test/generic-sql-source.test.ts',
      'test/imported-artifact.test.ts',
      'test/query-min-trust-alias.test.ts',
      'test/sync-envelope-cursor.test.ts',
      'test/swm/host-catchup-sign.test.ts',
      'test/swm/host-catchup-wire.test.ts',
      'test/swm/host-mode-store.test.ts',
      'test/swm/host-mode-key-canonicalization.test.ts',
      'test/profile-fix-verify.test.ts',
      'test/sync-verify-collapsed.test.ts',
      'test/durable-sync-since-threading.test.ts',
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
    pool: 'forks',
    execArgv: SQLITE_EXEC_ARGV,
  },
});
