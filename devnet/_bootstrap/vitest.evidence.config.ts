import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');

// Pure evidence-unit tests. No running devnet or built package artifacts needed.
export default defineConfig({
  root: repositoryRoot,
  test: {
    include: ['devnet/_bootstrap/rfc64-evidence.test.ts'],
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
});
