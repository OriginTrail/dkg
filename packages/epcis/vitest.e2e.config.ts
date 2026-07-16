import { defineConfig } from 'vitest/config';

/**
 * Live-node EPCIS coverage is intentionally opt-in. The default package test
 * must not attach to whichever DKG daemon happens to be running on a developer
 * or CI host and use credentials from a different DKG home.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
  },
});
