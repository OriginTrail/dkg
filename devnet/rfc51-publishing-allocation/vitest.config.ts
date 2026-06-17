import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Devnet validation for OT-RFC-51 "Publishing Allocation".
 *
 * Exercises the RFC-51 creation path end-to-end against a live
 * Hardhat-backed devnet (`./scripts/devnet.sh start 2` — two core nodes —
 * must be running):
 *
 *   1. Create a PCA through node1's daemon REST endpoint (`POST /api/pca`)
 *      designating node2 as `primaryNode`. Assert node2's committed
 *      publishing allocation grows by exactly committedTRAC (summed over
 *      the lock) and node1's does NOT — attribution follows the param, not
 *      the caller's node.
 *   2. Create with a non-existent `primaryNode` and assert the real,
 *      ethers-wrapped `PrimaryNodeNotInShardingTable` revert is classified
 *      to HTTP 400 (not 500) — the thing the mock-based route tests can't
 *      prove.
 *
 * Standalone config (kept out of the root `vitest.config.ts` projects list)
 * like the other devnet suites — it needs an operator-started devnet and is
 * not part of the `pnpm test` default fan-out / CI.
 *
 * Run via: `pnpm test:devnet:rfc51-publishing-allocation` (root package.json).
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 180_000,
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
