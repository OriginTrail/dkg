import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * storage-ack-store-outage — wraps `scripts/devnet-test-store-outage.sh`, which
 * pauses ONE core's store mid-publish (SIGSTOP/SIGCONT) and asserts the publish
 * still confirms via the healthy cores and again after recovery. Depends on a
 * running devnet; not part of the default `pnpm test` fan-out.
 *
 * Run: `pnpm test:devnet:storage-ack-store-outage`.
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 360_000,
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
