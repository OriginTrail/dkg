import { defineConfig } from 'vitest/config';
import { tornadoChainCoverage } from '../../vitest.coverage';

process.env.HARDHAT_PORT = '9545';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // V8/V9 chain-adapter tests are moved under test/archive/ as part of
    // the V10-only archive (PRD §4.2). Their fixtures deploy contracts that
    // are no longer in the active evm-module deploy set, so exclude them
    // from vitest discovery while keeping the source on disk for history.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/archive/**'],
    testTimeout: 120_000,
    globalSetup: ['test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9545' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      thresholds: tornadoChainCoverage,
    },
  },
});
