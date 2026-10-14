import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreparedContentCache, resolvePreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanup.splice(0)) await stop(); });
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
