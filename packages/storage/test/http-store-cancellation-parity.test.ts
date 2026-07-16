import { afterEach, describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  SparqlHttpStore,
  type TripleStore,
} from '../src/index.js';

interface HttpStoreCase {
  name: string;
  create(): TripleStore;
}

const cases: HttpStoreCase[] = [
  {
    name: 'Oxigraph-compatible SPARQL HTTP',
    create: () => new SparqlHttpStore({
      queryEndpoint: 'http://oxigraph.test/query',
      timeout: 5,
    }),
  },
  {
    name: 'Blazegraph',
    create: () => new BlazegraphStore('http://blazegraph.test/sparql', { timeout: 5 }),
  },
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.each(cases)('$name HTTP cancellation conformance', ({ create }) => {
  it('does not let a retry overlap an aborted attempt that is still cleaning up', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls > 1) {
        active -= 1;
        return new Response(JSON.stringify({
          head: { vars: [] },
          results: { bindings: [] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          // A transport may need time to propagate disconnect/cancel to the
          // server. Both adapters must retain admission until that work has
          // settled, otherwise the caller's immediate retry can overlap it.
          setTimeout(() => {
            active -= 1;
            reject(init.signal?.reason);
          }, 20);
        }, { once: true });
      });
    }) as typeof fetch;

    const store = create();
    await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toBeDefined();
    expect(active).toBe(0);

    await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).resolves.toMatchObject({
      type: 'bindings',
    });
    expect(maxActive).toBe(1);
    await store.close();
  });
});
