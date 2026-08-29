import { defineConfig } from 'vitest/config';
import { kosavaAdapterOpenclawCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Compile-time contract assertions (@ts-expect-error) live in test-d/ and
    // run through tsc here — the ordinary transform strips types, so a
    // @ts-expect-error in a runtime test file proves nothing.
    typecheck: {
      enabled: true,
      include: ['test-d/**/*.test-d.ts'],
      tsconfig: './tsconfig.typetest.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: kosavaAdapterOpenclawCoverage,
    },
  },
});
