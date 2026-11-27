import { defineConfig } from 'vitest/config';

// These tests exercise real domain objects and embedded storage; no EVM setup.
export default defineConfig({
  test: {
    include: ['packages/{core,agent,publisher}/test/*.property.test.ts'],
    allowOnly: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
