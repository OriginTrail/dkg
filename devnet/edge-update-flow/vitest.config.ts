import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * OT-RFC-41 Bundle B — Edge npm-only update + rollback flow.
 *
 * Wraps `scripts/devnet-test-edge-update.sh`, which spins up a local
 * verdaccio registry, packs + publishes every public workspace
 * package, installs the CLI globally into a scratch npm prefix,
 * exercises the full `dkg update` → `dkg rollback` round-trip against
 * a real `npm install -g`, and asserts the production
 * `performNpmUpdateEdge` + `dkg rollback` (Edge branch) code paths
 * actually mutate disk the way unit tests expect.
 *
 * This is the §6.2 testing-gap closer for RFC-41: unit tests in
 * `packages/cli/test/rfc-41-bundle-b.test.ts` cover the LOGIC with a
 * mocked `_autoUpdateIo.exec`; this suite covers the INTEGRATION with
 * the real npm CLI.
 *
 * Pre-requisites (see `docs/devnet/EDGE_UPDATE_VALIDATION.md`):
 *   - `pnpm install` from the repo root
 *   - `pnpm build` (so `packages/* /dist/` exists for `pnpm pack`)
 *   - `npx -y verdaccio --version` works on the host (warm the cache)
 *
 * Run: `pnpm test:devnet:edge-update-flow`
 *
 * Runtime: ~3-5 minutes. Dominated by verdaccio cold-start and two
 * `npm install -g` round-trips against the scratch prefix.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 600_000,
    hookTimeout: 60_000,
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
