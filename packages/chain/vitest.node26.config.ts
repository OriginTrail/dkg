import { defineConfig } from 'vitest/config';

// The required chain-rpc-node26 runner owns these real undici 8 checks.
// The separate suite makes the runtime prerequisite explicit without test skips.
export default defineConfig({
  test: {
    allowOnly: false,
    include: ['node26/**/*.test.ts'],
    testTimeout: 30_000,
    maxWorkers: 1,
  },
});
