import { afterEach, describe, it, expect, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  createResponderGraphListMemo,
  createResponderSyncRowListMemo,
  readDurableMetaPage,
  SyncRowSnapshotLimitError,
  type SyncRowListMemo,
} from '../src/sync/responder/graph-plan.js';
import {
  SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT,
  SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT,
  SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
  SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
  SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
  SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT,
  SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
  resolveSyncResponderSnapshotBudgetOptions,
} from '../src/sync/responder/sync-handler.js';
import {
  createSyncResponderSnapshotBudget,
  SyncRowSnapshotBudgetError,
} from '../src/sync/responder/snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../src/sync/memory-telemetry.js';
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

it('keeps responder snapshot defaults above the generic memo fallback', () => {
  expect(SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT).toBe(128);
  expect(SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT).toBe(64);
  expect(SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT).toBe(64);
  expect(SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT).toBe(750_000);
  expect(SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT).toBe(384 * 1024 * 1024);
  expect(SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT).toBe(250_000);
  expect(SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT).toBe(128 * 1024 * 1024);
});

it('allows operators to override every responder snapshot budget limit', () => {
  expect(resolveSyncResponderSnapshotBudgetOptions({
    DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: '101',
    DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '202',
    DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT: '303',
    DKG_SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '404',
  })).toEqual({
    maxRows: 101,
    maxBytesEstimate: 202,
    maxSnapshotRows: 303,
    maxSnapshotBytesEstimate: 404,
  });
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

function watchUnorderedSnapshotRead(
  store: OxigraphStore,
  graph: string,
) {
  const originalQuery = store.query.bind(store);
  let observedSnapshotReads = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    const isTargetSnapshotRead = /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`VALUES ?g { <${graph}>`) &&
      normalized.includes('GRAPH ?g { ?s ?p ?o }');
    if (isTargetSnapshotRead) {
      observedSnapshotReads++;
      expect(normalized).not.toContain('ORDER BY');
      expect(normalized).not.toContain('OFFSET ');
      expect(normalized).not.toContain('LIMIT ');
    }
    return originalQuery(sparql);
  }) as OxigraphStore['query'];

  return {
    assertObserved() {
      expect(observedSnapshotReads).toBeGreaterThan(0);
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

  it('uses unordered snapshot reads for deep SWM data pages with TTL filtering', async () => {
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

    const probe = watchUnorderedSnapshotRead(store, dataGraph);
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

  it('uses unordered snapshot reads for deep durable meta pages', async () => {
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

    const probe = watchUnorderedSnapshotRead(store, metaGraph);
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

  it('keeps active durable row snapshots alive while pages are still being read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const memo = createResponderSyncRowListMemo(10);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);

    vi.setSystemTime(9);
    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);

    vi.setSystemTime(18);
    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);
    expect(loads).toBe(1);
  });

  it('does not rebuild an expired durable row snapshot for the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const memo = createResponderSyncRowListMemo(10);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable', loadRows)).resolves.toHaveLength(1);

    vi.setSystemTime(11);
    await expect(memo.get('durable', loadRows)).rejects.toThrow(
      'Durable data sync session snapshot expired before page completion',
    );
    expect(loads).toBe(1);
  });

  it('does not retain empty durable row snapshots against the active cap', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 1);
    let emptyLoads = 0;
    let nonEmptyLoads = 0;

    await expect(memo.get('durable:empty', async () => {
      emptyLoads++;
      return [];
    })).resolves.toHaveLength(0);

    await expect(memo.get('durable:non-empty', async () => {
      nonEmptyLoads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: '"snapshot"',
        g: 'urn:memo:graph',
      }];
    })).resolves.toHaveLength(1);

    expect(emptyLoads).toBe(1);
    expect(nonEmptyLoads).toBe(1);
  });

  it('rejects new durable row snapshots at the active cap without evicting existing sessions', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 2);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable:session-1', loadRows)).resolves.toHaveLength(1);
    await expect(memo.get('durable:session-2', loadRows)).resolves.toHaveLength(1);
    await expect(memo.get('durable:session-3', loadRows)).rejects.toThrow(
      SyncRowSnapshotLimitError,
    );
    await expect(memo.get('durable:session-3', loadRows)).rejects.toMatchObject({
      key: 'durable:session-3',
      maxEntries: 2,
      cachedEntries: 2,
      inflightEntries: 0,
      activeEntries: 2,
    });

    await expect(
      memo.get('durable:session-1', loadRows, { requireExisting: true }),
    ).resolves.toMatchObject([{ o: '"snapshot-1"' }]);
    expect(loads).toBe(2);
  });

  it('retains the completed snapshot for reuse when the serving request aborts mid-build', async () => {
    // The owner's row load is not abort-aware, so a settled snapshot is the
    // COMPLETE result even if the owner's stream aborted while it was loading.
    // The aborted owner must still reject, but the snapshot it already paid to
    // build must be cached so a later same-session request reuses it instead of
    // issuing a second, redundant store query (regression: PR #1142 discarded it,
    // breaking sync-responder-protection's "keeps row-list cache-miss owners
    // counted until the shared snapshot settles" on the CI ordering).
    const memo = createResponderSyncRowListMemo(10_000, 1);
    const snapshot = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    const controller = new AbortController();
    let loads = 0;
    const loadRows = () => {
      loads += 1;
      return snapshot.promise;
    };

    const first = memo.get('durable:aborted', loadRows, { signal: controller.signal });
    controller.abort(new Error('request aborted'));
    snapshot.resolve([{
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"aborted"',
      g: 'urn:memo:graph',
    }]);

    // The aborting owner still rejects (its stream is gone).
    await expect(first).rejects.toThrow('request aborted');

    // A later same-session reader reuses the cached snapshot — no second load.
    await expect(
      memo.get('durable:aborted', () => {
        throw new Error('snapshot must be reused, not re-loaded');
      }, { requireExisting: true }),
    ).resolves.toHaveLength(1);
    expect(loads).toBe(1);
  });

  it('evicts a released durable row snapshot before blocking new work', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 1);
    const row = {
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"snapshot"',
      g: 'urn:memo:graph',
    };

    await expect(memo.get('durable:complete', async () => [row])).resolves.toHaveLength(1);
    memo.release('durable:complete', { graceMs: 10 });

    await expect(memo.get('durable:blocked', async () => [row])).resolves.toHaveLength(1);
    await expect(
      memo.get('durable:complete', async () => [], { requireExisting: true }),
    ).resolves.toBeNull();
  });

  it('coalesces concurrent durable row snapshot refreshes', async () => {
    const memo = createResponderSyncRowListMemo();
    const snapshot = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    let loads = 0;
    const loadRows = () => {
      loads++;
      return snapshot.promise;
    };

    const first = memo.get('durable', loadRows, { refresh: true });
    const second = memo.get('durable', loadRows, { refresh: true });
    snapshot.resolve([{
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"snapshot"',
      g: 'urn:memo:graph',
    }]);

    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(loads).toBe(1);
  });

  it('shares one row budget across durable-data, durable-meta, and shared-memory snapshots', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 4,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 4,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const durableData = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const durableMeta = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_meta',
      budget,
    });
    const sharedMemory = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'shared_memory',
      budget,
    });
    const rows = (label: string) => [0, 1].map((index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));

    const dataRows = rows('data');
    await expect(durableData.get('data', async () => dataRows)).resolves.toBe(dataRows);
    await expect(durableMeta.get('meta', async () => rows('meta'))).resolves.toHaveLength(2);
    // A hit makes durable-data most recently used; durable-meta is now the LRU.
    await expect(durableData.get('data', async () => [])).resolves.toBe(dataRows);
    durableMeta.release('meta', { graceMs: 10_000 });

    await expect(sharedMemory.get('swm', async () => rows('swm'))).resolves.toHaveLength(2);

    expect(budget.stats()).toEqual({
      snapshots: 2,
      rows: 4,
      bytesEstimate: expect.any(Number),
    });
    await expect(
      durableMeta.get('meta', async () => rows('must-not-reload'), { requireExisting: true }),
    ).resolves.toBeNull();
    await expect(
      durableData.get('data', async () => rows('must-not-reload'), { requireExisting: true }),
    ).resolves.toBe(dataRows);
  });

  it('rejects one oversized snapshot without retaining it or evicting unrelated data', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 10,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const makeRows = (count: number) => Array.from({ length: count }, (_, index) => ({
      s: `urn:row:${index}`,
      p: `${DKG_NS}label`,
      o: `"row-${index}"`,
      g: 'urn:graph',
    }));
    const retained = makeRows(2);

    await expect(memo.get('retained', async () => retained)).resolves.toBe(retained);
    await expect(memo.get('oversized', async () => makeRows(3))).rejects.toMatchObject({
      name: SyncRowSnapshotBudgetError.name,
      reason: 'snapshot_rows',
      rows: 3,
    });
    expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });
    await expect(memo.get('retained', async () => [], { requireExisting: true })).resolves.toBe(retained);
  });

  it('repeats a typed budget result for the same rejected session instead of reporting expiry', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 10,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 1,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    let loads = 0;
    const loadRows = async () => {
      loads += 1;
      return [0, 1].map((index) => ({
        s: `urn:retry:${index}`,
        p: `${DKG_NS}label`,
        o: `"retry-${index}"`,
        g: 'urn:retry:graph',
      }));
    };

    await expect(memo.get('same-session', loadRows)).rejects.toMatchObject({
      name: 'SyncRowSnapshotBudgetError',
      reason: 'snapshot_rows',
    });
    await expect(memo.get('same-session', loadRows)).rejects.toMatchObject({
      name: 'SyncRowSnapshotBudgetError',
      reason: 'snapshot_rows',
    });
    expect(loads).toBe(1);
  });

  it('preserves a previously-good snapshot when its refresh exceeds the budget', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 4,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const rows = (count: number, label: string) => Array.from({ length: count }, (_, index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));
    const original = rows(2, 'original');

    await expect(memo.get('refresh', async () => original)).resolves.toBe(original);
    await expect(
      memo.get('refresh', async () => rows(3, 'oversized'), { refresh: true }),
    ).rejects.toMatchObject({ reason: 'snapshot_rows' });
    await expect(
      memo.get('refresh', async () => [], { requireExisting: true }),
    ).resolves.toBe(original);
    expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });
  });

  it('enforces per-snapshot estimated-byte limits independently of row limits', async () => {
    const row = {
      s: 'urn:bytes:s',
      p: `${DKG_NS}label`,
      o: `"${'x'.repeat(256)}"`,
      g: 'urn:bytes:graph',
    };
    const estimate = estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100,
      maxBytesEstimate: estimate * 10,
      maxSnapshotRows: 100,
      maxSnapshotBytesEstimate: estimate - 1,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });

    await expect(memo.get('byte-heavy', async () => [row])).rejects.toMatchObject({
      reason: 'snapshot_bytes',
      bytesEstimate: estimate,
    });
  });

  it('evicts released snapshots under byte pressure while keeping active snapshots pinned', async () => {
    const makeRow = (label: string) => ({
      s: `urn:${label}:s`,
      p: `${DKG_NS}label`,
      o: `"${'x'.repeat(128)}"`,
      g: `urn:${label}:graph`,
    });
    const estimate = estimateStringRowHeapBytes(
      makeRow('a').s,
      makeRow('a').p,
      makeRow('a').o,
      makeRow('a').g,
    );
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100,
      maxBytesEstimate: estimate + 32,
      maxSnapshotRows: 100,
      maxSnapshotBytesEstimate: estimate + 32,
    });
    const first = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_data', budget });
    const second = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_meta', budget });

    await first.get('first', async () => [makeRow('a')]);
    await expect(second.get('second', async () => [makeRow('b')])).rejects.toMatchObject({
      reason: 'global_bytes',
    });
    await expect(first.get('first', async () => [], { requireExisting: true })).resolves.toHaveLength(1);

    first.release('first', { graceMs: 10_000 });
    await expect(second.get('second', async () => [makeRow('b')])).resolves.toHaveLength(1);
    await expect(first.get('first', async () => [], { requireExisting: true })).resolves.toBeNull();
  });

  it('keeps completed loads from aborted owners inside the shared retained-row budget', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 2,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });

    for (let session = 0; session < 5; session += 1) {
      const rows = [0, 1].map((index) => ({
        s: `urn:aborted:${session}:${index}`,
        p: `${DKG_NS}label`,
        o: `"row-${index}"`,
        g: 'urn:aborted:graph',
      }));
      const snapshot = deferred<readonly typeof rows[number][]>();
      const controller = new AbortController();
      const request = memo.get(`aborted:${session}`, () => snapshot.promise, {
        signal: controller.signal,
      });
      controller.abort(new Error('owner disconnected'));
      snapshot.resolve(rows);

      await expect(request).rejects.toThrow('owner disconnected');
      // Join the owner-independent load so its cache admission has settled.
      await expect(
        memo.get(`aborted:${session}`, async () => [], { requireExisting: true }),
      ).resolves.toBe(rows);
      memo.release(`aborted:${session}`, { graceMs: 10_000 });
      expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });
    }
  });

  it('extracts a cached page without iterating or copying the complete snapshot', async () => {
    const source = Array.from({ length: 2_000 }, (_, index) => ({
      s: `urn:row:${index}`,
      p: `${DKG_NS}label`,
      o: `"row-${index}"`,
      g: 'urn:graph',
    }));
    let wholeSnapshotIterations = 0;
    const snapshot = new Proxy(source, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          wholeSnapshotIterations += 1;
          throw new Error('complete snapshot must not be iterated while extracting one page');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const memo: SyncRowListMemo = {
      get: async () => snapshot,
      release: () => {},
    };

    const page = await readDurableMetaPage({
      store: {} as OxigraphStore,
      contextGraphId: 'urn:cg',
      registeredSubGraphNames: [],
      offset: 1_000,
      limit: 500,
      rowListMemo: memo,
      rowListCacheKey: 'cached-page',
    });

    expect(page).toHaveLength(500);
    expect(page[0]?.s).toBe('urn:row:1000');
    expect(wholeSnapshotIterations).toBe(0);
  });
});
