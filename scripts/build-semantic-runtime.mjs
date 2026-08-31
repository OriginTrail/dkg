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
const EXPECTED_RUST = '1.98.0';
const EXPECTED_WASM_BINDGEN = '0.2.127';
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
  const rustc = run('rustc', [`+${EXPECTED_RUST}`, '--version'], { capture: true });
  if (!rustc.startsWith(`rustc ${EXPECTED_RUST} `)) {
    throw new Error(`semantic-runtime: expected Rust ${EXPECTED_RUST}, got ${rustc}`);
  }
  const wasmBindgen = run('wasm-bindgen', ['--version'], { capture: true });
  if (wasmBindgen !== `wasm-bindgen ${EXPECTED_WASM_BINDGEN}`) {
    throw new Error(
      `semantic-runtime: expected wasm-bindgen ${EXPECTED_WASM_BINDGEN}, got ${wasmBindgen || 'missing'}`,
    );
  }
}

function buildInto(outputRoot) {
  verifyToolchain();
  const rustFlags = [
    '-C', `link-arg=--initial-memory=${INITIAL_MEMORY_PAGES * 65_536}`,
    '-C', `link-arg=--max-memory=${MAXIMUM_MEMORY_PAGES * 65_536}`,
    '-C', 'link-arg=--export-memory',
  ].join(' ');
  run(
    'cargo',
    [
      `+${EXPECTED_RUST}`,
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
  const manifest = {
    manifestVersion: 1,
    packageVersion: '10.0.14',
    rustCrateVersion: '0.1.0',
    abiVersion: 1,
    schemaVersion: 1,
    memory: limits,
    files: Object.fromEntries(
      artifactFiles.map((relative) => {
        const absolute = path.join(root, relative);
        return [relative, { sha256: sha256File(absolute), bytes: fs.statSync(absolute).size }];
      }),
    ),
  };
  fs.writeFileSync(path.join(root, 'integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function verifyGenerated(root = GENERATED_ROOT) {
  const manifestPath = path.join(root, 'integrity.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`semantic-runtime: integrity manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    manifest.manifestVersion !== 1
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
  return manifest;
}

function compareGenerated(expectedRoot, actualRoot) {
  const expectedFiles = generatedFiles(expectedRoot);
  const actualFiles = generatedFiles(actualRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `semantic-runtime: generated file set is stale\nexpected=${expectedFiles.join(',')}\nactual=${actualFiles.join(',')}`,
    );
  }
  for (const relative of expectedFiles) {
    const expected = fs.readFileSync(path.join(expectedRoot, relative));
    const actual = fs.readFileSync(path.join(actualRoot, relative));
    if (!expected.equals(actual)) {
      throw new Error(`semantic-runtime: generated artifact is stale: ${relative}`);
    }
  }
}

function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  const check = process.argv.includes('--check');
  if (verifyOnly && check) throw new Error('semantic-runtime: choose --verify-only or --check');
  if (verifyOnly) {
    verifyGenerated();
    console.log('semantic-runtime: generated Wasm integrity and ABI verified');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-semantic-runtime-'));
  try {
    buildInto(tempRoot);
    if (check) {
      compareGenerated(tempRoot, GENERATED_ROOT);
      console.log('semantic-runtime: generated artifacts match pinned Rust sources');
      return;
    }
    fs.mkdirSync(path.dirname(GENERATED_ROOT), { recursive: true });
    fs.rmSync(GENERATED_ROOT, { recursive: true, force: true });
    fs.renameSync(tempRoot, GENERATED_ROOT);
    verifyGenerated();
    console.log(`semantic-runtime: generated artifacts written to ${GENERATED_ROOT}`);
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
