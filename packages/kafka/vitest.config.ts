import { defineConfig } from 'vitest/config';
import { criticalityTargets } from '../../vitest.coverage.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: criticalityTargets.kosava,
    },
  },
});
