import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES, buildAtomicAssetGroupUpdate } from '../src/atomic-asset-group.js';
import type { Quad } from '../src/triple-store.js';

const graph = 'urn:data', meta = 'urn:meta', subject = 'urn:asset';
const data: Quad[] = [{ graph, subject: 'urn:item', predicate: 'urn:value', object: '"value"' }];
const properties: Quad[] = [{ graph: meta, subject, predicate: 'urn:version', object: '"1"' }];
afterEach(() => vi.unstubAllGlobals());

describe('Blazegraph single asset replacement boundaries', () => {
  it.each([
    [{ ...data[0]!, graph: 'urn:wrong' }],
    [{ ...data[0]!, subject: '_:blank' }],
    [{ ...data[0]!, object: '_:blank' }],
    [{ ...data[0]!, object: JSON.stringify('x'.repeat(65_536)) }],
  ])('rejects malformed data before dispatch', async row => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceGraphAndSubject(graph, [row], meta, subject, properties)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('rejects a metadata subject outside the replacement boundary before dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceGraphAndSubject(graph, data, meta, subject,
        [{ ...properties[0]!, subject: 'urn:another-asset' }])).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('does not retry or dispatch a second write after a transaction failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('transaction refused', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceGraphAndSubject(graph, data, meta, subject, properties)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(store.getPressureSnapshot().normalInflight).toBe(0);
    } finally { await store.close(); }
  });

  it('honors caller cancellation before dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const caller = new AbortController(); caller.abort(new Error('cancel single asset'));
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await expect(store.replaceGraphAndSubject(graph, data, meta, subject, properties,
        { signal: caller.signal })).rejects.toThrow('cancel single asset');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('retains the legacy allowance for a single asset larger than the group cap', async () => {
    const object = JSON.stringify('x'.repeat(60_000));
    const large = Array.from({ length: 560 }, (_, i) => ({ ...data[0]!, subject: `urn:item:${i}`, object }));
    const member = { graphUri: graph, graphQuads: large, metaGraphUri: meta, metadataSubject: subject, metadataQuads: properties };
    expect(() => buildAtomicAssetGroupUpdate([member])).toThrow('byte allowance exceeded');
    const fetcher = vi.fn().mockResolvedValue(new Response('')); vi.stubGlobal('fetch', fetcher);
    const store = new BlazegraphStore('http://fixture.invalid/sparql');
    try {
      await store.replaceGraphAndSubject(graph, large, meta, subject, properties);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(String(fetcher.mock.calls[0]![1].body))).toBeGreaterThan(ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES);
    } finally { await store.close(); }
  }, 30_000);
});
