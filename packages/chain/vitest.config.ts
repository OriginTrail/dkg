import { defineConfig } from 'vitest/config';
import { tornadoChainCoverage } from '../../vitest.coverage';

process.env.HARDHAT_PORT = '9545';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/evm-adapter.test.ts', 'test/evm-e2e.test.ts'],
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
