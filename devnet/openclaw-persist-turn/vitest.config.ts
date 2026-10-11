import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');
// Pure unit test of the settle helper: needs no devnet and takes no real time.
const settleTest = resolve(import.meta.dirname, 'settle.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest, settleTest],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
