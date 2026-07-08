import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Devnet validation for the 10.0.8 deterministic emission schedule
 * (OT-RFC-58) — the eager "bell", which SUPERSEDES the lazy-settlement
 * model exercised by devnet/conviction-lazy-settle.
 *
 * Exercises the V10 conviction flow against a live Hardhat-backed devnet
 * (`./scripts/devnet.sh start 6` must be running):
 *
 *   1. createAccount now writes the FULL staker-pool emission schedule up
 *      front (each billing window's budget forward-spread over the lock),
 *      so `EmissionScheduled` fires with `scheduled == committedTRAC` and
 *      the tx credits EpochStorage across the forward span — the exact
 *      inverse of the lazy-settle model, where createAccount emitted
 *      nothing.
 *   2. A within-budget publish through a registered agent draws the
 *      per-window budget (`windowSpent` grows, `CostCovered` shows a base
 *      draw) but emits NOTHING further to the pool — the base TRAC is
 *      already scheduled, so no double emission.
 *   3. `settle()` before expiry is a no-op (the schedule is already written).
 *   4. `migrateEmissionSchedule` on an account created at 10.0.8+ is
 *      idempotent (the schedule-written marker skips it).
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
