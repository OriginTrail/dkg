import { defineConfig } from 'vitest/config';

// This destructive campaign is launched only by its parent verification script.
export default defineConfig({
  test: {
    allowOnly: false,
    include: ['campaigns/catalog-durable-head.test.ts'],
    pool: 'forks',
    execArgv: ['--experimental-sqlite', '--no-warnings=ExperimentalWarning'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
