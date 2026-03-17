import { defineConfig } from 'vitest/config';
import { coverageThresholds } from '../../vitest.coverage';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@origintrail-official/dkg-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@origintrail-official/dkg-storage': fileURLToPath(new URL('../storage/src/index.ts', import.meta.url)),
      'better-sqlite3': resolve(fileURLToPath(new URL('.', import.meta.url)), '../node-ui/node_modules/better-sqlite3'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: coverageThresholds,
    },
  },
});
