import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

const hardhatEnv = hardhatTestEnvironment();

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: coverageForPackage('cli'),
  },
});
