import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { BLAZEGRAPH_GRAPH_LIST_QUERY, GRAPH_LIST_ACCEPT } from '../src/adapters/blazegraph-graph-list.js';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import { STORE_GRAPH_CATALOG_MAX_BYTES_ENV } from '../src/graph-catalog-internal-limit.js';
import type * as TsvDecoding from '../src/sparql-tsv-query-result.js';

/**
 * The HTTP adapters read a store's complete graph list one graph per line, in
 * SPARQL TSV, and decode it as a stream that lets other work run between
 * chunks (`yieldBetweenChunks`, tested on the decoder itself). Every other TSV
 * read keeps decoding straight through.
 */
const decodes = vi.hoisted(() => [] as Array<boolean | undefined>);
vi.mock('../src/sparql-tsv-query-result.js', async (importOriginal) => {
  const original = await importOriginal<typeof TsvDecoding>();
  return {
    ...original,
    decodeSparqlTsvSelectResponse: (...args: Parameters<typeof original.decodeSparqlTsvSelectResponse>) => {
      decodes.push(args[1]?.yieldBetweenChunks);
      return original.decodeSparqlTsvSelectResponse(...args);
    },
  };
});

const encoder = new TextEncoder();
function chunked(chunks: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/tab-separated-values' } });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  decodes.length = 0;
});

/** Answer every request with `answer`, and record each request's body and Accept header. */
function serve(answer: (body: string) => Response): Array<{ body: string; accept: string }> {
  const requests: Array<{ body: string; accept: string }> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    requests.push({ body, accept: new Headers(init?.headers).get('accept') ?? '' });
    return answer(body);
  }) as typeof fetch;
  return requests;
}

// IRIs as a TSV answer writes them: `\u` and `\U` escapes, and a hidden staging graph.
const BODY = [
  '?g\n<urn:graph-list:one>\n<did:dkg:context-graph:caf\\u00E9>\n',
  '<urn:dkg:internal:atomic-graph-replace:staged>\n<urn:graph-list:smile-\\U0001F600>\n',
];
const LISTED = ['urn:graph-list:one', 'did:dkg:context-graph:café', 'urn:graph-list:smile-😀'];
const BLAZEGRAPH = 'http://blazegraph.invalid/bigdata/namespace/kb/sparql';

describe('BlazegraphStore.listGraphs', () => {
  it('asks for the list one graph per line, decodes it as a stream with its escapes, and drops hidden graphs', async () => {
    const requests = serve(() => chunked(BODY));
    expect(await new BlazegraphStore(BLAZEGRAPH).listGraphs()).toEqual(LISTED);
    expect(requests).toEqual([{ body: BLAZEGRAPH_GRAPH_LIST_QUERY, accept: GRAPH_LIST_ACCEPT }]);
    expect(decodes).toEqual([true]);
  });

  it('answers the internal catalog limit, not a caller limit, when the list is too large', async () => {
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '32');
    serve(() => chunked(BODY));
    await expect(new BlazegraphStore(BLAZEGRAPH).listGraphs({ maxResponseBytes: 1 })).rejects.toMatchObject({
      code: 'STORE_INTERNAL_LIMIT', limitName: 'STORE_GRAPH_CATALOG_MAX_BYTES', limitBytes: 32,
    });
  });

  it('keeps the buffered decode for an answer that does not declare TSV', async () => {
    serve(() => Response.json({ head: { vars: ['g'] }, results: { bindings: [{ g: { type: 'uri', value: 'urn:graph-list:one' } }] } }));
    expect(await new BlazegraphStore(BLAZEGRAPH).listGraphs()).toEqual(['urn:graph-list:one']);
    expect(decodes).toEqual([]);
  });
});

describe('the graph list of a managed oxigraph-server', () => {
  const managed = () => createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' }, {});

  it('is decoded as a stream that lets other work run between chunks; another SELECT is not', async () => {
    serve((body) => body.startsWith('SELECT ?g') ? chunked(BODY) : chunked(['?s\n<urn:graph-list:s>\n']));
    const store = managed();
    try {
      expect(await store.listGraphs()).toEqual(LISTED);
      expect(await store.query('SELECT ?s WHERE { ?s ?p ?o }')).toMatchObject({ bindings: [{ s: 'urn:graph-list:s' }] });
      expect(decodes).toEqual([true, false]);
    } finally {
      await store.close();
    }
  });
});

const server = process.env.OXIGRAPH_SERVER_URL;
if (server) {
  describe('the graph list of a managed oxigraph-server (live server)', () => {
    it('lists graphs whose names need escapes', async () => {
      const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: `${server}/query`, updateEndpoint: `${server}/update` }, {});
      const root = `urn:graph-list:${randomUUID()}`;
      const graphs = [`${root}:café`, `${root}:smile-😀`, `${root}:a%20b`, `${root}:plain`];
      try {
        await store.insert(graphs.map((graph, i) => ({ subject: `${root}:s${i}`, predicate: 'urn:p', object: '"x"', graph })));
        expect((await store.listGraphs()).filter((graph) => graph.startsWith(root)).sort()).toEqual([...graphs].sort());
        expect(decodes).toContain(true);
      } finally {
        for (const graph of graphs) await store.dropGraph(graph);
        await store.close();
      }
    });
  });
}
