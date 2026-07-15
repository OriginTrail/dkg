import { describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  ExactGraphReadError,
  SparqlHttpStore,
  quadToNQuad,
  quadsToNQuads,
  readExactGraphPaged,
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
      { s: '_:s3', p: 'urn:test:p', o: '_:o3' },
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
