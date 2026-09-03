#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const RUST_ROOT = path.join(REPO_ROOT, 'rust');
const GENERATED_ROOT = path.join(REPO_ROOT, 'packages', 'semantic-runtime', 'generated');
const ARTIFACT_LOCK_PATH = path.join(
  REPO_ROOT,
  'packages',
  'semantic-runtime',
  'artifact-lock.json',
);
const EXPECTED_RUST_TOOLCHAIN = 'nightly-2026-08-18';
const EXPECTED_RUST_VERSION = '1.100.0-nightly';
const EXPECTED_WASM_BINDGEN = '0.2.127';
const EXPECTED_JCO = '1.32.1';
const COMPONENT_WIT_PACKAGE = 'origintrail:semantic-runtime@0.1.0';
const COMPONENT_WASI_VERSION = '0.3.0';
const INITIAL_MEMORY_PAGES = 256;
const MAXIMUM_MEMORY_PAGES = 4096;

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function readWasmMemoryLimits(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) {
    throw new Error('semantic-runtime: malformed Wasm header');
  }
  const expectedHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (!expectedHeader.every((byte, index) => bytes[index] === byte)) {
    throw new Error('semantic-runtime: invalid Wasm magic/version');
  }
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const sectionSize = readLebU32(bytes, offset);
    offset = sectionSize.next;
    const sectionEnd = offset + sectionSize.value;
    if (sectionEnd > bytes.length) {
      throw new Error('semantic-runtime: truncated Wasm section');
    }
    if (sectionId !== 5) {
      offset = sectionEnd;
      continue;
    }
    const count = readLebU32(bytes, offset, sectionEnd);
    offset = count.next;
    if (count.value !== 1) {
      throw new Error(`semantic-runtime: expected one Wasm memory, found ${count.value}`);
    }
    const flags = readLebU32(bytes, offset, sectionEnd);
    offset = flags.next;
    if ((flags.value & ~0b001) !== 0) {
      throw new Error('semantic-runtime: shared or memory64 memory is outside the V1 ABI');
    }
    const initial = readLebU32(bytes, offset, sectionEnd);
    offset = initial.next;
    let maximum = null;
    if ((flags.value & 0b001) !== 0) {
      const decodedMaximum = readLebU32(bytes, offset, sectionEnd);
      maximum = decodedMaximum.value;
      offset = decodedMaximum.next;
    }
    if (offset !== sectionEnd) {
      throw new Error('semantic-runtime: malformed Wasm memory section');
    }
    return { initialPages: initial.value, maximumPages: maximum };
  }
  throw new Error('semantic-runtime: Wasm memory section not found');
}

function readLebU32(bytes, start, end = bytes.length) {
  let value = 0;
  let offset = start;
  for (let index = 0; index < 5 && offset < end; index += 1) {
    const byte = bytes[offset++];
    if (index === 4 && (byte & 0xf0) !== 0) {
      throw new Error('semantic-runtime: unsigned LEB128 exceeds u32');
    }
    value += (byte & 0x7f) * (2 ** (index * 7));
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  throw new Error('semantic-runtime: malformed unsigned LEB128');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${details}`);
  }
  return result.stdout?.trim() ?? '';
}

function verifyToolchain() {
  const rustc = run('rustc', [`+${EXPECTED_RUST_TOOLCHAIN}`, '--version'], { capture: true });
  if (!rustc.startsWith(`rustc ${EXPECTED_RUST_VERSION} `)) {
    throw new Error(
      `semantic-runtime: expected Rust ${EXPECTED_RUST_TOOLCHAIN} (${EXPECTED_RUST_VERSION}), got ${rustc}`,
    );
  }
  const wasmBindgen = run('wasm-bindgen', ['--version'], { capture: true });
  if (wasmBindgen !== `wasm-bindgen ${EXPECTED_WASM_BINDGEN}`) {
    throw new Error(
      `semantic-runtime: expected wasm-bindgen ${EXPECTED_WASM_BINDGEN}, got ${wasmBindgen || 'missing'}`,
    );
  }
  const jco = run(
    'pnpm',
    ['--filter', '@origintrail-official/dkg-semantic-runtime', 'exec', 'jco', '--version'],
    { capture: true },
  );
  if (jco !== EXPECTED_JCO) {
    throw new Error(`semantic-runtime: expected jco ${EXPECTED_JCO}, got ${jco || 'missing'}`);
  }
}

function buildInto(outputRoot) {
  verifyToolchain();
  run('cargo', [
    `+${EXPECTED_RUST_TOOLCHAIN}`,
    'build',
    '--manifest-path', path.join(RUST_ROOT, 'Cargo.toml'),
    '--package', 'dkg-safe-llm-runner',
    '--release',
    '--locked',
  ]);
  const rustFlags = [
    '-C', `link-arg=--initial-memory=${INITIAL_MEMORY_PAGES * 65_536}`,
    '-C', `link-arg=--max-memory=${MAXIMUM_MEMORY_PAGES * 65_536}`,
    '-C', 'link-arg=--export-memory',
  ].join(' ');
  run(
    'cargo',
    [
      `+${EXPECTED_RUST_TOOLCHAIN}`,
      'build',
      '--manifest-path', path.join(RUST_ROOT, 'Cargo.toml'),
      '--package', 'dkg-runtime-wasm',
      '--target', 'wasm32-unknown-unknown',
      '--release',
      '--locked',
    ],
    {
      env: {
        ...process.env,
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: rustFlags,
      },
    },
  );

  const inputWasm = path.join(
    RUST_ROOT,
    'target',
    'wasm32-unknown-unknown',
    'release',
    'dkg_runtime_wasm.wasm',
  );
  const cjsDir = path.join(outputRoot, 'cjs');
  fs.mkdirSync(cjsDir, { recursive: true });
  run('wasm-bindgen', [
    inputWasm,
    '--out-dir', cjsDir,
    '--out-name', 'runtime',
    '--target', 'nodejs',
    '--no-demangle',
  ]);
  fs.writeFileSync(path.join(cjsDir, 'package.json'), '{"type":"commonjs"}\n');

  const componentDir = path.join(outputRoot, 'component');
  fs.mkdirSync(path.join(componentDir, 'wit'), { recursive: true });
  run(
    'cargo',
    [
      `+${EXPECTED_RUST_TOOLCHAIN}`,
      'build',
      '--manifest-path', path.join(RUST_ROOT, 'Cargo.toml'),
      '--package', 'dkg-runtime-component',
      '--target', 'wasm32-wasip2',
      '--release',
      '--locked',
    ],
    {
      env: {
        ...process.env,
        CARGO_TARGET_WASM32_WASIP2_RUSTFLAGS: rustFlags,
      },
    },
  );
  const componentWasm = path.join(
    RUST_ROOT,
    'target',
    'wasm32-wasip2',
    'release',
    'dkg_runtime_component.wasm',
  );
  fs.copyFileSync(componentWasm, path.join(componentDir, 'runtime.component.wasm'));
  fs.copyFileSync(
    path.join(RUST_ROOT, 'crates', 'dkg-runtime-component', 'wit', 'semantic-runtime.wit'),
    path.join(componentDir, 'wit', 'semantic-runtime.wit'),
  );
  run('pnpm', [
    '--filter', '@origintrail-official/dkg-semantic-runtime',
    'exec', 'jco', 'transpile',
    path.join(componentDir, 'runtime.component.wasm'),
    '--out-dir', componentDir,
    '--name', 'runtime',
    '--async-mode', 'jspi',
    '--async-exports',
    'origintrail:semantic-runtime/executor@0.1.0#[method]execution.advance',
    '--async-imports',
    'origintrail:semantic-runtime/investigator@0.1.0#investigate',
    'origintrail:semantic-runtime/query-catalog@0.1.0#query',
    'origintrail:semantic-runtime/safe-llm@0.1.0#run',
    'origintrail:semantic-runtime/remote-execute@0.1.0#execute',
    '--instantiation', 'async',
    '--no-wasi-shim',
    '--strict',
    '--quiet',
  ]);
  writeIntegrityManifest(outputRoot);
  verifyGenerated(outputRoot);
}

function generatedFiles(root) {
  const files = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root);
  return files;
}

function writeIntegrityManifest(root) {
  const artifactFiles = generatedFiles(root).filter((file) => file !== 'integrity.json');
  const wasmPath = path.join(root, 'cjs', 'runtime_bg.wasm');
  const limits = readWasmMemoryLimits(fs.readFileSync(wasmPath));
  const componentCorePath = path.join(root, 'component', 'runtime.core.wasm');
  const componentLimits = readWasmMemoryLimits(fs.readFileSync(componentCorePath));
  const componentWorld = inspectComponentWorld(
    path.join(root, 'component', 'runtime.component.wasm'),
  );
  const manifest = {
    manifestVersion: 2,
    packageVersion: '10.0.14',
    rustCrateVersion: '0.1.0',
    abiVersion: 1,
    schemaVersion: 1,
    memory: limits,
    component: {
      wasiVersion: COMPONENT_WASI_VERSION,
      targetCarrier: 'wasm32-wasip2',
      witPackage: COMPONENT_WIT_PACKAGE,
      asyncMode: 'jspi',
      imports: componentWorld.imports,
      exports: componentWorld.exports,
      memory: componentLimits,
      limits: {
        maxActiveExecutions: 8,
        maxOperationsPerExecution: 10000,
        watchdogMs: 10000,
        maxOldGenerationSizeMb: 256,
      },
    },
    files: Object.fromEntries(
      artifactFiles.map((relative) => {
        const absolute = path.join(root, relative);
        return [relative, { sha256: sha256File(absolute), bytes: fs.statSync(absolute).size }];
      }),
    ),
  };
  fs.writeFileSync(path.join(root, 'integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function inspectComponentWorld(componentPath) {
  const output = run(
    'pnpm',
    [
      '--filter', '@origintrail-official/dkg-semantic-runtime',
      'exec', 'jco', 'wit', componentPath,
    ],
    { capture: true },
  );
  const imports = [...output.matchAll(/^\s*import\s+([^;]+);$/gm)]
    .map((match) => match[1])
    .sort();
  const exports = [...output.matchAll(/^\s*export\s+([^;]+);$/gm)]
    .map((match) => match[1])
    .sort();
  if (
    imports.length === 0
    || exports.length === 0
    || !exports.includes('origintrail:semantic-runtime/executor@0.1.0')
  ) {
    throw new Error('semantic-runtime: component WIT world is missing required imports or exports');
  }
  return { imports, exports };
}

export function verifyGenerated(root = GENERATED_ROOT) {
  const manifestPath = path.join(root, 'integrity.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`semantic-runtime: integrity manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    manifest.manifestVersion !== 2
    || manifest.abiVersion !== 1
    || manifest.schemaVersion !== 1
  ) {
    throw new Error('semantic-runtime: incompatible integrity manifest or ABI');
  }
  for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(absolute)) {
      throw new Error(`semantic-runtime: required generated file missing: ${relative}`);
    }
    const actualBytes = fs.statSync(absolute).size;
    const actualHash = sha256File(absolute);
    if (actualBytes !== expected.bytes || actualHash !== expected.sha256) {
      throw new Error(`semantic-runtime: integrity mismatch for ${relative}`);
    }
  }
  const wasmPath = path.join(root, 'cjs', 'runtime_bg.wasm');
  const limits = readWasmMemoryLimits(fs.readFileSync(wasmPath));
  if (
    limits.initialPages !== INITIAL_MEMORY_PAGES
    || limits.maximumPages !== MAXIMUM_MEMORY_PAGES
    || manifest.memory?.initialPages !== limits.initialPages
    || manifest.memory?.maximumPages !== limits.maximumPages
  ) {
    throw new Error(
      `semantic-runtime: expected Wasm memory ${INITIAL_MEMORY_PAGES}..${MAXIMUM_MEMORY_PAGES} pages, `
      + `got ${limits.initialPages}..${limits.maximumPages ?? 'unbounded'}`,
    );
  }

  const gluePath = path.join(root, 'cjs', 'runtime.js');
  const abiOutput = run(
    process.execPath,
    ['-e', `const runtime=require(${JSON.stringify(gluePath)});process.stdout.write(String(runtime.runtime_abi_version()))`],
    { capture: true },
  );
  if (abiOutput !== String((1 << 16) | 1)) {
    throw new Error(`semantic-runtime: generated module reported incompatible ABI ${abiOutput}`);
  }
  if (
    manifest.component?.wasiVersion !== COMPONENT_WASI_VERSION
    || manifest.component?.targetCarrier !== 'wasm32-wasip2'
    || manifest.component?.witPackage !== COMPONENT_WIT_PACKAGE
    || manifest.component?.asyncMode !== 'jspi'
  ) {
    throw new Error('semantic-runtime: incompatible WASI 0.3 component manifest');
  }
  const componentWorld = inspectComponentWorld(
    path.join(root, 'component', 'runtime.component.wasm'),
  );
  if (
    JSON.stringify(componentWorld.imports) !== JSON.stringify(manifest.component.imports)
    || JSON.stringify(componentWorld.exports) !== JSON.stringify(manifest.component.exports)
  ) {
    throw new Error('semantic-runtime: component import/export manifest mismatch');
  }
  const componentLimits = readWasmMemoryLimits(
    fs.readFileSync(path.join(root, 'component', 'runtime.core.wasm')),
  );
  if (
    componentLimits.initialPages !== INITIAL_MEMORY_PAGES
    || componentLimits.maximumPages !== MAXIMUM_MEMORY_PAGES
    || manifest.component.memory?.initialPages !== componentLimits.initialPages
    || manifest.component.memory?.maximumPages !== componentLimits.maximumPages
  ) {
    throw new Error('semantic-runtime: unexpected component core memory limits');
  }
  if (path.resolve(root) === path.resolve(GENERATED_ROOT)) verifyArtifactLock(root, manifest);
  return manifest;
}

function verifyArtifactLock(root, manifest) {
  if (!fs.existsSync(ARTIFACT_LOCK_PATH)) {
    throw new Error(`semantic-runtime: checked-in artifact lock missing at ${ARTIFACT_LOCK_PATH}`);
  }
  const lock = JSON.parse(fs.readFileSync(ARTIFACT_LOCK_PATH, 'utf8'));
  const integritySha256 = sha256File(path.join(root, 'integrity.json'));
  if (
    lock.lockVersion !== 1
    || lock.rustToolchain !== EXPECTED_RUST_TOOLCHAIN
    || lock.rustVersion !== EXPECTED_RUST_VERSION
    || lock.jcoVersion !== EXPECTED_JCO
    || lock.wasiVersion !== COMPONENT_WASI_VERSION
    || lock.targetCarrier !== 'wasm32-wasip2'
    || lock.witPackage !== COMPONENT_WIT_PACKAGE
    || lock.integritySha256 !== integritySha256
    || lock.componentSha256 !== manifest.files?.['component/runtime.component.wasm']?.sha256
    || lock.witSha256 !== manifest.files?.['component/wit/semantic-runtime.wit']?.sha256
  ) {
    throw new Error('semantic-runtime: generated artifacts differ from the checked-in artifact lock');
  }
}

function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (verifyOnly) {
    verifyGenerated();
    console.log('semantic-runtime: local Wasm integrity and ABI verified');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-semantic-runtime-'));
  try {
    buildInto(tempRoot);
    fs.mkdirSync(path.dirname(GENERATED_ROOT), { recursive: true });
    fs.rmSync(GENERATED_ROOT, { recursive: true, force: true });
    fs.renameSync(tempRoot, GENERATED_ROOT);
    verifyGenerated();
    console.log(`semantic-runtime: local artifacts built and verified at ${GENERATED_ROOT}`);
  } finally {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
