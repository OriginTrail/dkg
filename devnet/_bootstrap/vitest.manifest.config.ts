import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest drift guard. Pure filesystem/JSON — NO live devnet required, so it
// runs fast (CI-friendly), unlike the harness smoke test (vitest.config.ts). It also runs
// the harness's other no-devnet unit tests: the JSON-block parser, and the SELECT answer
// reading (select-response.ts, and queryNode's unchanged reading of it).
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');
// The request `queryNode` sends and the response shapes it decodes (fetch stubbed, no devnet).
const harnessQueryTest = resolve(import.meta.dirname, 'harness-query.test.ts').replace(/\\/g, '/');
const selectResponseTest = resolve(import.meta.dirname, 'select-response.test.ts').replace(/\\/g, '/');
const queryNodeTest = resolve(import.meta.dirname, 'query-node.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, harnessJsonTest, harnessQueryTest, selectResponseTest, queryNodeTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
