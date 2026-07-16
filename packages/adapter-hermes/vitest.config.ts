import { defineConfig } from 'vitest/config';
import { kosavaAdapterHermesCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Profile setup tests perform filesystem-heavy replacement/backup flows.
    // Serialize only this package instead of throttling the whole workspace.
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaAdapterHermesCoverage,
    },
  },
});
