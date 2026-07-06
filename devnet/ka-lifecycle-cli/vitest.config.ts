import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: { modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'] },
});
