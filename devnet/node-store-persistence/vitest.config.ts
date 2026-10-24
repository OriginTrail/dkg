import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const suiteFile = (name: string): string => resolve(import.meta.dirname, name).replace(/\\/g, '/');

export default defineConfig({
  test: {
    // The live suite, and the unit test of the verdict it relies on (no devnet).
    include: [suiteFile('automated.test.ts'), suiteFile('chain-log-follows.test.ts')],
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
