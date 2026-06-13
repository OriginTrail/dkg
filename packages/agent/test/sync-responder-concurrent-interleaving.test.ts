import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { createResponderGraphListMemo } from '../src/sync/responder/graph-plan.js';
import {
  DKG_NS,
  lineGraphsFromNquads,
  linesFromNquads,
  registerTestSyncHandler,
  subGraphRegistrationQuads,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    const isTargetMultiGraphPageQuery = /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`VALUES ?g { <${graph}>`);
    if (isTargetPageQuery || isTargetMultiGraphPageQuery) {
      observedPageQueries++;
      expect(normalized).toMatch(/ORDER BY \?g \?s \?p \?o|ORDER BY \?s \?p \?o/);
      expect(normalized).toContain(`OFFSET ${expectedOffset}`);
      expect(normalized).toContain(`LIMIT ${expectedLimit}`);
    }
    const result = await originalQuery(sparql);
    if ((isTargetPageQuery || isTargetMultiGraphPageQuery) && result.type === 'bindings') {
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

  it('uses bounded store-side paging for deep SWM meta pages', async () => {
    const store = new OxigraphStore();
    const cgId = 'bounded-swm-meta';
    const swmMetaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    await store.insert(Array.from({ length: 100 }, (_, index) => q(swmMetaGraph, index)));

    const probe = watchBoundedPageQuery(store, swmMetaGraph, 90, 5);
    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 0, syncPageSize: 5 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
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
    const dataGraph = `${swmGraph}/0xabc/1`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const now = new Date().toISOString();
    const rows: Quad[] = [];
    for (let index = 0; index < 100; index++) {
      const root = `urn:interleave:${index.toString().padStart(3, '0')}`;
      rows.push(q(dataGraph, index));
      rows.push(...workspaceOpQuads(cgId, `op-${index}`, root, swmMetaGraph, now));
    }
    await store.insert(rows);

    const probe = watchBoundedPageQuery(store, dataGraph, 90, 5);
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
    expect(lineGraphsFromNquads(out)).toEqual(new Set([dataGraph]));
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

  it('refreshes the graph list before canonical page-zero durable fallback', async () => {
    const store = new OxigraphStore();
    const cgId = 'memo-refresh-before-canonical-fallback';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const fallbackGraph = `${cgPrefix}/context/1`;
    await store.insert([
      q(cgPrefix, 0),
      q(fallbackGraph, 1),
    ]);

    const originalListGraphs = store.listGraphs.bind(store);
    let listGraphCalls = 0;
    store.listGraphs = async () => {
      listGraphCalls++;
      return originalListGraphs();
    };

    const cap = registerTestSyncHandler(store, { syncPageSize: 2 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 2,
    });

    expect(listGraphCalls).toBe(1);
    expect(out).toContain('"row-000"');
    expect(out).toContain('"row-001"');
    expect(lineGraphsFromNquads(out)).toEqual(new Set([cgPrefix, fallbackGraph]));
  });

  it('durable fallback pages admitted graphs with one global store query', async () => {
    const store = new OxigraphStore();
    const cgId = 'single-query-durable-fallback';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const fallbackGraph = `${cgPrefix}/context/1`;
    await store.insert([
      q(cgPrefix, 0),
      q(fallbackGraph, 1),
    ]);

    const originalQuery = store.query.bind(store);
    let globalPageQueries = 0;
    store.query = (async (sparql: string) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('COUNT(*)')) {
        throw new Error(`durable fallback should not count per graph: ${normalized}`);
      }
      if (
        /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
        normalized.includes(`VALUES ?g { <${cgPrefix}> <${fallbackGraph}>`) &&
        normalized.includes('ORDER BY ?g ?s ?p ?o')
      ) {
        globalPageQueries++;
      }
      return originalQuery(sparql);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 1,
      limit: 1,
    });

    expect(globalPageQueries).toBe(1);
    expect(out).toContain('"row-001"');
    expect(out).not.toContain('"row-000"');
  });

  it('reuses the responder graph-list memo across nearby page requests', async () => {
    const store = new OxigraphStore();
    const cgId = 'memo-swm';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    await store.insert(Array.from({ length: 2 }, (_, index) => q(swmGraph, index)));
    const originalListGraphs = store.listGraphs.bind(store);
    let listGraphCalls = 0;
    store.listGraphs = async () => {
      listGraphCalls++;
      return originalListGraphs();
    };

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 0, syncPageSize: 1 });
    await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 1,
    });
    await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 1,
      limit: 1,
    });

    expect(listGraphCalls).toBe(1);
  });

  it('keeps SWM data pagination stable when a subgraph appears after page zero', async () => {
    const store = new OxigraphStore();
    const cgId = 'memo-stable-swm';
    const rootSwm = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const subSwm = `did:dkg:context-graph:${cgId}/later/_shared_memory`;
    await store.insert([
      q(rootSwm, 0),
      q(rootSwm, 1),
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 0, syncPageSize: 1 });
    const first = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 1,
    });

    await store.insert([
      ...subGraphRegistrationQuads(cgId, 'later'),
      {
        graph: subSwm,
        subject: 'urn:interleave:000',
        predicate: `${DKG_NS}label`,
        object: '"new-subgraph-row"',
      },
    ]);

    const second = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 1,
      limit: 1,
    });

    expect(first).toContain('"row-000"');
    expect(second).toContain('"row-001"');
    expect(second).not.toContain('"new-subgraph-row"');
  });

  it('joins an in-flight graph-list refresh before serving cached pages', async () => {
    const firstRefresh = deferred<string[]>();
    const secondRefresh = deferred<string[]>();
    let calls = 0;
    const store = {
      listGraphs: async () => {
        calls++;
        return calls === 1 ? firstRefresh.promise : secondRefresh.promise;
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store);

    const initial = memo.get({ refresh: true });
    firstRefresh.resolve(['old']);
    await expect(initial).resolves.toEqual(['old']);

    const refreshing = memo.get({ refresh: true });
    const overlappingRefresh = memo.get({ refresh: true });
    const deepPage = memo.get();
    secondRefresh.resolve(['new']);

    await expect(refreshing).resolves.toEqual(['new']);
    await expect(overlappingRefresh).resolves.toEqual(['new']);
    await expect(deepPage).resolves.toEqual(['new']);
    expect(calls).toBe(2);
  });
});
