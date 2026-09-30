import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * SWM host-mode store durability - kill -9 of a hosting core on a live devnet.
 *
 * Standalone config (out of the root vitest projects): it needs a running
 * devnet and restarts node4 several times, so it must run alone.
 *
 * Run via: `pnpm test:devnet:swm-host-store-durability`
 *
 * Preconditions:
 *   pnpm run build && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/')],
    testTimeout: 1_800_000,
    hookTimeout: 900_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
