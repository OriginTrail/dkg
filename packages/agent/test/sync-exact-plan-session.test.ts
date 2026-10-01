import { describe, expect, it, vi } from 'vitest';
import {
  createResponderExactGraphPagePlanMemo,
  createResponderPageOnlyExactGraphPlanMemo,
  readDurableDataPage,
  type SyncRow,
} from '../src/sync/responder/graph-plan.js';
import { createGraphMembershipSnapshot } from '../src/sync/graph-membership-snapshot.js';
import {
  createBoundedExactAssetExportCache,
  type ExactAssetExportLease,
} from '../src/sync/responder/exact-asset-export-cache.js';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { SYNC_REQUEST_PAGE_SIZE } from '../src/dkg-agent-constants.js';

function budget(maxBytesEstimate = 2 * 1024 * 1024) {
  return createSyncResponderSnapshotBudget({
    maxRows: 1, maxBytesEstimate, maxSnapshotRows: 1, maxSnapshotBytesEstimate: 1,
  });
}

function plan(graph = 'urn:exact:one') {
  return {
    entries: [{ graph, rowCount: 2 }], totalRows: 2,
    pagedGraphs: new Set([graph]), cursors: new Map([[0, null]]),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('page-only exact plan ownership and bounds', () => {
  it('lets existing requesters immediately rotate a retained token after revision expiry', async () => {
    const tokens: string[] = [];
    let round = 0;
    const params: Parameters<typeof fetchSyncPages>[0] = {
      ctx: { kind: 'system', id: 'exact-expiry', startedAt: Date.now() } as never,
      remotePeerId: 'exact-expiry-peer', contextGraphId: 'exact-expiry-cg',
      includeSharedMemory: false, phase: 'data', graphUri: 'urn:exact-expiry',
      assetUals: ['did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/1'],
      deadline: Date.now() + 5000, syncPageTimeoutMs: 1000,
      syncRouterAttempts: 1, syncPageRetryAttempts: 1, syncPageSize: SYNC_REQUEST_PAGE_SIZE,
      syncDeniedResponse: '#DENIED', debugSyncProgress: false, protocolSync: '/test/sync',
      checkpointStore: new MemorySyncCheckpointStore(), forceFreshSession: false,
      buildSyncRequest: async (_cg, _offset, _limit, _swm, _peer, _phase, _ref, _batch, token) => {
        tokens.push(token!);
        return new Uint8Array();
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        if (round === 0) throw new Error('stream reset');
        if (round === 1) {
          throw new Error('Sync session exact-graph plan expired: store revision changed before page completion');
        }
        return new Uint8Array();
      },
      logWarn: () => {}, logInfo: () => {}, logDebug: () => {},
    };
    await expect(fetchSyncPages(params)).rejects.toThrow('stream reset');
    round = 1;
    await expect(fetchSyncPages(params)).rejects.toThrow('store revision changed');
    round = 2;
    await fetchSyncPages(params);
    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('physically drains an aborted load and never admits its late result', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, retained);
    const load = deferred<ReturnType<typeof plan>>();
    const controller = new AbortController();
    let settled = false;
    const result = memo.get('peer/cg/selection/token', () => load.promise, { signal: controller.signal });
    const observed = result.catch((error: Error) => error).finally(() => { settled = true; });
    controller.abort(new Error('owned cancellation'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(retained.stats().snapshots).toBe(0);
    load.resolve(plan());
    expect((await observed as Error).message).toBe('owned cancellation');
    expect(retained.stats().snapshots).toBe(0);
    expect(await memo.get('peer/cg/selection/token', () => Promise.resolve(plan()), {
      requireExisting: true,
    })).toBeNull();
  });

  it('drains an older pending refresh before loading a replacement plan', async () => {
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, budget());
    const oldLoad = deferred<ReturnType<typeof plan>>();
    const old = memo.get('same-scope', () => oldLoad.promise);
    const replacementLoader = vi.fn(async () => plan('urn:exact:new'));
    const fresh = memo.get('same-scope', replacementLoader, { refresh: true });
    await Promise.resolve();
    expect(replacementLoader).not.toHaveBeenCalled();
    oldLoad.resolve(plan('urn:exact:old'));
    expect((await old)?.entries[0].graph).toBe('urn:exact:old');
    expect((await fresh)?.entries[0].graph).toBe('urn:exact:new');
    expect(replacementLoader).toHaveBeenCalledOnce();
  });

  it('reserves cursor bytes globally and enforces entry bounds at concurrent settlement', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 1, retained);
    const a = deferred<ReturnType<typeof plan>>();
    const b = deferred<ReturnType<typeof plan>>();
    const first = memo.get('a', () => a.promise);
    const second = memo.get('b', () => b.promise);
    a.resolve(plan('urn:a'));
    await first;
    b.resolve(plan('urn:b'));
    await second;
    expect(retained.stats().snapshots).toBe(1);
    expect(retained.stats().bytesEstimate).toBeGreaterThanOrEqual(256 * 1024);
    expect(await memo.get('a', () => Promise.resolve(plan()), { requireExisting: true })).toBeNull();
    expect((await memo.get('b', () => Promise.resolve(plan()), { requireExisting: true }))?.entries[0].graph)
      .toBe('urn:b');
  });

  it('rejects oversized plan scalars without retaining them', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, retained);
    await expect(memo.get('large', async () => plan(`urn:${'x'.repeat(300_000)}`)))
      .rejects.toThrow('snapshot');
    expect(retained.stats().snapshots).toBe(0);
  });
});

async function integerPageFixture() {
  const contextGraphId = 'exact-integer-page-order';
  const assetUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(assetUal, 1));
  const payload: Quad[] = Array.from({ length: 8_193 }, (_, index) => ({
    graph, subject: 'urn:integer-asset', predicate: 'urn:integer-value',
    object: `"${index}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
  }));
  const root = computeFlatKCRootV10(payload, []);
  const metadata = generateGraphKnowledgeAssetMetadata({
    ual: assetUal, contextGraphId, assertionGraph: graph, assertionVersion: '1',
    merkleRoot: root, publisherPeerId: 'publisher', accessPolicy: 'public', timestamp: new Date(0),
    publicTripleCount: payload.length, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: 1n, blockNumber: 1, blockTimestamp: 0,
    publisherAddress: '0x00000000000000000000000000000000000000ab', chainId: '31337',
  } } });
  const backing = new OxigraphStore();
  await backing.insert([...metadata, ...payload]);
  // Exercise genuine SPARQL numeric ordering and the real root-verifying
  // export cache without starting an HTTP service. The HTTP adapter profile
  // supplies the bounded export capability; its query port uses the local store.
  const store = new BlazegraphStore('http://127.0.0.1:1/unused');
  const query = vi.spyOn(store, 'query').mockImplementation((sparql, options) => backing.query(sparql, options));
  const retained = createSyncResponderSnapshotBudget({ maxRows: 100_000,
    maxBytesEstimate: 384 * 1024 * 1024, maxSnapshotRows: 100_000,
    maxSnapshotBytesEstimate: 128 * 1024 * 1024 });
  const cache = createBoundedExactAssetExportCache({ store, budget: retained });
  const originalAcquire = cache.acquire;
  const acquire = vi.spyOn(cache, 'acquire');
  const memo = createResponderExactGraphPagePlanMemo(60_000, 8);
  const pressureId = Symbol('active-unrelated-response');
  const occupy = (megabytes = 320) => retained.admit({ id: pressureId, key: 'active-unrelated-response', rows: 0,
    bytesEstimate: megabytes * 1024 * 1024, phase: 'durable_data', controlPlane: true, onEvict: () => {} });
  const releasePressure = () => retained.remove(pressureId);
  const read = async (offset: number, key: string | undefined, limit = 8_192, assetUals = [assetUal]) => {
    const leases: ExactAssetExportLease[] = [];
    try {
      const rows = await readDurableDataPage({ store,
        graphMembership: createGraphMembershipSnapshot([]),
        contextGraphId, sinceBatchId: null, offset, limit,
        assetUals, exactGraphReadMode: 'page-only',
        exactGraphPlanMemo: memo, exactGraphPlanCacheKey: key,
        maxPageBytes: 4 * 1024 * 1024, exactAssetExportCache: cache,
        onExactAssetExportLease: lease => leases.push(lease) });
      for (const lease of leases) await lease.assertCurrent();
      return rows;
    } finally { for (const lease of leases) lease.release(); }
  };
  const assertComplete = (rows: readonly SyncRow[]) => {
    expect(rows).toHaveLength(payload.length);
    expect(new Set(rows.map(row => row.o)).size).toBe(payload.length);
    expect(new Set(rows.map(row => row.o))).toEqual(new Set(payload.map(quad => quad.object)));
    expect(computeFlatKCRootV10(rows.map(row => ({
      graph: row.g, subject: row.s, predicate: row.p, object: row.o,
    })), [])).toEqual(root);
  };
  return { read, query, cache, acquire, occupy, releasePressure, assertComplete, retained, originalAcquire,
    contextGraphId, assetUal, graph,
    async changeMetadata() { await backing.insert([{ graph: `did:dkg:context-graph:${contextGraphId}/_meta`,
      subject: assetUal, predicate: 'urn:changed-immutable-metadata', object: '"changed"' }]); },
    async close() { releasePressure(); vi.restoreAllMocks(); await backing.close(); } };
}

describe('exact DATA session pagination order', () => {
  it('retains one validated singleton export identity across cached adaptive pages', async () => {
    const f = await integerPageFixture();
    try {
      const rows: SyncRow[] = [];
      let retainedAfterFirst: ReturnType<typeof f.retained.stats> | undefined;
      for (const limit of [64, 128, 256, 512, 8_192]) {
        const page = await f.read(rows.length, 'singleton-export-session', limit);
        expect(page).toHaveLength(Math.min(limit, 8_193 - rows.length));
        rows.push(...page);
        retainedAfterFirst ??= f.retained.stats();
        expect(f.retained.stats()).toEqual(retainedAfterFirst);
      }
      f.assertComplete(rows);
      const identity = (await f.acquire.mock.results[0]!.value)!.identity;
      expect(f.acquire).toHaveBeenCalledTimes(5);
      expect(f.acquire.mock.calls.map(([request]) => ({
        contextGraphId: request.contextGraphId, assetUal: request.assetUal,
        graph: request.graph, expectedRows: request.expectedRows, expectedIdentity: request.expectedIdentity,
      }))).toEqual(Array.from({ length: 5 }, (_, index) => ({
        contextGraphId: f.contextGraphId, assetUal: f.assetUal, graph: f.graph,
        expectedRows: 8_193, expectedIdentity: index === 0 ? undefined : identity,
      })));
      expect(f.query.mock.calls.filter(([, options]) => options?.source === 'sync.responder.readGraphScopedVmManifest'))
        .toHaveLength(1);
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
      // This adapter has no write revisions, so each page revalidates a fresh export.
      expect(f.cache.stats()).toMatchObject({ exports: 5, cacheHits: 0, fallbacks: {} });
    } finally { await f.close(); }
  });

  it('fences metadata changes before a cached singleton export continuation', async () => {
    const f = await integerPageFixture();
    try {
      const first = await f.read(0, 'singleton-export-session', 64);
      const identity = (await f.acquire.mock.results[0]!.value)!.identity;
      const retainedAfterFirst = f.retained.stats();
      await f.changeMetadata();
      await expect(f.read(first.length, 'singleton-export-session', 128)).rejects.toMatchObject({
        code: 'SYNC_EXACT_EXPORT_CHANGED', message: expect.stringMatching(/sync session.*expired/i),
      });
      expect(f.acquire.mock.calls[1]![0]).toMatchObject({
        assetUal: f.assetUal, graph: f.graph, expectedIdentity: identity,
      });
      expect(f.query.mock.calls.filter(([, options]) => options?.source === 'sync.responder.readGraphScopedVmManifest'))
        .toHaveLength(1);
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
      expect(f.retained.stats()).toEqual(retainedAfterFirst);
    } finally { await f.close(); }
  });

  it('uses store paging for a multiple-asset selection with only one confirmed match', async () => {
    const f = await integerPageFixture();
    try {
      const selected = [f.assetUal, `${f.assetUal.slice(0, -1)}2`];
      const first = await f.read(0, 'multiple-asset-session', 8_192, selected);
      const last = await f.read(first.length, 'multiple-asset-session', 8_192, selected);
      f.assertComplete([...first, ...last]);
      expect(first.at(-1)?.o).toBe('"8191"^^<http://www.w3.org/2001/XMLSchema#integer>');
      expect(f.acquire).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('expires an export-first session when admission later refuses export, then restarts completely on store pages', async () => {
    const f = await integerPageFixture();
    try {
      const first = await f.read(0, 'integer-session');
      expect(first).toHaveLength(8_192);
      expect(first.some(row => row.o.startsWith('"999"'))).toBe(false);
      f.occupy();
      await expect(f.read(first.length, 'integer-session')).rejects.toMatchObject({
        code: 'SYNC_EXACT_EXPORT_UNAVAILABLE', message: expect.stringMatching(/sync session.*expired/i),
      });
      expect(f.cache.stats().fallbacks['build-admission']).toBe(1);
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
      const restartedFirst = await f.read(0, 'store-restart-session');
      f.releasePressure();
      const restartedLast = await f.read(restartedFirst.length, 'store-restart-session');
      f.assertComplete([...restartedFirst, ...restartedLast]);
      expect(await f.read(8_193, 'store-restart-session')).toEqual([]);
      // Admission recovery must not switch the restarted session back to lexical order.
      expect(f.acquire).toHaveBeenCalledTimes(3);
    } finally { await f.close(); }
  });

  it('keeps store-first numeric pagination when export admission becomes available between pages', async () => {
    const f = await integerPageFixture();
    try {
      f.occupy();
      const first = await f.read(0, 'integer-session');
      expect(first[0]?.o).toBe('"0"^^<http://www.w3.org/2001/XMLSchema#integer>');
      expect(first.at(-1)?.o).toBe('"8191"^^<http://www.w3.org/2001/XMLSchema#integer>');
      f.releasePressure();
      const last = await f.read(first.length, 'integer-session');
      expect(last.map(row => row.o)).toEqual(['"8192"^^<http://www.w3.org/2001/XMLSchema#integer>']);
      f.assertComplete([...first, ...last]);
      expect(f.acquire).toHaveBeenCalledOnce();
      const storeReads = f.query.mock.calls.filter(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage');
      expect(storeReads.every(([sparql]) => Number(/LIMIT\s+(\d+)/.exec(sparql)?.[1]) <= 65)).toBe(true);
    } finally { await f.close(); }
  });

  it('releases a delayed export when a concurrent first page pins store order after response admission refusal', async () => {
    const f = await integerPageFixture();
    const acquired = deferred<ExactAssetExportLease>();
    const releaseAcquisition = deferred<void>();
    const releaseLease = vi.fn();
    f.acquire.mockImplementationOnce(async request => {
      const lease = await f.originalAcquire(request);
      if (!lease) throw new Error('First export lease absent');
      releaseLease.mockImplementation(lease.release);
      const delayed = { ...lease, release: releaseLease };
      acquired.resolve(delayed);
      await releaseAcquisition.promise;
      return delayed;
    });
    const delayedPage = f.read(0, 'concurrent-integer-session');
    try {
      await Promise.race([acquired.promise, delayedPage.then(() => {
        throw new Error('Delayed page completed before acquiring an export lease');
      })]);
      f.occupy(200);
      const storePage = await f.read(0, 'concurrent-integer-session');
      expect(f.cache.stats().fallbacks['response-admission']).toBe(1);
      releaseAcquisition.resolve(undefined);
      expect(await delayedPage).toEqual(storePage);
      expect(releaseLease).toHaveBeenCalledOnce();
      f.releasePressure();
      const last = await f.read(storePage.length, 'concurrent-integer-session');
      f.assertComplete([...storePage, ...last]);
      expect(f.acquire).toHaveBeenCalledTimes(2);
      expect(f.retained.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally {
      releaseAcquisition.resolve(undefined);
      await delayedPage.catch(() => {});
      await f.close();
    }
  });

  it('uses store paging throughout stateless requests even when export admission changes', async () => {
    const f = await integerPageFixture();
    try {
      const first = await f.read(0, undefined);
      f.occupy();
      const last = await f.read(first.length, undefined);
      f.assertComplete([...first, ...last]);
      expect(f.acquire).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
