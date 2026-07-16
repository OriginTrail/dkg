import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Core-peers features — devnet validation of the chain-driven VM
 * reconciliation effort (Phases B / C / D / E / F).
 *
 * Standalone config (out of the root vitest projects) because it requires a
 * live devnet and stops/restarts a node mid-run.
 *
 * Run via: `pnpm test:devnet:core-peers-features`
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
