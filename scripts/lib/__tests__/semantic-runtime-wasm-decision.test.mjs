import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../build-semantic-runtime.mjs', import.meta.url));
const GENERATED = fileURLToPath(new URL('../../../packages/semantic-runtime/generated', import.meta.url));

/** Runs the build script with an empty directory as the whole PATH, so no rustc, wasm-bindgen or pnpm is found. */
function buildWithoutRust(wasm) {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-no-rust-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  try {
    return spawnSync(process.execPath, [SCRIPT], {
      env: { ...env, PATH: emptyBin, DKG_SEMANTIC_RUNTIME_WASM: wasm },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
}

test('without the pinned toolchain, a build skips the semantic runtime Wasm with a warning and succeeds', () => {
  const before = fs.existsSync(GENERATED);
  const result = buildWithoutRust('');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /the Wasm build is skipped/);
  assert.match(result.stderr, /DKG_SEMANTIC_RUNTIME_WASM=required/);
  assert.equal(fs.existsSync(GENERATED), before);
});

test('without the pinned toolchain, DKG_SEMANTIC_RUNTIME_WASM=required fails the build', () => {
  const result = buildWithoutRust('required');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /the Wasm build is skipped/);
});
