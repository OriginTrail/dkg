import { StoreOperationTimeoutError, isStoreOperationTimeoutError } from '../src/store-operation-timeout.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorCommitInput } from './rfc64-author-commit-cas-harness.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { isStoreReadTransportFailure } from '../src/store-read-transport-failure.js';

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
      expect(isStoreReadTransportFailure(failure)).toBe(status === 503 || status === 429);
    } finally { await store.close(); }
  });
  it('keeps malformed read evidence outside automatic transport recovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', {
      headers: { 'content-type': 'application/sparql-results+json' },
    })));
    const store = create();
    try { expect(isStoreReadTransportFailure(await store.query('SELECT ?s WHERE { ?s ?p ?o }').catch(e => e))).toBe(false); }
    finally { await store.close(); }
  });
  it('marks an adapter read deadline without changing the existing timeout contract', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const store = backend === 'blazegraph' ? new BlazegraphStore('http://127.0.0.1:1/sparql', { timeout: 10 })
      : new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1/sparql', consistencyProfile: 'atomic-readback', timeout: 10 });
    try {
      const failure = await store.query('SELECT ?s WHERE { ?s ?p ?o }').catch(e => e);
      expect(failure).toBeInstanceOf(StoreOperationTimeoutError);
      expect(isStoreOperationTimeoutError(failure)).toBe(true);
      expect(isStoreReadTransportFailure(failure)).toBe(true);
    } finally { await store.close(); }
  });
  it('does not mark an indeterminate mutation deadline as a safe read', async () => {
    const error = new StoreOperationTimeoutError({ backend, operation: 'insert', outcome: 'indeterminate' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const store = create();
    try { expect(isStoreReadTransportFailure(await store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: '"x"', graph: 'urn:g' }]).catch(e => e))).toBe(false); }
    finally { await store.close(); }
  });
  it.each(['transport', 'http-503'])('does not grant read-only retry safety to a %s receipt failure after a mutation', async kind => {
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests++;
      if (String(init?.body).includes('ASK')) {
        if (kind === 'http-503') return new Response('unavailable', { status: 503 });
        throw new TypeError('fetch failed');
      }
      return new Response(null, { status: 200 });
    }));
    const store = create();
    try {
      expect(isStoreReadTransportFailure(await store.rfc64AuthorCommitCasV1(authorCommitInput()).catch(e => e))).toBe(false);
      expect(requests).toBe(3); // Update, failed receipt, best-effort cleanup.
    } finally { await store.close(); }
  });
  it('keeps a failed mutation uncertain and does not classify arbitrary diagnostic prose', async () => {
    const cause = new TypeError('fetch failed');
    const fetch = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const store = create();
    try {
      expect(isStoreReadTransportFailure(await store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: '"x"', graph: 'urn:g' }]).catch(e => e))).toBe(false);
      const prose = new Error('network timeout integrity refusal');
      fetch.mockRejectedValue(prose);
      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toBe(prose);
    } finally { await store.close(); }
  });
});
