import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest drift guard. Pure filesystem/JSON — NO live devnet required, so it
// runs fast (CI-friendly), unlike the harness smoke test (vitest.config.ts).
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, harnessJsonTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
