import { describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { readSwmDataPage } from '../src/sync/responder/graph-plan.js';

describe('graph-backed shared-memory responder planning', () => {
  const contextGraphId = 'test/graph-backed-cg';
  const dataGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
  const metaGraph = `${dataGraph}_meta`;
  const snapshotGraph = `did:dkg:context-graph:${encodeURIComponent(contextGraphId)}`
    + '/_shared_memory_snapshots/_/share-op-1/ka';
  const rows = [0, 1, 2].map((index) => ({
    s: `urn:graph-backed:${index}`,
    p: 'http://schema.org/value',
    o: `"${index}"`,
    g: snapshotGraph,
  }));

  function storeWithActualCount(actualCount = rows.length): TripleStore {
    return {
      async query(sparql: string) {
        if (sparql.includes('SELECT DISTINCT ?g ?root')) {
          return { type: 'bindings' as const, bindings: [] };
        }
        if (sparql.includes('SELECT DISTINCT ?snapshotGraph ?count ?ts')) {
          return {
            type: 'bindings' as const,
            bindings: [{
              snapshotGraph,
              count: `"${rows.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
              ts: '"2026-08-15T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
            }],
          };
        }
        if (sparql.includes(`SELECT (<${snapshotGraph}> AS ?g) (COUNT(*) AS ?count)`)) {
          return {
            type: 'bindings' as const,
            bindings: [{ g: snapshotGraph, count: String(actualCount) }],
          };
        }
        if (sparql.includes(`GRAPH <${snapshotGraph}> { ?s ?p ?o }`)) {
          const offset = Number(/OFFSET (\d+)/.exec(sparql)?.[1] ?? 0);
          const limit = Number(/LIMIT (\d+)/.exec(sparql)?.[1] ?? rows.length);
          return {
            type: 'bindings' as const,
            bindings: rows.slice(offset, offset + limit),
          };
        }
        return { type: 'bindings' as const, bindings: [] };
      },
    } as unknown as TripleStore;
  }

  it('serves a fresh immutable snapshot graph as one paged batch plan', async () => {
    const first = await readSwmDataPage({
      store: storeWithActualCount(),
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 0,
      limit: 2,
    });
    const second = await readSwmDataPage({
      store: storeWithActualCount(),
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 2,
      limit: 2,
    });

    expect([...first, ...second]).toEqual(rows);
  });

  it('fails closed when operation metadata and stored graph count disagree', async () => {
    await expect(readSwmDataPage({
      store: storeWithActualCount(rows.length - 1),
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 0,
      limit: 2,
    })).rejects.toThrow('count mismatch');
  });

  it('executes the graph-backed discovery and count plan against Oxigraph', async () => {
    const store = new OxigraphStore();
    const operation = 'urn:dkg:share:graph-backed-real-store';
    const head = 'did:dkg:test/graph-backed/1#dkg-swm-head';
    const shareOperationId = 'share-op-1';
    const staleOperation = 'urn:dkg:share:graph-backed-stale';
    const staleSnapshotGraph = `did:dkg:context-graph:${encodeURIComponent(contextGraphId)}`
      + '/_shared_memory_snapshots/_/stale-share-op/ka';
    await store.insert([
      {
        graph: metaGraph,
        subject: head,
        predicate: 'http://dkg.io/ontology/shareOperationId',
        object: `"${shareOperationId}"`,
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/WorkspaceOperation',
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://dkg.io/ontology/shareOperationId',
        object: `"${shareOperationId}"`,
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://dkg.io/ontology/contentScopeVersion',
        object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://dkg.io/ontology/publicSnapshotGraph',
        object: snapshotGraph,
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: `"${rows.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      },
      {
        graph: metaGraph,
        subject: operation,
        predicate: 'http://dkg.io/ontology/publishedAt',
        object: '"2026-08-15T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      },
      // Superseded operations remain in metadata history. This intentionally
      // advertises a missing graph/count mismatch and must be ignored because
      // no canonical head references its shareOperationId.
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/WorkspaceOperation',
      },
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://dkg.io/ontology/shareOperationId',
        object: '"stale-share-op"',
      },
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://dkg.io/ontology/contentScopeVersion',
        object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      },
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://dkg.io/ontology/publicSnapshotGraph',
        object: staleSnapshotGraph,
      },
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: '"999"^^<http://www.w3.org/2001/XMLSchema#integer>',
      },
      {
        graph: metaGraph,
        subject: staleOperation,
        predicate: 'http://dkg.io/ontology/publishedAt',
        object: '"2026-08-15T00:01:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      },
      ...rows.map((row) => ({
        graph: row.g,
        subject: row.s,
        predicate: row.p,
        object: row.o,
      })),
    ]);

    const actual = await readSwmDataPage({
      store,
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 0,
      limit: 10,
    });

    expect(actual).toEqual(rows);
    await store.close();
  });

  it('emits graph-backed groups before legacy root-scoped rows across pages', async () => {
    const store = new OxigraphStore();
    const operation = 'urn:dkg:share:graph-backed-mixed';
    const head = 'did:dkg:test/graph-backed/mixed#dkg-swm-head';
    const legacyOperation = 'urn:dkg:share:legacy-mixed';
    const legacyRoot = 'urn:legacy:root';
    const legacyRows = [
      { subject: legacyRoot, predicate: 'http://schema.org/name', object: '"root"' },
      { subject: `${legacyRoot}/.well-known/genid/1`, predicate: 'http://schema.org/value', object: '"child"' },
    ];
    await store.insert([
      { graph: metaGraph, subject: head, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"share-op-1"' },
      { graph: metaGraph, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: metaGraph, subject: operation, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"share-op-1"' },
      { graph: metaGraph, subject: operation, predicate: 'http://dkg.io/ontology/contentScopeVersion', object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { graph: metaGraph, subject: operation, predicate: 'http://dkg.io/ontology/publicSnapshotGraph', object: snapshotGraph },
      { graph: metaGraph, subject: operation, predicate: 'http://dkg.io/ontology/publicQuadsCount', object: `"${rows.length}"^^<http://www.w3.org/2001/XMLSchema#integer>` },
      { graph: metaGraph, subject: operation, predicate: 'http://dkg.io/ontology/publishedAt', object: '"2026-08-15T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' },
      { graph: metaGraph, subject: legacyOperation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: metaGraph, subject: legacyOperation, predicate: 'http://dkg.io/ontology/rootEntity', object: legacyRoot },
      { graph: metaGraph, subject: legacyOperation, predicate: 'http://dkg.io/ontology/publishedAt', object: '"2026-08-15T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' },
      ...rows.map((row) => ({ graph: row.g, subject: row.s, predicate: row.p, object: row.o })),
      ...legacyRows.map((row) => ({ graph: dataGraph, ...row })),
    ]);

    const page1 = await readSwmDataPage({
      store,
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 0,
      limit: 4,
    });
    const page2 = await readSwmDataPage({
      store,
      graphList: [dataGraph, metaGraph, snapshotGraph],
      registeredSubGraphNames: [],
      contextGraphId,
      cutoffIso: '2026-08-14T00:00:00.000Z',
      offset: 4,
      limit: 4,
    });
    const actual = [...page1, ...page2];
    expect(actual.slice(0, rows.length).every((row) => row.g === snapshotGraph)).toBe(true);
    expect(actual.slice(rows.length).every((row) => row.g === dataGraph)).toBe(true);
    expect(actual).toHaveLength(rows.length + legacyRows.length);
    await store.close();
  });
});
