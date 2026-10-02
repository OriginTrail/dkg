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
    expect(verified.manifest.component).toMatchObject({
      wasiVersion: '0.3.0',
      targetCarrier: 'wasm32-wasip2',
      witPackage: 'origintrail:semantic-runtime@0.1.0',
      asyncMode: 'jspi',
      exports: ['origintrail:semantic-runtime/executor@0.1.0'],
      limits: {
        maxActiveExecutions: 8,
        maxOperationsPerExecution: 10_000,
        watchdogMs: 10_000,
        maxOldGenerationSizeMb: 256,
      },
    });
    expect(verified.manifest.component.imports).toEqual(expect.arrayContaining([
      'origintrail:semantic-runtime/investigator@0.1.0',
      'origintrail:semantic-runtime/query-catalog@0.1.0',
    ]));
    const wit = fs.readFileSync(
      path.join(defaultArtifactRoot(), 'component/wit/semantic-runtime.wit'),
      'utf8',
    );
    expect(wit).toContain('import investigator;');
    expect(wit).toContain('import query-catalog;');
    expect(wit).not.toContain('effect-request');
    expect(wit).not.toContain('arguments: list<string>');
    expect(verified.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.componentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.witSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    'component/runtime.component.wasm',
    'component/runtime.core.wasm',
    'component/runtime.js',
    'component/wit/semantic-runtime.wit',
  ])('fails closed when %s differs by one byte', (relative) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-runtime-integrity-'));
    temporaryDirectories.push(temporary);
    const copiedRoot = path.join(temporary, 'generated');
    fs.cpSync(defaultArtifactRoot(), copiedRoot, { recursive: true });
    const artifactPath = path.join(copiedRoot, relative);
    fs.appendFileSync(artifactPath, Buffer.from([0x00]));
    expect(() => verifyRuntimeArtifacts(copiedRoot)).toThrow(/integrity mismatch/);
  });

  it('fails closed when the component import set in the manifest changes', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-runtime-integrity-'));
    temporaryDirectories.push(temporary);
    const copiedRoot = path.join(temporary, 'generated');
    fs.cpSync(defaultArtifactRoot(), copiedRoot, { recursive: true });
    const manifestPath = path.join(copiedRoot, 'integrity.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      component: { imports: string[] };
    };
    manifest.component.imports.push('wasi:http/outgoing-handler@0.2.12');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyRuntimeArtifacts(copiedRoot)).toThrow(/checked-in build lock/);
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
    expect(() => verifyRuntimeArtifacts(copiedRoot)).toThrow(/checked-in build lock/);
  });
});
