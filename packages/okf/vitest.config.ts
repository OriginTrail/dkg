import { defineConfig } from 'vitest/config';
import { kosavaOkfCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // index.ts is a pure re-export barrel; types.ts is interfaces only.
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: kosavaOkfCoverage,
    },
  },
});
