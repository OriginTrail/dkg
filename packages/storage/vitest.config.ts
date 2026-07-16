import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { tornadoStorageCoverage } from '../../vitest.coverage';

export default defineConfig({
  cacheDir: join(tmpdir(), 'dkg-storage-vitest-cache'),
  test: {
    include: ['test/**/*.test.ts'],
    // Deadline/abort tests use real timers; keep files serial inside this
    // package while Turbo continues running independent packages in parallel.
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: tornadoStorageCoverage,
    },
  },
});
