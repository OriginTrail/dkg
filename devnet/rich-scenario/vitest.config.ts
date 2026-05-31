import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * ~10 minute devnet gate: edge CG policy matrix, 20 KAs (WM/SWM/VM),
 * greenfield updates, conviction staking, random sampling.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run: pnpm test:devnet:rich-scenario
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
