/**
 * Unit-only vitest config — skips the Hardhat globalSetup so pure-logic
 * tests (no chain spin-up) run in seconds instead of minutes. Mirrors
 * the cli/vitest.unit.config.ts pattern used since rc.10 PR-2 (#659).
 *
 * Add tests here only when they don't touch the chain — anything that
 * needs deployed contracts must stay in the default `vitest.config.ts`
 * include set so it gets the Hardhat boot.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Codex (#670#discussion_r3301775307): a hardcoded include list silently
    // drops new `*.unit.test.ts` files added later. The original list missed
    // `hub-resolution-cache.unit.test.ts` which had existed for several
    // sprints. Use a glob so unit coverage stays auto-discovered. The
    // explicit entries below are preserved for files that are pure-logic
    // but do not follow the `.unit.test.ts` naming convention.
    include: [
      'test/**/*.unit.test.ts',
      'test/conviction-cost-covered-decode.test.ts',
      'test/evm-adapter-pca-rpc.unit.test.ts',
      'test/evm-adapter-pca-enrich.test.ts',
      'test/filter-error-console-suppressor.test.ts',
      'test/filter-error-silencer.test.ts',
      'test/keyed-mutex-observability.test.ts',
      'test/mock-adapter-publishing-conviction-v10.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    maxWorkers: 1,
  },
});
