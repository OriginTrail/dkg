import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * OT-RFC-27 marketplace — protocol-level prototype devnet suite.
 *
 * Runs the full RFC-27 loop against a live 6-node devnet: offer KAs in the
 * `marketplace` Context Graph → buyer discovery → on-chain subscription +
 * session key → off-chain quote/serve with bounded authorizations → seller
 * receipt batches on-chain → pro-rata bucket finalization → QIF epoch
 * rewards → soft-ceiling refusal. Standalone config (out of root vitest
 * projects) because it requires a live devnet, and it TIME-WARPS the shared
 * chain clock — run it after any RS/consensus suites on a shared devnet.
 *
 * Run via: `pnpm test:devnet:marketplace-rfc27`
 *
 * Preconditions:
 *   pnpm build
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs
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
