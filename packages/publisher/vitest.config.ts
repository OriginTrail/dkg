import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';
import { tornadoPublisherCoverage } from '../../vitest.coverage';

const hardhatEnv = hardhatTestEnvironment(9546);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/publisher-evm-e2e.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoPublisherCoverage,
    },
  },
});
