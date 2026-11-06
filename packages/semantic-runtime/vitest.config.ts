import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: coverageForPackage('semantic-runtime'),
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
