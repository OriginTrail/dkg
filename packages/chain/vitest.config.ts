import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';
import { EVM_TEST_SCOPES } from '../../scripts/ci/evm-test-scopes.mjs';
import { tornadoChainCoverage } from '../../vitest.coverage';

const hardhatEnv = hardhatTestEnvironment();

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // V8/V9 chain-adapter tests are moved under test/archive/ as part of
    // the V10-only archive (PRD §4.2). Their fixtures deploy contracts that
    // are no longer in the active evm-module deploy set, so exclude them
    // from vitest discovery while keeping the source on disk for history.
    // evm-adapter owns a separate live Hardhat node and runs in the required
    // EVM integration scope. Avoid executing it again in the primary shards.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/archive/**', ...EVM_TEST_SCOPES.chain.files],
    testTimeout: 120_000,
    globalSetup: ['test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      thresholds: tornadoChainCoverage,
    },
  },
});
