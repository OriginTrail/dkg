import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SYNC_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../src/sync/durable-recovery-runner.js';
import { runDurableSync, type DurableMetaContinuation } from '../src/sync/requester/durable-sync.js';
import { deleteSyncPageCheckpoint, fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';

const CG = 'slice-yield-cg';
const PEER = '12D3KooWSliceYieldPeer';
const ctx = { operationId: 'slice-yield', operationName: 'sync' } as OperationContext;

interface AssetFixture {
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
}

function asset(kaNumber: number): AssetFixture {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, '1'));
  const payload = Array.from({ length: 4 + kaNumber }, (_, index): Quad => ({
    subject: `urn:slice-yield:${kaNumber}:${index}`,
    predicate: 'urn:slice-yield:value',
    object: `"${index}"`,
    graph,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: '1',
    publicTripleCount: payload.length,
    privateTripleCount: 0,
    assertionGraph: graph,
  }, { status: 'tentative' });
  return { ual, graph, payload, meta };
}

/** A peer serving one graph: META, then DATA in manifest order (exact graphs by code point). */
function servingPeer(assets: readonly AssetFixture[]) {
  const ordered = [...assets].sort((left, right) => (left.graph < right.graph ? -1 : left.graph > right.graph ? 1 : 0));
  let pending: { phase: string; offset: number; limit: number } | undefined;
  const responses = new Map<string, Quad[]>();
  return {
    buildSyncRequest: async (
      _cg: string, offset: number, limit: number, _swm: boolean, _peer: string, phase?: string,
    ) => {
      pending = { phase: phase ?? 'data', offset, limit };
      return new TextEncoder().encode('request');
    },
    send: async () => {
      const { phase, offset, limit } = pending!;
      const rows = ordered.flatMap((fixture) => (phase === 'meta' ? fixture.meta : fixture.payload));
      const page = rows.slice(offset, offset + limit);
      if (page.length === 0) return new Uint8Array();
      const id = `response-${responses.size}`;
      responses.set(id, page);
      return new TextEncoder().encode(id);
    },
    parseAndFilter: async (body: string) => {
      const quads = responses.get(body) ?? [];
      return { quads, totalQuads: quads.length };
    },
  };
}

function processBatch(
  dataQuads: Quad[],
  metaQuads: Quad[],
  _ctx: OperationContext,
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode,
) {
  const wire = processDurableBatchForWire(dataQuads, metaQuads, acceptUnverified, mode);
  return {
    verifiedData: wire.verifiedDataIndexes.map((index) => dataQuads[index]!),
    verifiedMeta: wire.verifiedMetaIndexes.map((index) => metaQuads[index]!),
    verifiedGraphScopedDataGraphs: wire.verifiedGraphScopedDataGraphs,
    consumedUnpersistedMetaTriples: wire.consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses: wire.verifiedPrivateOnlyResponses,
    totalFetchedDataQuads: wire.totalFetchedDataQuads,
    totalFetchedMetaQuads: wire.totalFetchedMetaQuads,
    rejectedKcs: wire.rejectedKcs,
    emptyResponses: wire.emptyResponses,
    metaOnlyResponses: wire.metaOnlyResponses,
    dataRejectedMissingMeta: wire.dataRejectedMissingMeta,
  };
}

describe('a recovery whose rounds outlast their slices', () => {
  it('fetches META again from row zero after a round yields, so every DATA round is bounded', async () => {
    const graph = Array.from({ length: 12 }, (_, index) => asset(index + 1));
    const peer = servingPeer(graph);
    const checkpointStore = new MemorySyncCheckpointStore();
    const writes: string[] = [];
    const info: string[] = [];
    const dataRounds: Array<{ manifestBound: boolean; bounded: boolean }> = [];
    const round = (durableMetaContinuation: DurableMetaContinuation) => runDurableSync({
      ctx,
      remotePeerId: PEER,
      contextGraphIds: [CG],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      // Each round starts past its slice's soft deadline, so it yields at the first settled boundary it can.
      settlementSliceDeadline: Date.now(),
      durableMetaContinuation,
      fetchSyncPages: (request) => {
        if (request.phase === 'data') {
          dataRounds.push({
            manifestBound: request.manifestDigest !== undefined,
            bounded: request.shouldStopAfterPage !== undefined,
          });
        }
        return fetchSyncPages({
          ctx: request.ctx,
          remotePeerId: request.remotePeerId,
          contextGraphId: request.contextGraphId,
          includeSharedMemory: false,
          phase: request.phase,
          graphUri: request.graphUri,
          deadline: request.fetchContext.deadline,
          syncPageTimeoutMs: 5_000,
          syncRouterAttempts: 1,
          syncPageRetryAttempts: 1,
          syncPageSize: SYNC_PAGE_SIZE,
          syncDeniedResponse: '#DENIED',
          debugSyncProgress: false,
          protocolSync: '/test/durable-slice-yield',
          checkpointStore,
          forceFreshSession: request.forceFreshSession,
          manifestDigest: request.manifestDigest,
          manifestPrefixDigestAtOffset: request.manifestPrefixDigestAtOffset,
          shouldStopAfterPage: request.shouldStopAfterPage,
          requesterScope: request.requesterScope,
          buildSyncRequest: peer.buildSyncRequest,
          send: peer.send,
          parseAndFilter: peer.parseAndFilter,
          logWarn: () => {},
          logInfo: () => {},
          logDebug: () => {},
        });
      },
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({ asset: verified }) => {
        writes.push(verified.ual);
        return 'applied';
      },
      deleteCheckpoint: (key) => deleteSyncPageCheckpoint(checkpointStore, key),
      setCheckpoint: (key, checkpoint) => {
        if (checkpoint.binding) {
          checkpointStore.setManifestBoundOffset(key, checkpoint.offset, checkpoint.binding.manifestDigest, Date.now(),
            checkpoint.binding.manifestPrefixDigest, checkpoint.binding.terminal, checkpoint.responderSessionOffset);
        } else checkpointStore.set(key, checkpoint.offset, Date.now(), checkpoint.responderSessionOffset);
      },
      logInfo: (_ctx, message) => { info.push(message); },
      logWarn: (_ctx, message) => { info.push(message); },
      logDebug: () => {},
    });
    const dependencies: DurableRecoveryRunnerDependencies = {
      checkpointStore,
      isRunning: () => true,
      resolvePreferredPeerId: async () => undefined,
      connectRequestedPeer: async () => {},
      primeConnections: async () => {},
      liveConnectionPeerIds: () => [PEER],
      admitPeer: async () => true,
      isPrivateContextGraph: async () => false,
      orderPeerIds: (peerIds) => [...peerIds],
      isSyncCapable: async () => true,
      executeSlice: (_peerId, continuation) => round(continuation),
      logDebug: () => {},
      logInfo: (message) => { info.push(message); },
      logWarn: (message) => { info.push(message); },
    };

    const recovered = await new DurableRecoveryRunner().run({ contextGraphId: CG, dependencies });

    expect(recovered.outcome).toBe('terminal');
    expect([...writes].sort()).toEqual(graph.map((fixture) => fixture.ual).sort());
    expect(info.filter((line) => line.startsWith('Yielding durable recovery')).length).toBeGreaterThan(1);
    // Every DATA round ran under a complete manifest, and so under the round bound.
    expect(dataRounds.length).toBeGreaterThan(1);
    expect(dataRounds).toEqual(dataRounds.map(() => ({ manifestBound: true, bounded: true })));
  });
});
