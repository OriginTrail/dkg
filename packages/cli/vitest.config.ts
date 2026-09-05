import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';
import { buraCliCoverage } from '../../vitest.coverage';

const hardhatEnv = hardhatTestEnvironment();

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: buraCliCoverage,
    },
  },
});
