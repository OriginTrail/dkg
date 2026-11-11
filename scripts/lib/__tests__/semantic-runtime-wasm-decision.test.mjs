import assert from 'node:assert/strict';
import test from 'node:test';

import { wasmBuildDecision } from '../../build-semantic-runtime.mjs';

test('a build without the pinned toolchain skips the semantic runtime Wasm, unless the environment requires it', () => {
  assert.equal(wasmBuildDecision({}, null), 'build');
  assert.equal(wasmBuildDecision({ DKG_SEMANTIC_RUNTIME_WASM: 'required' }, null), 'build');
  assert.equal(wasmBuildDecision({}, 'semantic-runtime: expected Rust nightly-2026-08-18'), 'skip');
  assert.equal(wasmBuildDecision({ DKG_SEMANTIC_RUNTIME_WASM: 'required' }, 'spawnSync rustc ENOENT'), 'fail');
  // Only the exact value requires it.
  assert.equal(wasmBuildDecision({ DKG_SEMANTIC_RUNTIME_WASM: '1' }, 'spawnSync rustc ENOENT'), 'skip');
});
