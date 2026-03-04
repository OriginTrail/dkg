import { defineConfig } from 'vitest/config';
import { coverageThresholds } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: coverageThresholds,
    },
  },
});
