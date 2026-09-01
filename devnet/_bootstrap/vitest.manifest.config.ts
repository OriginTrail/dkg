import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest and shared-sweep topology guards. They use isolated fixtures and
// need NO live devnet, so they stay fast (CI-friendly), unlike the harness smoke test.
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');
const sharedSweepPreflightTest = resolve(
  import.meta.dirname,
  'devnet-shared-sweep-preflight.test.ts',
).replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, sharedSweepPreflightTest, harnessJsonTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
