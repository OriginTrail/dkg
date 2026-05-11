import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * V10 chain stress + scenario validation against a live 6-node devnet.
 *
 * Significantly heavier than `v10-end-to-end-devnet`:
 *   1. 20 stakers across mixed conviction tiers (0/1/3/6/12).
 *   2. 100 publishes mixing 4 publish modes (custodial / pre-signed
 *      self-sovereign / daemon-signed self-sovereign / unattributed)
 *      × 4 lifecycle stages (WM-only / WM→SWM / WM→SWM→VM /
 *      one-shot create-finalize-promote-publish).
 *   3. Mid-run 7th core node spawn — addnode → ensureIdentity → stake
 *      → updateAsk → assert it submits RS proofs in the next epoch.
 *   4. Random sampling reconciliation across multiple epochs.
 *   5. Stake NFT transferability — ERC-721 safeTransferFrom + redelegate.
 *      Documents the "V10 KC author is immutable" finding.
 *   6. Reward lifecycle — time-warp epochs of accrual, claim → withdraw,
 *      restake; reconcile TRAC totals end-to-end.
 *
 * Standalone config — kept out of the root vitest projects list because
 * the suite takes ~20-30 minutes and requires a live devnet.
 *
 * Run via: `pnpm test:devnet:v10-stress`.
 *
 * Preconditions: `./scripts/devnet.sh start 6` running, no node 7 yet.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
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
