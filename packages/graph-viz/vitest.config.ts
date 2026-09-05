import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['tests/**/*.test.ts'],
    coverage: coverageForPackage('graph-viz'),
  },
});
