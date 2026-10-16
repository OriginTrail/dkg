import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorCommitInput } from './rfc64-author-commit-cas-harness.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { StoreReadTransportFailure } from '../src/store-read-transport-failure.js';

afterEach(() => vi.unstubAllGlobals());
describe.each(['blazegraph', 'sparql-http'])('%s read transport classification', backend => {
  const create = () => backend === 'blazegraph' ? new BlazegraphStore('http://127.0.0.1:1/sparql')
    : new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1/sparql', consistencyProfile: 'atomic-readback' });
  it.each(['SELECT ?s WHERE { ?s ?p ?o }', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'])('types a reset during a proven read: %s', async query => {
    const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    const store = create();
    try { await expect(store.query(query)).rejects.toMatchObject({ code: 'STORE_READ_TRANSPORT_FAILURE', cause }); }
    finally { await store.close(); }
  });
  it.each([503, 429, 403, 400])('uses structured read HTTP status %s without retrying refusal', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('backend response', { status })));
    const store = create();
    try {
      const failure = await store.query('SELECT ?s WHERE { ?s ?p ?o }').catch(e => e);
      expect(failure instanceof StoreReadTransportFailure).toBe(status === 503 || status === 429);
    } finally { await store.close(); }
  });
  it('keeps malformed read evidence outside automatic transport recovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', {
      headers: { 'content-type': 'application/sparql-results+json' },
    })));
    const store = create();
    try { await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.not.toBeInstanceOf(StoreReadTransportFailure); }
    finally { await store.close(); }
  });
  it('does not grant read-only retry safety to a receipt failure after a mutation', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests++;
      if (String(init?.body).includes('ASK')) throw new TypeError('fetch failed');
      return new Response(null, { status: 200 });
    }));
    const store = create();
    try {
      await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.not.toBeInstanceOf(StoreReadTransportFailure);
      expect(requests).toBe(3); // Update, failed receipt, best-effort cleanup.
    } finally { await store.close(); }
  });
  it('keeps a failed mutation uncertain and does not classify arbitrary diagnostic prose', async () => {
    const cause = new TypeError('fetch failed');
    const fetch = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const store = create();
    try {
      await expect(store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: '"x"', graph: 'urn:g' }])).rejects.not.toBeInstanceOf(StoreReadTransportFailure);
      const prose = new Error('network timeout integrity refusal');
      fetch.mockRejectedValue(prose);
      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toBe(prose);
    } finally { await store.close(); }
  });
});
