import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    // Compile-time contract assertions (@ts-expect-error) live in test-d/ and
    // run through tsc here — the ordinary transform strips types, so a
    // @ts-expect-error in a runtime test file proves nothing.
    typecheck: {
      enabled: true,
      include: ['test-d/**/*.test-d.ts'],
      tsconfig: './tsconfig.typetest.json',
    },
    coverage: coverageForPackage('adapter-openclaw'),
  },
});
