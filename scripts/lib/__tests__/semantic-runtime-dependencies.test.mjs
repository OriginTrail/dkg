import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';
import test from 'node:test';

// Resolve through JCO's real dependency graph, including the scoped pnpm override.
function dependencyRequire(from, name) {
  const manifest = from.resolve.paths(name)
    .map((directory) => join(directory, name, 'package.json')).find(existsSync);
  assert.ok(manifest, `Missing installed dependency: ${name}`);
  return createRequire(realpathSync(manifest));
}
const runtimeRequire = createRequire(new URL('../../../packages/semantic-runtime/package.json', import.meta.url));
const jcoRequire = dependencyRequire(runtimeRequire, '@bytecodealliance/jco');
const componentRequire = dependencyRequire(jcoRequire, '@bytecodealliance/componentize-js');
const wevalEntry = componentRequire.resolve('@bytecodealliance/weval');
const wevalRequire = createRequire(wevalEntry);
const xz = wevalRequire('@napi-rs/lzma/xz');

function tar(entries) {
  const blocks = [];
  for (const { name, contents = '', mode = 0o755, type = '0', link = '' } of entries) {
    const data = Buffer.from(contents);
    const header = Buffer.alloc(512);
    const octal = (value, offset, width) => header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset);
    header.write(name, 0, 100);
    octal(mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(' ', 148, 156);
    header.write(type, 156, 1);
    header.write(link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function fixture(t, entries) {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'dkg-weval-extraction-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Copy only the unchanged upstream loader. Its downloads and output stay in this
  // temporary directory; its dependencies are exactly the installed dependency tree.
  const loader = join(directory, 'index.mjs');
  await writeFile(loader, await readFile(wevalEntry));
  await symlink(join(dirname(wevalEntry), '../..'), join(directory, 'node_modules'), 'junction');
  const download = await xz.compress(tar(entries));
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /^https:\/\/github\.com\/bytecodealliance\/weval\/releases\/download\/v0\.4\.1\/weval-v0\.4\.1-.+\.tar\.xz$/);
    return new Response(download);
  });
  const { default: getWeval } = await import(pathToFileURL(loader).href);
  return { directory, getWeval };
}

// The real Unix downloader covers both the original CommonJS tar plugin and the
// replacement ESM extractor. CI runs this on Linux; the same path runs on macOS.
test('weval extracts its binary with strip/filter and removes privileged mode bits', async (t) => {
  const { directory, getWeval } = await fixture(t, [
    { name: 'release/weval', contents: 'fixture binary', mode: 0o6755 },
    { name: 'release/README', contents: 'must not be extracted' },
  ]);
  const binary = await getWeval();
  assert.ok(binary.startsWith(directory));
  assert.equal(await readFile(binary, 'utf8'), 'fixture binary');
  assert.equal(existsSync(join(dirname(binary), 'README')), false);
  assert.equal((await stat(binary)).mode & 0o7000, 0);
  assert.equal((await stat(binary)).mode & 0o111, 0o111 & ~process.umask());
});

test('weval rejects archive paths escaping into a sibling directory', async (t) => {
  const { directory, getWeval } = await fixture(t, [
    { name: '../../outside/weval', contents: 'must not be written' },
  ]);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await assert.rejects(getWeval(), /outside (?:the )?output/);
  assert.equal(existsSync(join(outside, 'weval')), false);
});

for (const [kind, type] of [['symbolic', '2'], ['hard', '1']]) {
  test(`weval rejects ${kind} links to files outside the extraction directory`, async (t) => {
    const { directory, getWeval } = await fixture(t, [
      { name: 'release/weval', type, link: '../outside' },
    ]);
    const outside = join(directory, 'outside');
    await writeFile(outside, 'fixture sentinel');
    await assert.rejects(getWeval(), /outside (?:the )?output/);
    assert.equal(await readFile(outside, 'utf8'), 'fixture sentinel');
  });
}

function zip(name, contents) {
  const filename = Buffer.from(name);
  const data = Buffer.from(contents);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('replacement extractor supports weval Windows ZIP plugin and options', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-weval-zip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { default: decompress } = await import(pathToFileURL(wevalRequire.resolve('decompress')).href);
  const plugins = [wevalRequire('decompress-unzip')(), wevalRequire('decompress-tar')()];
  await decompress(zip('release/weval.exe', 'fixture binary'), directory, {
    strip: 1,
    plugins,
    filter: (file) => parse(file.path).base === 'weval.exe',
  });
  assert.equal(await readFile(join(directory, 'weval.exe'), 'utf8'), 'fixture binary');
});
