import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const automatedTest = resolve(import.meta.dirname, 'automated.test.ts').replace(/\\/g, '/');

/**
 * RPC quiet-window budget validation.
 *
 * Run on an already-started, idle devnet:
 *   pnpm run build
 *   DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6
 *   pnpm test:devnet:rpc-quiet-window
 *
 * The suite tails daemon rpc_usage logs only; route probes and publishes should
 * not run during the observation window.
 */
export default defineConfig({
  test: {
    include: [automatedTest],
    testTimeout: Number(process.env.RPC_QUIET_TEST_TIMEOUT_MS ?? 300_000),
    hookTimeout: 60_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
