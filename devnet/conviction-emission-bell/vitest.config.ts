import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Devnet validation for Conviction Account payments at use time
 * (PublishingConviction 10.2.0, OT-RFC-27), whose window bookings still
 * follow the 10.0.8 emission "bell" when they are settled on time.
 *
 * Exercises the V10 conviction flow against a live Hardhat-backed devnet
 * (`./scripts/devnet.sh start 6` must be running):
 *
 *   1. createAccount books nothing to the staker pool; the account pays when
 *      it uses its allowance.
 *   2. A publish through a registered agent books its whole discounted draw
 *      over the Knowledge Asset's epochs, as a wallet publish spreads its
 *      payment.
 *   3. `settle()` before the first window closes books nothing.
 *   4. As each window closes, an on-time `settle()` books B − spent over the
 *      lock's epoch-lengths after the window — the 10.0.8 bell's own credits
 *      for that window; the expiry settle is the final sweep.
 *   5. The permissionless `settleMany([...])` books synthetic accounts from
 *      before 10.0.8 the same way (the mainnet path).
 *   6. An account as 10.0.8 left it, scheduled up front, is left untouched.
 *
 * Standalone config (not in root `vitest.config.ts`) like the other devnet
 * suites, so it can be run after the daemons are settled.
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
