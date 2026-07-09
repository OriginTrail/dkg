import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * KA lifecycle log proof — devnet artifact suite.
 *
 * Preconditions:
 *   pnpm run build
 *   DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6
 *
 * Run via: `pnpm test:devnet:ka-lifecycle-log-proof`
 */
const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: { modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'] },
});
