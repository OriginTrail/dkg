import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { coverageForPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

// Distinct port per Hardhat-backed test package so parallel monorepo
// test runs (`pnpm -r test` / turbo) don't collide on the same RPC
// port. Current map: chain 9545, publisher 9546, agent 9547, cli 9548,
// kafka-plugin 9549, random-sampling 9550. (Was 9547 — collided with
// `agent`, see #957.)
const hardhatEnv = hardhatTestEnvironment();

// Full-source critical-path coverage is ratcheted in the shared policy.
export default defineConfig({
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    // The Hardhat e2e file spawns a real node (~20s startup) and
    // publishes a real KC before driving the prover; bumping the
    // default vitest 5s timeout is necessary for that file. The
    // off-chain tests (mock-chain, prover, wal etc.) all complete
    // in <1s so they're unaffected.
    testTimeout: 120_000,
    globalSetup: ['../chain/test/hardhat-global-setup.ts'],
    maxWorkers: 1,
    env: hardhatEnv,
    coverage: coverageForPackage('random-sampling'),
  },
});
