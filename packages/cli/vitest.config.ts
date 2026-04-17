import { defineConfig } from 'vitest/config';
import { buraCliCoverage } from '../../vitest.coverage';

process.env.HARDHAT_PORT = '9548';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9548' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: buraCliCoverage,
    },
  },
});
