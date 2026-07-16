import { defineConfig } from 'vitest/config';

export const EPCIS_E2E_TEST_INCLUDE = ['test/**/*.e2e.test.ts'];

/**
 * Live-node EPCIS coverage is intentionally opt-in. The default package test
 * must not attach to whichever DKG daemon happens to be running on a developer
 * or CI host and use credentials from a different DKG home.
 */
export default defineConfig({
  test: {
    include: EPCIS_E2E_TEST_INCLUDE,
  },
});
