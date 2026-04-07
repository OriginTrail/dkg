import { defineConfig } from 'vitest/config';
import { kosavaGraphVizCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaGraphVizCoverage,
    },
  },
});
