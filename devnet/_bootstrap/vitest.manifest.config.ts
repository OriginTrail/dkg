import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Suite-manifest drift guard and the devnet chain guard. Pure filesystem/JSON and
// a local fake RPC — NO live devnet required, so it runs fast (CI-friendly),
// unlike the harness smoke test (vitest.config.ts).
const devnetChainTest = resolve(import.meta.dirname, 'devnet-chain.test.ts').replace(/\\/g, '/');
const harnessJsonTest = resolve(import.meta.dirname, 'harness-json.test.ts').replace(/\\/g, '/');
const suiteManifestTest = resolve(import.meta.dirname, 'suite-manifest.test.ts').replace(/\\/g, '/');

export default defineConfig({
  test: {
    include: [suiteManifestTest, harnessJsonTest, devnetChainTest],
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
