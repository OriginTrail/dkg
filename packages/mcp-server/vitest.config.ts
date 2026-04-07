import { defineConfig } from 'vitest/config';
import { kosavaMcpServerCoverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Stdio entrypoint (index.ts) is not unit-tested here; ratchet DkgClient only.
      include: ['src/connection.ts'],
      thresholds: kosavaMcpServerCoverage,
    },
  },
});
