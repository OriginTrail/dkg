import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Mixed-version devnet interop suite. Depends on a running devnet — ideally a
 * mixed-version one started with `DEVNET_VERSION_LAYOUT` (see
 * scripts/devnet.sh). Not part of the default `pnpm test` fan-out.
 *
 * Run via: `pnpm test:devnet:mixed-version`.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 240_000,
    hookTimeout: 120_000,
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
