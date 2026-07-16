import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * V10 core-flows — release-gate validation suite.
 *
 * Sits between `v10-end-to-end-devnet` (basic happy path) and
 * `v10-stress-devnet` (scale + race conditions). Covers every first-class
 * V10 capability deliberately, one canonical scenario each:
 *
 *   1. Chained sign-at-creation assertion lifecycle (4 standalone routes
 *      + SSE event emission per step).
 *   2. Edge-node publish — verifies the architectural rule that nodes
 *      without on-chain identity surface "tentative" rather than crashing.
 *   3. NFT staking withdraw — `DKGStakingConvictionNFT.withdraw()` returns
 *      raw + claimed rewards to the staker EOA; NFT burned; position cleared.
 *   4. Operator-fee accrual + withdrawal — RFC-26 fee math against gross
 *      epoch reward; request → cooldown → finalize cycle delivers TRAC to
 *      the operator's admin EOA.
 *
 * **Run before any "bigger update" lands** — anything that touches the
 * assertion route, staking contracts, publisher chain-submit path, or
 * the operator-fee mechanism. Standalone config (out of root vitest
 * projects) because it requires a live devnet.
 *
 * Run via: `pnpm test:devnet:v10-core-flows`
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs   # 10 delegators + initial publishes
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [
      resolve(import.meta.dirname, '../../node_modules'),
      'node_modules',
    ],
  },
});
