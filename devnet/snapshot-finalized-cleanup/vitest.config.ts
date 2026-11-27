import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Finalized SWM snapshot cleanup - devnet coverage.
 *
 * Preconditions: the devnet must be booted with the collector opted in and a
 * short grace period and interval, and with the publisher runtime (the async
 * VM publish is what records a retirement):
 *
 *   ./scripts/devnet.sh clean
 *   DEVNET_ENABLE_PUBLISHER=1 DEVNET_SNAPSHOT_GC_FINALIZED_CLEANUP=1 \
 *     DEVNET_SNAPSHOT_GC_FINALIZED_RETENTION_MS=30000 DEVNET_SNAPSHOT_GC_INTERVAL_MS=2000 \
 *     ./scripts/devnet.sh start 6
 *
 * Run via: `pnpm test:devnet:snapshot-finalized-cleanup`. The suite fail-fasts
 * in beforeAll when the nodes were not configured that way.
 */
const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [automatedTest],
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: { modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'] },
});
