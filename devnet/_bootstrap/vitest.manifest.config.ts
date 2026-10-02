import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest drift guard, plus the pure helper tests: the JSON-block parser, the SELECT
// answer reading (select-response.ts, and queryNode's unchanged reading of it), and the
// shared node-lifecycle helpers against temp dirs, child processes and a local stand-in
// API. NO live devnet required, so it runs fast (CI-friendly), unlike the harness smoke
// test (vitest.config.ts).
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');
const selectResponseTest = resolve(import.meta.dirname, 'select-response.test.ts').replace(/\\/g, '/');
const queryNodeTest = resolve(import.meta.dirname, 'query-node.test.ts').replace(/\\/g, '/');
const nodeLifecycleTest = resolve(import.meta.dirname, 'node-lifecycle.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, harnessJsonTest, selectResponseTest, queryNodeTest, nodeLifecycleTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
