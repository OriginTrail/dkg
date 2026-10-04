import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  contextGraphCatalogUri,
  DEFAULT_MAX_READ_BYTES,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SYNC_BYTE_BUDGET_EXACT_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
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
import { resolveSyncResponderRequestProfile } from '../src/sync/responder/page-framing-policy.js';
import * as wireCompression from '../src/sync/wire-compression.js';
import {
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

const CG_ID = 'byte-budget-cg';
const POLICY_UAL = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
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
  it.each(['data', 'meta'] as const)('negotiates shared-memory %s paging above the legacy cap', async (phase) => {
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: CG_ID, offset: 0, limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: true, phase, needsAuth: false,
      targetPeerId: REMOTE_PEER_ID, requesterPeerId: LOCAL_PEER_ID,
      computeSyncDigest: () => new Uint8Array(32), getIdentityId: async () => 0n,
    });
    expect(new TextDecoder().decode(encoded)).toContain(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(resolveSyncResponderRequestProfile({ legacyLimit: 500, includeSharedMemory: true,
      phase, pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 1200,
      assetUals: undefined }).framing).toMatchObject({ usesByteBudgetPage: true, limit: 1200 });
  });

  it('keeps exact compression and export policy behind the durable boundary', () => {
    const request = { legacyLimit: 128, includeSharedMemory: true, phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 1200,
      assetUals: [POLICY_UAL], responseEncoding: 'gzip-nquads-v1' };
    expect(resolveSyncResponderRequestProfile(request).framing).toMatchObject({
      usesByteBudgetPage: true, limit: 1200, maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
    });
    expect(resolveSyncResponderRequestProfile(request).durableData).toMatchObject({
      cacheMode: 'session-snapshot', exactGraphReadMode: 'snapshot-or-page',
      usesExactAssetExport: false, usesByteBudgetPage: false,
      maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
    });
    expect(resolveSyncResponderRequestProfile({ ...request, includeSharedMemory: false }).framing).toMatchObject({
      usesByteBudgetPage: true, limit: 1200, maxPageBytes: 16 * 1024 * 1024,
    });
    expect(resolveSyncResponderRequestProfile({ ...request, includeSharedMemory: false }).durableData).toMatchObject({
      cacheMode: 'page-only', exactGraphReadMode: 'page-only', usesExactAssetExport: true,
    });
  });

  it.each([
    { selection: undefined, rows: 1200, cacheMode: 'session-snapshot' },
    { selection: [], rows: SYNC_BYTE_BUDGET_EXACT_MAX_ROWS, cacheMode: 'page-only' },
    { selection: [POLICY_UAL, `${POLICY_UAL.slice(0, -1)}8`], rows: SYNC_BYTE_BUDGET_EXACT_MAX_ROWS, cacheMode: 'page-only' },
  ])('keeps non-singleton selection $selection on the conservative profile', ({ selection, rows, cacheMode }) => {
    const profile = resolveSyncResponderRequestProfile({ legacyLimit: 128,
      includeSharedMemory: false, phase: 'data', pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: 1200, assetUals: selection, responseEncoding: 'gzip-nquads-v1' });
    expect(profile.compression).toBeUndefined();
    expect(profile.framing).toMatchObject({ usesByteBudgetPage: true, limit: rows,
      maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES });
    expect(profile.durableData).toMatchObject({ cacheMode, usesExactAssetExport: false });
  });

  it('uses the actual selection to negotiate once and passes that profile through encoding', async () => {
    const store = new OxigraphStore();
    const negotiation = vi.spyOn(wireCompression, 'resolveExactSyncGzipProfile');
    const encode = vi.spyOn(wireCompression, 'encodeResolvedExactSyncResponse');
    try {
      const cap = registerTestSyncHandler(store);
      await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 128,
        includeSharedMemory: false, phase: 'meta', assetUals: [POLICY_UAL],
        pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 1200,
        responseEncoding: 'gzip-nquads-v1' });
      expect(negotiation).toHaveBeenCalledOnce();
      expect(negotiation.mock.calls[0]?.[0]).toMatchObject({ assetUals: [POLICY_UAL], phase: 'meta' });
      expect(encode).toHaveBeenCalledOnce();
      expect(encode.mock.calls[0]?.[1].profile).toBe(negotiation.mock.results[0]?.value);
    } finally { negotiation.mockRestore(); encode.mockRestore(); await store.close(); }
  });

  it.each(['data', 'meta'] as const)('serves shared-memory %s row hints with byte-budget negotiation', async (phase) => {
    const store = new OxigraphStore();
    try {
      const contextGraphId = 'byte-budget-swm';
      const graph = `did:dkg:context-graph:${contextGraphId}/_shared_memory${phase === 'meta' ? '_meta' : ''}`;
      await store.insert(Array.from({ length: 1200 }, (_, i) => ({ graph,
        subject: `urn:swm:${i}`, predicate: 'urn:value', object: `"value-${i}"` })));
      const cap = registerTestSyncHandler(store, { syncPageSize: 128 });
      const request = { contextGraphId, offset: 0, limit: 128, includeSharedMemory: true, phase };
      expect(linesFromNquads(await cap.invoke(request))).toHaveLength(128);
      const upgraded = await cap.invoke({ ...request, pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 1200 });
      expect(linesFromNquads(upgraded)).toHaveLength(1200);
      expect(new TextEncoder().encode(upgraded).byteLength).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
    } finally { await store.close(); }
  });

  it.each(['data', 'meta'] as const)('bounds shared-memory %s bytes and resumes the emitted row prefix', async (phase) => {
    const store = new OxigraphStore();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const contextGraphId = 'byte-fit-swm';
      const graph = `did:dkg:context-graph:${contextGraphId}/_shared_memory${phase === 'meta' ? '_meta' : ''}`;
      await store.insert(Array.from({ length: 220 }, (_, i) => ({ graph,
        subject: `urn:swm:${String(i).padStart(4, '0')}`, predicate: 'urn:value',
        object: `"${'x'.repeat(22_000)}"` })));
      const cap = registerTestSyncHandler(store, { syncPageSize: 128, snapshotBudget: {
        maxRows: 300, maxSnapshotRows: 300,
        maxBytesEstimate: 64 * 1024 * 1024, maxSnapshotBytesEstimate: 64 * 1024 * 1024,
      } });
      const request = { contextGraphId, limit: 128, includeSharedMemory: true, phase,
        syncSessionId: `swm-byte-fit-${phase}`, pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 1200 };
      const first = await cap.invoke({ ...request, offset: 0 });
      const firstRows = linesFromNquads(first);
      expect(firstRows.length).toBeGreaterThan(128);
      expect(firstRows.length).toBeLessThan(220);
      expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
      const competitor = { ...request, syncSessionId: `competing-${phase}`, offset: 0 };
      await expect(cap.invoke(competitor, 'competing-peer')).rejects.toThrow(/global rows budget/u);
      const now = Date.now();
      clock = vi.spyOn(Date, 'now').mockImplementation(() => now + 31_000);
      const second = await cap.invoke({ ...request, offset: firstRows.length });
      const allRows = [...firstRows, ...linesFromNquads(second)];
      expect(allRows).toHaveLength(220);
      expect(new Set(allRows).size).toBe(220);
      expect(new TextEncoder().encode(second).byteLength).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
      expect(await cap.invoke({ ...request, offset: allRows.length })).toBe('');
      // Empty EOF releases the pin, so the competing snapshot can evict it.
      expect(linesFromNquads(await cap.invoke(competitor, 'competing-peer')).length).toBeGreaterThan(128);
    } finally { clock?.mockRestore(); await store.close(); }
  });

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
    expect(resolveSyncResponderRequestProfile({
      legacyLimit: request.limit,
      includeSharedMemory: false,
      phase: request.phase,
      pageMode: request.pageMode,
      pageRowsHint: request.pageRowsHint,
      assetUals: [POLICY_UAL],
    }).durableData).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      cacheMode: 'page-only',
      exactGraphReadMode: 'page-only',
      maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
      usesExactAssetExport: false,
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
    expect(resolveSyncResponderRequestProfile({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      assetUals: [POLICY_UAL],
    }).durableData).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_BYTE_BUDGET_EXACT_MAX_ROWS,
      cacheMode: 'page-only',
      exactGraphReadMode: 'page-only',
      maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
      usesExactAssetExport: false,
    });

    expect(resolveSyncResponderRequestProfile({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      assetUals: undefined,
    }).durableData).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_PAGE_SIZE,
      cacheMode: 'session-snapshot',
      exactGraphReadMode: 'snapshot-or-page',
      maxPageBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
      usesExactAssetExport: false,
    });
  });
});
