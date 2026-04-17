import { defineConfig } from 'vitest/config';
import { kosavaOriginTrailGameCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/ui/**', '.test-nodes/**'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaOriginTrailGameCoverage,
    },
  },
});
