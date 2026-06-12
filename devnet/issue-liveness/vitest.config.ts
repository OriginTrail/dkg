import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Multi-node issue-liveness regression suite against a live devnet.
 *
 * Encodes confirmed-live cross-node bugs from the rc.17 QA sweep as plain
 * failing `it()` repros — each asserts the CORRECT behaviour, so it is RED while
 * the bug is live and turns GREEN when fixed, signalling the linked GitHub issue
 * can close. Manual-run (needs a live devnet), like the sibling devnet suites.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs
 *
 * Run: pnpm test:devnet:issue-liveness
 */
// ESM package (`"type": "module"`) — `__dirname` is undefined when Vitest loads
// this config, so derive paths from `import.meta.dirname` like the sibling
// devnet vitest configs (otherwise the suite fails before any test loads).
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts'), resolve(import.meta.dirname, 'high-issues.test.ts')],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
