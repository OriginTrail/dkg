import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  contextGraphCatalogUri,
  DEFAULT_MAX_READ_BYTES,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
  SYNC_EXACT_PAGE_READ_MAX_ROWS,
  SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD,
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_INITIAL_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../src/dkg-agent-constants.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import {
  fetchSyncPages,
  SyncPageSizeProfileCache,
} from '../src/sync/requester/page-fetch.js';
import {
  serializeResponderRowsWithinByteBudget,
  type SyncRow,
} from '../src/sync/responder/graph-plan.js';
import { resolveDataRequestPolicy } from '../src/sync/responder/data-request-policy.js';
import {
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

const CG_ID = 'byte-budget-cg';
const REMOTE_PEER_ID = '12D3KooWByteBudgetRemote';
const LOCAL_PEER_ID = '12D3KooWByteBudgetLocal';

function makeCtx(): OperationContext {
  return { kind: 'system', id: 'byte-budget-test', startedAt: Date.now() } as never;
}

function noopLog(): void {}

function pageSizeScope(
  remotePeerId: string,
  phase: 'meta' | 'data' | 'snapshot' = 'meta',
  includeSharedMemory = true,
) {
  return {
    remotePeerId,
    contextGraphId: CG_ID,
    includeSharedMemory,
    phase,
  } as const;
}

type PageFetchParams = Parameters<typeof fetchSyncPages>[0];

function pageFetchParams(overrides: Partial<PageFetchParams> = {}): PageFetchParams {
  return {
    ctx: makeCtx(),
    remotePeerId: REMOTE_PEER_ID,
    contextGraphId: CG_ID,
    includeSharedMemory: true,
    phase: 'meta',
    graphUri: 'urn:meta',
    deadline: Date.now() + 15_000,
    syncPageTimeoutMs: 5_000,
    syncRouterAttempts: 1,
    syncPageRetryAttempts: 3,
    syncPageSize: SYNC_REQUEST_PAGE_SIZE,
    syncDeniedResponse: '#DENIED',
    debugSyncProgress: false,
    protocolSync: '/dkg/test/sync',
    checkpointStore: new MemorySyncCheckpointStore(),
    buildSyncRequest: async () => new TextEncoder().encode('request'),
    parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    send: async () => new Uint8Array(),
    logWarn: noopLog,
    logInfo: noopLog,
    logDebug: noopLog,
    ...overrides,
  };
}

describe('byte-budget sync pagination', () => {
  it('advertises byte-budget paging in an unauthenticated public request', async () => {
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'data',
      needsAuth: false,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
    });

    expect(new TextDecoder().decode(encoded)).toBe(
      `${CG_ID}|0|${SYNC_REQUEST_PAGE_SIZE}|data`
      + `|page-mode|${SYNC_BYTE_BUDGET_PAGE_MODE}|page-rows|${SYNC_REQUEST_PAGE_SIZE}`,
    );
  });

  it('advertises byte-budget paging for public shared-memory data', async () => {
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: true,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'data',
      needsAuth: false,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
    });

    expect(new TextDecoder().decode(encoded)).toBe(
      `workspace:${CG_ID}|0|${SYNC_REQUEST_PAGE_SIZE}|data`
      + `|page-mode|${SYNC_BYTE_BUDGET_PAGE_MODE}|page-rows|${SYNC_REQUEST_PAGE_SIZE}`,
    );
  });

  it('keeps the authenticated legacy limit signed while adding the larger hint', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signedLimits: number[] = [];
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'data',
      needsAuth: true,
      computeSyncDigest: (_cg, _offset, limit) => {
        signedLimits.push(limit);
        return new Uint8Array(32);
      },
      getIdentityId: async () => 0n,
      claimedAgentAddress: wallet.address,
      claimedAgentPrivateKey: wallet.privateKey,
    });

    const request = JSON.parse(new TextDecoder().decode(encoded));
    expect(signedLimits).toEqual([SYNC_PAGE_SIZE]);
    expect(request.limit).toBe(SYNC_PAGE_SIZE);
    expect(request.pageMode).toBe(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(request.pageRowsHint).toBe(SYNC_REQUEST_PAGE_SIZE);
    expect(request.requesterSignatureR).toMatch(/^0x/);
  });

  it('keeps an exact DATA request on page-only mode after fallback reaches 64 rows', async () => {
    const wallet = ethers.Wallet.createRandom();
    const exactUal = 'did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/1';
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'data',
      assetUals: [exactUal],
      needsAuth: true,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
      claimedAgentAddress: wallet.address,
      claimedAgentPrivateKey: wallet.privateKey,
    });

    const request = JSON.parse(new TextDecoder().decode(encoded));
    expect(request).toMatchObject({
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_SAFE_PAGE_SIZE,
      assetUals: [exactUal],
    });
    expect(resolveDataRequestPolicy({
      legacyLimit: request.limit,
      includeSharedMemory: false,
      phase: request.phase,
      pageMode: request.pageMode,
      pageRowsHint: request.pageRowsHint,
      hasExactAssetFilter: true,
    })).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      cacheMode: 'page-only',
      exactGraphReadMode: 'page-only',
    });
  });

  // #1916: durable META now negotiates byte-budget paging exactly like durable
  // DATA. These two cases pin the request-builder's meta advertisement directly:
  // a regression dropping 'meta' from the useByteBudgetPage condition would
  // silently break the wire negotiation, and the handler-level tests (which
  // hand-craft the pageMode field) would not catch it.
  it('advertises the byte-budget page mode for a durable meta request above the legacy cap', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signedLimits: number[] = [];
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'meta',
      needsAuth: true,
      computeSyncDigest: (_cg, _offset, limit) => {
        signedLimits.push(limit);
        return new Uint8Array(32);
      },
      getIdentityId: async () => 0n,
      claimedAgentAddress: wallet.address,
      claimedAgentPrivateKey: wallet.privateKey,
    });

    const request = JSON.parse(new TextDecoder().decode(encoded));
    // The larger hint rides while the signed legacy limit stays 500-row capped,
    // so digests remain wire-compatible with an old responder.
    expect(signedLimits).toEqual([SYNC_PAGE_SIZE]);
    expect(request.limit).toBe(SYNC_PAGE_SIZE);
    expect(request.pageMode).toBe(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(request.pageRowsHint).toBe(SYNC_REQUEST_PAGE_SIZE);
  });

  it('advertises byte-budget paging for public shared-memory metadata', async () => {
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: true,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'meta',
      needsAuth: false,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
    });

    expect(new TextDecoder().decode(encoded)).toBe(
      `workspace:${CG_ID}|0|${SYNC_REQUEST_PAGE_SIZE}|meta`
      + `|page-mode|${SYNC_BYTE_BUDGET_PAGE_MODE}|page-rows|${SYNC_REQUEST_PAGE_SIZE}`,
    );
  });

  it('does not advertise byte-budget paging for a durable meta request at the legacy cap', async () => {
    const wallet = ethers.Wallet.createRandom();
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: REMOTE_PEER_ID,
      requesterPeerId: LOCAL_PEER_ID,
      phase: 'meta',
      needsAuth: true,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
      claimedAgentAddress: wallet.address,
      claimedAgentPrivateKey: wallet.privateKey,
    });

    const request = JSON.parse(new TextDecoder().decode(encoded));
    // At the 500-row cap there is no larger page to negotiate, so the responder
    // must see an unmodified legacy meta request (no pageMode field).
    expect(request.pageMode).toBeUndefined();
    expect(request.pageRowsHint).toBeUndefined();
  });

  it('continues after an old responder returns a short legacy page', async () => {
    const requested: Array<{ offset: number; limit: number }> = [];
    let sends = 0;
    const result = await fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      graphUri: `did:dkg:context-graph:${CG_ID}`,
      deadline: Date.now() + 10_000,
      syncPageTimeoutMs: 2_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: SYNC_REQUEST_PAGE_SIZE,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: '/dkg/test/sync',
      checkpointStore: new MemorySyncCheckpointStore(),
      buildSyncRequest: async (_cg, offset, limit) => {
        requested.push({ offset, limit });
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: SYNC_PAGE_SIZE }),
      send: async () => {
        sends += 1;
        return sends === 1
          ? new TextEncoder().encode('<urn:s> <urn:p> <urn:o> <urn:g> .')
          : new Uint8Array();
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    expect(requested).toEqual([
      { offset: 0, limit: SYNC_REQUEST_INITIAL_PAGE_SIZE },
      { offset: SYNC_PAGE_SIZE, limit: SYNC_REQUEST_INITIAL_PAGE_SIZE },
    ]);
    expect(result.nextOffset).toBe(SYNC_PAGE_SIZE);
    expect(result.completed).toBe(true);
  });

  it('returns a soft page boundary as incomplete progress without a timeout', async () => {
    let sends = 0;
    const observedProgress: Array<{ resumedFromOffset: number; nextOffset: number }> = [];
    const result = await fetchSyncPages(pageFetchParams({
      includeSharedMemory: false,
      phase: 'data',
      graphUri: `did:dkg:context-graph:${CG_ID}`,
      parseAndFilter: async () => ({ quads: [], totalQuads: SYNC_PAGE_SIZE }),
      send: async () => {
        sends += 1;
        return new TextEncoder().encode('<urn:s> <urn:p> <urn:o> <urn:g> .');
      },
      shouldStopAfterPage: (progress) => {
        observedProgress.push(progress);
        return true;
      },
    }));

    expect(sends).toBe(1);
    expect(observedProgress).toEqual([{
      resumedFromOffset: 0,
      nextOffset: SYNC_PAGE_SIZE,
    }]);
    expect(result).toMatchObject({
      nextOffset: SYNC_PAGE_SIZE,
      completed: false,
      timedOut: false,
    });
  });

  it('keeps a successful fallback size sticky and probes upward gradually', async () => {
    const requestedSizes: number[] = [];
    let sends = 0;
    const result = await fetchSyncPages(pageFetchParams({
      phase: 'snapshot',
      graphUri: '',
      snapshotRef: 'snapshot-ref',
      syncPageRetryAttempts: 2,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 100 }),
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('relay stream reset');
        return sends <= SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD + 1
          ? new TextEncoder().encode('<urn:s> <urn:p> <urn:o> <urn:g> .')
          : new Uint8Array();
      },
    }));

    expect(requestedSizes).toEqual([
      SYNC_REQUEST_INITIAL_PAGE_SIZE,
      ...Array.from(
        { length: SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD },
        () => SYNC_REQUEST_SAFE_PAGE_SIZE,
      ),
      SYNC_REQUEST_SAFE_PAGE_SIZE * 2,
    ]);
    expect(result.completed).toBe(true);
  });

  it('retains the safe fallback across bounded continuation fetches', async () => {
    const requestedSizes: number[] = [];
    const pageSizeProfileCache = new SyncPageSizeProfileCache();
    const scope = pageSizeScope(REMOTE_PEER_ID);
    const checkpointStore = new MemorySyncCheckpointStore();
    let failFirstRound = true;
    const run = () => fetchSyncPages(pageFetchParams({
      syncPageRetryAttempts: 3,
      checkpointStore,
      pageSizeProfileCache,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        if (failFirstRound) throw new Error('sync responder queue wait exceeded');
        return new Uint8Array();
      },
    }));

    await expect(run()).rejects.toThrow('sync responder queue wait exceeded');
    expect(requestedSizes).toEqual([
      SYNC_REQUEST_INITIAL_PAGE_SIZE,
      SYNC_REQUEST_SAFE_PAGE_SIZE,
      SYNC_REQUEST_SAFE_PAGE_SIZE,
    ]);
    expect(pageSizeProfileCache.preferred(scope)).toBe(SYNC_REQUEST_SAFE_PAGE_SIZE);

    failFirstRound = false;
    await expect(run()).resolves.toMatchObject({ completed: true, nextOffset: 0 });
    expect(requestedSizes.at(-1)).toBe(SYNC_REQUEST_SAFE_PAGE_SIZE);
  });

  it('does not collapse page capacity for a failure before response opening', async () => {
    const requestedSizes: number[] = [];
    const pageSizeProfileCache = new SyncPageSizeProfileCache();
    const scope = pageSizeScope(REMOTE_PEER_ID);
    let sends = 0;
    await expect(fetchSyncPages(pageFetchParams({
      syncPageRetryAttempts: 2,
      pageSizeProfileCache,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('Remote closed connection during opening');
        return new Uint8Array();
      },
    }))).resolves.toMatchObject({ completed: true, nextOffset: 0 });

    expect(requestedSizes).toEqual([
      SYNC_REQUEST_INITIAL_PAGE_SIZE,
      SYNC_REQUEST_INITIAL_PAGE_SIZE,
    ]);
    // An empty EOF page is not throughput evidence, so the shared profile is
    // deliberately left untouched; the important invariant is that the retry
    // itself kept the 512-row request.
    expect(pageSizeProfileCache.preferred(scope)).toBeUndefined();
  });

  it('retains a terminal transport fallback when no retry callback runs', async () => {
    const requestedSizes: number[] = [];
    const pageSizeProfileCache = new SyncPageSizeProfileCache();
    const scope = pageSizeScope(REMOTE_PEER_ID);
    const checkpointStore = new MemorySyncCheckpointStore();
    let failTransport = true;
    const run = () => fetchSyncPages(pageFetchParams({
      syncPageRetryAttempts: 1,
      checkpointStore,
      pageSizeProfileCache,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        if (failTransport) throw new Error('terminal relay stream reset');
        return new Uint8Array();
      },
    }));

    await expect(run()).rejects.toThrow('terminal relay stream reset');
    expect(requestedSizes).toEqual([SYNC_REQUEST_INITIAL_PAGE_SIZE]);
    expect(pageSizeProfileCache.preferred(scope)).toBe(SYNC_REQUEST_SAFE_PAGE_SIZE);

    failTransport = false;
    await expect(run()).resolves.toMatchObject({ completed: true, nextOffset: 0 });
    expect(requestedSizes).toEqual([
      SYNC_REQUEST_INITIAL_PAGE_SIZE,
      SYNC_REQUEST_SAFE_PAGE_SIZE,
    ]);
  });

  it('does not poison page-size learning when request construction fails locally', async () => {
    const pageSizeProfileCache = new SyncPageSizeProfileCache();
    const scope = pageSizeScope(REMOTE_PEER_ID);
    pageSizeProfileCache.remember(scope, 2_048);
    const requestedSizes: number[] = [];
    await expect(fetchSyncPages(pageFetchParams({
      syncPageRetryAttempts: 2,
      pageSizeProfileCache,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        throw new Error('wallet signer unavailable');
      },
    }))).rejects.toThrow('wallet signer unavailable');

    expect(requestedSizes).toEqual([2_048, 2_048]);
    expect(pageSizeProfileCache.preferred(scope)).toBe(2_048);
  });

  it('does not poison page-size learning when the caller aborts during send', async () => {
    const controller = new AbortController();
    const pageSizeProfileCache = new SyncPageSizeProfileCache();
    const scope = pageSizeScope(REMOTE_PEER_ID);
    pageSizeProfileCache.remember(scope, 2_048);
    const requestedSizes: number[] = [];
    await expect(fetchSyncPages(pageFetchParams({
      syncPageRetryAttempts: 2,
      signal: controller.signal,
      pageSizeProfileCache,
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        controller.abort(new Error('node stopping'));
        throw new Error('transport closed during shutdown');
      },
    }))).rejects.toThrow('transport closed during shutdown');

    expect(requestedSizes).toEqual([2_048]);
    expect(pageSizeProfileCache.preferred(scope)).toBe(2_048);
  });

  it('bounds and expires agent-local page-size profiles', () => {
    const cache = new SyncPageSizeProfileCache(2, 100);
    cache.remember(pageSizeScope('first'), 64, 0);
    cache.remember(pageSizeScope('second'), 128, 1);
    expect(cache.preferred(pageSizeScope('first'), 2)).toBe(64);
    cache.remember(pageSizeScope('third'), 256, 3);
    expect(cache.preferred(pageSizeScope('second'), 4)).toBeUndefined();

    const expiringCache = new SyncPageSizeProfileCache(2, 100);
    expiringCache.remember(pageSizeScope('expiring'), 64, 0);
    expect(expiringCache.preferred(pageSizeScope('expiring'), 99)).toBe(64);
    expect(expiringCache.preferred(pageSizeScope('expiring'), 199)).toBeUndefined();

    const writeRefreshed = new SyncPageSizeProfileCache(2, 100);
    writeRefreshed.remember(pageSizeScope('write-refreshed'), 64, 0);
    writeRefreshed.remember(pageSizeScope('write-refreshed'), 128, 99);
    expect(writeRefreshed.preferred(pageSizeScope('write-refreshed'), 198)).toBe(128);
    expect(() => writeRefreshed.remember(pageSizeScope('invalid'), 0)).toThrow(RangeError);
  });

  it('serializes a UTF-8-correct prefix inside the response target', () => {
    const rows: SyncRow[] = Array.from({ length: 20 }, (_, i) => ({
      s: `urn:subject:${i}`,
      p: 'urn:predicate',
      o: `"${'🚀'.repeat(40)}-${i}"`,
      g: 'urn:graph',
    }));
    const budget = 600;
    const serialized = serializeResponderRowsWithinByteBudget(rows, budget);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    expect(linesFromNquads(serialized).length).toBeGreaterThan(0);
    expect(linesFromNquads(serialized).length).toBeLessThan(rows.length);
    expect(bytes).toBeLessThanOrEqual(budget);
  });

  it('lets an upgraded responder exceed 500 rows while legacy requests remain capped', async () => {
    const store = new OxigraphStore();
    const graph = `did:dkg:context-graph:${CG_ID}/context/1`;
    await store.insert(Array.from({ length: 1_200 }, (_, i) => ({
      graph,
      subject: `urn:subject:${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: `"value-${i}"`,
    })));
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });

    const legacy = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      syncSessionId: 'legacy-session',
    });
    expect(linesFromNquads(legacy)).toHaveLength(SYNC_PAGE_SIZE);

    const upgraded = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      syncSessionId: 'byte-budget-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    });
    expect(linesFromNquads(upgraded)).toHaveLength(1_200);

    await store.close();
  });

  it('lets negotiated shared-memory data use the larger byte-bounded page', async () => {
    const store = new OxigraphStore();
    const graph = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
    await store.insert(Array.from({ length: 1_200 }, (_, i) => ({
      graph,
      subject: 'urn:shared-memory-root',
      predicate: `urn:predicate:${i.toString().padStart(4, '0')}`,
      object: `"value-${i}"`,
    })));
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });

    const legacy = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: true,
      phase: 'data',
      syncSessionId: 'legacy-swm-data-session',
    });
    expect(linesFromNquads(legacy)).toHaveLength(SYNC_PAGE_SIZE);

    const upgraded = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: true,
      phase: 'data',
      syncSessionId: 'byte-budget-swm-data-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    });
    expect(linesFromNquads(upgraded)).toHaveLength(1_200);
    expect(new TextEncoder().encode(upgraded).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    await store.close();
  });

  it('keeps an oversized SWM byte-budget session alive for the serialized continuation', async () => {
    const store = new OxigraphStore();
    const graph = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
    const totalRows = 900;
    await store.insert(Array.from({ length: totalRows }, (_, i) => ({
      graph,
      subject: 'urn:shared-memory-oversized-root',
      predicate: `urn:predicate:${i.toString().padStart(4, '0')}`,
      object: `"${'x'.repeat(6_000)}-${i}"`,
    })));
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
    const request = {
      contextGraphId: CG_ID,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: true,
      phase: 'data' as const,
      syncSessionId: 'byte-budget-swm-oversized-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    };

    const first = await cap.invoke({ ...request, offset: 0 });
    const firstRows = linesFromNquads(first);
    expect(firstRows.length).toBeGreaterThan(0);
    expect(firstRows.length).toBeLessThan(totalRows);
    expect(new TextEncoder().encode(first).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    // The store-loaded slice was short (900 < 8192), but the byte serializer
    // exposed only a prefix. The same responder session must still own the
    // suffix addressed by this continuation offset.
    const second = await cap.invoke({ ...request, offset: firstRows.length });
    expect(linesFromNquads(second)).toHaveLength(totalRows - firstRows.length);

    await store.close();
  });

  it('honours the negotiated row hint for durable meta while legacy meta remains capped', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'byte-budget-meta-cg';
    const graph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    await store.insert(Array.from({ length: 1_200 }, (_, i) => ({
      graph,
      subject: `did:dkg:activity:meta-subject-${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: `"value-${i}"`,
    })));
    // Model a responder whose legacy page was deliberately reduced. The
    // additive byte-budget hint must bypass that row cap without bypassing the
    // serializer's byte cap.
    const legacyPageSize = 128;
    const cap = registerTestSyncHandler(store, { syncPageSize: legacyPageSize });

    const legacy = await cap.invoke({
      contextGraphId,
      offset: 0,
      limit: legacyPageSize,
      includeSharedMemory: false,
      phase: 'meta',
      syncSessionId: 'legacy-meta-session',
    });
    expect(linesFromNquads(legacy)).toHaveLength(legacyPageSize);

    const upgraded = await cap.invoke({
      contextGraphId,
      offset: 0,
      limit: legacyPageSize,
      includeSharedMemory: false,
      phase: 'meta',
      syncSessionId: 'byte-budget-meta-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    });
    expect(linesFromNquads(upgraded)).toHaveLength(1_200);
    expect(new TextEncoder().encode(upgraded).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    await store.close();
  });

  it('honours the negotiated row hint for shared-memory meta while legacy meta remains capped', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'byte-budget-swm-meta-cg';
    const graph = `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
    await store.insert(Array.from({ length: 1_200 }, (_, i) => ({
      graph,
      subject: `urn:swm-meta-subject-${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: `"value-${i}"`,
    })));
    const legacyPageSize = 128;
    const cap = registerTestSyncHandler(store, {
      syncPageSize: legacyPageSize,
      sharedMemoryTtlMs: 0,
    });

    const legacy = await cap.invoke({
      contextGraphId,
      offset: 0,
      limit: legacyPageSize,
      includeSharedMemory: true,
      phase: 'meta',
      syncSessionId: 'legacy-swm-meta-session',
    });
    expect(linesFromNquads(legacy)).toHaveLength(legacyPageSize);

    const upgraded = await cap.invoke({
      contextGraphId,
      offset: 0,
      limit: legacyPageSize,
      includeSharedMemory: true,
      phase: 'meta',
      syncSessionId: 'byte-budget-swm-meta-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    });
    expect(linesFromNquads(upgraded)).toHaveLength(1_200);
    expect(new TextEncoder().encode(upgraded).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    await store.close();
  });

  it('continues a byte-truncated shared-memory meta page from the same session snapshot', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'byte-budget-swm-meta-continuation-cg';
    const graph = `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
    const totalRows = 900;
    await store.insert(Array.from({ length: totalRows }, (_, i) => ({
      graph,
      subject: `urn:swm-meta-large-${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: `"${'x'.repeat(6_000)}-${i}"`,
    })));
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 128,
      sharedMemoryTtlMs: 0,
    });
    const request = {
      contextGraphId,
      limit: 128,
      includeSharedMemory: true,
      phase: 'meta' as const,
      syncSessionId: 'byte-budget-swm-meta-continuation-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    };

    const first = await cap.invoke({ ...request, offset: 0 });
    const firstRows = linesFromNquads(first);
    expect(firstRows.length).toBeGreaterThan(0);
    expect(firstRows.length).toBeLessThan(totalRows);
    expect(new TextEncoder().encode(first).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    const second = await cap.invoke({ ...request, offset: firstRows.length });
    const secondRows = linesFromNquads(second);
    expect(secondRows.length).toBe(totalRows - firstRows.length);
    expect(new TextEncoder().encode(second).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);

    await store.close();
  });

  it('never emits an oversized legacy response frame and keeps negotiated data under 4 MiB', async () => {
    const store = new OxigraphStore();
    const graph = `did:dkg:context-graph:${CG_ID}/context/oversized`;
    const largeObject = `"${'x'.repeat(22_000)}"`;
    await store.insert(Array.from({ length: SYNC_PAGE_SIZE }, (_, i) => ({
      graph,
      subject: `urn:large-subject:${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: largeObject,
    })));
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });

    await expect(cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      syncSessionId: 'oversized-legacy-session',
    })).rejects.toThrow(
      new RegExp(`exceeds ${DEFAULT_MAX_READ_BYTES}-byte transport frame cap`),
    );

    const negotiated = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      syncSessionId: 'oversized-negotiated-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    });
    const negotiatedBytes = new TextEncoder().encode(negotiated).byteLength;
    expect(negotiatedBytes).toBeGreaterThan(0);
    expect(negotiatedBytes).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
    expect(linesFromNquads(negotiated).length).toBeLessThan(SYNC_PAGE_SIZE);

    await store.close();
  });

  it('guards an oversized prepared catalog response at the common protocol boundary', async () => {
    const store = new OxigraphStore();
    const graph = contextGraphCatalogUri(CG_ID);
    const largeObject = `"${'c'.repeat(22_000)}"`;
    await store.insert(Array.from({ length: SYNC_PAGE_SIZE }, (_, i) => ({
      graph,
      subject: `urn:catalog-subject:${i.toString().padStart(4, '0')}`,
      predicate: 'urn:predicate',
      object: largeObject,
    })));
    const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });

    await expect(cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'catalog',
    })).rejects.toThrow(
      new RegExp(`exceeds ${DEFAULT_MAX_READ_BYTES}-byte transport frame cap`),
    );

    await store.close();
  });

  it('retains the 64-row transport fallback floor', () => {
    expect(SYNC_REQUEST_SAFE_PAGE_SIZE).toBe(64);
  });

  it('derives exact-fetch resource policy without trusting signature fields', () => {
    expect(resolveDataRequestPolicy({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      hasExactAssetFilter: true,
    })).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_EXACT_PAGE_READ_MAX_ROWS,
      cacheMode: 'page-only',
      exactGraphReadMode: 'page-only',
    });

    expect(resolveDataRequestPolicy({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      hasExactAssetFilter: false,
    })).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_PAGE_SIZE,
      cacheMode: 'session-snapshot',
      exactGraphReadMode: 'snapshot-or-page',
    });

    expect(resolveDataRequestPolicy({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: true,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      hasExactAssetFilter: false,
    })).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_PAGE_SIZE,
      cacheMode: 'session-snapshot',
      exactGraphReadMode: 'snapshot-or-page',
    });
  });
});
