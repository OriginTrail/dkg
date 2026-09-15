#!/usr/bin/env node

// Cargo includes the native compiler host in proc-macro-dependent crate metadata
// (rust-lang/cargo#8140). Keep Cargo's cache filenames, but make the metadata
// embedded in our two portable Wasm targets describe their source and ABI only.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SEMANTIC_RUST_TOOLCHAIN = 'nightly-2026-08-18';
export const SEMANTIC_RUST_VERSION = '1.100.0-nightly';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../rust');
const TARGETS = new Set(['wasm32-unknown-unknown', 'wasm32-wasip2']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function options(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === option) {
      if (index + 1 >= args.length) throw new Error(`missing ${option} value`);
      values.push(args[++index]);
    } else if (args[index].startsWith(`${option}=`)) {
      values.push(args[index].slice(option.length + 1));
    }
  }
  return values;
}

function lockPackages(lock) {
  return lock.split(/^\[\[package\]\]\s*$/m).slice(1).map((block) => {
    const record = {};
    for (const name of ['name', 'version', 'source', 'checksum']) {
      const value = new RegExp(`^${name} = ("(?:[^"\\\\]|\\\\.)*")$`, 'm').exec(block)?.[1];
      if (value !== undefined) record[name] = JSON.parse(value);
    }
    if (!record.name || !record.version) throw new Error('invalid Cargo.lock package identity');
    return record;
  });
}

function relativeWithin(root, filename) {
  const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function portableRustcArguments(args, {
  env = process.env,
  cwd = process.cwd(),
  workspaceRoot = WORKSPACE_ROOT,
} = {}) {
  const target = options(args, '--target');
  // Cargo's rustc probes and all native build scripts/procedural macros retain
  // their original metadata and normal host-specific cache behavior.
  if (target.length === 0 || !TARGETS.has(target[0]) || args.some((arg) => arg === '--print' || arg.startsWith('--print='))) return args;
  if (target.length !== 1) throw new Error('expected exactly one Wasm target');
  const name = env.CARGO_PKG_NAME;
  const version = env.CARGO_PKG_VERSION;
  if (!name || !version || !env.CARGO_MANIFEST_DIR) throw new Error('missing Cargo package identity for Wasm compilation');
  const root = fs.realpathSync(workspaceRoot);
  const manifestRoot = fs.realpathSync(env.CARGO_MANIFEST_DIR);
  const lockBytes = fs.readFileSync(path.join(root, 'Cargo.lock'));
  const packages = lockPackages(lockBytes.toString('utf8')).filter((entry) => entry.name === name && entry.version === version);
  let source;
  const workspaceRelative = relativeWithin(root, manifestRoot);
  if (workspaceRelative !== null) {
    if (packages.filter((entry) => entry.source === undefined).length !== 1) throw new Error(`ambiguous workspace identity for ${name}@${version}`);
    source = `workspace:${workspaceRelative}`;
  } else {
    // Cargo verifies registry archives against this lock checksum. Standard
    // extracted registry sources do not contain cargo-vendor checksum files.
    const registryRoot = path.dirname(path.dirname(path.dirname(manifestRoot)));
    if (path.basename(registryRoot) !== 'registry'
      || path.basename(path.dirname(path.dirname(manifestRoot))) !== 'src'
      || path.basename(manifestRoot) !== `${name}-${version}`) {
      throw new Error(`unsupported non-workspace source for ${name}@${version}`);
    }
    const matches = packages.filter((entry) => entry.source?.startsWith('registry+') && /^[0-9a-f]{64}$/.test(entry.checksum ?? ''));
    if (matches.length !== 1) throw new Error(`ambiguous registry identity for ${name}@${version}`);
    source = `${matches[0].source}#${matches[0].checksum}`;
  }
  const sourceArgs = args.filter((arg) => !arg.startsWith('-') && arg.endsWith('.rs'));
  if (sourceArgs.length !== 1) throw new Error('expected exactly one Rust source input');
  const sourceRelative = relativeWithin(manifestRoot, fs.realpathSync(path.resolve(cwd, sourceArgs[0])));
  if (sourceRelative === null) throw new Error('Rust source input is outside its Cargo package');
  const crateNames = options(args, '--crate-name');
  const crateTypes = options(args, '--crate-type').flatMap((value) => value.split(',')).sort();
  if (crateNames.length !== 1 || crateTypes.length === 0) throw new Error('missing Rust crate identity');
  const codegen = [];
  const metadataIndexes = [];
  for (let index = 0; index < args.length; index++) {
    let value;
    let valueIndex = index;
    let compact = false;
    if (args[index] === '-C') { valueIndex = ++index; value = args[index]; }
    else if (args[index].startsWith('-C')) { value = args[index].slice(2); compact = true; }
    else continue;
    if (value === undefined) throw new Error('missing -C value');
    const key = value.split('=', 1)[0];
    if (key === 'metadata') metadataIndexes.push({ index: valueIndex, compact });
    else if (!['extra-filename', 'incremental'].includes(key)) {
      // These Wasm builds use value-only codegen settings. Refuse an accidental
      // absolute host path rather than hashing it into portable crate identity.
      if (value.includes(root) || value.includes(manifestRoot)) throw new Error(`host path in Wasm codegen option ${key}`);
      codegen.push(value);
    }
  }
  if (metadataIndexes.length !== 1) throw new Error('expected exactly one Cargo metadata flag');
  const metadata = sha256(JSON.stringify({
    version: 1, toolchain: SEMANTIC_RUST_TOOLCHAIN, rustVersion: SEMANTIC_RUST_VERSION,
    lock: sha256(lockBytes), package: { name, version, source }, input: sourceRelative,
    crate: crateNames[0], crateTypes, target: target[0],
    edition: options(args, '--edition'), cfg: options(args, '--cfg').sort(), codegen,
  }));
  const rewritten = [...args];
  const location = metadataIndexes[0];
  rewritten[location.index] = `${location.compact ? '-C' : ''}metadata=${metadata}`;
  return rewritten;
}

export function rustcStdio(env = process.env, validateDescriptor = (fd) => fs.fstatSync(fd)) {
  const descriptors = new Set();
  for (const match of (env.CARGO_MAKEFLAGS ?? '').matchAll(/(?:^|\s)--jobserver-(?:fds|auth)=(\d+),(\d+)(?=\s|$)/g)) {
    for (const value of match.slice(1)) {
      const fd = Number(value);
      if (!Number.isSafeInteger(fd) || fd > 4096) throw new Error('unsupported Cargo jobserver descriptor');
      validateDescriptor(fd);
      descriptors.add(fd);
    }
  }
  if (descriptors.size === 0) return 'inherit'; // FIFO/named jobservers need no inherited descriptor.
  const stdio = Array(Math.max(2, ...descriptors) + 1).fill('ignore');
  stdio[0] = 'inherit'; stdio[1] = 'inherit'; stdio[2] = 'inherit';
  for (const fd of descriptors) stdio[fd] = fd;
  return stdio;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const [compiler, ...args] = process.argv.slice(2);
    if (!compiler) throw new Error('missing rustc executable');
    const compilerEnv = { ...process.env };
    if (process.platform === 'darwin') {
      // macOS strips DYLD_* while launching the /usr/bin/env shebang. Restore
      // the selected toolchain's own library directory for rust-lld/libLLVM.
      const compilerLib = path.resolve(path.dirname(fs.realpathSync(compiler)), '../lib');
      compilerEnv.DYLD_LIBRARY_PATH = [compilerLib, compilerEnv.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    }
    const result = spawnSync(compiler, portableRustcArguments(args), { stdio: rustcStdio(compilerEnv), env: compilerEnv });
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`semantic-runtime rustc: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
