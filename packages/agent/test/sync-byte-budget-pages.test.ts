import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SYNC_BYTE_BUDGET_PAGE_MODE,
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

  it('retains the 64-row transport fallback floor', () => {
    expect(SYNC_REQUEST_SAFE_PAGE_SIZE).toBe(64);
  });
});
