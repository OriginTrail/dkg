import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { coverageForPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

// Distinct from the cli lane (9548) so kafka-plugin's E2E can spin its
// own Hardhat node without colliding when the two packages are run in
// parallel by turbo.
const hardhatEnv = hardhatTestEnvironment(9549);

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: coverageForPackage('kafka-plugin'),
  },
});
