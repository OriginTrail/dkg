import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, open, readdir, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreparedContentCache, resolvePreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename), unlink: vi.fn(fs.unlink) };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockReset().mockImplementation(real.open);
  vi.mocked(rename).mockReset().mockImplementation(real.rename);
  vi.mocked(unlink).mockReset().mockImplementation(real.unlink);
  for (const stop of cleanup.splice(0)) await stop();
});
const value = { body: new Uint8Array([1, 2, 3]), plainBytes: 3 };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-publish-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const options = resolvePreparedContentCacheConfig({ enabled: true, directory, maxEntries: 2, maxBytes: 4096 })!;
  const cache = createPreparedContentCache(options);
  await cache.put('a', value); await cache.put('b', value);
  return { cache, directory, options };
}
it.each(['open', 'writeFile', 'sync'] as const)('preserves retained entries when temporary %s fails', async phase => {
  const f = await fixture();
  const error = Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' });
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  if (phase === 'open') vi.mocked(open).mockRejectedValueOnce(error);
  else vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await real.open(...args);
    vi.spyOn(handle, phase).mockRejectedValueOnce(error);
    return handle;
  });
  await expect(f.cache.put('b', { body: new Uint8Array([9]), plainBytes: 1 })).resolves.toBeUndefined();
  expect(await f.cache.get('a')).toEqual(value);
  expect(await f.cache.get('b')).toEqual(value);
  expect((await readdir(f.directory)).every(name => name.endsWith('.prepared'))).toBe(true);
  const reopened = createPreparedContentCache(f.options);
  expect(await reopened.get('a')).toEqual(value);
  expect(await reopened.get('b')).toEqual(value);
});
it('replaces an existing key at the entry limit without evicting a different entry', async () => {
  const f = await fixture();
  const replacement = { body: new Uint8Array([9]), plainBytes: 1 };
  await f.cache.put('b', replacement);
  expect(await f.cache.get('a')).toEqual(value);
  expect(await f.cache.get('b')).toEqual(replacement);
  const sizes = await Promise.all((await readdir(f.directory)).map(async file => (await stat(join(f.directory, file))).size));
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(f.options.maxBytes);
});
it('keeps admitting newer assertions at the byte limit without exceeding physical bytes during preparation', async () => {
  const f = await fixture();
  const options = { ...f.options, maxBytes: 1024, maxEntries: 100 };
  let cache = createPreparedContentCache(options);
  const large = { body: new Uint8Array(300), plainBytes: 300 };
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    if (args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...data) => {
        await write(...data);
        const sizes = await Promise.all((await readdir(f.directory)).map(async name => (await stat(join(f.directory, name))).size));
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(options.maxBytes);
      });
    }
    return handle;
  });
  for (const key of ['new-a', 'new-b', 'new-c']) {
    await cache.put(key, large);
    cache = createPreparedContentCache(options);
    expect(await cache.get(key)).toEqual(large);
  }
  expect(await cache.get('new-a')).toBeNull();
});
it.each([false, true])('reclaims expired unreachable keys without looking them up (restart=%s)', async restart => {
  const createdAt = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(createdAt);
  const f = await fixture();
  const options = { ...f.options, ttlMs: 1000 };
  let cache = createPreparedContentCache(options);
  await cache.put('obsolete-root', value);
  vi.setSystemTime(createdAt + 1100);
  if (restart) cache = createPreparedContentCache(options);
  await cache.put('new-root', value);
  expect(await readdir(f.directory)).toHaveLength(1);
  expect(await cache.get('new-root')).toEqual(value);
});

it('preserves all retained entries when publishing a new key fails at rename', async () => {
  const f = await fixture();
  vi.mocked(rename).mockRejectedValueOnce(new Error('injected rename failure'));
  await f.cache.put('c', value);
  expect(await f.cache.get('a')).toEqual(value);
  expect(await f.cache.get('b')).toEqual(value);
  expect(await f.cache.get('c')).toBeNull();
  expect(await readdir(f.directory)).toHaveLength(2);
});
it('recovers post-publication eviction failure before admitting another write', async () => {
  const f = await fixture();
  vi.mocked(unlink).mockRejectedValueOnce(new Error('injected eviction failure'));
  await f.cache.put('c', value);
  expect(await readdir(f.directory)).toHaveLength(3);
  await f.cache.put('d', value);
  expect(await readdir(f.directory)).toHaveLength(2);
  expect(await f.cache.get('c')).toEqual(value);
  expect(await f.cache.get('d')).toEqual(value);
});
it('closes admission and drains a held fsync before a restarted owner opens the cache', async () => {
  const f = await fixture();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await real.open(...args), sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => { entered(); await held; await sync(); });
    return handle;
  });
  const pending = f.cache.put('c', value); await started;
  let closed = false;
  const drain = f.cache.closeAndDrain().then(() => { closed = true; });
  await f.cache.put('late', value);
  expect(await f.cache.get('a')).toBeNull();
  expect(closed).toBe(false);
  expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
  release(); await pending; await drain;
  const restarted = createPreparedContentCache(f.options);
  expect(await restarted.get('c')).toEqual(value);
  expect(await restarted.get('b')).toEqual(value);
  expect(await restarted.get('late')).toBeNull();
  expect((await readdir(f.directory)).every(name => name.endsWith('.prepared'))).toBe(true);
});
