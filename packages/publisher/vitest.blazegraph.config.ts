import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    include: [
      'test/async-lift-wallet-ownership.blazegraph.integration.test.ts',
      'test/async-lift-primary-persistence.blazegraph.integration.test.ts',
      // Live-only suites throw without BLAZEGRAPH_TEST_URL, so they live outside test/ (the default config globs it) and are listed here and in test-policy/test-routes.json.
      'test-live/**/*.blazegraph.test.ts',
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
