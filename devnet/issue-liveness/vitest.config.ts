import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Multi-node issue-liveness regression suite against a live devnet.
 *
 * Encodes confirmed-live cross-node bugs from the rc.17 QA sweep as `it.fails`
 * repros — each fails today (bug live) and flips RED when fixed, signalling the
 * linked GitHub issue can close. Manual-run (needs a live devnet), like the
 * sibling devnet suites.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs
 *
 * Run: pnpm test:devnet:issue-liveness
 */
export default defineConfig({
  test: {
    include: [resolve(__dirname, 'automated.test.ts'), resolve(__dirname, 'high-issues.test.ts')],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
