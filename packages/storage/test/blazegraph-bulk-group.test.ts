import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import * as bulkPlanner from '../src/adapters/bulk-asset-group.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const members = [{ graphUri: 'urn:data', metaGraphUri: 'urn:meta', metadataSubject: 'urn:asset',
  graphQuads: [{ graph: 'urn:data', subject: 'urn:s', predicate: 'urn:p', object: '"value"' }],
  metadataQuads: [{ graph: 'urn:meta', subject: 'urn:asset', predicate: 'urn:p', object: '"metadata"' }],
}];

describe('Blazegraph confirmed bulk publication', () => {
  it('does not serialize a bulk payload until the scheduler admits it', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
      healthReservedSlots: 0, normalReservedSlots: 0, backgroundReservedSlots: 0 });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const occupying = scheduler.run('normal', 'fixture', async () => { entered(); await blocked; });
    await admitted;
    const plan = vi.spyOn(bulkPlanner, 'buildBulkAssetGroupPlan');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: true }))).mockResolvedValueOnce(new Response(''));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql', { scheduler });
    const work = store.replaceAssetGroup(members);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(plan).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
      release(); await occupying; await work;
      expect(plan).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(4);
    } finally { release(); await occupying; await store.close(); }
  });

  it('selects SPARQL fallback for value aliases before any native upload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    const [asset] = members;
    try {
      await store.replaceAssetGroup([{ ...asset!, graphQuads: ['1', '01'].map(value => ({
        ...asset!.graphQuads[0]!, object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      })) }]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get('content-type')).toContain('sparql-update');
    } finally { await store.close(); }
  });

  it.each(['http-error', 'deadline'] as const)('preserves success when cleanup fails: %s', async failure => {
    const request = vi.fn().mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: true })))
      .mockImplementationOnce(async (_url, init) => {
        if (failure === 'http-error') return new Response('', { status: 500 });
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      });
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql', { timeout: 100 });
    try {
      await expect(store.replaceAssetGroup(members)).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(4);
      const receiptHeaders = new Headers(request.mock.calls[2]![1].headers);
      expect(receiptHeaders.get('x-bigdata-max-query-millis')).toBeTruthy();
      expect(receiptHeaders.get('accept')).toBe('application/sparql-results+json');
      expect(store.getPressureSnapshot()).toMatchObject({ ackInflight: 0, healthInflight: 0, normalInflight: 0, backgroundInflight: 0 });
    } finally { await store.close(); }
  });

  it('does not convert a missing receipt into success or retry publication', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boolean: false })));
    vi.stubGlobal('fetch', request);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceAssetGroup(members)).rejects.toThrow('receipt missing');
      expect(request).toHaveBeenCalledTimes(3);
    } finally { await store.close(); }
  });
});
