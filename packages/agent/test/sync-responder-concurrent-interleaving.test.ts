import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  lineGraphsFromNquads,
  linesFromNquads,
  registerTestSyncHandler,
  workspaceOpQuads,
} from './_helpers/sync-responder.js';

function q(graph: string, index: number): Quad {
  return {
    graph,
    subject: `urn:interleave:${index.toString().padStart(3, '0')}`,
    predicate: `${DKG_NS}label`,
    object: `"row-${index.toString().padStart(3, '0')}"`,
  };
}

function watchBoundedPageQuery(
  store: OxigraphStore,
  graph: string,
  expectedOffset: number,
  expectedLimit: number,
) {
  const originalQuery = store.query.bind(store);
  let observedPageQueries = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    const isTargetPageQuery = /^SELECT (?:DISTINCT )?\?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`GRAPH <${graph}>`);
    if (isTargetPageQuery) {
      observedPageQueries++;
      expect(normalized).toContain('ORDER BY ?s ?p ?o');
      expect(normalized).toContain(`OFFSET ${expectedOffset}`);
      expect(normalized).toContain(`LIMIT ${expectedLimit}`);
    }
    const result = await originalQuery(sparql);
    if (isTargetPageQuery && result.type === 'bindings') {
      expect(result.bindings.length).toBeLessThanOrEqual(expectedLimit);
    }
    return result;
  }) as OxigraphStore['query'];

  return {
    assertObserved() {
      expect(observedPageQueries).toBeGreaterThan(0);
    },
  };
}

describe('sync responder pagination interleaving', () => {
  it('returns an exact no-gap/no-duplicate union across overlapping durable-data page loops', async () => {
    const store = new OxigraphStore();
    const cgId = 'interleave-cg';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const graphA = `${cgPrefix}/a`;
    const graphB = `${cgPrefix}/b`;
    const graphC = `${cgPrefix}/c`;
    const rows: Quad[] = [];
    for (let i = 0; i < 18; i++) {
      rows.push(q(i < 6 ? graphA : i < 12 ? graphB : graphC, i));
    }
    await store.insert(rows);

    const cap = registerTestSyncHandler(store, { syncPageSize: 3 });
    const requestPage = (offset: number) =>
      cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: false,
        phase: 'data',
        offset,
        limit: 3,
      });

    const outputs = await Promise.all([
      requestPage(0),
      requestPage(6),
      requestPage(3),
      requestPage(12),
      requestPage(9),
      requestPage(15),
    ]);

    const lines = outputs.flatMap(linesFromNquads);
    expect(lines).toHaveLength(rows.length);
    expect(new Set(lines).size).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(lines.join('\n')).toContain(`"row-${i.toString().padStart(3, '0')}"`);
    }
    const graphs = new Set(outputs.flatMap((out) => [...lineGraphsFromNquads(out)]));
    expect(graphs).toEqual(new Set([graphA, graphB, graphC]));
  });

  it('uses bounded store-side paging for deep SWM data pages without TTL', async () => {
    const store = new OxigraphStore();
    const cgId = 'bounded-swm';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    await store.insert(Array.from({ length: 100 }, (_, index) => q(swmGraph, index)));

    const probe = watchBoundedPageQuery(store, swmGraph, 90, 5);
    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 0, syncPageSize: 5 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 90,
      limit: 5,
    });

    probe.assertObserved();
    const lines = linesFromNquads(out);
    expect(lines).toHaveLength(5);
    expect(out).toContain('"row-090"');
    expect(out).toContain('"row-094"');
    expect(out).not.toContain('"row-089"');
    expect(out).not.toContain('"row-095"');
  });

  it('uses bounded store-side paging for deep SWM data pages with TTL filtering', async () => {
    const store = new OxigraphStore();
    const cgId = 'bounded-swm-ttl';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const now = new Date().toISOString();
    const rows: Quad[] = [];
    for (let index = 0; index < 100; index++) {
      const root = `urn:interleave:${index.toString().padStart(3, '0')}`;
      rows.push(q(swmGraph, index));
      rows.push(...workspaceOpQuads(cgId, `op-${index}`, root, swmMetaGraph, now));
    }
    await store.insert(rows);

    const probe = watchBoundedPageQuery(store, swmGraph, 90, 5);
    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 5 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 90,
      limit: 5,
    });

    probe.assertObserved();
    const lines = linesFromNquads(out);
    expect(lines).toHaveLength(5);
    expect(out).toContain('"row-090"');
    expect(out).toContain('"row-094"');
    expect(out).not.toContain('"row-089"');
    expect(out).not.toContain('"row-095"');
  });

  it('uses bounded store-side paging for deep durable meta pages', async () => {
    const store = new OxigraphStore();
    const cgId = 'bounded-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    const rows: Quad[] = [];
    for (let index = 0; index < 100; index++) {
      const padded = index.toString().padStart(3, '0');
      rows.push({
        graph: metaGraph,
        subject: cgPrefix,
        predicate: `http://schema.org/p${padded}`,
        object: `"meta-${padded}"`,
      });
    }
    rows.push({
      graph: metaGraph,
      subject: 'urn:noise',
      predicate: 'http://schema.org/p000',
      object: '"noise-leak"',
    });
    await store.insert(rows);

    const probe = watchBoundedPageQuery(store, metaGraph, 90, 5);
    const cap = registerTestSyncHandler(store, { syncPageSize: 5 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 90,
      limit: 5,
    });

    probe.assertObserved();
    const lines = linesFromNquads(out);
    expect(lines).toHaveLength(5);
    expect(out).toContain('"meta-090"');
    expect(out).toContain('"meta-094"');
    expect(out).not.toContain('"meta-089"');
    expect(out).not.toContain('"meta-095"');
    expect(out).not.toContain('"noise-leak"');
  });
});
