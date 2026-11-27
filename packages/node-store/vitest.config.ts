import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  resolve: {
    // The store tests open the real `DashboardDB` (packages/node-ui/src/db.ts),
    // which owns every table and migration in Phase 1 and re-exports these very
    // stores from this package. Resolve that self-import to this package's
    // source so the tests run against one copy of the classes, not a stale
    // `dist` build, and coverage is measured on `src`.
    alias: {
      '@origintrail-official/dkg-node-store': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    coverage: coverageForPackage('node-store'),
  },
});
