import { describe, expect, it } from 'vitest';
import { ChangelogStore, GraphManager, GraphSetIndexStore, SharedMemoryLiteralBlobStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { createQueryStoreReadContext, requireQueryDataset } from '../src/query-store-read-context.js';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';

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
  const slicePrefix = 'urn:unrelated:999:';
  const slice = graphs.filter(graph => graph.startsWith(slicePrefix));
  const sliceBytes = Buffer.byteLength(JSON.stringify(slice), 'utf8');
  const emptyBytes = Buffer.byteLength(JSON.stringify([]), 'utf8');
  const result = { type: 'bindings' as const, bindings: [{ value: '"ok"' }] };
  const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const store = { listGraphs: async () => graphs, query: async () => result } as unknown as TripleStore;

  it.each(['enumeration', 'catalog', 'withheld'] as const)('charges only the slice it returns in the %s lane', async kind => {
    expect(slice).toHaveLength(1);
    expect(rawBytes).toBeGreaterThan(100 * sliceBytes);
    const context = createQueryStoreReadContext(store, { maxMaterializedBytes: 1024 });
    const lane = kind === 'enumeration' ? context : kind === 'catalog' ? context.catalog : context.withWithheldGraphRoots([]);
    await expect(lane.listGraphsByPrefix('urn:absent:')).resolves.toEqual([]);
    await expect(lane.listGraphsByPrefix(slicePrefix)).resolves.toEqual(slice);
    // The request's enumeration reads a prefix once: reading it again is not charged, the next
    // prefix is. The catalog and withheld lanes read, and charge, every time.
    if (kind === 'enumeration') await expect(lane.listGraphsByPrefix(slicePrefix)).resolves.toEqual(slice);
    const next = kind === 'enumeration' ? 'urn:unrelated:998:' : slicePrefix;
    await expect(lane.listGraphsByPrefix(next)).rejects.toMatchObject({
      code: 'QUERY_MATERIALIZATION_TOO_LARGE', maxBytes: 1024, actualBytes: emptyBytes + 2 * sliceBytes,
    });
  });

  it('retains the slice cost for cache replay and caller-local cumulative charging', async () => {
    const loader = createQueryStoreReadContext(store, { maxMaterializedBytes: sliceBytes });
    const discovery = await loader.shared.measure(reads => reads.listGraphsByPrefix(slicePrefix));
    expect(discovery).toEqual({ snapshot: slice, byteCount: sliceBytes });
    expect(loader.shared.replay(discovery)).toEqual(slice);
    await expect(loader.query('SELECT * WHERE {}')).rejects.toMatchObject({ actualBytes: sliceBytes + resultBytes });
    const other = createQueryStoreReadContext(store, { maxMaterializedBytes: sliceBytes + resultBytes });
    expect(other.shared.replay(discovery)).toEqual(slice);
    await expect(other.query('SELECT * WHERE {}')).resolves.toEqual(result);
    const small = createQueryStoreReadContext(store, { maxMaterializedBytes: sliceBytes - 1 });
    expect(() => small.shared.replay(discovery)).toThrow(expect.objectContaining({ actualBytes: sliceBytes }));
  });

  it('charges direct fallback enumeration once, then adds the query result', async () => {
    const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: sliceBytes + resultBytes });
    await expect(reads.listGraphsByPrefix(slicePrefix)).resolves.toEqual(slice);
    await expect(reads.query('SELECT * WHERE {}')).resolves.toEqual(result);
    await expect(reads.query('SELECT * WHERE {}')).rejects.toMatchObject({ actualBytes: sliceBytes + 2 * resultBytes });
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
    ('charges the visible slice through %s and cache replay without exposing reserved graphs', async kind => {
      const store = decorate(kind);
      // The reserved graph is the only match: the visible slice is empty, whatever the inventory behind it.
      const emptyBytes = Buffer.byteLength(JSON.stringify([]));
      expect(inventoryBytes).toBeGreaterThan(1000 * emptyBytes);
      const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: emptyBytes });
      const discovery = await reads.shared.measure(lane => lane.listGraphsByPrefix('did:dkg:context-graph:'));
      expect(discovery).toEqual({ snapshot: [], byteCount: emptyBytes });
      expect(reads.shared.replay(discovery)).toEqual([]);
      await expect(reads.query('SELECT * WHERE {}')).rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE', actualBytes: emptyBytes + resultBytes,
      });
      const exact = createQueryStoreReadContext(store, { maxMaterializedBytes: emptyBytes + resultBytes });
      await expect(exact.listGraphsByPrefix('did:dkg:context-graph:')).resolves.toEqual([]);
      await expect(exact.query('SELECT * WHERE {}')).resolves.toEqual(result);
      // The owner inventory of unscoped admission is node work: it is read, never charged.
      await expect(new GraphManager(store).listStoredContextGraphOwnerCandidates({})).resolves.toEqual([]);
    });
});

describe('requireQueryDataset', () => {
  it('passes a read that sets its own dataset and refuses one that does not', async () => {
    const sent: string[] = [];
    const answer = { type: 'bindings' as const, bindings: [] };
    const store = { async query(sparql: string) { sent.push(sparql); return answer; } } as unknown as TripleStore;
    const reads = requireQueryDataset(createQueryStoreReadContext(store, undefined));
    const withDataset = 'SELECT ?s FROM NAMED <urn:g> WHERE { GRAPH ?g { ?s ?p ?o } }';

    await expect(reads.query(withDataset, true)).resolves.toEqual(answer);
    await expect(reads.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toBeInstanceOf(ScopedQueryViolationError);
    expect(sent).toEqual([withDataset]);
  });
});
