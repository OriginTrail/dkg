import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readWasmMemoryLimits,
  verifyGenerated,
} from '../../build-semantic-runtime.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGE_ROOT = path.join(REPO_ROOT, 'packages', 'semantic-runtime');
const GENERATED_ROOT = path.join(PACKAGE_ROOT, 'generated');

test('locally built semantic-runtime artifacts have pinned hashes, ABI, and bounded memory', () => {
  const manifest = verifyGenerated(GENERATED_ROOT);
  assert.equal(manifest.abiVersion, 1);
  assert.deepEqual(manifest.memory, { initialPages: 256, maximumPages: 4096 });
  assert.deepEqual(manifest.component.exports, [
    'origintrail:semantic-runtime/runtime@0.1.0',
  ]);
  assert.equal(manifest.component.wasiVersion, '0.3.0');
  assert.equal(manifest.component.targetCarrier, 'wasm32-wasip2');
  assert.deepEqual(
    readWasmMemoryLimits(fs.readFileSync(path.join(GENERATED_ROOT, 'cjs', 'runtime_bg.wasm'))),
    manifest.memory,
  );
});

test('semantic-runtime npm tarball includes integrity metadata, glue, declarations, and Wasm', () => {
  const output = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const packed = JSON.parse(output);
  assert.equal(packed.length, 1);
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const required of [
    'generated/integrity.json',
    'artifact-lock.json',
    'generated/cjs/package.json',
    'generated/cjs/runtime.js',
    'generated/cjs/runtime.d.ts',
    'generated/cjs/runtime_bg.wasm',
    'generated/cjs/runtime_bg.wasm.d.ts',
    'generated/component/runtime.component.wasm',
    'generated/component/runtime.js',
    'generated/component/runtime.d.ts',
    'generated/component/runtime.core.wasm',
    'generated/component/runtime.core2.wasm',
    'generated/component/runtime.core3.wasm',
    'generated/component/wit/semantic-runtime.wit',
  ]) {
    assert.ok(files.has(required), `semantic runtime tarball must include ${required}`);
  }
});
