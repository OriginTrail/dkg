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
  component: {
    wasiVersion: string;
    targetCarrier: string;
    witPackage: string;
    asyncMode: string;
    imports: string[];
    exports: string[];
    memory: { initialPages: number; maximumPages: number };
    limits: {
      maxActiveExecutions: number;
      maxOperationsPerExecution: number;
      watchdogMs: number;
      maxOldGenerationSizeMb: number;
    };
  };
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface VerifiedRuntimeArtifacts {
  root: string;
  gluePath: string;
  wasmPath: string;
  wasmSha256: string;
  componentRoot: string;
  componentJsPath: string;
  componentWasmPath: string;
  componentSha256: string;
  witSha256: string;
  manifest: IntegrityManifest;
}

interface ArtifactLock {
  lockVersion: number;
  rustToolchain: string;
  rustVersion: string;
  jcoVersion: string;
  wasiVersion: string;
  targetCarrier: string;
  witPackage: string;
  integritySha256: string;
  componentSha256: string;
  witSha256: string;
}

const REQUIRED_FILES = [
  'cjs/package.json',
  'cjs/runtime.js',
  'cjs/runtime.d.ts',
  'cjs/runtime_bg.wasm',
  'cjs/runtime_bg.wasm.d.ts',
  'component/interfaces/origintrail-semantic-runtime-capability.d.ts',
  'component/interfaces/origintrail-semantic-runtime-investigator.d.ts',
  'component/interfaces/origintrail-semantic-runtime-query-catalog.d.ts',
  'component/interfaces/origintrail-semantic-runtime-runtime.d.ts',
  'component/interfaces/wasi-cli-environment.d.ts',
  'component/interfaces/wasi-cli-exit.d.ts',
  'component/interfaces/wasi-cli-stderr.d.ts',
  'component/interfaces/wasi-cli-stdin.d.ts',
  'component/interfaces/wasi-cli-stdout.d.ts',
  'component/interfaces/wasi-cli-terminal-input.d.ts',
  'component/interfaces/wasi-cli-terminal-output.d.ts',
  'component/interfaces/wasi-cli-terminal-stderr.d.ts',
  'component/interfaces/wasi-cli-terminal-stdin.d.ts',
  'component/interfaces/wasi-cli-terminal-stdout.d.ts',
  'component/interfaces/wasi-clocks-monotonic-clock.d.ts',
  'component/interfaces/wasi-io-error.d.ts',
  'component/interfaces/wasi-io-poll.d.ts',
  'component/interfaces/wasi-io-streams.d.ts',
  'component/runtime.component.wasm',
  'component/runtime.core.wasm',
  'component/runtime.core2.wasm',
  'component/runtime.core3.wasm',
  'component/runtime.d.ts',
  'component/runtime.js',
  'component/wit/semantic-runtime.wit',
] as const;

const EXPECTED_COMPONENT_IMPORTS = [
  'origintrail:semantic-runtime/capability@0.1.0',
  'origintrail:semantic-runtime/investigator@0.1.0',
  'origintrail:semantic-runtime/query-catalog@0.1.0',
  'wasi:cli/environment@0.2.12',
  'wasi:cli/exit@0.2.12',
  'wasi:cli/stderr@0.2.12',
  'wasi:cli/stdin@0.2.12',
  'wasi:cli/stdout@0.2.12',
  'wasi:cli/terminal-input@0.2.12',
  'wasi:cli/terminal-output@0.2.12',
  'wasi:cli/terminal-stderr@0.2.12',
  'wasi:cli/terminal-stdin@0.2.12',
  'wasi:cli/terminal-stdout@0.2.12',
  'wasi:clocks/monotonic-clock@0.2.12',
  'wasi:io/error@0.2.12',
  'wasi:io/poll@0.2.12',
  'wasi:io/streams@0.2.12',
].sort();
const EXPECTED_COMPONENT_EXPORTS = ['origintrail:semantic-runtime/runtime@0.1.0'];

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
  const lockPath = fileURLToPath(new URL('../artifact-lock.json', import.meta.url));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as ArtifactLock;
  const integritySha256 = createHash('sha256')
    .update(fs.readFileSync(manifestPath))
    .digest('hex');
  if (
    lock.lockVersion !== 1
    || lock.rustToolchain !== 'nightly-2026-08-18'
    || lock.rustVersion !== '1.100.0-nightly'
    || lock.jcoVersion !== '1.32.1'
    || lock.wasiVersion !== '0.3.0'
    || lock.targetCarrier !== 'wasm32-wasip2'
    || lock.witPackage !== 'origintrail:semantic-runtime@0.1.0'
    || lock.integritySha256 !== integritySha256
    || lock.componentSha256 !== manifest.files?.['component/runtime.component.wasm']?.sha256
    || lock.witSha256 !== manifest.files?.['component/wit/semantic-runtime.wit']?.sha256
  ) {
    throw new Error('semantic runtime artifacts do not match the checked-in build lock');
  }
  if (
    manifest.manifestVersion !== 2
    || manifest.abiVersion !== ABI_VERSION
    || manifest.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new Error('semantic runtime integrity manifest has an incompatible version');
  }
  if (manifest.memory?.initialPages !== 256 || manifest.memory?.maximumPages !== 4096) {
    throw new Error('semantic runtime integrity manifest has unexpected Wasm memory limits');
  }
  if (
    manifest.component?.wasiVersion !== '0.3.0'
    || manifest.component?.targetCarrier !== 'wasm32-wasip2'
    || manifest.component?.witPackage !== 'origintrail:semantic-runtime@0.1.0'
    || manifest.component?.asyncMode !== 'jspi'
    || !sameStrings(manifest.component?.imports, EXPECTED_COMPONENT_IMPORTS)
    || !sameStrings(manifest.component?.exports, EXPECTED_COMPONENT_EXPORTS)
    || manifest.component?.memory?.initialPages !== 256
    || manifest.component?.memory?.maximumPages !== 4096
    || manifest.component?.limits?.maxActiveExecutions !== 8
    || manifest.component?.limits?.maxOperationsPerExecution !== 10_000
    || manifest.component?.limits?.watchdogMs !== 10_000
    || manifest.component?.limits?.maxOldGenerationSizeMb !== 256
  ) {
    throw new Error('semantic runtime integrity manifest has an incompatible WASI 0.3 component');
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
  const componentWasmPath = safeArtifactPath(resolvedRoot, 'component/runtime.component.wasm');
  return {
    root: resolvedRoot,
    gluePath: safeArtifactPath(resolvedRoot, 'cjs/runtime.js'),
    wasmPath,
    wasmSha256: manifest.files['cjs/runtime_bg.wasm'].sha256,
    componentRoot: safeArtifactPath(resolvedRoot, 'component'),
    componentJsPath: safeArtifactPath(resolvedRoot, 'component/runtime.js'),
    componentWasmPath,
    componentSha256: manifest.files['component/runtime.component.wasm'].sha256,
    witSha256: manifest.files['component/wit/semantic-runtime.wit'].sha256,
    manifest,
  };
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.every((value) => typeof value === 'string')
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === expected[index]);
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
