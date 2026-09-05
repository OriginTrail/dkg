import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/core/test/context-graph-join-policy*.test.ts'],
    allowOnly: false,
    maxWorkers: 1,
  },
});
