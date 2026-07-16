import { afterEach, describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  SparqlHttpStore,
  type TripleStore,
} from '../src/index.js';

interface HttpStoreCase {
  name: string;
  create(timeout?: number): TripleStore;
}

const cases: HttpStoreCase[] = [
  {
    name: 'Oxigraph-compatible SPARQL HTTP',
    create: (timeout = 5) => new SparqlHttpStore({
      queryEndpoint: 'http://oxigraph.test/query',
      timeout,
    }),
  },
  {
    name: 'Blazegraph',
    create: (timeout = 5) => new BlazegraphStore('http://blazegraph.test/sparql', { timeout }),
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

  for (const bodyPath of ['query JSON', 'update error text'] as const) {
    it(`retains admission through delayed ${bodyPath} cleanup`, async () => {
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      let bodiesStarted = 0;
      let bodiesAborted = 0;
      let resolveBodiesStarted!: () => void;
      let resolveBodiesAborted!: () => void;
      const allBodiesStarted = new Promise<void>((resolve) => { resolveBodiesStarted = resolve; });
      const allBodiesAborted = new Promise<void>((resolve) => { resolveBodiesAborted = resolve; });

      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls > 2) {
          active -= 1;
          return bodyPath === 'query JSON'
            ? new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), {
              status: 200,
              headers: { 'Content-Type': 'application/sparql-results+json' },
            })
            : new Response(null, { status: 204 });
        }

        const delayedBody = () => {
          bodiesStarted += 1;
          if (bodiesStarted === 2) resolveBodiesStarted();
          return new Promise<never>((_resolve, reject) => {
            const settleAfterAbort = () => {
              bodiesAborted += 1;
              if (bodiesAborted === 2) resolveBodiesAborted();
              setTimeout(() => {
                active -= 1;
                reject(init?.signal?.reason ?? new Error('aborted'));
              }, 20);
            };
            if (init?.signal?.aborted) settleAfterAbort();
            else init?.signal?.addEventListener('abort', settleAfterAbort, { once: true });
          });
        };
        return {
          ok: bodyPath === 'query JSON',
          status: bodyPath === 'query JSON' ? 200 : 500,
          json: delayedBody,
          text: delayedBody,
        } as unknown as Response;
      }) as typeof fetch;

      const store = create(1_000);
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      const invoke = (signal?: AbortSignal) => bodyPath === 'query JSON'
        ? store.query('SELECT ?s WHERE { ?s ?p ?o }', { signal })
        : store.update('INSERT DATA { <urn:s> <urn:p> "value" }', { signal });

      const first = invoke(firstAbort.signal);
      const second = invoke(secondAbort.signal);
      const firstAttemptsSettled = Promise.allSettled([first, second]);
      await allBodiesStarted;
      firstAbort.abort(new Error('cancel first'));
      secondAbort.abort(new Error('cancel second'));
      await allBodiesAborted;

      const retry = invoke();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls).toBe(2);

      const settled = await firstAttemptsSettled;
      expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      if (bodyPath === 'query JSON') {
        await expect(retry).resolves.toMatchObject({ type: 'bindings' });
      } else {
        await expect(retry).resolves.toBeUndefined();
      }
      expect(active).toBe(0);
      expect(maxActive).toBe(2);
      await store.close();
    });
  }
});
