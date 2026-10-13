import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

afterEach(() => vi.unstubAllGlobals());
const members = [{ graphUri: 'urn:data', metaGraphUri: 'urn:meta', metadataSubject: 'urn:asset',
  graphQuads: [{ graph: 'urn:data', subject: 'urn:s', predicate: 'urn:p', object: '"value"' }],
  metadataQuads: [{ graph: 'urn:meta', subject: 'urn:asset', predicate: 'urn:p', object: '"metadata"' }],
}];

describe('Blazegraph confirmed bulk publication', () => {
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
