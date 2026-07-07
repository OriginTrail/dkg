import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * KA lifecycle CLI — devnet coverage for the #1410 `dkg ka` commands.
 *
 * Preconditions (the async VM-publish tests need the publisher runtime; a
 * devnet booted without it makes every publisher job queue forever and each
 * of those tests burns its full 300s timeout):
 *
 *   ./scripts/devnet.sh clean
 *   DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6
 *
 * Run via: `pnpm test:devnet:ka-lifecycle-cli`
 * The suite also fail-fasts in beforeAll with a pointed message when the
 * devnet's publisher runtime is not running — detected via node1's
 * publisher-wallets.json, which devnet.sh only writes under
 * DEVNET_ENABLE_PUBLISHER=1 (config.json's publisher.enabled is always true).
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
