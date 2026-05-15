import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Devnet validation for the lazy-settlement passive sink.
 *
 * Exercises the V10 conviction-lazy-settlement flow against a live
 * Hardhat-backed devnet (`./scripts/devnet.sh start 6` must be running):
 *
 *   1. Create a PCA, register the edge's op-wallet as an agent.
 *   2. Publish a small KC through the agent — verify the ACTIVE SINK
 *      fired (NFT.windowSpent grew and the `addTokensToEpochRange` event
 *      went into the KC's chain-epoch range for `discountedCost`).
 *   3. Advance Hardhat time past one billing window (`Chronos.epochLength()`).
 *      Call `settle(accountId)` — verify the PASSIVE SINK fired
 *      (`WindowSettled` event with `remainder == baseAllowance - drawn`
 *      and the staker pool grew for the chain epochs window 0 overlapped).
 *   4. Confirm `lastSettledWindow` advanced and a second `settle()` is a
 *      no-op (idempotent).
 *
 * Runs after the v10-end-to-end suite so it can warp time without
 * disturbing daemons mid-RS-loop. Standalone config (not in root
 * `vitest.config.ts`) for the same reason as the other devnet suites.
 *
 * Run via: `pnpm test:devnet:conviction-lazy-settle` (root package.json).
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 300_000,
    hookTimeout: 120_000,
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
