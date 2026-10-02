#!/usr/bin/env node

// Cargo includes the native compiler host in proc-macro-dependent crate metadata
// (rust-lang/cargo#8140). Keep Cargo's cache filenames, but make embedded metadata
// and rlib object names (used to order fat LTO inputs) independent of the host.
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

function codegenOption(args, name) {
  const values = options(args, '-C');
  values.push(...args.filter((arg) => arg.startsWith('-C') && arg !== '-C').map((arg) => arg.slice(2)));
  return values.filter((value) => value.startsWith(`${name}=`)).map((value) => value.slice(name.length + 1));
}

function rlibAssert(condition, message) {
  if (!condition) throw new Error(`invalid portable rlib: ${message}`);
}

function rlibLeb(bytes, start, end) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < end && shift <= 28) {
    const byte = bytes[offset++];
    rlibAssert(shift < 28 || byte <= 15, 'integer exceeds u32');
    value += (byte & 127) * (2 ** shift);
    if (byte < 128) return { value, next: offset };
    shift += 7;
  }
  throw new Error('invalid portable rlib: truncated integer');
}

// This is the GNU archive + Wasm .rmeta-link format emitted by the pinned Rust
// compiler on both supported build hosts. Keep every member's size and offset,
// the symbol table, crate metadata, and all object/bitcode payloads unchanged.
export function portableRlibBytes(bytes, { crateName, extraFilename, metadata }) {
  rlibAssert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(crateName), 'invalid crate name');
  rlibAssert(/^-[a-f0-9]{16}$/.test(extraFilename), 'unexpected Cargo filename suffix');
  rlibAssert(/^[a-f0-9]{64}$/.test(metadata), 'invalid portable metadata');
  rlibAssert(bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n')), 'unsupported archive format');
  const members = [];
  let offset = 8;
  while (offset < bytes.length) {
    rlibAssert(offset + 60 <= bytes.length, 'truncated archive header');
    const header = bytes.subarray(offset, offset + 60);
    rlibAssert(header.subarray(58).equals(Buffer.from('`\n')), 'invalid archive header');
    const sizeText = header.subarray(48, 58).toString('ascii').trim();
    rlibAssert(/^\d+$/.test(sizeText), 'invalid archive member size');
    const size = Number(sizeText);
    const start = offset + 60;
    const end = start + size;
    rlibAssert(Number.isSafeInteger(size) && end <= bytes.length, 'truncated archive member');
    members.push({ rawName: header.subarray(0, 16).toString('ascii').trim(), start, end });
    offset = end + (size % 2);
    rlibAssert(offset <= bytes.length && (size % 2 === 0 || bytes[end] === 10), 'invalid archive padding');
  }
  const tables = members.filter((member) => member.rawName === '//');
  rlibAssert(tables.length <= 1, 'duplicate archive filename table');
  const table = tables[0];
  const byName = new Map();
  for (const member of members) {
    if (['/', '//', '/SYM64/'].includes(member.rawName)) continue;
    if (/^\/\d+$/.test(member.rawName)) {
      rlibAssert(table !== undefined, 'missing archive filename table');
      member.nameStart = table.start + Number(member.rawName.slice(1));
      rlibAssert(member.nameStart >= table.start && member.nameStart < table.end
        && (member.nameStart === table.start || bytes[member.nameStart - 1] === 10), 'invalid filename table offset');
      const end = bytes.indexOf(Buffer.from('/\n'), member.nameStart);
      rlibAssert(end >= member.nameStart && end + 2 <= table.end, 'unterminated archive filename');
      member.name = bytes.subarray(member.nameStart, end).toString('utf8');
    } else {
      rlibAssert(member.rawName.endsWith('/') && !member.rawName.startsWith('/'), 'unsupported archive filename format');
      member.name = member.rawName.slice(0, -1);
    }
    rlibAssert(!byName.has(member.name), 'duplicate archive filename');
    byName.set(member.name, member);
  }
  const linkIndex = byName.get('lib.rmeta-link');
  rlibAssert(linkIndex !== undefined, 'missing Rust LTO filename index');
  rlibAssert(bytes.subarray(linkIndex.start, linkIndex.start + 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), 'unsupported LTO index object');
  let indexSection;
  offset = linkIndex.start + 8;
  while (offset < linkIndex.end) {
    const kind = bytes[offset++];
    const size = rlibLeb(bytes, offset, linkIndex.end);
    const end = size.next + size.value;
    rlibAssert(end <= linkIndex.end, 'truncated LTO index section');
    if (kind === 0) {
      const name = rlibLeb(bytes, size.next, end);
      rlibAssert(name.next + name.value <= end, 'truncated LTO index section name');
      if (bytes.subarray(name.next, name.next + name.value).toString('utf8') === '.rmeta-link') {
        rlibAssert(indexSection === undefined, 'duplicate Rust LTO filename index');
        indexSection = { start: name.next + name.value, end };
      }
    }
    offset = end;
  }
  const magic = Buffer.from('rust-end-file');
  rlibAssert(indexSection !== undefined && bytes.subarray(indexSection.end - magic.length, indexSection.end).equals(magic), 'unsupported Rust LTO index encoding');
  const indexEnd = indexSection.end - magic.length;
  const count = rlibLeb(bytes, indexSection.start, indexEnd);
  offset = count.next;
  const edits = [];
  const indexed = new Set();
  const normalizedNames = new Set();
  const oldPrefix = `${crateName}${extraFilename}.`;
  const newPrefix = `${crateName}-${metadata.slice(0, 16)}.`;
  for (let item = 0; item < count.value; item++) {
    // rustc_serialize writes Vec<String> as length-prefixed UTF-8 strings,
    // each terminated by its invalid-UTF-8 0xC1 sentinel.
    const length = rlibLeb(bytes, offset, indexEnd);
    const end = length.next + length.value;
    rlibAssert(end < indexEnd && bytes[end] === 0xc1, 'invalid Rust LTO index filename');
    const name = bytes.subarray(length.next, end).toString('utf8');
    const member = byName.get(name);
    rlibAssert(member !== undefined && member.nameStart !== undefined && !indexed.has(name), 'Rust LTO index disagrees with archive members');
    rlibAssert((name.startsWith(oldPrefix) || name.startsWith(newPrefix)) && /^[a-zA-Z0-9_.-]+\.rcgu\.o$/.test(name), 'unexpected Rust object filename');
    const normalizedName = newPrefix + name.slice(oldPrefix.length);
    rlibAssert(!normalizedNames.has(normalizedName), 'duplicate normalized Rust object filename');
    indexed.add(name);
    normalizedNames.add(normalizedName);
    edits.push(member.nameStart, length.next);
    offset = end + 1;
  }
  for (const name of byName.keys()) {
    rlibAssert(!name.endsWith('.rcgu.o') || indexed.has(name), 'unindexed Rust object member');
  }
  const result = Buffer.from(bytes);
  for (const start of edits) result.write(newPrefix, start, 'utf8');
  return result;
}

export function normalizePortableRustcArchives(args, { cwd = process.cwd() } = {}) {
  const targets = options(args, '--target');
  if (targets.length !== 1 || !TARGETS.has(targets[0]) || args.some((arg) => arg === '--print' || arg.startsWith('--print='))) return;
  if (!options(args, '--crate-type').some((value) => value.split(',').some((type) => ['lib', 'rlib'].includes(type)))) return;
  const emits = options(args, '--emit').flatMap((value) => value.split(','));
  if (emits.length > 0 && !emits.some((value) => value === 'link' || value.startsWith('link='))) return;
  const suffixes = codegenOption(args, 'extra-filename');
  if (suffixes.length === 0 || (suffixes.length === 1 && suffixes[0] === '')) return; // Unsuffixed crate names are already portable.
  const names = options(args, '--crate-name');
  const metadata = codegenOption(args, 'metadata');
  const directories = options(args, '--out-dir');
  rlibAssert(suffixes.length === 1 && names.length === 1 && metadata.length === 1 && directories.length === 1
    && !args.includes('-o') && !emits.some((value) => value.startsWith('link=')), 'unsupported Cargo output arguments');
  const archive = path.resolve(cwd, directories[0], `lib${names[0]}${suffixes[0]}.rlib`);
  const original = fs.readFileSync(archive);
  const normalized = portableRlibBytes(original, { crateName: names[0], extraFilename: suffixes[0], metadata: metadata[0] });
  if (!original.equals(normalized)) fs.writeFileSync(archive, normalized);
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
    const portableArgs = portableRustcArguments(args);
    const result = spawnSync(compiler, portableArgs, { stdio: rustcStdio(compilerEnv), env: compilerEnv });
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else {
      if (result.status === 0) normalizePortableRustcArchives(portableArgs);
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(`semantic-runtime rustc: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
