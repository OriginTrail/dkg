import { afterEach, describe, it, expect, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  createResponderGraphListMemo,
  createResponderSubGraphRegistrationMemo,
} from '../src/sync/responder/graph-plan.js';
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

afterEach(() => {
  vi.useRealTimers();
});

function watchBoundedPageQuery(
  store: OxigraphStore,
  graph: string,
  expectedOffset: number | readonly number[],
  expectedLimit: number,
) {
  const originalQuery = store.query.bind(store);
  let observedPageQueries = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    const isTargetPageQuery = /^SELECT (?:DISTINCT )?\?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`GRAPH <${graph}>`) && normalized.includes('ORDER BY');
    const isTargetMultiGraphPageQuery = /^SELECT (?:DISTINCT )?\?g \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`VALUES ?g { <${graph}>`) && normalized.includes('ORDER BY');
    if (isTargetPageQuery || isTargetMultiGraphPageQuery) {
      observedPageQueries++;
      expect(normalized).toMatch(/ORDER BY \?g \?s \?p \?o|ORDER BY \?s \?p \?o/);
      const expectedOffsets: readonly number[] = typeof expectedOffset === 'number'
        ? [expectedOffset]
        : expectedOffset;
      expect(expectedOffsets.some((offset) => normalized.includes(`OFFSET ${offset}`))).toBe(true);
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
    const requestPage = (offset: number, index: number) =>
      cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: false,
        phase: 'data',
        offset,
        limit: 3,
      }, `12D3KooWInterleavePeer${index}`);

    const outputs = await Promise.all([0, 6, 3, 12, 9, 15].map(requestPage));

    const lines = outputs.flatMap(linesFromNquads);
    expect(lines).toHaveLength(rows.length);
    expect(new Set(lines).size).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(lines.join('\n')).toContain(`"row-${i.toString().padStart(3, '0')}"`);
    }
    const graphs = new Set(outputs.flatMap((out) => [...lineGraphsFromNquads(out)]));
    expect(graphs).toEqual(new Set([graphA, graphB, graphC]));
  });

  it('falls back to store-bounded paging when a durable snapshot exceeds its cap', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-fallback';
    const graph = `did:dkg:context-graph:${cgId}/data`;
    await store.insert([q(graph, 0), q(graph, 1), q(graph, 2)]);
    const boundedQuery = watchBoundedPageQuery(store, graph, [0, 2], 2);
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 2,
      syncSessionId: 'oversized-fallback-session',
    };

    const first = await cap.invoke({ ...base, offset: 0 });
    const second = await cap.invoke({ ...base, offset: 2 });

    expect(linesFromNquads(first)).toHaveLength(2);
    expect(linesFromNquads(second)).toHaveLength(1);
    expect(new Set(linesFromNquads(`${first}\n${second}`)).size).toBe(3);
    boundedQuery.assertObserved();
  });

  it('falls back to store-bounded paging for an oversized durable-meta snapshot', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-durable-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    // Rows keyed on the CG entity subject survive readDurableMetaRows filtering.
    await store.insert(Array.from({ length: 3 }, (_, i) => ({
      graph: metaGraph,
      subject: cgPrefix,
      predicate: `http://schema.org/p${i.toString().padStart(3, '0')}`,
      object: `"meta-${i.toString().padStart(3, '0')}"`,
    })));
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta' as const,
      limit: 2,
      syncSessionId: 'oversized-durable-meta-session',
    };

    const first = await cap.invoke({ ...base, offset: 0 });
    const second = await cap.invoke({ ...base, offset: 2 });

    expect(linesFromNquads(first)).toHaveLength(2);
    expect(linesFromNquads(second)).toHaveLength(1);
    expect(new Set(linesFromNquads(`${first}\n${second}`)).size).toBe(3);
  });

  it('falls back to store-bounded paging for an oversized shared-memory meta snapshot', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-swm-meta';
    const swmMetaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    await store.insert(Array.from({ length: 3 }, (_, index) => q(swmMetaGraph, index)));
    const boundedQuery = watchBoundedPageQuery(store, swmMetaGraph, [0, 2], 2);
    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: 0,
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta' as const,
      limit: 2,
      syncSessionId: 'oversized-swm-meta-session',
    };

    const first = await cap.invoke({ ...base, offset: 0 });
    const second = await cap.invoke({ ...base, offset: 2 });

    expect(linesFromNquads(first)).toHaveLength(2);
    expect(linesFromNquads(second)).toHaveLength(1);
    expect(new Set(linesFromNquads(`${first}\n${second}`)).size).toBe(3);
    boundedQuery.assertObserved();
  });

  it('falls back to store-bounded paging for an oversized TTL-filtered SWM data snapshot', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-swm-data-ttl';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const dataGraph = `${swmGraph}/0xabc/1`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const now = new Date().toISOString();
    const rows: Quad[] = [];
    for (let index = 0; index < 3; index++) {
      const root = `urn:interleave:${index.toString().padStart(3, '0')}`;
      rows.push(q(dataGraph, index));
      rows.push(...workspaceOpQuads(cgId, `op-${index}`, root, swmMetaGraph, now));
    }
    await store.insert(rows);

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: 60_000,
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data' as const,
      limit: 2,
      syncSessionId: 'oversized-swm-data-ttl-session',
    };

    const first = await cap.invoke({ ...base, offset: 0 });
    const second = await cap.invoke({ ...base, offset: 2 });

    expect(linesFromNquads(first)).toHaveLength(2);
    expect(linesFromNquads(second)).toHaveLength(1);
    expect(lineGraphsFromNquads(`${first}\n${second}`)).toEqual(new Set([dataGraph]));
    expect(new Set(linesFromNquads(`${first}\n${second}`)).size).toBe(3);
  });

  it('falls back to store-bounded delta paging for an oversized sinceBatchId snapshot', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-delta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const dataGraph = `${cgPrefix}/context/1`;
    const metaGraph = `${cgPrefix}/context/1/_meta`;
    const intLit = (n: number) => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
    const quads: Quad[] = [];
    for (let i = 1; i <= 3; i++) {
      const kc = `did:dkg:evm:31337/0xkc${i}`;
      const ka = `${kc}/1`;
      const root = `urn:delta-root:${i}`;
      quads.push(
        { graph: metaGraph, subject: kc, predicate: `${DKG_NS}batchId`, object: intLit(i) },
        { graph: metaGraph, subject: ka, predicate: `${DKG_NS}partOf`, object: kc },
        { graph: metaGraph, subject: ka, predicate: `${DKG_NS}rootEntity`, object: root },
        { graph: dataGraph, subject: root, predicate: `${DKG_NS}label`, object: `"delta-${i}"` },
      );
    }
    await store.insert(quads);

    const cap = registerTestSyncHandler(store, {
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 1000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 2,
      sinceBatchId: '1',
      syncSessionId: 'oversized-delta-session',
    };

    const collected: string[] = [];
    for (let offset = 0, page = 0; page < 20; page += 1, offset += 2) {
      const out = await cap.invoke({ ...base, offset });
      const lines = linesFromNquads(out);
      collected.push(...lines);
      if (lines.length < 2) break;
    }
    const joined = collected.join('\n');
    // Included: KCs with batchId 2, 3 (> sinceBatchId 1); excluded: batchId 1.
    expect(joined).toContain('"delta-2"');
    expect(joined).toContain('"delta-3"');
    expect(joined).not.toContain('"delta-1"');
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

  it('uses store-bounded paged reads for deep TTL-filtered SWM data pages', async () => {
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

    // The TTL-cutoff SWM-data read is now store-bounded (fresh roots resolved via
    // FILTER EXISTS), so a deep page pulls only the requested rows.
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

  it('uses store-bounded paged reads for deep durable meta pages', async () => {
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

    // The durable-meta read is now store-bounded (subject-membership filter
    // pushed into the store via EXISTS), so a deep page is a paged store query.
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

  it('caches sorted durable-data rows instead of issuing ordered offset page queries', async () => {
    const store = new OxigraphStore();
    const cgId = 'single-query-durable-fallback';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const fallbackGraph = `${cgPrefix}/context/1`;
    await store.insert([
      q(cgPrefix, 0),
      q(fallbackGraph, 1),
    ]);

    const originalQuery = store.query.bind(store);
    let globalRowLoads = 0;
    store.query = (async (sparql: string) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('COUNT(*)')) {
        throw new Error(`durable fallback should not count per graph: ${normalized}`);
      }
      if (
        /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
        normalized.includes(`VALUES ?g { <${cgPrefix}> <${fallbackGraph}>`)
      ) {
        globalRowLoads++;
        expect(normalized).not.toContain('ORDER BY');
        expect(normalized).not.toContain('OFFSET');
        expect(normalized).not.toContain('LIMIT');
      }
      return originalQuery(sparql);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const first = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'cache-session',
    });
    const second = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 1,
      limit: 1,
      syncSessionId: 'cache-session',
    });

    expect(globalRowLoads).toBe(1);
    expect(first).toContain('"row-000"');
    expect(first).not.toContain('"row-001"');
    expect(second).toContain('"row-001"');
    expect(second).not.toContain('"row-000"');
  });

  it('refreshes full durable-data snapshots on page zero for the same peer', async () => {
    const store = new OxigraphStore();
    const cgId = 'fresh-page-zero-durable';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    await store.insert([q(cgPrefix, 1)]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const first = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
    }, 'peer-a');
    expect(first).toContain('"row-001"');

    await store.insert([q(cgPrefix, 0)]);
    const refreshed = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
    }, 'peer-a');

    expect(refreshed).toContain('"row-000"');
    expect(refreshed).not.toContain('"row-001"');
  });

  it('isolates active durable-data row snapshots per remote peer', async () => {
    const store = new OxigraphStore();
    const cgId = 'peer-isolated-durable';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    await store.insert([q(cgPrefix, 1)]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const peerAFirst = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'peer-a-session',
    }, 'peer-a');
    expect(peerAFirst).toContain('"row-001"');

    await store.insert([q(cgPrefix, 0)]);
    const peerBFresh = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'peer-b-session',
    }, 'peer-b');
    expect(peerBFresh).toContain('"row-000"');

    const peerASecond = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 1,
      limit: 1,
      syncSessionId: 'peer-a-session',
    }, 'peer-a');
    expect(peerASecond).toBe('');
  });

  it('refreshes same-peer durable-data snapshots when the page-zero session token changes', async () => {
    const store = new OxigraphStore();
    const cgId = 'session-refresh-durable';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    await store.insert([q(cgPrefix, 1)]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const firstSessionPage = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'session-old',
    }, 'peer-a');
    expect(firstSessionPage).toContain('"row-001"');

    await store.insert([q(cgPrefix, 0)]);
    const secondSessionPage = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'session-new',
    }, 'peer-a');
    expect(secondSessionPage).toContain('"row-000"');

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 1,
      limit: 1,
      syncSessionId: 'session-old',
    }, 'peer-a')).rejects.toThrow('Durable data sync session was superseded before page completion');
  });

  it('derives durable-data cache keys server-side instead of from arbitrary session ids', async () => {
    const store = new OxigraphStore();
    const cgId = 'server-keyed-session-durable';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    await store.insert([q(cgPrefix, 1)]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    for (let i = 0; i < 40; i++) {
      const page = await cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: false,
        phase: 'data',
        offset: 0,
        limit: 1,
        syncSessionId: `attacker-controlled-${i}`,
      }, 'peer-a');
      expect(page).toContain('"row-001"');
    }
  });

  it('reuses a durable-data session snapshot on page-zero retry', async () => {
    const store = new OxigraphStore();
    const cgId = 'retry-session-durable';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    await store.insert([q(cgPrefix, 1)]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const firstAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session',
    }, 'peer-a');
    expect(firstAttempt).toContain('"row-001"');

    await store.insert([q(cgPrefix, 0)]);
    const retryAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session',
    }, 'peer-a');
    expect(retryAttempt).toBe(firstAttempt);
    expect(retryAttempt).not.toContain('"row-000"');
  });

  it('reuses a durable-meta session snapshot on page-zero retry', async () => {
    const store = new OxigraphStore();
    const cgId = 'retry-session-durable-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    await store.insert([{
      graph: metaGraph,
      subject: cgPrefix,
      predicate: 'http://schema.org/p001',
      object: '"meta-001"',
    }]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 1 });
    const firstAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-meta',
    }, 'peer-a');
    expect(firstAttempt).toContain('"meta-001"');

    await store.insert([{
      graph: metaGraph,
      subject: cgPrefix,
      predicate: 'http://schema.org/p000',
      object: '"meta-000"',
    }]);
    const retryAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-meta',
    }, 'peer-a');
    expect(retryAttempt).toBe(firstAttempt);
    expect(retryAttempt).not.toContain('"meta-000"');
  });

  it('serves the signed agent delegation needed for private-CG sync authorization', async () => {
    const store = new OxigraphStore();
    const cgId = 'private-delegation-durable-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    const delegation = `did:dkg:agent-delegation:${cgId}:0x1234`;
    const orphanDelegation = `did:dkg:agent-delegation:${cgId}:0xorphan`;
    const revokedDelegation = `did:dkg:agent-delegation:${cgId}:0xrevoked`;
    await store.insert([
      {
        graph: metaGraph,
        subject: cgPrefix,
        predicate: 'https://dkg.network/ontology#allowedAgent',
        object: '"0x1234"',
      },
      {
        graph: metaGraph,
        subject: delegation,
        predicate: 'https://dkg.network/ontology#delegationAgent',
        object: '"0x1234"',
      },
      {
        graph: metaGraph,
        subject: delegation,
        predicate: 'https://dkg.network/ontology#allowedDelegateePeer',
        object: '"12D3KooWAuthorizedJoiner"',
      },
      {
        graph: metaGraph,
        subject: orphanDelegation,
        predicate: 'https://dkg.network/ontology#delegationAgent',
        object: '"0xorphan"',
      },
      {
        graph: metaGraph,
        subject: orphanDelegation,
        predicate: 'https://dkg.network/ontology#allowedDelegateePeer',
        object: '"12D3KooWOrphaned"',
      },
      {
        graph: metaGraph,
        subject: cgPrefix,
        predicate: 'https://dkg.network/ontology#allowedAgent',
        object: '"0xrevoked"',
      },
      {
        graph: metaGraph,
        subject: cgPrefix,
        predicate: 'https://dkg.network/ontology#revokedAgent',
        object: '"0xrevoked"',
      },
      {
        graph: metaGraph,
        subject: revokedDelegation,
        predicate: 'https://dkg.network/ontology#delegationAgent',
        object: '"0xrevoked"',
      },
      {
        graph: metaGraph,
        subject: revokedDelegation,
        predicate: 'https://dkg.network/ontology#allowedDelegateePeer',
        object: '"12D3KooWRevoked"',
      },
      {
        graph: metaGraph,
        subject: 'did:dkg:agent-delegation:another-cg:0x1234',
        predicate: 'https://dkg.network/ontology#allowedDelegateePeer',
        object: '"12D3KooWUnrelated"',
      },
    ]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });
    const response = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 10,
      syncSessionId: 'private-delegation-session',
    }, 'peer-a');

    expect(response).toContain(delegation);
    expect(response).toContain('12D3KooWAuthorizedJoiner');
    expect(response).not.toContain('12D3KooWOrphaned');
    expect(response).not.toContain('12D3KooWRevoked');
    expect(response).not.toContain('12D3KooWUnrelated');

    // Force the intrinsically-oversized snapshot path so the store-bounded
    // SPARQL predicate is held to the same active-delegation contract.
    const fallbackCap = registerTestSyncHandler(store, {
      syncPageSize: 10,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const fallbackResponse = await fallbackCap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 10,
      syncSessionId: 'private-delegation-fallback-session',
    }, 'peer-a');
    expect(fallbackResponse).toContain('12D3KooWAuthorizedJoiner');
    expect(fallbackResponse).not.toContain('12D3KooWOrphaned');
    expect(fallbackResponse).not.toContain('12D3KooWRevoked');
    expect(fallbackResponse).not.toContain('12D3KooWUnrelated');
  });

  it('reuses a SWM data session snapshot on page-zero retry', async () => {
    const store = new OxigraphStore();
    const cgId = 'retry-session-swm-data';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const now = new Date().toISOString();
    await store.insert([
      q(swmGraph, 1),
      ...workspaceOpQuads(cgId, 'op-001', 'urn:interleave:001', swmMetaGraph, now),
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 1 });
    const firstAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-swm-data',
    }, 'peer-a');
    expect(firstAttempt).toContain('"row-001"');

    await store.insert([
      q(swmGraph, 0),
      ...workspaceOpQuads(cgId, 'op-000', 'urn:interleave:000', swmMetaGraph, now),
    ]);
    const retryAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-swm-data',
    }, 'peer-a');
    expect(retryAttempt).toBe(firstAttempt);
    expect(retryAttempt).not.toContain('"row-000"');
  });

  it('reuses a SWM meta session snapshot on page-zero retry', async () => {
    const store = new OxigraphStore();
    const cgId = 'retry-session-swm-meta';
    const swmMetaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const now = new Date().toISOString();
    await store.insert(workspaceOpQuads(cgId, 'op-001', 'urn:interleave:001', swmMetaGraph, now));

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 1 });
    const firstAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-swm-meta',
    }, 'peer-a');
    expect(firstAttempt).toContain('op-001');

    await store.insert(workspaceOpQuads(cgId, 'op-000', 'urn:interleave:000', swmMetaGraph, now));
    const retryAttempt = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 1,
      syncSessionId: 'retry-session-swm-meta',
    }, 'peer-a');
    expect(retryAttempt).toBe(firstAttempt);
    expect(retryAttempt).not.toContain('op-000');
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

  it('reloads graph-list and subgraph prerequisites for a newer session generation', async () => {
    const oldGraphs = deferred<string[]>();
    const newGraphs = deferred<string[]>();
    let graphCalls = 0;
    const graphStore = {
      listGraphs: async () => {
        graphCalls++;
        return graphCalls === 1 ? oldGraphs.promise : newGraphs.promise;
      },
    } as unknown as OxigraphStore;
    const graphMemo = createResponderGraphListMemo(graphStore);

    const oldGraphSession = graphMemo.get({
      refresh: true,
      refreshGeneration: 'old-session',
    });
    const newGraphSession = graphMemo.get({
      refresh: true,
      refreshGeneration: 'new-session',
    });
    await Promise.resolve();
    expect(graphCalls).toBe(1);
    oldGraphs.resolve(['urn:graph:old']);
    await expect(oldGraphSession).resolves.toEqual(['urn:graph:old']);
    await vi.waitFor(() => expect(graphCalls).toBe(2));
    newGraphs.resolve(['urn:graph:new']);
    await expect(newGraphSession).resolves.toEqual(['urn:graph:new']);

    const cgId = 'generation-aware-subgraphs';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const oldSubgraphs = deferred<any>();
    const newSubgraphs = deferred<any>();
    let subgraphCalls = 0;
    const subgraphStore = {
      query: async () => {
        subgraphCalls++;
        return subgraphCalls === 1 ? oldSubgraphs.promise : newSubgraphs.promise;
      },
    } as unknown as OxigraphStore;
    const subgraphMemo = createResponderSubGraphRegistrationMemo(subgraphStore);

    const oldSubgraphSession = subgraphMemo.get(cgId, {
      refresh: true,
      refreshGeneration: 'old-session',
    });
    const newSubgraphSession = subgraphMemo.get(cgId, {
      refresh: true,
      refreshGeneration: 'new-session',
    });
    await Promise.resolve();
    expect(subgraphCalls).toBe(1);
    oldSubgraphs.resolve({
      type: 'bindings',
      bindings: [{ sg: `${cgPrefix}/old`, name: '"old"' }],
    });
    await expect(oldSubgraphSession).resolves.toEqual(['old']);
    await vi.waitFor(() => expect(subgraphCalls).toBe(2));
    newSubgraphs.resolve({
      type: 'bindings',
      bindings: [{ sg: `${cgPrefix}/new`, name: '"new"' }],
    });
    await expect(newSubgraphSession).resolves.toEqual(['new']);
  });
});
