import { defineConfig } from 'vitest/config';
import { kosavaKafkaCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Scope coverage to the package's production surface. Test helpers (which
      // are wired up only when `DKG_KAFKA_INTEGRATION=1` and Docker is
      // available) would otherwise drag the unit-test coverage numbers down.
      // `src/index.ts` is a re-export barrel — it has no executable lines that
      // unit tests can meaningfully credit, so it is excluded from the scope.
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: kosavaKafkaCoverage,
    },
  },
});
