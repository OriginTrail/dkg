import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Standalone vitest config for the automated 5-node devnet validation
 * suite. Kept out of the root `vitest.config.ts` `projects` list because
 * the test:
 *   - takes ~3-5 minutes (default per-test 60s+),
 *   - depends on a real running devnet (`./scripts/devnet.sh start 5`),
 *   - is intentionally NOT part of the `pnpm test` default fan-out.
 *
 * Run via: `pnpm test:devnet:agent-provenance` (see top-level package.json).
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 240_000,
    hookTimeout: 180_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    // Resolve `ethers` (and any other shared deps) from the repo root
    // node_modules. The experiments dir isn't a workspace member, so we
    // avoid duplicating dependencies by pointing the resolver at root.
    modules: [
      resolve(import.meta.dirname, '../../node_modules'),
      'node_modules',
    ],
  },
});
