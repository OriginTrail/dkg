import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * BDD pilot — runs Gherkin .feature specs on the project's existing Vitest
 * runner via @amiceli/vitest-cucumber (no second runner, no extra CI lane).
 *
 *   - steps/entity-predicate.steps.ts  -> pure smoke spec, always runnable
 *   - steps/ka-lifecycle.steps.ts      -> @devnet, skipped unless a devnet is up
 *
 * Smoke only:   pnpm --filter @origintrail-official/dkg-bdd test       (CI default)
 * All specs:    pnpm --filter @origintrail-official/dkg-bdd test:all
 * Devnet spec:  ./scripts/devnet.sh start 6   (then)   ... test:devnet
 *
 * Timeouts/pool mirror the devnet scenario configs so the @devnet spec has
 * room to boot + round-trip; the smoke spec finishes in milliseconds.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'steps/**/*.steps.ts')],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../node_modules'), 'node_modules'],
  },
});
