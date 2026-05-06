import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/publish-async-get-benchmark.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
    maxWorkers: 1,
  },
});
