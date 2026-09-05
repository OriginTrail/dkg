import { hardhatTestEnvironment } from '../../scripts/lib/hardhat-test-env.mjs';
import { defineConfig } from 'vitest/config';

// Each project owns its context; Hardhat binds an OS-assigned port.
const hardhatEnv = hardhatTestEnvironment();

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
    env: hardhatEnv,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
