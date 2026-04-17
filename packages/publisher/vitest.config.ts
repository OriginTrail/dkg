import { defineConfig } from 'vitest/config';
import { tornadoPublisherCoverage } from '../../vitest.coverage';

process.env.HARDHAT_PORT = '9546';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/publisher-evm-e2e.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9546' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoPublisherCoverage,
    },
  },
});
