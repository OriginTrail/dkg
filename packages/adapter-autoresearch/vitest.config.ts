import { defineConfig } from 'vitest/config';
import { kosavaAdapterAutoresearchCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaAdapterAutoresearchCoverage,
    },
  },
});
