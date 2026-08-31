import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ABI_VERSION, SCHEMA_VERSION } from './codec.js';

export interface IntegrityManifest {
  manifestVersion: number;
  packageVersion: string;
  rustCrateVersion: string;
  abiVersion: number;
  schemaVersion: number;
  memory: { initialPages: number; maximumPages: number };
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface VerifiedRuntimeArtifacts {
  root: string;
  gluePath: string;
  wasmPath: string;
  wasmSha256: string;
  manifest: IntegrityManifest;
}

const REQUIRED_FILES = [
  'cjs/package.json',
  'cjs/runtime.js',
  'cjs/runtime.d.ts',
  'cjs/runtime_bg.wasm',
  'cjs/runtime_bg.wasm.d.ts',
] as const;

export function defaultArtifactRoot(): string {
  return fileURLToPath(new URL('../generated/', import.meta.url));
}

export function verifyRuntimeArtifacts(root = defaultArtifactRoot()): VerifiedRuntimeArtifacts {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, 'integrity.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`semantic runtime integrity manifest is missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as IntegrityManifest;
  if (
    manifest.manifestVersion !== 1
    || manifest.abiVersion !== ABI_VERSION
    || manifest.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new Error('semantic runtime integrity manifest has an incompatible version');
  }
  if (manifest.memory?.initialPages !== 256 || manifest.memory?.maximumPages !== 4096) {
    throw new Error('semantic runtime integrity manifest has unexpected Wasm memory limits');
  }
  const declaredFiles = Object.keys(manifest.files ?? {}).sort();
  const requiredFiles = [...REQUIRED_FILES].sort();
  if (
    declaredFiles.length !== requiredFiles.length
    || declaredFiles.some((file, index) => file !== requiredFiles[index])
  ) {
    throw new Error('semantic runtime integrity manifest has an unexpected artifact set');
  }
  for (const relative of REQUIRED_FILES) {
    const expected = manifest.files?.[relative];
    if (!expected) throw new Error(`semantic runtime integrity entry is missing for ${relative}`);
    const absolute = safeArtifactPath(resolvedRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`semantic runtime generated artifact is missing: ${relative}`);
    }
    const bytes = fs.readFileSync(absolute);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) {
      throw new Error(`semantic runtime integrity mismatch for ${relative}`);
    }
  }
  const wasmPath = safeArtifactPath(resolvedRoot, 'cjs/runtime_bg.wasm');
  return {
    root: resolvedRoot,
    gluePath: safeArtifactPath(resolvedRoot, 'cjs/runtime.js'),
    wasmPath,
    wasmSha256: manifest.files['cjs/runtime_bg.wasm'].sha256,
    manifest,
  };
}

export function artifactRootUrl(root = defaultArtifactRoot()): URL {
  return pathToFileURL(`${path.resolve(root)}${path.sep}`);
}

function safeArtifactPath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`semantic runtime artifact escaped package root: ${relative}`);
  }
  return absolute;
}
