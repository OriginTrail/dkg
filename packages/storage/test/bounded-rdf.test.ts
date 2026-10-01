import { describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES,
  EXACT_GRAPH_EXPORT_MAX_ROWS,
  ExactGraphReadError,
  SparqlHttpStore,
  StoreResponseTooLargeError,
  quadToNQuad,
  quadsToNQuads,
  readExactGraph,
  readExactGraphPaged,
  supportsBoundedExactGraphExport,
  type Quad,
  type QueryOptions,
  type QueryResult,
  type TripleStore,
} from '../src/index.js';

describe('canonical storage N-Quads serialization', () => {
  it('formats every Quad term shape at the public storage seam', () => {
    const quads: Quad[] = [
      {
        subject: 'urn:test:iri-subject',
        predicate: 'urn:test:predicate',
        object: 'urn:test:iri-object',
        graph: '',
      },
      {
        subject: 'urn:test:typed-subject',
        predicate: 'urn:test:predicate',
        object: '"value"^^urn:test:datatype',
        graph: 'urn:test:named-graph',
      },
      {
        subject: '_:subject',
        predicate: 'urn:test:predicate',
        object: '_:object',
        graph: 'urn:test:named-graph',
      },
    ];

    expect(quadToNQuad(quads[0])).toBe(
      '<urn:test:iri-subject> <urn:test:predicate> <urn:test:iri-object> .',
    );
    expect(quadsToNQuads(quads)).toBe(
      '<urn:test:iri-subject> <urn:test:predicate> <urn:test:iri-object> .\n' +
        '<urn:test:typed-subject> <urn:test:predicate> "value"^^<urn:test:datatype> <urn:test:named-graph> .\n' +
        '_:subject <urn:test:predicate> _:object <urn:test:named-graph> .',
    );
  });
});

describe('readExactGraphPaged', () => {
  it('uses a server-side COUNT instead of a materializing store count', async () => {
    const graph = 'urn:test:server-count';
    const store = {
      countQuads: async () => {
        throw new Error('materializing countQuads must not run');
      },
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return {
            type: 'bindings',
            bindings: [{ count: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
          };
        }
        return {
          type: 'bindings',
          bindings: [{ s: 'urn:s', p: 'urn:p', o: 'urn:o' }],
        };
      },
    } as Pick<TripleStore, 'countQuads' | 'query'> as TripleStore;

    await expect(readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
    })).resolves.toEqual([
      { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph },
    ]);
  });

  it('rechecks the exact graph count after the final page', async () => {
    const graph = 'urn:test:postflight-count';
    let countQueries = 0;
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          countQueries++;
          return {
            type: 'bindings',
            bindings: [{ count: `"${countQueries}"` }],
          };
        }
        return {
          type: 'bindings',
          bindings: [{ s: 'urn:s', p: 'urn:p', o: 'urn:o' }],
        };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'integrity',
      code: 'QUAD_COUNT_MISMATCH',
      expected: 1,
      actual: 2,
    });
  });

  it('never sends a caller-sized unbounded page to the store', async () => {
    const graph = 'urn:test:bounded-page-size';
    let pageQuery = '';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"5000"' }] };
        }
        pageQuery = sparql;
        return { type: 'bindings', bindings: [] };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    await readExactGraphPaged(store, graph, {
      expectedQuadCount: 5000,
      pageSize: Number.MAX_SAFE_INTEGER,
    }).catch(() => undefined);

    expect(pageQuery).toMatch(/LIMIT 256\s+OFFSET 0/);
  });

  it('rejects duplicate triples returned across OFFSET pages', async () => {
    const graph = 'urn:test:duplicate-pages';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"2"' }] };
        }
        const offset = Number(sparql.match(/OFFSET (\d+)/)?.[1] ?? 0);
        return {
          type: 'bindings',
          bindings: offset < 2
            ? [{ s: 'urn:s', p: 'urn:p', o: 'urn:o' }]
            : [],
        };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    await expect(readExactGraphPaged(store, graph, {
      expectedQuadCount: 2,
      pageSize: 1,
    })).rejects.toMatchObject({
      kind: 'integrity',
      code: 'INVALID_QUERY_RESULT',
    });
  });

  it('reads one exact named graph in stable ordered pages', async () => {
    const graph = 'urn:test:exact-graph';
    const queryOptions: QueryOptions = {
      source: 'bounded-rdf-test',
      priority: 'background',
    };
    const queries: string[] = [];
    const seenOptions: Array<QueryOptions | undefined> = [];
    const rows = [
      { s: 'urn:test:s1', p: 'urn:test:p', o: 'urn:test:o1' },
      { s: 'urn:test:s2', p: 'urn:test:p', o: '"literal"' },
      { s: 'urn:test:s3', p: 'urn:test:p', o: 'urn:test:o3' },
    ];
    const store = {
      query: async (sparql: string, options?: QueryOptions): Promise<QueryResult> => {
        seenOptions.push(options);
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"3"' }] };
        }
        queries.push(sparql);
        const offset = Number(sparql.match(/OFFSET (\d+)/)?.[1] ?? 0);
        return {
          type: 'bindings',
          bindings: rows.slice(offset, offset + 2),
        };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    await expect(
      readExactGraphPaged(store, graph, {
        expectedQuadCount: 3,
        pageSize: 2,
        queryOptions,
      }),
    ).resolves.toEqual(rows.map((row) => ({
      subject: row.s,
      predicate: row.p,
      object: row.o,
      graph,
    })));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/ORDER BY \?s \?p \?o\s+LIMIT 2\s+OFFSET 0/);
    expect(queries[1]).toMatch(/ORDER BY \?s \?p \?o\s+LIMIT 2\s+OFFSET 2/);
    expect(seenOptions).toHaveLength(4);
    for (const options of seenOptions) {
      expect(options).toMatchObject(queryOptions);
      expect(options?.maxResponseBytes).toBeGreaterThan(0);
      expect(options?.maxResponseBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    }
  });

  it('preserves blank-node relationships in one bounded result document', async () => {
    const graph = 'urn:test:paged-blank-node-graph';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"2"' }] };
        }
        if (sparql.includes('CONSTRUCT')) {
          expect(sparql).toContain('LIMIT 3');
          return {
            type: 'quads',
            quads: [
              { subject: 'urn:root', predicate: 'urn:child', object: '_:stable', graph: '' },
              { subject: '_:stable', predicate: 'urn:name', object: '"child"', graph: '' },
            ],
          };
        }
        const offset = Number(sparql.match(/OFFSET (\d+)/)?.[1] ?? 0);
        return {
          type: 'bindings',
          bindings: offset === 0
            ? [{ s: 'urn:root', p: 'urn:child', o: '_:page-one' }]
            : offset === 1
              ? [{ s: '_:page-two', p: 'urn:name', o: '"child"' }]
              : [],
        };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    await expect(readExactGraphPaged(store, graph, {
      expectedQuadCount: 2,
      pageSize: 1,
      outputGraph: 'urn:test:rewritten-blank-node-graph',
    })).resolves.toEqual([
      {
        subject: 'urn:root',
        predicate: 'urn:child',
        object: '_:stable',
        graph: 'urn:test:rewritten-blank-node-graph',
      },
      {
        subject: '_:stable',
        predicate: 'urn:name',
        object: '"child"',
        graph: 'urn:test:rewritten-blank-node-graph',
      },
    ]);
  });

  it('fails closed before materializing an oversized blank-node graph', async () => {
    const graph = 'urn:test:oversized-blank-node-graph';
    let constructCalled = false;
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"257"' }] };
        }
        if (sparql.includes('CONSTRUCT')) {
          constructCalled = true;
          return { type: 'quads', quads: [] };
        }
        return {
          type: 'bindings',
          bindings: [{ s: '_:page-local', p: 'urn:p', o: '"value"' }],
        };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 257,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'limit',
      code: 'QUAD_COUNT_LIMIT_EXCEEDED',
      actual: 257,
      limit: 256,
    });
    expect(constructCalled).toBe(false);
  });

  it('fails with a typed limit error before materializing an oversized graph', async () => {
    const graph = 'urn:test:oversized-graph';
    const store = {
      query: async (): Promise<QueryResult> => ({
        type: 'bindings',
        bindings: [{ count: '"2"' }],
      }),
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
      maxQuadCount: 1,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'limit',
      code: 'QUAD_COUNT_LIMIT_EXCEEDED',
      graphIri: graph,
      actual: 2,
      limit: 1,
    });
  });

  it('enforces the cumulative N-Quads budget in UTF-8 bytes', async () => {
    const graph = 'urn:test:utf8-graph';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => sparql.includes('COUNT(*)')
        ? { type: 'bindings', bindings: [{ count: '"1"' }] }
        : {
            type: 'bindings',
            bindings: [{ s: 'urn:s', p: 'urn:p', o: '"😀"' }],
          },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
      maxNQuadsBytes: 22,
      outputGraph: '',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'limit',
      code: 'NQUADS_BYTE_LIMIT_EXCEEDED',
      graphIri: graph,
      actual: 24,
      limit: 22,
    });
  });

  it('fails with a typed integrity error when the final page count is not exact', async () => {
    const graph = 'urn:test:changing-graph';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => sparql.includes('COUNT(*)')
        ? { type: 'bindings', bindings: [{ count: '"2"' }] }
        : {
            type: 'bindings',
            bindings: [{ s: 'urn:s', p: 'urn:p', o: 'urn:o' }],
          },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 2,
      pageSize: 2,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'integrity',
      code: 'QUAD_COUNT_MISMATCH',
      graphIri: graph,
      expected: 2,
      actual: 1,
    });
  });

  it('classifies a non-SELECT store response as an integrity failure', async () => {
    const graph = 'urn:test:wrong-result-shape';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => sparql.includes('COUNT(*)')
        ? { type: 'bindings', bindings: [{ count: '"1"' }] }
        : { type: 'quads', quads: [] },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'integrity',
      code: 'INVALID_QUERY_RESULT',
      graphIri: graph,
    });
  });

  it('classifies malformed runtime bindings as an integrity failure', async () => {
    const graph = 'urn:test:malformed-bindings';
    const store = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"1"' }] };
        }
        return {
          type: 'bindings',
          bindings: [null],
        } as unknown as QueryResult;
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await readExactGraphPaged(store, graph, {
      expectedQuadCount: 1,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'integrity',
      code: 'INVALID_QUERY_RESULT',
      graphIri: graph,
    });
  });
});

describe('storage-owned exact graph profiles', () => {
  const graph = 'urn:test:exact-profile';
  const row = { s: 'urn:s', p: 'urn:p', o: '"😀"' };
  const quad = { subject: row.s, predicate: row.p, object: row.o, graph: '' };
  const profiles = ['paged', 'bounded-single-result'] as const;

  function httpStore(rows: Array<Record<string, string>>, options: {
    counts?: string[];
    oversized?: boolean;
  } = {}) {
    const store = new BlazegraphStore('http://store.test/query');
    let counts = 0;
    const query = vi.spyOn(store, 'query').mockImplementation(async (sparql): Promise<QueryResult> => {
      if (sparql.includes('COUNT(*)')) {
        return { type: 'bindings', bindings: [{ count: options.counts?.[counts++] ?? String(rows.length) }] };
      }
      if (options.oversized && !sparql.includes('ORDER BY')) {
        throw new StoreResponseTooLargeError(EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES,
          EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES + 1);
      }
      const offset = Number(/OFFSET\s+(\d+)/.exec(sparql)?.[1] ?? 0);
      const limit = Number(/LIMIT\s+(\d+)/.exec(sparql)![1]);
      return { type: 'bindings', bindings: rows.slice(offset, offset + limit) };
    });
    return { store, query };
  }

  it('uses one bounded payload between count fences and keeps queries on decorators', async () => {
    const { store: innerStore, query } = httpStore([row]);
    const outerQuery = vi.fn((sparql: string, options?: QueryOptions) => innerStore.query(sparql, options));
    const store = { innerStore, query: outerQuery } as unknown as TripleStore;
    const signal = new AbortController().signal;
    expect(supportsBoundedExactGraphExport(store)).toBe(true);
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile: 'bounded-single-result', outputGraph: '',
      queryOptions: { source: 'test.exact-profile', priority: 'background', signal },
    })).resolves.toEqual([quad]);
    expect(outerQuery).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]![0]).toContain('LIMIT 2');
    expect(query.mock.calls[1]![0]).not.toMatch(/ORDER BY|OFFSET/);
    expect(query.mock.calls.map(([, options]) => options?.maxResponseBytes)).toEqual([
      64 * 1024, EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES, 64 * 1024,
    ]);
    for (const [, options] of query.mock.calls) {
      expect(options).toMatchObject({ source: 'test.exact-profile', priority: 'background', signal });
    }
  });

  it.each(profiles)('%s applies the same canonical duplicate and COUNT validators', async (profile) => {
    const duplicate = httpStore([
      { s: 'urn:s', p: 'urn:p', o: '"1"^^urn:type' },
      { s: 'urn:s', p: 'urn:p', o: '"1"^^<urn:type>' },
    ]);
    await expect(readExactGraph(duplicate.store, graph, {
      expectedQuadCount: 2, profile, outputGraph: '',
    })).rejects.toMatchObject({ kind: 'integrity', code: 'INVALID_QUERY_RESULT' });
    const count = httpStore([row], { counts: ['1.0'] });
    await expect(readExactGraph(count.store, graph, {
      expectedQuadCount: 1, profile,
    })).rejects.toMatchObject({ kind: 'integrity', code: 'INVALID_QUERY_RESULT' });
    expect(count.query).toHaveBeenCalledTimes(1);
  });

  it.each(profiles)('%s enforces caller row, UTF-8 and response ceilings', async (profile) => {
    const { store, query } = httpStore([row]);
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile, maxQuadCount: 0,
    })).rejects.toMatchObject({ code: 'QUAD_COUNT_LIMIT_EXCEEDED', actual: 1, limit: 0 });
    expect(query).not.toHaveBeenCalled();
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile, outputGraph: '', maxNQuadsBytes: 22,
    })).rejects.toMatchObject({ code: 'NQUADS_BYTE_LIMIT_EXCEEDED', actual: 24, limit: 22 });
    query.mockClear();
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile, outputGraph: '', maxNQuadsBytes: 24,
      queryOptions: { maxResponseBytes: 1024 },
    })).resolves.toEqual([quad]);
    for (const [, options] of query.mock.calls) expect(options?.maxResponseBytes).toBe(1024);
  });

  it.each(profiles)('%s rejects preflight and postflight count races', async (profile) => {
    const before = httpStore([row], { counts: ['2'] });
    await expect(readExactGraph(before.store, graph, {
      expectedQuadCount: 1, profile,
    })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH', expected: 1, actual: 2 });
    expect(before.query).toHaveBeenCalledTimes(1);
    const after = httpStore([row], { counts: ['"1"^^<urn:integer>', '2'] });
    await expect(readExactGraph(after.store, graph, {
      expectedQuadCount: 1, profile,
    })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH', expected: 1, actual: 2 });
    expect(after.query).toHaveBeenCalledTimes(3);
  });

  it('falls back to complete bounded pages for an unsupported store', async () => {
    const { store: innerStore, query } = httpStore([row]);
    const store = { query: (sparql: string, options?: QueryOptions) => innerStore.query(sparql, options) } as TripleStore;
    expect(supportsBoundedExactGraphExport(store)).toBe(false);
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile: 'bounded-single-result', outputGraph: '',
    })).resolves.toEqual([quad]);
    expect(query.mock.calls[1]![0]).toMatch(/ORDER BY[\s\S]+LIMIT 2[\s\S]+OFFSET 0/);
  });

  it('falls back before a large payload when the expected count exceeds the profile', async () => {
    const rows = Array.from({ length: EXACT_GRAPH_EXPORT_MAX_ROWS + 1 }, (_, index) => ({
      s: `urn:s:${index}`, p: 'urn:p', o: 'urn:o',
    }));
    const { store, query } = httpStore(rows);
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: rows.length, profile: 'bounded-single-result', outputGraph: '',
    })).resolves.toHaveLength(rows.length);
    const payloads = query.mock.calls.filter(([sparql]) => !sparql.includes('COUNT(*)'));
    expect(payloads.length).toBeGreaterThan(1);
    for (const [sparql] of payloads) {
      expect(sparql).toContain('ORDER BY');
      expect(Number(/LIMIT\s+(\d+)/.exec(sparql)![1])).toBeLessThanOrEqual(256);
    }
  });

  it('restarts oversized results with fresh count fences instead of retaining a prefix', async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ s: `urn:s:${index}`, p: 'urn:p', o: 'urn:o' }));
    const { store, query } = httpStore(rows, { oversized: true });
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: rows.length, profile: 'bounded-single-result',
    })).resolves.toHaveLength(rows.length);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('COUNT(*)'))).toHaveLength(3);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('OFFSET'))).toHaveLength(2);
    const raced = httpStore([row], { oversized: true, counts: ['1', '2'] });
    await expect(readExactGraph(raced.store, graph, {
      expectedQuadCount: 1, profile: 'bounded-single-result',
    })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH', expected: 1, actual: 2 });
    expect(raced.query.mock.calls.filter(([sparql]) => sparql.includes('OFFSET'))).toHaveLength(0);
  });

  it('restarts blank-node rows in one bounded CONSTRUCT document', async () => {
    const { store, query } = httpStore([{ s: 'urn:root', p: 'urn:p', o: '_:select-local' }]);
    query.mockImplementation(async (sparql): Promise<QueryResult> => {
      if (sparql.includes('COUNT(*)')) return { type: 'bindings', bindings: [{ count: '1' }] };
      if (sparql.includes('CONSTRUCT')) return {
        type: 'quads', quads: [{ subject: 'urn:root', predicate: 'urn:p', object: '_:document', graph: '' }],
      };
      return { type: 'bindings', bindings: [{ s: 'urn:root', p: 'urn:p', o: '_:select-local' }] };
    });
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile: 'bounded-single-result', outputGraph: '',
    })).resolves.toEqual([{ subject: 'urn:root', predicate: 'urn:p', object: '_:document', graph: '' }]);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('CONSTRUCT'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('COUNT(*)'))).toHaveLength(3);
  });

  it('rejects a server ignoring the single-result overflow LIMIT', async () => {
    const { store, query } = httpStore([row]);
    query.mockImplementation(async (sparql): Promise<QueryResult> => sparql.includes('COUNT(*)')
      ? { type: 'bindings', bindings: [{ count: '1' }] }
      : { type: 'bindings', bindings: [row, row, row] });
    await expect(readExactGraph(store, graph, {
      expectedQuadCount: 1, profile: 'bounded-single-result',
    })).rejects.toMatchObject({ code: 'INVALID_QUERY_RESULT' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('bounded HTTP query responses', () => {
  it.each([
    ['SPARQL HTTP', () => new SparqlHttpStore({ queryEndpoint: 'http://store.test/query' })],
    ['Blazegraph', () => new BlazegraphStore('http://store.test/query')],
  ])('rejects an oversized %s SELECT response before JSON materialization', async (_name, makeStore) => {
    const originalFetch = globalThis.fetch;
    const body = JSON.stringify({
      head: { vars: ['o'] },
      results: {
        bindings: [{ o: { type: 'literal', value: 'x'.repeat(256) } }],
      },
    });
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    })) as typeof fetch;

    try {
      const store = makeStore();
      await expect(store.query(
        'SELECT ?o WHERE { ?s ?p ?o }',
        { maxResponseBytes: 64 },
      )).rejects.toMatchObject({
        code: 'STORE_RESPONSE_TOO_LARGE',
        maxBytes: 64,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ['SPARQL HTTP', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', () => new SparqlHttpStore({ queryEndpoint: 'http://store.test/query' })],
    ['SPARQL HTTP', 'DESCRIBE <urn:test:subject>', () => new SparqlHttpStore({ queryEndpoint: 'http://store.test/query' })],
    ['Blazegraph', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', () => new BlazegraphStore('http://store.test/query')],
    ['Blazegraph', 'DESCRIBE <urn:test:subject>', () => new BlazegraphStore('http://store.test/query')],
  ])('rejects an oversized %s N-Quads response for %s before parsing', async (_name, sparql, makeStore) => {
    const originalFetch = globalThis.fetch;
    // Deliberately malformed: parsing before enforcing the byte limit would
    // surface an RDF parser error instead of STORE_RESPONSE_TOO_LARGE.
    const body = `<urn:test:s> <urn:test:p> "unterminated-${'x'.repeat(256)}`;
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/n-quads' },
    })) as typeof fetch;

    try {
      const store = makeStore();
      await expect(store.query(sparql, { maxResponseBytes: 64 }))
        .rejects.toMatchObject({
          code: 'STORE_RESPONSE_TOO_LARGE',
          maxBytes: 64,
        });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
