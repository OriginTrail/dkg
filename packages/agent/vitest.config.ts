import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';
import { tornadoAgentCoverage } from '../../vitest.coverage';

const hardhatEnv = hardhatTestEnvironment();

// `--experimental-sqlite` is required for `import('node:sqlite')` on
// Node 22.5–23.x (the workspace's `.nvmrc` line) and is a no-op on
// Node 24+. The flag has to land on the actual Node process — Node's
// worker_threads cannot toggle process-level features — so we use
// `pool: 'forks'` and pass it via `poolOptions.forks.execArgv`. Without
// this, the real-SQLite test in `generic-sql-source.test.ts` is
// silently skipped on the .nvmrc-pinned CI Node 22 lane (PR #792 bot
// review). `--no-warnings=ExperimentalWarning` mutes Node's runtime
// notice so the JUnit reporter stays clean.
const SQLITE_EXEC_ARGV = ['--experimental-sqlite', '--no-warnings=ExperimentalWarning'];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e-chain.test.ts', 'test/e2e-finalization.test.ts', 'test/a2-pointers-and-b3-addressing.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    // Vitest 4 flattened `poolOptions.{forks,threads}.execArgv` to the
    // top-level `test.execArgv`. Combined with `pool: 'forks'` it
    // becomes process-level argv on each test fork.
    pool: 'forks',
    execArgv: SQLITE_EXEC_ARGV,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoAgentCoverage,
    },
  },
});
