import { defineConfig } from 'vitest/config';
import { tornadoCoreCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoCoreCoverage,
    },
  },
});
