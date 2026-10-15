import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/async-lift-wallet-ownership.blazegraph.integration.test.ts'],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
