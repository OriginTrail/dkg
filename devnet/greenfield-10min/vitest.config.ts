import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * ~10 minute devnet gate: publish → greenfield update (owner seal) →
 * conviction staking → random sampling proof on the same KC.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run: pnpm test:devnet:greenfield-10min
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
