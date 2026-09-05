import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
