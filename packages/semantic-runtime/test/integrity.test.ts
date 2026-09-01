import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultArtifactRoot,
  verifyRuntimeArtifacts,
} from '../src/integrity.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('semantic runtime artifact integrity', () => {
  it('verifies every generated artifact and the pinned ABI metadata', () => {
    const verified = verifyRuntimeArtifacts();
    expect(verified.manifest.abiVersion).toBe(1);
    expect(verified.manifest.memory).toEqual({ initialPages: 256, maximumPages: 4096 });
    expect(verified.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when the packaged Wasm differs by one byte', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-runtime-integrity-'));
    temporaryDirectories.push(temporary);
    const copiedRoot = path.join(temporary, 'generated');
    fs.cpSync(defaultArtifactRoot(), copiedRoot, { recursive: true });
    const wasmPath = path.join(copiedRoot, 'cjs', 'runtime_bg.wasm');
    const bytes = fs.readFileSync(wasmPath);
    bytes[bytes.length - 1] ^= 0x01;
    fs.writeFileSync(wasmPath, bytes);
    expect(() => verifyRuntimeArtifacts(copiedRoot)).toThrow(/integrity mismatch/);
  });

  it('fails closed when the manifest declares an unexpected executable artifact', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-runtime-integrity-'));
    temporaryDirectories.push(temporary);
    const copiedRoot = path.join(temporary, 'generated');
    fs.cpSync(defaultArtifactRoot(), copiedRoot, { recursive: true });
    const manifestPath = path.join(copiedRoot, 'integrity.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, { sha256: string; bytes: number }>;
    };
    manifest.files['cjs/unexpected.js'] = { sha256: '00'.repeat(32), bytes: 0 };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyRuntimeArtifacts(copiedRoot)).toThrow(/unexpected artifact set/);
  });
});
