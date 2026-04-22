import { defineConfig } from 'vitest/config';

/**
 * Local test config for @origintrail-official/dkg-mcp.
 *
 * Tests are pure unit tests (no daemon required) covering:
 *   - the slug normalisation algorithm (the URI-convergence rule)
 *   - URI helpers (mint vs pass-through)
 *   - the capture-chat hook's pure functions (config parsing, payload
 *     field resolution, regex backstop)
 *   - structural sanity of all 5 starter ontologies
 *
 * Integration (against a running daemon) is exercised by the smoke
 * scripts at scripts/smoke-writes.mjs and scripts/smoke-annotate.mjs.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
