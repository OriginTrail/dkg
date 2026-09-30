import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest drift guard, plus the pure helper tests (harness JSON parsing, the
// shared node-lifecycle helpers against temp dirs, child processes and a local
// stand-in API). NO live devnet required, so it runs fast (CI-friendly), unlike the
// harness smoke test (vitest.config.ts).
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');
const nodeLifecycleTest = resolve(import.meta.dirname, 'node-lifecycle.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, harnessJsonTest, nodeLifecycleTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
