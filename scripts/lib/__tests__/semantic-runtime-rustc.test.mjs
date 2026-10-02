import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizePortableRustcArchives, portableRlibBytes, portableRustcArguments, rustcStdio } from '../../semantic-runtime-rustc.mjs';
import { assertPortableBuildEnvironment, portableBuildRecipe } from '../../build-semantic-runtime.mjs';

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


test('the Cargo cache recipe changes for both wrapper implementation and full lock graph', () => {
  const baseline = portableBuildRecipe(Buffer.from('wrapper-v1'), Buffer.from('lock-v1'));
  assert.equal(portableBuildRecipe(Buffer.from('wrapper-v1'), Buffer.from('lock-v1')), baseline);
  assert.notEqual(portableBuildRecipe(Buffer.from('wrapper-v2'), Buffer.from('lock-v1')), baseline);
  assert.notEqual(portableBuildRecipe(Buffer.from('wrapper-v1'), Buffer.from('lock-v2')), baseline);
});

function archiveFixture(suffix = '-1111111111111111', names = [0, 1].map((index) => `fixture${suffix}.fixture.1234567890abcdef-cgu.${index}.rcgu.o`)) {
  const leb = (value) => {
    const bytes = [];
    do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
  };
  const strings = names.map((name) => Buffer.concat([leb(name.length), Buffer.from(name), Buffer.from([0xc1])]));
  const sectionName = Buffer.from('.rmeta-link');
  const index = Buffer.concat([leb(sectionName.length), sectionName, leb(names.length), ...strings, Buffer.from([0]), Buffer.from('rust-end-file')]);
  const indexObject = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0]), leb(index.length), index]);
  const chunks = [Buffer.from('!<arch>\n')];
  const members = [];
  let size = 8;
  const member = (name, data) => {
    const header = `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(data.length).padEnd(10)}\x60\n`;
    members.push({ name, start: size + 60, end: size + 60 + data.length });
    chunks.push(Buffer.from(header), data);
    size += 60 + data.length;
    if (data.length % 2) { chunks.push(Buffer.from('\n')); size++; }
  };
  member('/', Buffer.from('symbol-table-payload'));
  member('//', Buffer.from(`${names.join('/\n')}/\n`));
  member('lib.rmeta/', Buffer.from('metadata payload must stay intact'));
  member('lib.rmeta-link/', indexObject);
  for (const [index, name] of names.entries()) {
    const tableOffset = names.slice(0, index).reduce((sum, entry) => sum + entry.length + 2, 0);
    // A matching-looking name in object bytes must never be rewritten.
    member(`/${tableOffset}`, Buffer.from(`opaque bitcode ${index}: fixture-1111111111111111.fixture.1234567890abcdef-cgu.0.rcgu.o`));
    assert.ok(name.endsWith('.rcgu.o'));
  }
  member('native-helper.o/', Buffer.from('bundled native object'));
  return { bytes: Buffer.concat(chunks), members, names };
}

const archiveOptions = { crateName: 'fixture', extraFilename: '-1111111111111111', metadata: 'abcdef0123456789'.repeat(4) };

test('canonical rlib names remove host LTO ordering differences without changing object or metadata payloads', () => {
  const first = archiveFixture();
  const second = archiveFixture('-2222222222222222');
  const canonical = portableRlibBytes(first.bytes, archiveOptions);
  assert.deepEqual(canonical, portableRlibBytes(second.bytes, { ...archiveOptions, extraFilename: '-2222222222222222' }));
  assert.equal(canonical.length, first.bytes.length);
  const editable = first.members.filter(({ name }) => ['//', 'lib.rmeta-link/'].includes(name));
  for (let index = 0; index < canonical.length; index++) {
    if (canonical[index] !== first.bytes[index]) {
      assert.ok(editable.some(({ start, end }) => index >= start && index < end), `unexpected payload edit at ${index}`);
    }
  }
  for (const { name, start, end } of first.members) {
    if (!['//', 'lib.rmeta-link/'].includes(name)) assert.deepEqual(canonical.subarray(start, end), first.bytes.subarray(start, end), name);
  }
  assert.deepEqual(portableRlibBytes(canonical, archiveOptions), canonical);
});

test('rlib normalization rejects corrupt archives and inconsistent LTO indexes before producing output', () => {
  const { bytes, members, names } = archiveFixture();
  assert.throws(() => portableRlibBytes(bytes.subarray(0, 7), archiveOptions), /archive format/);
  assert.throws(() => portableRlibBytes(bytes.subarray(0, bytes.length - 4), archiveOptions), /truncated archive/);
  assert.throws(() => portableRlibBytes(bytes, { ...archiveOptions, extraFilename: '-unknown' }), /filename suffix/);
  assert.throws(() => portableRlibBytes(bytes, { ...archiveOptions, metadata: 'bad' }), /portable metadata/);
  const invalidHeader = Buffer.from(bytes); invalidHeader[66] = 0;
  assert.throws(() => portableRlibBytes(invalidHeader, archiveOptions), /archive header/);
  const index = members.find(({ name }) => name === 'lib.rmeta-link/');
  const missingIndex = Buffer.from(bytes); missingIndex.write('xib.rmeta-link/', index.start - 60);
  assert.throws(() => portableRlibBytes(missingIndex, archiveOptions), /missing Rust LTO/);
  const mismatch = Buffer.from(bytes); mismatch[bytes.indexOf(names[0], index.start)] = 'x'.charCodeAt(0);
  assert.throws(() => portableRlibBytes(mismatch, archiveOptions), /disagrees with archive/);
  const invalidSentinel = Buffer.from(bytes); invalidSentinel[bytes.indexOf(names[0], index.start) + names[0].length] = 0;
  assert.throws(() => portableRlibBytes(invalidSentinel, archiveOptions), /index filename/);
  const invalidTableOffset = Buffer.from(bytes);
  const object = members.find(({ name }) => name === '/0');
  invalidTableOffset.write('/1 ', object.start - 60);
  assert.throws(() => portableRlibBytes(invalidTableOffset, archiveOptions), /table offset/);
  const table = members.find(({ name }) => name === '//');
  const terminatorInPadding = Buffer.from(bytes);
  terminatorInPadding.write(String(table.end - table.start - 1).padEnd(10), table.start - 12);
  assert.throws(() => portableRlibBytes(terminatorInPadding, archiveOptions), /unterminated archive filename/);
  const collision = archiveFixture(undefined, [names[0], names[0].replace(archiveOptions.extraFilename, `-${archiveOptions.metadata.slice(0, 16)}`)]);
  assert.throws(() => portableRlibBytes(collision.bytes, archiveOptions), /duplicate normalized Rust object filename/);
  assert.deepEqual(bytes, archiveFixture().bytes, 'validation must not mutate its input');
});

test('post-compile normalization preserves Cargo output filenames and dep-info for both Wasm targets', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rlib-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'out');
  fs.mkdirSync(directory);
  const filename = `libfixture${archiveOptions.extraFilename}.rlib`;
  const depInfo = 'fixture.d: source.rs\n';
  fs.writeFileSync(path.join(directory, 'fixture.d'), depInfo);
  for (const target of ['wasm32-unknown-unknown', 'wasm32-wasip2']) {
    const { bytes } = archiveFixture();
    fs.writeFileSync(path.join(directory, filename), bytes);
    normalizePortableRustcArchives([
      '--target', target, '--crate-name=fixture', '--crate-type', 'cdylib,rlib',
      '--emit=dep-info,metadata,link', '--out-dir', 'out',
      '-C', `extra-filename=${archiveOptions.extraFilename}`, `-Cmetadata=${archiveOptions.metadata}`,
    ], { cwd: temporary });
    assert.deepEqual(fs.readFileSync(path.join(directory, filename)), portableRlibBytes(bytes, archiveOptions));
    assert.equal(fs.readFileSync(path.join(directory, 'fixture.d'), 'utf8'), depInfo);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['fixture.d', filename].sort());
  }
});

test('native compilations, probes, non-link emits and unsuffixed outputs need no archive postprocessing', () => {
  const common = ['--target', 'wasm32-wasip2', '--crate-type=rlib'];
  for (const args of [
    [], ['--target', 'aarch64-apple-darwin', '--crate-type=rlib'],
    [...common, '--print=file-names'], [...common, '--emit=dep-info,metadata'],
    ['--target', 'wasm32-wasip2', '--crate-type=cdylib'],
    common, [...common, '-Cextra-filename='],
  ]) assert.doesNotThrow(() => normalizePortableRustcArchives(args, { cwd: '/not-present' }));
});
