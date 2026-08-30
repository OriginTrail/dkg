import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  createResponderGraphListMemo,
  createResponderSubGraphRegistrationMemo,
} from '../src/sync/responder/graph-plan.js';
import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
  SYNC_PAGE_SIZE,
} from '../src/dkg-agent-constants.js';
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

function graphScopedVmMeta(params: {
  cgId: string;
  ual: string;
  assertionVersion?: number;
  publicTripleCount: number;
  status: 'tentative' | 'confirmed';
  subGraphName?: string;
}): { graph: string; quads: Quad[] } {
  const assertionVersion = params.assertionVersion ?? 1;
  const scope = createGraphKnowledgeAssetScope(params.ual, assertionVersion);
  const graph = knowledgeAssetLayerGraphUri(
    params.cgId,
    MemoryLayer.VerifiableMemory,
    scope,
    params.subGraphName,
  );
  const meta = `did:dkg:context-graph:${params.cgId}/_meta`;
  const int = (value: number) =>
    `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  const quads: Quad[] = [
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}contentScopeVersion`, object: int(GRAPH_KA_CONTENT_SCOPE_VERSION) },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}kaUal`, object: params.ual },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}assertionVersion`, object: int(assertionVersion) },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}assertionGraph`, object: graph },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}contextGraph`, object: `did:dkg:context-graph:${params.cgId}` },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}publicTripleCount`, object: int(params.publicTripleCount) },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}privateTripleCount`, object: int(0) },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}status`, object: `"${params.status}"` },
    { graph: meta, subject: params.ual, predicate: `${DKG_NS}merkleRoot`, object: '"0x0000000000000000000000000000000000000000000000000000000000000000"' },
  ];
  if (params.subGraphName) {
    quads.push({
      graph: meta,
      subject: params.ual,
      predicate: `${DKG_NS}subGraphName`,
      object: `"${params.subGraphName}"`,
    });
  }
  return { graph, quads };
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

function watchBoundedExactGraphSnapshot(store: OxigraphStore, graph: string) {
  const originalQuery = store.query.bind(store);
  let observedSnapshotQueries = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    const isTargetSnapshot = /^SELECT \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`GRAPH <${graph}>`) &&
      !normalized.includes('ORDER BY') &&
      !normalized.includes('OFFSET');
    if (isTargetSnapshot) {
      observedSnapshotQueries++;
      expect(normalized).toMatch(/LIMIT \d+$/);
    }
    return originalQuery(sparql);
  }) as OxigraphStore['query'];
  return {
    assertObserved() {
      expect(observedSnapshotQueries).toBeGreaterThan(0);
    },
  };
}

describe('sync responder pagination interleaving', () => {
  it('uses confirmed V2 metadata as the exact VM manifest and omits tentative V2 payloads', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-manifest';
    const confirmed = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ab/7',
      publicTripleCount: 3,
      status: 'confirmed',
    });
    const tentative = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ab/8',
      publicTripleCount: 2,
      status: 'tentative',
    });
    const legacyProjection = `did:dkg:context-graph:${cgId}/context/106`;
    const legacyProjectionMeta = `${legacyProjection}/_meta`;
    const catalog = `did:dkg:context-graph:${cgId}/_catalog`;
    await store.insert([
      ...confirmed.quads,
      ...tentative.quads,
      q(confirmed.graph, 0),
      q(confirmed.graph, 1),
      q(confirmed.graph, 2),
      q(tentative.graph, 3),
      q(tentative.graph, 4),
      q(legacyProjection, 5),
      q(legacyProjectionMeta, 6),
      q(catalog, 7),
    ]);

    const originalCount = store.countQuads.bind(store);
    let confirmedCountCalls = 0;
    store.countQuads = async (graph, options) => {
      if (graph === confirmed.graph) {
        confirmedCountCalls += 1;
        throw new Error('confirmed V2 graph must use manifest publicTripleCount');
      }
      return originalCount(graph, options);
    };
    const originalQuery = store.query.bind(store);
    let vmChildProbeQueries = 0;
    store.query = (async (sparql: string, options?: Parameters<OxigraphStore['query']>[1]) => {
      const normalized = sparql.replace(/\s+/g, ' ');
      if (normalized.includes('ASK') && normalized.includes('_verifiable_memory')) {
        vmChildProbeQueries += 1;
      }
      return originalQuery(sparql, options);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      limit: 10,
    } as const;
    const data = await cap.invoke({
      ...base,
      phase: 'data',
      offset: 0,
      syncSessionId: 'rootless-v2-data',
    });
    const meta = await cap.invoke({
      ...base,
      phase: 'meta',
      offset: 0,
      syncSessionId: 'rootless-v2-meta',
    });

    expect(linesFromNquads(data)).toHaveLength(3);
    expect(data).toContain(confirmed.graph);
    expect(data).not.toContain(tentative.graph);
    expect(data).not.toContain(legacyProjection);
    expect(data).not.toContain(legacyProjectionMeta);
    expect(data).not.toContain(catalog);
    expect(meta).toContain(confirmed.quads[0]!.subject);
    expect(meta).toContain('contentScopeVersion');
    expect(meta).not.toContain(tentative.quads[0]!.subject);
    expect(confirmedCountCalls).toBe(0);
    expect(vmChildProbeQueries).toBe(0);
  });

  it('fails closed when a confirmed V2 manifest count disagrees with its exact graph', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-count-race';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ac/9',
      publicTripleCount: 2,
      status: 'confirmed',
    });
    await store.insert([...manifest.quads, q(manifest.graph, 0)]);
    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'rootless-v2-count-race',
    })).rejects.toThrow(/expected 2 rows, found 1/);
  });

  it('uses a sentinel row to reject surplus data in page-only exact-graph mode', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-surplus-page-only';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ac/10',
      publicTripleCount: 1,
      status: 'confirmed',
    });
    await store.insert([
      ...manifest.quads,
      q(manifest.graph, 0),
      q(manifest.graph, 1),
    ]);
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 10,
      snapshotBudget: {
        maxRows: 1_000,
        maxBytesEstimate: 1_000_000,
        maxSnapshotRows: 0,
        maxSnapshotBytesEstimate: 1_000_000,
      },
    });

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'rootless-v2-surplus-page-only',
    })).rejects.toThrow(/expected 1 total rows but found a surplus row/);
  });

  it('fails closed instead of treating an incomplete V2 descriptor as legacy data', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-incomplete-manifest';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ad/10',
      publicTripleCount: 1,
      status: 'confirmed',
    });
    await store.insert([
      ...manifest.quads.filter((quad) => quad.predicate !== `${DKG_NS}status`),
      q(manifest.graph, 0),
    ]);
    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'rootless-v2-incomplete-manifest',
    })).rejects.toThrow(/incomplete V2 descriptor/);
  });

  it('does not mistake a graph lifecycle scope marker for a V2 UAL descriptor', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-lifecycle-marker';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ad/11',
      publicTripleCount: 1,
      status: 'confirmed',
    });
    const lifecycleSubject = `${manifest.graph}/assertion-lifecycle`;
    await store.insert([
      ...manifest.quads,
      {
        graph: `did:dkg:context-graph:${cgId}/_meta`,
        subject: lifecycleSubject,
        predicate: `${DKG_NS}contentScopeVersion`,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      },
      q(manifest.graph, 0),
    ]);
    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });

    const data = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'rootless-v2-lifecycle-marker',
    });

    expect(linesFromNquads(data)).toHaveLength(1);
    expect(data).toContain(manifest.graph);
  });

  it('fails closed on a future graph-scoped content version', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-v2-future-manifest';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ae/11',
      publicTripleCount: 1,
      status: 'confirmed',
    });
    const futureVersion = '"3"^^<http://www.w3.org/2001/XMLSchema#integer>';
    await store.insert([
      ...manifest.quads.map((quad) => quad.predicate === `${DKG_NS}contentScopeVersion`
        ? { ...quad, object: futureVersion }
        : quad),
      q(manifest.graph, 0),
    ]);
    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'rootless-v2-future-manifest',
    })).rejects.toThrow(/unsupported contentScopeVersion 3/);
  });

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

  it('preserves durable cursors beyond one million rows and fails closed on a short exact graph', async () => {
    const store = new OxigraphStore();
    const cgId = 'rootless-cursor-over-one-million';
    const manifest = graphScopedVmMeta({
      cgId,
      ual: 'did:dkg:base:8453/0x00000000000000000000000000000000000000ae/11',
      publicTripleCount: 1_000_010,
      status: 'confirmed',
    });
    await store.insert([...manifest.quads, q(manifest.graph, 0)]);

    const requestedDeepOffset = 1_000_005;
    const boundedQuery = watchBoundedPageQuery(
      store,
      manifest.graph,
      [0, requestedDeepOffset],
      1,
    );
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 1,
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
      limit: 1,
      syncSessionId: 'rootless-cursor-over-one-million-session',
    };

    expect(linesFromNquads(await cap.invoke({ ...base, offset: 0 }))).toHaveLength(1);
    await expect(cap.invoke({ ...base, offset: requestedDeepOffset }))
      .rejects.toThrow(/expected 1 rows at offset 1000005, found 0/);
    boundedQuery.assertObserved();
  });

  it('falls back to store-bounded paging for an oversized durable-meta snapshot', async () => {
    const store = new OxigraphStore();
    const cgId = 'oversized-durable-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    // Three DISTINCT admitted subjects (one row each), so the page boundary
    // falls on a subject boundary and the fallback pages 2 + 1. Since #1788 a
    // single subject is emitted atomically and would never split across pages,
    // so distinct subjects are required to exercise paging here. Activity-prefix
    // subjects survive readDurableMetaRows filtering.
    await store.insert(Array.from({ length: 3 }, (_, i) => ({
      graph: metaGraph,
      subject: `did:dkg:activity:${cgId}-${i}`,
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

  // Handler-level (through registerSyncHandler): the durable-meta wire branch
  // handles an oversized admitted subject DIFFERENTLY by negotiation, and both
  // outcomes are frame-safe with no silent metadata loss (#1788/#1916):
  //  - NEGOTIATED (byte-budget pageMode): the subject-atomic byte-fit chunks the
  //    oversized subject under the frame and pages to completion (empty=EOF, so a
  //    short page is not EOF). A regression returning the whole >4 MiB subject
  //    would fail (pageCount 1 + over-budget bytes).
  //  - LEGACY (no pageMode): a legacy requester reads a short page as EOF, so
  //    byte-fitting would silently drop the rest of the subject; instead the
  //    responder FAILS LOUD. A regression byte-fitting it would fail (no throw).
  const oversizedMetaStore = (cgId: string): { store: OxigraphStore; rows: Quad[]; subject: string } => {
    const store = new OxigraphStore();
    const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
    const subject = `did:dkg:activity:${cgId}-big`;
    const bigLiteral = `"${'y'.repeat(60_000)}"`; // ~60 KB per row (under the 65535 literal cap)
    const rows: Quad[] = Array.from({ length: 80 }, (_, i) => ({
      graph: metaGraph,
      subject,
      predicate: `${DKG_NS}p${String(i).padStart(3, '0')}`,
      object: bigLiteral,
    })); // ~4.8 MB total > the 4 MiB budget
    return { store, rows, subject };
  };

  it('durable-meta handler byte-caps an oversized subject under the frame and pages to completion — negotiated (byte-budget pageMode) (#1916)', async () => {
    const cgId = 'oversized-meta-frame-neg';
    const { store, rows } = oversizedMetaStore(cgId);
    await store.insert(rows);
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta' as const,
      limit: SYNC_PAGE_SIZE,
      syncSessionId: `${cgId}-session`,
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_BYTE_BUDGET_MAX_ROWS,
    };

    const enc = new TextEncoder();
    let offset = 0;
    let delivered = 0;
    let pageCount = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const resp = await cap.invoke({ ...base, offset });
      const n = resp === '' ? 0 : linesFromNquads(resp).length;
      if (n === 0) break;
      // Frame-safety: every response stays within the byte budget.
      expect(enc.encode(resp).byteLength).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
      pageCount += 1;
      delivered += n;
      offset += n;
    }
    // Chunked (byte cap engaged, not one oversized frame) and every row delivered.
    expect(pageCount).toBeGreaterThan(1);
    expect(delivered).toBe(rows.length);
    await store.close();
  });

  it('durable-meta handler FAILS LOUD on an oversized subject for a legacy (no pageMode) requester, never a silent short page (#1788)', async () => {
    const cgId = 'oversized-meta-frame-legacy';
    const { store, rows } = oversizedMetaStore(cgId);
    await store.insert(rows);
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
    // No pageMode ⇒ non-negotiated legacy requester. Byte-fitting would return a
    // short page it reads as EOF (silent loss + #1788 split); the responder must
    // instead surface a hard, explicit failure — not a successful short response.
    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      limit: SYNC_PAGE_SIZE,
      offset: 0,
      syncSessionId: `${cgId}-session`,
    })).rejects.toThrow(/cannot be served frame-safe/);
    await store.close();
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

  it('uses one bounded unordered exact-graph snapshot for deep SWM pages without TTL', async () => {
    const store = new OxigraphStore();
    const cgId = 'bounded-swm';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    await store.insert(Array.from({ length: 100 }, (_, index) => q(swmGraph, index)));

    const probe = watchBoundedExactGraphSnapshot(store, swmGraph);
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
    // 100 DISTINCT admitted subjects (one row each): since #1788 a single
    // subject is emitted atomically, so a deep window into ONE subject is no
    // longer meaningful — distinct subjects let the deep page address a subject
    // boundary. Activity-prefix subjects survive durable-meta admission.
    for (let index = 0; index < 100; index++) {
      const padded = index.toString().padStart(3, '0');
      rows.push({
        graph: metaGraph,
        subject: `did:dkg:activity:m${padded}`,
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

    // The durable-meta read is store-bounded (subject-membership filter pushed
    // into the store via EXISTS), so a deep page is a paged store query. Durable
    // meta reads `limit + 1` rows to detect a subject straddling the page
    // boundary (#1788) and serves at most `limit` when the boundary is clean, so
    // the store query's LIMIT is 6 here while the served page stays 5.
    const probe = watchBoundedPageQuery(store, metaGraph, 90, 6);
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

  it('builds a reusable durable-data snapshot from bounded unordered exact-graph reads', async () => {
    const store = new OxigraphStore();
    const cgId = 'single-query-durable-fallback';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const fallbackGraph = `${cgPrefix}/context/1`;
    await store.insert([
      q(cgPrefix, 0),
      q(fallbackGraph, 1),
    ]);

    const originalQuery = store.query.bind(store);
    let exactGraphRowLoads = 0;
    let exactGraphCounts = 0;
    const originalCountQuads = store.countQuads.bind(store);
    store.countQuads = async (graph, options) => {
      if (graph === cgPrefix || graph === fallbackGraph) exactGraphCounts++;
      return originalCountQuads(graph, options);
    };
    store.query = (async (sparql: string) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (
        /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
        normalized.includes('VALUES ?g') &&
        normalized.includes('ORDER BY ?g ?s ?p ?o')
      ) {
        throw new Error(`durable fallback must not globally sort graph rows: ${normalized}`);
      }
      if (
        /^SELECT \?s \?p \?o WHERE \{/.test(normalized) &&
        (normalized.includes(`GRAPH <${cgPrefix}>`) || normalized.includes(`GRAPH <${fallbackGraph}>`))
      ) {
        exactGraphRowLoads++;
        expect(normalized).not.toContain('ORDER BY');
        expect(normalized).not.toContain('OFFSET');
        expect(normalized).toMatch(/LIMIT \d+$/);
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

    expect(exactGraphCounts).toBe(2);
    expect(exactGraphRowLoads).toBe(2);
    expect(first).toContain('"row-000"');
    expect(first).not.toContain('"row-001"');
    expect(second).toContain('"row-001"');
    expect(second).not.toContain('"row-000"');
  });

  it('never admits transient working-memory graphs into durable data sync', async () => {
    const store = new OxigraphStore();
    const cgId = 'exclude-transient-working-memory';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const durableGraph = `${cgPrefix}/context/1`;
    const orphanWorkingGraph = `${cgPrefix}/_working_memory/0xabc/271`;
    await store.insert([
      q(durableGraph, 1),
      ...Array.from({ length: 100 }, (_, index) => q(orphanWorkingGraph, 1000 + index)),
    ]);

    const originalCountQuads = store.countQuads.bind(store);
    store.countQuads = async (graph, options) => {
      if (graph === orphanWorkingGraph) {
        throw new Error('durable sync must reject WM before count/query planning');
      }
      return originalCountQuads(graph, options);
    };
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: Parameters<OxigraphStore['query']>[1]) => {
      expect(sparql).not.toContain(`GRAPH <${orphanWorkingGraph}>`);
      return originalQuery(sparql, options);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { syncPageSize: 10 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'wm-exclusion',
    });

    expect(out).toContain('"row-001"');
    expect(out).not.toContain('"row-1000"');
    expect(lineGraphsFromNquads(out)).toEqual(new Set([durableGraph]));
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
    expect((await initial).graphs).toEqual(['old']);

    const refreshing = memo.get({ refresh: true });
    const overlappingRefresh = memo.get({ refresh: true });
    const deepPage = memo.get();
    secondRefresh.resolve(['new']);

    expect((await refreshing).graphs).toEqual(['new']);
    expect((await overlappingRefresh).graphs).toEqual(['new']);
    expect((await deepPage).graphs).toEqual(['new']);
    expect(calls).toBe(2);
  });

  it('does not retain a graph list read while a remote mutation is pending', async () => {
    let generation = 0;
    let stable = true;
    let calls = 0;
    let graphs = ['urn:graph:b', 'urn:graph:a', 'urn:graph:b'];
    const store = {
      getWriteRevision: (prefix: string) => {
        expect(prefix).toBe('');
        return { generation, stable };
      },
      listGraphs: async () => {
        calls++;
        return graphs;
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store);

    expect((await memo.get({
      refresh: true,
      refreshGeneration: 'session-1',
    })).graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect((await memo.get({
      refresh: true,
      refreshGeneration: 'session-2',
    })).graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect(calls).toBe(1);

    // Dispatch: the endpoint has not committed yet, so a refresh can still
    // observe and memoize the old graph set at this intermediate generation.
    generation++;
    stable = false;
    expect((await memo.get({
      refresh: true,
      refreshGeneration: 'pending-mutation',
    })).graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect(calls).toBe(2);

    // The remote mutation is still pending at the same revision. Stability,
    // not generation change alone, must prevent reuse of the completed read.
    graphs = ['urn:graph:c', 'urn:graph:a'];
    expect((await memo.get({
      refresh: true,
      refreshGeneration: 'same-pending-mutation',
    })).graphs).toEqual(['urn:graph:a', 'urn:graph:c']);
    expect(calls).toBe(3);

    // Settlement must advance again so the next session cannot reuse the
    // graph list that was read while the mutation was in flight.
    graphs = ['urn:graph:d', 'urn:graph:a'];
    generation++;
    stable = true;
    expect((await memo.get({
      refresh: true,
      refreshGeneration: 'session-3',
    })).graphs).toEqual(['urn:graph:a', 'urn:graph:d']);
    expect(calls).toBe(4);
  });

  it('shares one in-flight graph enumeration at an unstable revision without caching it', async () => {
    const firstRead = deferred<string[]>();
    const secondRead = deferred<string[]>();
    let calls = 0;
    const store = {
      getWriteRevision: () => ({ generation: 7, stable: false }),
      listGraphs: async () => {
        calls += 1;
        return calls === 1 ? firstRead.promise : secondRead.promise;
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store);

    const first = memo.get({ refresh: true });
    const simultaneous = memo.get({ refresh: true });
    await vi.waitFor(() => expect(calls).toBe(1));
    firstRead.resolve(['urn:graph:b', 'urn:graph:a']);
    expect((await first).graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect((await simultaneous).graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect(calls).toBe(1);

    // Unstable completed results are never reused, even though simultaneous
    // waiters may share the promise that produced them.
    const later = memo.get({ refresh: true });
    await vi.waitFor(() => expect(calls).toBe(2));
    secondRead.resolve(['urn:graph:c']);
    expect((await later).graphs).toEqual(['urn:graph:c']);
  });

  it('supersedes an in-flight graph list when write generation changes', async () => {
    const oldGraphs = deferred<string[]>();
    const newGraphs = deferred<string[]>();
    let generation = 0;
    let calls = 0;
    const store = {
      getWriteRevision: () => ({ generation, stable: true }),
      listGraphs: async () => {
        calls++;
        return calls === 1 ? oldGraphs.promise : newGraphs.promise;
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store);

    const beforeWrite = memo.get({ refresh: true, refreshGeneration: 'old-session' });
    await vi.waitFor(() => expect(calls).toBe(1));
    generation++;
    const afterWrite = memo.get({ refresh: true, refreshGeneration: 'new-session' });

    oldGraphs.resolve(['urn:graph:old']);
    expect((await beforeWrite).graphs).toEqual(['urn:graph:old']);
    await vi.waitFor(() => expect(calls).toBe(2));
    newGraphs.resolve(['urn:graph:new']);
    expect((await afterWrite).graphs).toEqual(['urn:graph:new']);
  });

  it('retains the TTL backstop for writers outside the tracked store process', async () => {
    let calls = 0;
    const store = {
      getWriteRevision: () => ({ generation: 0, stable: true }),
      listGraphs: async () => {
        calls++;
        return ['urn:graph:a'];
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store, 0);

    await memo.get({ refresh: true, refreshGeneration: 'session-1' });
    await memo.get({ refresh: true, refreshGeneration: 'session-2' });

    expect(calls).toBe(2);
  });

  it('reuses the immutable graph membership snapshot across content-only writes', async () => {
    let generation = 0;
    let graphs = ['urn:graph:b', 'urn:graph:a'];
    let calls = 0;
    const store = {
      getWriteRevision: () => ({ generation, stable: true }),
      listGraphs: async () => {
        calls += 1;
        return graphs;
      },
    } as unknown as OxigraphStore;
    const memo = createResponderGraphListMemo(store);

    const initial = await memo.get({ refresh: true, refreshGeneration: 'initial' });
    expect(initial.graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.graphs)).toBe(true);

    // A write inside an existing graph advances the store revision, but the
    // named-graph listing still describes the same set in a different order.
    generation += 1;
    graphs = ['urn:graph:a', 'urn:graph:b'];
    const contentOnly = await memo.get({ refresh: true, refreshGeneration: 'content-write' });
    expect(contentOnly).toBe(initial);

    generation += 1;
    graphs = ['urn:graph:c', 'urn:graph:a', 'urn:graph:b'];
    const membershipChange = await memo.get({ refresh: true, refreshGeneration: 'graph-added' });
    expect(membershipChange).not.toBe(initial);
    expect(membershipChange.graphs).toEqual(['urn:graph:a', 'urn:graph:b', 'urn:graph:c']);

    // Preserve the old deduplication contract: a malformed duplicate listing
    // cannot make a same-length equality check retain absent graphs.
    generation += 1;
    graphs = ['urn:graph:a', 'urn:graph:a', 'urn:graph:b'];
    const duplicateListing = await memo.get({ refresh: true, refreshGeneration: 'graph-removed' });
    expect(duplicateListing).not.toBe(membershipChange);
    expect(duplicateListing.graphs).toEqual(['urn:graph:a', 'urn:graph:b']);
    expect(calls).toBe(4);
  });

  it('uses the outer sorted catalog without exposing reserved decorator graphs', async () => {
    const visible = 'did:dkg:context-graph:sorted-boundary/data';
    const reserved = 'did:dkg:context-graph:sorted-boundary/internal';
    const base = new OxigraphStore();
    await base.insert([q(visible, 1), q(reserved, 2)]);
    const indexed = new GraphSetIndexStore(base, { revalidateMs: 100_000 });
    const store = new ChangelogStore(indexed, { reservedGraphs: [reserved] });
    const listGraphs = vi.spyOn(store, 'listGraphs').mockRejectedValue(
      new Error('unsorted graph enumeration must not be selected'),
    );
    const memo = createResponderGraphListMemo(store);

    const initial = await memo.get({ refresh: true });
    expect(initial.graphs).toContain(visible);
    expect(initial.graphs).not.toContain(reserved);
    expect(listGraphs).not.toHaveBeenCalled();

    await store.insert([q(visible, 3)]);
    const contentOnly = await memo.get({ refresh: true });
    expect(contentOnly).toBe(initial);
    expect(contentOnly.graphs).not.toContain(reserved);
    expect(listGraphs).not.toHaveBeenCalled();
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
    expect((await oldGraphSession).graphs).toEqual(['urn:graph:old']);
    await vi.waitFor(() => expect(graphCalls).toBe(2));
    newGraphs.resolve(['urn:graph:new']);
    expect((await newGraphSession).graphs).toEqual(['urn:graph:new']);

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
