import { afterEach, describe, expect, it, vi } from 'vitest';
import { SparqlHttpStore, GraphSetIndexStore } from '../src/index.js';

const graph = `http://example.org/${'large-catalog-graph'.repeat(40)}`;
const catalogResponse = () => new Response(JSON.stringify({ head: { vars: ['g'] },
  results: { bindings: [{ g: { type: 'uri', value: graph } }] } }),
{ headers: { 'Content-Type': 'application/sparql-results+json' } });
const managed = () => new SparqlHttpStore({ queryEndpoint: 'http://catalog.test/query', managedByDkg: true });
afterEach(() => vi.unstubAllGlobals());

describe('managed catalog byte ceilings', () => {
  it('rejects a cold oversized transport and checks a warm cache without another fetch', async () => {
    const fetch = vi.fn(async () => catalogResponse());
    vi.stubGlobal('fetch', fetch);
    const store = managed();
    await expect(store.listGraphs({ maxResponseBytes: 256 })).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(store.listGraphs({ maxResponseBytes: 256 })).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  for (const indexed of [false, true]) for (const largerLimit of [undefined, 4096]) {
    it.each([false, true])(`isolates delayed ceilings (indexed=${indexed}, larger=${largerLimit}, bounded first=%s)`, async boundedFirst => {
      const pending: Array<() => void> = [];
      const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(() => resolve(catalogResponse()))));
      vi.stubGlobal('fetch', fetch);
      const raw = managed();
      const store = indexed ? new GraphSetIndexStore(raw) : raw;
      const limits = boundedFirst ? [256, largerLimit] : [largerLimit, 256];
      const observe = (limit: number | undefined) => store.listGraphs({ maxResponseBytes: limit })
        .then(graphs => ({ graphs }), error => ({ error }));
      const first = observe(limits[0]);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const second = observe(limits[1]);
      try {
        // A bounded caller must start its own bounded transport before either result arrives.
        await vi.waitFor(() => expect(pending).toHaveLength(2));
      } finally {
        for (const release of pending) release();
        await Promise.all([first, second]);
      }
      const outcomes = await Promise.all([first, second]);
      expect(outcomes[boundedFirst ? 0 : 1]).toMatchObject({ error: { code: 'STORE_RESPONSE_TOO_LARGE' } });
      expect(outcomes[boundedFirst ? 1 : 0]).toEqual({ graphs: [graph] });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  }
});
