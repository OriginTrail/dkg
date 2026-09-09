import { defineConfig } from 'vitest/config';

const SQLITE_EXEC_ARGV = [
  '--experimental-sqlite',
  '--no-warnings=ExperimentalWarning',
];

export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test-live/**/*.test.ts'],
    testTimeout: 30_000,
    maxWorkers: 1,
    pool: 'forks',
    execArgv: SQLITE_EXEC_ARGV,
  },
});
