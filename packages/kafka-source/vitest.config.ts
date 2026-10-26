import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.mjs'],
    coverage: coverageForPackage('kafka-source'),
  },
});
