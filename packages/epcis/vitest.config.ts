import { defineConfig } from 'vitest/config';
import { kosavaEpcisCoverage } from '../../vitest.coverage';

export const EPCIS_DEFAULT_TEST_INCLUDE = ['test/**/*.test.ts'];
export const EPCIS_DEFAULT_TEST_EXCLUDE = ['test/**/*.e2e.test.ts'];

export default defineConfig({
  test: {
    include: EPCIS_DEFAULT_TEST_INCLUDE,
    exclude: EPCIS_DEFAULT_TEST_EXCLUDE,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaEpcisCoverage,
    },
  },
});
