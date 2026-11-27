import { afterEach, describe, expect, it, vi } from 'vitest';
import { SparqlHttpStore, GraphSetIndexStore, STORE_GRAPH_CATALOG_MAX_BYTES_ENV } from '../src/index.js';

const graph = `http://example.org/${'large-catalog-graph'.repeat(40)}`;
const catalogResponse = () => new Response(JSON.stringify({ head: { vars: ['g'] },
  results: { bindings: [{ g: { type: 'uri', value: graph } }] } }),
{ headers: { 'Content-Type': 'application/sparql-results+json' } });
const managed = () => new SparqlHttpStore({ queryEndpoint: 'http://catalog.test/query', managedByDkg: true });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('managed catalog byte ceilings', () => {
  it('bounds a cold transport by the internal ceiling and serves a warm cache without another fetch', async () => {
    const fetch = vi.fn(async () => catalogResponse());
    vi.stubGlobal('fetch', fetch);
    const store = managed();
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '256');
    await expect(store.listGraphs()).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT', limitBytes: 256 });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    // A caller's own byte limit does not bound the complete list: it is node work.
    await expect(store.listGraphs({ maxResponseBytes: 256 })).resolves.toEqual([graph]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(store.listGraphs({ maxResponseBytes: 256 })).resolves.toEqual([graph]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  for (const indexed of [false, true]) for (const largerLimit of [undefined, 4096]) {
    it.each([false, true])(`shares one internal flight across caller limits (indexed=${indexed}, larger=${largerLimit}, bounded first=%s)`, async boundedFirst => {
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
        // Both callers join the one in-flight catalog read.
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(pending).toHaveLength(1);
      } finally {
        for (const release of pending) release();
        await Promise.all([first, second]);
      }
      const outcomes = await Promise.all([first, second]);
      // The index hands the complete list to its caller, so that caller's own limit bounds it.
      expect(outcomes[boundedFirst ? 0 : 1]).toEqual(indexed
        ? { error: expect.objectContaining({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: 256 }) }
        : { graphs: [graph] });
      expect(outcomes[boundedFirst ? 1 : 0]).toEqual({ graphs: [graph] });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
});
