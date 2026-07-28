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
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../src/dkg-agent-constants.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import {
  serializeResponderRowsWithinByteBudget,
  type SyncRow,
} from '../src/sync/responder/graph-plan.js';
import { resolveDurableDataRequestPolicy } from '../src/sync/responder/durable-data-request-policy.js';
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
      { offset: 0, limit: SYNC_REQUEST_PAGE_SIZE },
      { offset: SYNC_PAGE_SIZE, limit: SYNC_REQUEST_PAGE_SIZE },
    ]);
    expect(result.nextOffset).toBe(SYNC_PAGE_SIZE);
    expect(result.completed).toBe(true);
  });

  it('keeps a successful fallback size sticky and probes upward gradually', async () => {
    const requestedSizes: number[] = [];
    let sends = 0;
    const result = await fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: true,
      phase: 'snapshot',
      graphUri: '',
      snapshotRef: 'snapshot-ref',
      deadline: Date.now() + 15_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 2,
      syncPageSize: SYNC_REQUEST_PAGE_SIZE,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: '/dkg/test/sync',
      checkpointStore: new MemorySyncCheckpointStore(),
      buildSyncRequest: async (_cg, _offset, limit) => {
        requestedSizes.push(limit);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 100 }),
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error('relay stream reset');
        return sends <= 4
          ? new TextEncoder().encode('<urn:s> <urn:p> <urn:o> <urn:g> .')
          : new Uint8Array();
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    expect(requestedSizes).toEqual([
      SYNC_REQUEST_PAGE_SIZE,
      SYNC_REQUEST_PAGE_SIZE / 2,
      SYNC_REQUEST_PAGE_SIZE / 2,
      SYNC_REQUEST_PAGE_SIZE / 2,
      SYNC_REQUEST_PAGE_SIZE,
    ]);
    expect(result.completed).toBe(true);
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
    expect(resolveDurableDataRequestPolicy({
      legacyLimit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      hasExactAssetFilter: true,
    })).toEqual({
      usesByteBudgetPage: true,
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      cacheMode: 'page-only',
      exactGraphReadMode: 'page-only',
    });

    expect(resolveDurableDataRequestPolicy({
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
  });
});
