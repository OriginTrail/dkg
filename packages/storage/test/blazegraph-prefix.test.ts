import { afterEach, describe, expect, it, vi } from 'vitest';
import { listGraphsByPrefixCandidate } from '../scripts/blazegraph-prefix-candidate.mjs';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import type { TripleStore } from '../src/triple-store.js';

function response(graphs: string[]) {
  return new Response(JSON.stringify({ head: { vars: ['g'] }, results: {
    bindings: graphs.map(value => ({ g: { type: 'uri', value } })),
  } }), { headers: { 'Content-Type': 'application/sparql-results+json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('experimental fresh Blazegraph graph-prefix reads', () => {
  it('keeps the slower candidate disabled in the production adapter', () => {
    expect((new BlazegraphStore('http://local.test/sparql') as TripleStore).listGraphsByPrefix).toBeUndefined();
  });
  it('pushes the prefix to the server instead of downloading unrelated identifiers', async () => {
    const all = ['urn:scope:one', ...Array.from({ length: 100 }, (_, i) => `urn:other:${i}`)];
    let returnedRows = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const query = String(init.body);
      const graphs = query.includes('STRSTARTS') ? all.filter(g => g.startsWith('urn:scope:')) : all;
      returnedRows += graphs.length;
      return response(graphs);
    }));
    expect(await listGraphsByPrefixCandidate(new BlazegraphStore('http://local.test/sparql'), 'urn:scope:'))
      .toEqual(['urn:scope:one']);
    expect(returnedRows).toBe(1);
  });

  it('does not cache an external insert or removal between calls', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(['urn:scope:old']))
      .mockResolvedValueOnce(response(['urn:scope:new']));
    vi.stubGlobal('fetch', fetch);
    const store = new BlazegraphStore('http://local.test/sparql');
    expect(await listGraphsByPrefixCandidate(store, 'urn:scope:')).toEqual(['urn:scope:old']);
    expect(await listGraphsByPrefixCandidate(store, 'urn:scope:')).toEqual(['urn:scope:new']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps abort, deadline, response bound and scheduler priority on the read boundary', async () => {
    const scheduler = new StorePriorityScheduler();
    const run = vi.spyOn(scheduler, 'run');
    const fetch = vi.fn(async () => response(['urn:scope:one']));
    vi.stubGlobal('fetch', fetch);
    const store = new BlazegraphStore('http://local.test/sparql', { scheduler, timeout: 100 });
    const abort = new AbortController(); abort.abort(new Error('caller stopped'));
    await expect(listGraphsByPrefixCandidate(store, 'urn:', { signal: abort.signal })).rejects.toThrow('caller stopped');
    expect(fetch).not.toHaveBeenCalled();
    await listGraphsByPrefixCandidate(store, 'urn:', { priority: 'ack', source: 'test.prefix' });
    expect(run).toHaveBeenCalledWith('ack', 'test.prefix', expect.any(Function), expect.any(AbortSignal), { storeOperation: 'query' });
    const wire = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(wire[1].signal).toBeInstanceOf(AbortSignal);
    expect(wire[1].headers).toMatchObject({ 'X-BIGDATA-MAX-QUERY-MILLIS': '400' });
  });

  it('bounds a stalled response and releases admission after the abort settles', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const scheduler = new StorePriorityScheduler();
    const store = new BlazegraphStore('http://local.test/sparql', { scheduler, timeout: 30 });
    await expect(listGraphsByPrefixCandidate(store, 'urn:')).rejects.toMatchObject({ storeOperation: 'query' });
    expect(scheduler.snapshot.normalInflight).toBe(0);
  });

  it('preserves an explicit response byte limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(['urn:scope:one'])));
    const store = new BlazegraphStore('http://local.test/sparql');
    await expect(listGraphsByPrefixCandidate(store, 'urn:', { maxResponseBytes: 8 })).rejects.toThrow();
  });
});
