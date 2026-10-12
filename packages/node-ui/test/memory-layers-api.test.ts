import { afterEach, expect, it, vi } from 'vitest';
import { fetchMemoryLayersDeduped } from '../src/ui/api.js';

afterEach(() => vi.unstubAllGlobals());

it('coalesces only the same caller, graph and visibility options, then releases the completed flight', async () => {
  const releases: Array<() => void> = [];
  const page = { __DKG_TOKEN__: 'caller-a' };
  vi.stubGlobal('window', page);
  const fetch = vi.fn(() => new Promise<Response>(resolve => releases.push(() => resolve({
    ok: true, json: async () => ({ layers: {} }),
  } as Response))));
  vi.stubGlobal('fetch', fetch);
  const first = fetchMemoryLayersDeduped('cg');
  expect(fetchMemoryLayersDeduped('cg')).toBe(first);
  const catalog = fetchMemoryLayersDeduped('cg', true);
  const otherGraph = fetchMemoryLayersDeduped('other');
  page.__DKG_TOKEN__ = 'caller-b';
  const otherCaller = fetchMemoryLayersDeduped('cg');
  expect(otherCaller).not.toBe(first);
  expect(fetch).toHaveBeenCalledTimes(4);
  releases.splice(0).forEach(release => release());
  await Promise.all([first, catalog, otherGraph, otherCaller]);
  const fresh = fetchMemoryLayersDeduped('cg');
  expect(fetch).toHaveBeenCalledTimes(5);
  releases.splice(0).forEach(release => release());
  await fresh;
});
