import { defineConfig } from 'vitest/config';

// Distinct from the cli lane (9548) so kafka-plugin's E2E can spin its
// own Hardhat node without colliding when the two packages are run in
// parallel by turbo.
process.env.HARDHAT_PORT = '9549';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9549' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
