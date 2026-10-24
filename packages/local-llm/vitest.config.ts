import { coverageForPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: coverageForPackage('local-llm'),
    include: ['test/**/*.test.ts', 'benchmark/**/*.test.mjs'],
  },
});
