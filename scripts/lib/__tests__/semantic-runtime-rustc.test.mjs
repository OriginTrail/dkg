import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { portableRustcArguments, rustcStdio } from '../../semantic-runtime-rustc.mjs';
import { assertPortableBuildEnvironment } from '../../build-semantic-runtime.mjs';

function fixture(t, registry = false) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rustc-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporary, 'project', 'rust');
  const manifest = registry
    ? path.join(temporary, 'cargo', 'registry', 'src', 'registry-cache-id', 'fixture-1.0.0')
    : path.join(workspaceRoot, 'crates', 'fixture');
  fs.mkdirSync(path.join(manifest, 'src'), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const source = path.join(manifest, 'src', 'lib.rs');
  fs.writeFileSync(source, 'pub fn example() {}\n');
  const sourceEntry = registry ? `source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${'a'.repeat(64)}"\n` : '';
  fs.writeFileSync(path.join(workspaceRoot, 'Cargo.lock'), `version = 4\n\n[[package]]\nname = "fixture"\nversion = "1.0.0"\n${sourceEntry}`);
  const env = { CARGO_PKG_NAME: 'fixture', CARGO_PKG_VERSION: '1.0.0', CARGO_MANIFEST_DIR: manifest };
  const args = ['--crate-name', 'fixture', '--edition=2024', source, '--crate-type', 'lib', '--target', 'wasm32-unknown-unknown', '-C', 'opt-level=s', '-C', 'metadata=host-dependent', '-C', 'extra-filename=-host-cache', '--cfg', 'feature="std"', '--out-dir', path.join(temporary, 'out')];
  return { args, options: { env, workspaceRoot, cwd: workspaceRoot }, manifest, workspaceRoot };
}
const metadata = (args) => args.find((arg) => arg.startsWith('metadata=') || arg.startsWith('-Cmetadata='));

test('portable crate metadata ignores host paths/disambiguators while preserving Cargo cache arguments', (t) => {
  for (const registry of [false, true]) {
    const first = fixture(t, registry);
    const second = fixture(t, registry);
    second.args[second.args.indexOf('metadata=host-dependent')] = 'metadata=other-host';
    second.args[second.args.indexOf('extra-filename=-host-cache')] = 'extra-filename=-other-cache';
    const left = portableRustcArguments(first.args, first.options);
    const right = portableRustcArguments(second.args, second.options);
    assert.match(metadata(left), /^metadata=[a-f0-9]{64}$/);
    assert.equal(metadata(left), metadata(right));
    assert.deepEqual(left.filter((arg) => !arg.startsWith('metadata=')), first.args.filter((arg) => !arg.startsWith('metadata=')));
    assert.ok(right.includes('extra-filename=-other-cache'));
  }
});

test('native compilers and Cargo probes pass through without a workspace or package identity', () => {
  for (const args of [[], ['--version'], ['--target', 'aarch64-apple-darwin'], ['--target', 'wasm32-wasip2', '--print=file-names']]) {
    assert.equal(portableRustcArguments(args, { env: {}, workspaceRoot: '/not-present' }), args);
  }
});

test('metadata binds target, crate type, feature cfg, codegen order, and compiler recipe', (t) => {
  const current = fixture(t);
  const baseline = metadata(portableRustcArguments(current.args, current.options));
  for (const args of [
    current.args.map((arg) => arg === 'wasm32-unknown-unknown' ? 'wasm32-wasip2' : arg),
    current.args.map((arg) => arg === 'lib' ? 'cdylib' : arg),
    [...current.args, '--cfg', 'feature="extra"'],
    [...current.args, '-C', 'opt-level=3'],
    [...current.args, '--cfg', 'dkg_semantic_runtime_build_recipe="recipe-2"'],
  ]) assert.notEqual(metadata(portableRustcArguments(args, current.options)), baseline);
  const first = [...current.args, '--cfg', 'feature="extra"', '--cfg', 'feature="more"'];
  const reordered = [...current.args, '--cfg', 'feature="more"', '--cfg', 'feature="extra"'];
  assert.equal(metadata(portableRustcArguments(first, current.options)), metadata(portableRustcArguments(reordered, current.options)));
  assert.notEqual(
    metadata(portableRustcArguments([...current.args, '-C', 'opt-level=2', '-C', 'opt-level=3'], current.options)),
    metadata(portableRustcArguments([...current.args, '-C', 'opt-level=3', '-C', 'opt-level=2'], current.options)),
  );
});

test('metadata changes with locked dependencies and distinguishes registry from workspace packages', (t) => {
  const current = fixture(t);
  const baseline = metadata(portableRustcArguments(current.args, current.options));
  fs.appendFileSync(path.join(current.workspaceRoot, 'Cargo.lock'), '\n[[package]]\nname = "another-dependency"\nversion = "2.0.0"\n');
  assert.notEqual(metadata(portableRustcArguments(current.args, current.options)), baseline);
  const registry = fixture(t, true);
  assert.notEqual(metadata(portableRustcArguments(registry.args, registry.options)), baseline);
});

test('supports compact metadata flags without modifying output filenames or incremental caches', (t) => {
  const current = fixture(t);
  const index = current.args.indexOf('metadata=host-dependent');
  current.args.splice(index - 1, 2, '-Cmetadata=old');
  current.args.push('-Cincremental=/host/cache');
  const actual = portableRustcArguments(current.args, current.options);
  assert.match(metadata(actual), /^-Cmetadata=[a-f0-9]{64}$/);
  assert.ok(actual.includes('-Cincremental=/host/cache'));
  assert.ok(actual.includes('extra-filename=-host-cache'));
});

test('refuses missing, ambiguous, or out-of-package Wasm identity', (t) => {
  const current = fixture(t);
  assert.throws(() => portableRustcArguments(current.args, { ...current.options, env: {} }), /missing Cargo package identity/);
  assert.throws(() => portableRustcArguments(current.args.filter((arg) => arg !== 'metadata=host-dependent'), current.options), /exactly one Cargo metadata/);
  assert.throws(() => portableRustcArguments([...current.args, '-Cmetadata=second'], current.options), /exactly one Cargo metadata/);
  const other = path.join(current.workspaceRoot, 'outside.rs');
  fs.writeFileSync(other, 'pub fn outside() {}');
  assert.throws(() => portableRustcArguments(current.args.map((arg) => arg.endsWith('lib.rs') ? other : arg), current.options), /outside its Cargo package/);
  const registry = fixture(t, true);
  fs.appendFileSync(path.join(registry.workspaceRoot, 'Cargo.lock'), `\n[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "registry+https://other.registry/index"\nchecksum = "${'b'.repeat(64)}"\n`);
  assert.throws(() => portableRustcArguments(registry.args, registry.options), /ambiguous registry identity/);
});

test('rejects ambient flags that would override the pinned cache recipe and memory bounds', () => {
  assert.doesNotThrow(() => assertPortableBuildEnvironment({}));
  for (const variable of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) {
    for (const value of ['', '-Copt-level=0']) assert.throws(() => assertPortableBuildEnvironment({ [variable]: value }), /ambient Rust flags/);
  }
  for (const variable of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
    assert.throws(() => assertPortableBuildEnvironment({ [variable]: '/another-wrapper' }), /external Rust wrappers/);
  }
});


test('forwards Cargo jobserver descriptors while leaving FIFO transport unchanged', () => {
  const checked = [];
  assert.deepEqual(rustcStdio({ CARGO_MAKEFLAGS: '-j --jobserver-fds=3,5 --jobserver-auth=3,5' }, (fd) => checked.push(fd)), ['inherit', 'inherit', 'inherit', 3, 'ignore', 5]);
  assert.deepEqual(new Set(checked), new Set([3, 5]));
  assert.equal(rustcStdio({ CARGO_MAKEFLAGS: '--jobserver-auth=fifo:/tmp/cargo-jobserver' }), 'inherit');
  assert.throws(() => rustcStdio({ CARGO_MAKEFLAGS: '--jobserver-auth=3,5' }, () => { throw new Error('closed descriptor'); }), /closed descriptor/);
  assert.throws(() => rustcStdio({ CARGO_MAKEFLAGS: '--jobserver-auth=999999,5' }), /unsupported Cargo jobserver descriptor/);
});
