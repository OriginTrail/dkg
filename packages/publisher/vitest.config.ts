import { defineConfig } from 'vitest/config';
import { tornadoPublisherCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/publisher-evm-e2e.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoPublisherCoverage,
    },
  },
});
