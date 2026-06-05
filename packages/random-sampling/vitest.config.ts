import { defineConfig } from 'vitest/config';

// Distinct port per Hardhat-backed test package so parallel monorepo
// test runs (`pnpm -r test` / turbo) don't collide on the same RPC
// port. Current map: chain 9545, publisher 9546, agent 9547, cli 9548,
// kafka-plugin 9549, random-sampling 9550. (Was 9547 — collided with
// `agent`, see #957.)
process.env.HARDHAT_PORT = '9550';

// Coverage thresholds intentionally omitted while the package is just
// a skeleton. Once Phase 3+ lands real prover / extractor / mutual-aid
// code, add a `tornadoRandomSamplingCoverage` export to
// `vitest.coverage.ts` and ratchet floors here — random sampling is
// Tornado-tier (gas-stake-rewards path).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The Hardhat e2e file spawns a real node (~20s startup) and
    // publishes a real KC before driving the prover; bumping the
    // default vitest 5s timeout is necessary for that file. The
    // off-chain tests (mock-chain, prover, wal etc.) all complete
    // in <1s so they're unaffected.
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: { HARDHAT_PORT: '9550' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
