import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Pure evidence-unit tests. No running devnet or built package artifacts needed.
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'rfc64-evidence.test.ts')],
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
