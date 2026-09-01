import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const suiteTests = [
  'automated.test.ts',
  'cleanup-stack.test.ts',
  'known-transaction.test.ts',
].map((file) =>
  resolve(import.meta.dirname, file).replace(/\\/g, '/'));

export default defineConfig({
  test: {
    include: suiteTests,
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
