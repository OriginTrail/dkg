import { coverageForUnbaselinedPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: coverageForUnbaselinedPackage('marketplace'),
    include: ['test/**/*.test.ts'],
  },
});
