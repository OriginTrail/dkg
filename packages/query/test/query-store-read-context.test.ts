import { describe, expect, it } from 'vitest';
import { ChangelogStore, GraphManager, GraphSetIndexStore, SharedMemoryLiteralBlobStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { createQueryStoreReadContext, QueryMaterializationBudget } from '../src/query-store-read-context.js';

describe('query store-read materialization budget', () => {
  it('charges graph enumeration even when no SPARQL result is materialized', async () => {
    const graphs = Array.from(
      { length: 8 },
      (_, index) => `did:dkg:context-graph:test/_verifiable_memory/${index}-${'x'.repeat(80)}`,
    );
    const store = {
      async listGraphsByPrefix() { return graphs; },
    } as unknown as TripleStore;
    const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: 128 });

    await expect(reads.listGraphsByPrefix('did:dkg:context-graph:test/'))
      .rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE',
        maxBytes: 128,
        actualBytes: expect.any(Number),
      });
  });

  it('uses one cumulative budget for graph enumeration and query results', async () => {
    const graphs = [`urn:graph:${'x'.repeat(48)}`];
    const queryResult = { type: 'bindings' as const, bindings: [{ value: '"ok"' }] };
    const graphBytes = Buffer.byteLength(JSON.stringify(graphs), 'utf8');
    const resultBytes = Buffer.byteLength(JSON.stringify(queryResult), 'utf8');
    const store = {
      async listGraphsByPrefix() { return graphs; },
      async query() { return queryResult; },
    } as unknown as TripleStore;
    const reads = createQueryStoreReadContext(store, {
      maxMaterializedBytes: Math.max(graphBytes, resultBytes),
    });

    await expect(reads.listGraphsByPrefix('urn:graph:')).resolves.toEqual(graphs);
    await expect(reads.query('SELECT ?value WHERE { ?s ?p ?value }'))
      .rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE',
        actualBytes: graphBytes + resultBytes,
      });
  });
});

describe('fallback inventory materialization', () => {
  const graphs = Array.from({ length: 1000 }, (_, index) => `urn:unrelated:${index}:${'x'.repeat(500)}`);
  const rawBytes = Buffer.byteLength(JSON.stringify(graphs), 'utf8');
  const result = { type: 'bindings' as const, bindings: [{ value: '"ok"' }] };
  const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const store = { listGraphs: async () => graphs, query: async () => result } as unknown as TripleStore;

  it.each(['enumeration', 'catalog', 'withheld'] as const)('charges the full nonmatching inventory in the %s lane', async kind => {
    const context = createQueryStoreReadContext(store, { maxMaterializedBytes: 1024 });
    const lane = kind === 'enumeration' ? context : kind === 'catalog' ? context.catalog : context.withWithheldGraphRoots([]);
    await expect(lane.listGraphsByPrefix('urn:absent:')).rejects.toMatchObject({
      code: 'QUERY_MATERIALIZATION_TOO_LARGE', maxBytes: 1024, actualBytes: rawBytes,
    });
  });

  it('retains raw discovery cost for cache replay and caller-local cumulative charging', async () => {
    const loader = createQueryStoreReadContext(store, { maxMaterializedBytes: rawBytes });
    const discovery = await loader.shared.measure(reads => reads.listGraphsByPrefix('urn:absent:'));
    expect(discovery).toEqual({ snapshot: [], byteCount: rawBytes });
    expect(loader.shared.replay(discovery)).toEqual([]);
    await expect(loader.query('SELECT * WHERE {}')).rejects.toMatchObject({ actualBytes: rawBytes + resultBytes });
    const other = createQueryStoreReadContext(store, { maxMaterializedBytes: rawBytes + resultBytes });
    expect(other.shared.replay(discovery)).toEqual([]);
    await expect(other.query('SELECT * WHERE {}')).resolves.toEqual(result);
    const small = createQueryStoreReadContext(store, { maxMaterializedBytes: 1024 });
    expect(() => small.shared.replay(discovery)).toThrow(expect.objectContaining({ actualBytes: rawBytes }));
  });

  it('charges direct fallback enumeration once, then adds the query result', async () => {
    const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: rawBytes + resultBytes });
    await expect(reads.listGraphsByPrefix('urn:absent:')).resolves.toEqual([]);
    await expect(reads.query('SELECT * WHERE {}')).resolves.toEqual(result);
    await expect(reads.query('SELECT * WHERE {}')).rejects.toMatchObject({ actualBytes: rawBytes + 2 * resultBytes });
  });
});


describe('decorated inventory materialization', () => {
  const hidden = 'did:dkg:context-graph:hidden';
  const inventory = [hidden, ...Array.from({ length: 1000 }, (_, i) => `urn:unrelated:${i}:${'x'.repeat(500)}`)];
  const inventoryBytes = Buffer.byteLength(JSON.stringify(inventory));
  const result = { type: 'bindings' as const, bindings: [{ value: '"ok"' }] };
  const resultBytes = Buffer.byteLength(JSON.stringify(result));
  const base = { listGraphs: async () => inventory, query: async () => result } as unknown as TripleStore;
  const decorate = (kind: string): TripleStore => {
    const visible = new ChangelogStore(base, { reservedGraphs: [hidden] });
    if (kind === 'visibility') return visible;
    if (kind === 'blob') return new SharedMemoryLiteralBlobStore(visible, { blobDir: '/unused-read-only-fixture', thresholdBytes: 1024 });
    return new GraphSetIndexStore(visible, { enabled: kind === 'index-enabled' });
  };
  it.each(['visibility', 'blob', 'index-disabled', 'index-enabled'])
    ('retains full fallback cost through %s and cache replay without exposing reserved graphs', async kind => {
      const store = decorate(kind);
      const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: inventoryBytes });
      const discovery = await reads.shared.measure(lane => lane.listGraphsByPrefix('did:dkg:context-graph:'));
      expect(discovery).toEqual({ snapshot: [], byteCount: inventoryBytes });
      expect(reads.shared.replay(discovery)).toEqual([]);
      await expect(reads.query('SELECT * WHERE {}')).rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE', actualBytes: inventoryBytes + resultBytes,
      });
      const exact = createQueryStoreReadContext(store, { maxMaterializedBytes: inventoryBytes + resultBytes });
      await expect(exact.listGraphsByPrefix('did:dkg:context-graph:')).resolves.toEqual([]);
      await expect(exact.query('SELECT * WHERE {}')).resolves.toEqual(result);
      const budget = new QueryMaterializationBudget(inventoryBytes);
      await expect(new GraphManager(store).listStoredContextGraphOwnerCandidates({}, budget)).resolves.toEqual([]);
      expect(() => budget.consume(result)).toThrow(expect.objectContaining({ actualBytes: inventoryBytes + resultBytes }));
    });
});
