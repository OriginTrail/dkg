import { defineConfig } from 'vitest/config';
import { kosavaAdapterPrimeAgentCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // host-integration.test.ts spawns real child processes whose waitFor
    // diagnostics fire at 10s; the test timeout must exceed that so a hang
    // reports the fixture's backlog + stderr instead of a bare vitest kill.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaAdapterPrimeAgentCoverage,
    },
  },
});
