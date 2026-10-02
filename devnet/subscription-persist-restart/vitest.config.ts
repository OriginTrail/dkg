import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');
// Pure filesystem test of the log-window helper: needs no devnet.
const logWindowTest = resolve(import.meta.dirname, 'log-window.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest, logWindowTest],
    testTimeout: 480_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
