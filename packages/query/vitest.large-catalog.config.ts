import { defineConfig } from 'vitest/config';

// The large-catalog fixture, one engine per run (see the test file for how the engine is chosen).
export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test-live/large-catalog.test.ts'],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
