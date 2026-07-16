import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Combined V10 chain validation against a live devnet.
 *
 * One ordered vitest run that exercises the full V10 happy path:
 *   1. Random sampling proof submission + on-chain score credit
 *   2. Publish + DKGPublishingConvictionNFT cost coverage
 *   3. Conviction-staking lifecycle (createConviction → withdraw)
 *   4. Operator fee withdrawal lifecycle (request → finalize)
 *
 * RS runs first because it's the most flow-sensitive: it waits for a core
 * node prover tick and the on-chain score to land. Publish/staking can
 * run after without disturbing it.
 *
 * Standalone config — kept out of the root `vitest.config.ts` projects list
 * because the suite takes ~5-8 minutes, requires a live devnet, and is not
 * part of the `pnpm test` default fan-out.
 *
 * Run via: `pnpm test:devnet:v10-e2e` (see top-level package.json).
 *
 * Preconditions: `./scripts/devnet.sh start 6` must already be running.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [
      resolve(import.meta.dirname, '../../node_modules'),
      'node_modules',
    ],
  },
});
