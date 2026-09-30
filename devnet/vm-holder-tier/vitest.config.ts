import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * VM exact-recovery holder tier — live devnet coverage.
 *
 * Precondition: `pnpm run build && ./scripts/devnet.sh start 6`. The suite
 * restarts nodes 1, 5 and 6 itself (see automated.test.ts), so it takes a while:
 * the hooks cover the publish + restart choreography, the test the convergence.
 *
 * Run via: `pnpm test:devnet:vm-holder-tier`
 */
const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
