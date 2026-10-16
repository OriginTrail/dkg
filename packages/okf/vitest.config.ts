import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    // Test files run in child processes, Vitest's default, pinned here: the
    // staleness tests switch `process.env.TZ` to zones away from UTC, which
    // takes effect in a process but not in a worker thread (their guard
    // assertion would then fail rather than pass vacuously).
    pool: 'forks',
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    coverage: coverageForPackage('okf'),
  },
});
