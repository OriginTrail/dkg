import { defineConfig } from 'vitest/config';
import { tornadoAgentCoverage } from '../../vitest.coverage';

process.env.HARDHAT_PORT = '9547';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e-chain.test.ts', 'test/e2e-finalization.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9547' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoAgentCoverage,
    },
  },
});
