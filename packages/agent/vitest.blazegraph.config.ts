import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test-live/**/*.blazegraph.test.ts'],
    testTimeout: 30_000,
    maxWorkers: 1,
  },
});
