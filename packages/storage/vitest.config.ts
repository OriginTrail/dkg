import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverageForPackage } from '../../vitest.coverage';

export default defineConfig({
  cacheDir: join(tmpdir(), 'dkg-storage-vitest-cache'),
  test: {
    allowOnly: false,
    include: ['test/**/*.test.ts'],
    coverage: coverageForPackage('storage'),
  },
});
