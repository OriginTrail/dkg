import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Harness smoke test config. Precondition: ./scripts/devnet.sh start 6
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'smoke.test.ts')],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
