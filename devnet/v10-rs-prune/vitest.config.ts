import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * V10 Random Sampling — expired-KA prune keeper, end-to-end on a live devnet.
 *
 * Standalone config (kept out of the root vitest projects list) — it requires a
 * live 6-node devnet and drives a real CLI publish flow + chain time-warps.
 *
 * Run via: `pnpm test:devnet:v10-rs-prune`.
 * Preconditions: `./scripts/devnet.sh start 6` running.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
