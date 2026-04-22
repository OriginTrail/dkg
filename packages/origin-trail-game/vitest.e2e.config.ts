import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    // `sequence.concurrent: false` only serializes tests *within* a file.
    // Each e2e file boots 3 DKG daemons + Hardhat into a shared
    // `.test-nodes/` directory and shared ports (19200-19202, 18545), so
    // running files in parallel races over the same state and wipes
    // each other's config/log files via `rmSync(TEST_DIR, ...)` in
    // `startTestCluster`. Force single-threaded, file-level serial
    // execution to keep the suite deterministic in CI.
    //
    // Vitest 4 removed `test.poolOptions.*.singleThread|singleFork`;
    // `fileParallelism: false` is now the canonical way to make vitest
    // run test files one at a time in one worker.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
