import { coverageForPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: coverageForPackage('rdf-utils'),
    include: ['test/**/*.test.ts'],
  },
});
