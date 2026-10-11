import { describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  SharedMemoryLiteralBlobStore,
  SparqlHttpStore,
  asBoundedQueryResponseCapability,
  readBoundedGraphPayload,
  readExactGraph,
  supportsBoundedExactGraphExport,
  type BoundedGraphPayloadProfile,
  type BoundedQueryResponseCapability,
  type QueryOptions,
  type QueryResult,
  type TripleStore,
} from '../src/index.js';

const graph = 'urn:test:bounded-capability';
const row = { s: 'urn:s', p: 'urn:p', o: '"value"' };
const quad = { subject: row.s, predicate: row.p, object: row.o, graph: '' };
const profile: BoundedGraphPayloadProfile = {
  maxRows: 10, maxResponseBytes: 1024, maxNQuadsBytes: 1024, maxHeapBytes: 4096,
  rowOverheadBytes: 160, heapAccounting: 'output-graph',
};

function result(sparql: string): QueryResult {
  return sparql.includes('COUNT(*)')
    ? { type: 'bindings', bindings: [{ count: '1' }] }
    : { type: 'bindings', bindings: [row] };
}

describe('bounded query response capability discovery', () => {
  it.each([
    ['Blazegraph', () => new BlazegraphStore('http://store.test/query')],
    ['SPARQL HTTP', () => new SparqlHttpStore({ queryEndpoint: 'http://store.test/query' })],
  ])('discovers %s through the supported decorators while every read stays on the outer path', async (_name, makeStore) => {
    const inner = makeStore();
    const innerQuery = vi.spyOn(inner, 'query').mockImplementation(async sparql => result(sparql));
    const indexed = new GraphSetIndexStore(inner);
    const changelog = new ChangelogStore(indexed);
    const outer = new SharedMemoryLiteralBlobStore(changelog, {
      blobDir: '/unused/bounded-query-response-capability', thresholdBytes: 1024,
    });
    const indexedQuery = vi.spyOn(indexed, 'query');
    const changelogQuery = vi.spyOn(changelog, 'query');
    const outerQuery = vi.spyOn(outer, 'query');
    const signal = new AbortController().signal;
    const queryOptions: QueryOptions = { source: 'test.bounded-capability', priority: 'background', signal };
    expect(asBoundedQueryResponseCapability(outer)).toBe(inner);
    expect(supportsBoundedExactGraphExport(outer)).toBe(true);
    await expect(readBoundedGraphPayload(outer, graph, {
      expectedQuadCount: 1, outputGraph: '', profile, queryOptions,
    })).resolves.toMatchObject({ status: 'read', quads: [quad] });
    expect(innerQuery).toHaveBeenCalledOnce();
    expect(innerQuery.mock.calls[0]![0]).not.toMatch(/COUNT|OFFSET|ORDER BY/);
    await expect(readExactGraph(outer, graph, {
      expectedQuadCount: 1, outputGraph: '', profile: 'bounded-single-result', queryOptions,
    })).resolves.toEqual([quad]);
    for (const query of [outerQuery, changelogQuery, indexedQuery, innerQuery]) {
      expect(query).toHaveBeenCalledTimes(4);
      expect(query.mock.calls.map(([, options]) => options?.maxResponseBytes))
        .toEqual([1024, 64 * 1024, 8 * 1024 * 1024, 64 * 1024]);
      for (const [, options] of query.mock.calls) expect(options).toMatchObject(queryOptions);
    }
  });

  it('accepts a third-party implementation by its declared response contract', async () => {
    const capable = {
      queryResponseLimitMode: 'pre-materialization' as const,
      query: vi.fn(async (sparql: string, _options?: QueryOptions) => result(sparql)),
    } satisfies BoundedQueryResponseCapability;
    const store = capable as unknown as TripleStore;
    expect(asBoundedQueryResponseCapability(store)).toBe(capable);
    expect(supportsBoundedExactGraphExport(store)).toBe(true);
    await expect(readBoundedGraphPayload(store, graph, { expectedQuadCount: 1, outputGraph: '', profile }))
      .resolves.toMatchObject({ status: 'read', quads: [quad] });
    expect(capable.query).toHaveBeenCalledOnce();
  });

  it('refuses embedded materialization and leaves exact reads on their bounded paged fallback', async () => {
    const store = new OxigraphStore();
    const query = vi.spyOn(store, 'query').mockImplementation(async sparql => result(sparql));
    try {
      expect(asBoundedQueryResponseCapability(store)).toBeNull();
      expect(supportsBoundedExactGraphExport(store)).toBe(false);
      await expect(readBoundedGraphPayload(store, graph, { expectedQuadCount: 1, profile }))
        .resolves.toEqual({ status: 'refused', reason: 'store-capability' });
      expect(query).not.toHaveBeenCalled();
      await expect(readExactGraph(store, graph, { expectedQuadCount: 1, outputGraph: '', profile: 'bounded-single-result' }))
        .resolves.toEqual([quad]);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[1]![0]).toMatch(/ORDER BY[\s\S]+LIMIT 2[\s\S]+OFFSET 0/);
    } finally { await store.close(); }
  });

  it('uses only the documented innerStore chain and bounds cycles and traversal depth', () => {
    const capable = { queryResponseLimitMode: 'pre-materialization', query: vi.fn() };
    expect(asBoundedQueryResponseCapability({ inner: capable })).toBeNull();
    const cyclic: { innerStore?: unknown } = {};
    cyclic.innerStore = cyclic;
    expect(asBoundedQueryResponseCapability(cyclic)).toBeNull();
    let chain: unknown = capable;
    for (let depth = 0; depth < 15; depth += 1) chain = { innerStore: chain };
    expect(asBoundedQueryResponseCapability(chain)).toBe(capable);
    expect(asBoundedQueryResponseCapability({ innerStore: chain })).toBeNull();
  });

  it.each([null, undefined, {}, { query: vi.fn() },
    { queryResponseLimitMode: 'pre-materialization' },
    { queryResponseLimitMode: 'post-materialization', query: vi.fn() },
  ])('does not infer the capability from an incomplete or unsupported contract: %j', candidate => {
    expect(asBoundedQueryResponseCapability(candidate)).toBeNull();
  });
});
