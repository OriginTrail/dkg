import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreparedContentCache, resolvePreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';

const dirs: string[] = [];
async function fixture(limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-cache-')); dirs.push(directory);
  const options = resolvePreparedContentCacheConfig({ enabled: true, directory, ...limits })!;
  return { directory, options, cache: createPreparedContentCache(options), restart: () => createPreparedContentCache(options) };
}
const value = { body: new TextEncoder().encode('bounded immutable assertion'), plainBytes: 100 };
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('persistent prepared content', () => {
  it('atomically publishes bytes and manifest and reads them from a new cache instance', async () => {
    const f = await fixture(); await f.cache.put('graph/asset/version/root', value);
    expect(await f.restart().get('graph/asset/version/root')).toEqual(value);
    expect(await f.restart().get('graph/asset/version2/root')).toBeNull();
    const files = await readdir(f.directory); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.prepared$/);
    const first = (await f.cache.get('graph/asset/version/root'))!; first.body[0] = 0;
    expect(await f.cache.get('graph/asset/version/root')).toEqual(value);
  });
  it.each(['body', 'key', 'length', 'truncated', 'json', 'future'])('rejects a corrupt %s before returning any bytes', async kind => {
    const f = await fixture(); await f.cache.put('key', value);
    const file = join(f.directory, (await readdir(f.directory))[0]!);
    let bytes = await readFile(file); const length = bytes.readUInt32BE();
    if (kind === 'body') bytes[bytes.length - 1] ^= 1;
    if (kind === 'length') bytes.writeUInt32BE(0xffffffff);
    if (kind === 'truncated') bytes = bytes.subarray(0, 5);
    if (kind === 'json') bytes[4] = 0;
    if (kind === 'key' || kind === 'future') {
      const header = JSON.parse(bytes.subarray(4, 4 + length).toString());
      if (kind === 'key') header.key = 'wrong'; else header.createdAt += 86_400_000;
      const encoded = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
      bytes = Buffer.concat([prefix, encoded, bytes.subarray(4 + length)]);
    }
    await writeFile(file, bytes);
    expect(await f.restart().get('key')).toBeNull(); expect(await readdir(f.directory)).toEqual([]);
  });
  it('expires entries by creation time even if they are read frequently', async () => {
    const f = await fixture({ ttlMs: 1 }); await f.cache.put('key', value);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await f.restart().get('key')).toBeNull();
  });
  it('bounds entries and physical bytes across restarts and concurrent puts', async () => {
    const f = await fixture({ maxEntries: 2, maxBytes: 1024 });
    await Promise.all(['a', 'b', 'c', 'd'].map(key => f.cache.put(key, value)));
    expect((await readdir(f.directory)).length).toBe(2);
    expect(await f.restart().get('a')).toBeNull(); expect(await f.restart().get('d')).toEqual(value);
    const shrunk = createPreparedContentCache({ ...f.options, maxBytes: 1 });
    expect(await shrunk.get('d')).toBeNull(); expect(await readdir(f.directory)).toEqual([]);
    await shrunk.put('e', value); expect(await readdir(f.directory)).toEqual([]);
  });
  it('ignores unrelated files and refuses symlinked cache roots and entries', async () => {
    const f = await fixture(); await writeFile(join(f.directory, 'unrelated'), 'keep');
    await f.cache.put('../not-a-path', value);
    const file = (await readdir(f.directory)).find(name => name.endsWith('.prepared'))!;
    await rm(join(f.directory, file)); await symlink(join(f.directory, 'unrelated'), join(f.directory, file));
    expect(await f.restart().get('../not-a-path')).toBeNull();
    const link = join(f.directory, 'link'); await symlink(f.directory, link);
    expect(await createPreparedContentCache({ ...f.options, directory: link }).get('key')).toBeNull();
    expect(await readFile(join(f.directory, 'unrelated'), 'utf8')).toBe('keep');
  });
  it('fails open on unavailable IO without modifying other files', async () => {
    const f = await fixture(); const file = join(f.directory, 'file'); await writeFile(file, 'keep');
    const cache = createPreparedContentCache({ ...f.options, directory: file }, () => { throw new Error('logger unavailable'); });
    await expect(cache.put('key', value)).resolves.toBeUndefined(); expect(await cache.get('key')).toBeNull();
    expect(await readFile(file, 'utf8')).toBe('keep');
  });
  it('cleans only abandoned atomic-write files on reopen', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'a'.repeat(64) + '.prepared.12345678-1234-1234-1234-123456789abc.tmp'), 'interrupted');
    await writeFile(join(f.directory, 'unrelated.tmp'), 'keep');
    expect(await f.restart().get('none')).toBeNull();
    expect(await readdir(f.directory)).toEqual(['unrelated.tmp']);
  });
  it('validates operator limits and requires an owned absolute path', () => {
    expect(resolvePreparedContentCacheConfig(undefined)).toBeUndefined();
    expect(resolvePreparedContentCacheConfig({ enabled: false })).toBeUndefined();
    expect(resolvePreparedContentCacheConfig({ enabled: true }, '/owned')?.directory).toBe('/owned/prepared-content-v1');
    for (const config of [{ enabled: 'true' }, { enabled: true }, { enabled: true, directory: 'relative' },
      { enabled: true, directory: '/owned', maxEntries: 0 }, { enabled: true, directory: '/owned', maxBytes: 17 * 1024 ** 3 },
      { enabled: true, directory: '/owned', ttlMs: NaN }]) {
      expect(() => resolvePreparedContentCacheConfig(config as any)).toThrow();
    }
  });
});
