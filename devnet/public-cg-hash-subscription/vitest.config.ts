import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const suiteFile = (name: string): string => resolve(import.meta.dirname, name).replace(/\\/g, '/');
const automatedTest = suiteFile('automated.test.ts');
// Unit tests of the suite's own helpers: no devnet needed.
const wireTest = suiteFile('wire.test.ts');
const flowsTest = suiteFile('flows.test.ts');

export default defineConfig({
  test: {
    include: [automatedTest, wireTest, flowsTest],
    testTimeout: 900_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
