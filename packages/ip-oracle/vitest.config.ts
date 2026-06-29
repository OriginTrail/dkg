import { defineConfig } from 'vitest/config';
import { kosavaIpOracleCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // index.ts is a pure re-export barrel.
      exclude: ['src/index.ts'],
      thresholds: kosavaIpOracleCoverage,
    },
  },
});
