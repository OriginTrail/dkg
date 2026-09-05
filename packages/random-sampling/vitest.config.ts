import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { coverageForPackage } from '../../vitest.coverage';
import { defineConfig } from 'vitest/config';

// Each project owns its context; Hardhat binds an OS-assigned port.
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
