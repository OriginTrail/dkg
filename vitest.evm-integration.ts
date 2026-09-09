import { defineConfig } from 'vitest/config';
import { evmFilesForPackage } from './scripts/ci/evm-test-scopes.mjs';

export default defineConfig({
  test: {
    allowOnly: false,
    include: evmFilesForPackage(process.cwd()),
    testTimeout: 120_000,
  },
});
