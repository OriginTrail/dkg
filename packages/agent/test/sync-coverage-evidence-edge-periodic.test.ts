import { describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKGAgent,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
} from '../src/index.js';

const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition did not become true');
}

function cleanDurableSyncResult() {
  return {
    insertedTriples: 0,
    insertedDataTriples: 0,
    insertedMetaTriples: 0,
    fetchedDataTriples: 0,
    fetchedMetaTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 10,
    checkpointAdvances: 0,
    emptyResponses: 1,
    metaOnlyResponses: 0,
    verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    complete: true,
  };
}

function cleanSharedMemorySyncResult() {
  return {
    insertedTriples: 0,
    insertedDataTriples: 0,
    insertedMetaTriples: 0,
    fetchedDataTriples: 0,
    fetchedMetaTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 1,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
  };
}

async function createRehydratedEdgeEvidenceAgent(contextGraphId: string): Promise<DKGAgent> {
  const persisted = new Map<string, ContextGraphSubscriptionRecord>([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    sharedMemorySynced: false,
    metaSynced: false,
    syncAdmission: 'explicit',
    syncScoped: true,
  }]]);
  const contextGraphSubscriptionStore: ContextGraphSubscriptionStore = {
    loadAll: async () => [...persisted.values()],
    save: async (record) => { persisted.set(record.id, { ...record }); },
    delete: async (id) => { persisted.delete(id); },
  };
  const agent = await DKGAgent.create({
    name: 'SyncEvidenceEdgePeriodic',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    syncContextGraphs: [],
    chainAdapter: new MockChainAdapter(),
    contextGraphSubscriptionStore,
  });
  (agent as any).started = true;
  (agent as any).networkAdmissionCoordinator.isAcceptedPeer = () => true;
  (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
  (agent as any).discoverContextGraphsFromStore = async () => 0;
  (agent as any).planSharedMemorySyncContextGraphs = async (
    _peerId: string,
    contextGraphIds: string[],
  ) => ({
    publicContextGraphIds: [...contextGraphIds],
    privateRecoverFromCurator: [],
    eligibleContextGraphIds: [...contextGraphIds],
  });
  (agent as any).refreshMetaSyncedFlags = async () => new Set<string>();
  (agent as any).hasConfirmedMetaState = async () => true;
  (agent as any).gossip = {
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    onMessage: () => undefined,
    offMessage: () => undefined,
  };
  (agent.node as any).node = {
    peerId: { toString: () => '12D3KooWLocalEvidencePeer' },
  };
  await (agent as any).rehydrateContextGraphSubscriptions();
  (agent.node as any).node = {
    getPeers: () => [{ toString: () => PEER }],
    getConnections: () => [],
  };
  (agent as any).getSyncReconcilerProbe = async () => ({
    protocolsKey: PROTOCOL_SYNC,
    connectionKey: PEER,
  });
  return agent;
}

describe('Edge periodic sync scope evidence', () => {
  it('keeps the normal Edge periodic scope when broad sync-on-connect is enabled', async () => {
    const rehydrated = 'cg-rehydrated-normal-periodic';
    const runtimeSelected = 'cg-runtime-normal-periodic';
    const agent = await createRehydratedEdgeEvidenceAgent(rehydrated);
    (agent as any).config.syncOnConnectEnabled = true;
    (agent as any).config.syncSharedMemoryOnConnect = true;
    (agent as any).config.syncContextGraphs.push(runtimeSelected);
    (agent as any).subscribedContextGraphs.set(runtimeSelected, {
      subscribed: true,
      syncMode: 'always-on',
      syncAdmission: 'explicit',
      metaSynced: false,
    });
    const durableScopes: string[][] = [];
    const sharedMemoryScopes: string[][] = [];
    (agent as any).syncFromPeerDetailed = async (
      _peerId: string,
      contextGraphIds: string[],
    ) => {
      durableScopes.push([...contextGraphIds]);
      return cleanDurableSyncResult();
    };
    (agent as any).syncSharedMemoryFromPeerDetailed = async (
      _peerId: string,
      contextGraphIds: string[],
    ) => {
      sharedMemoryScopes.push([...contextGraphIds]);
      const summary = cleanSharedMemorySyncResult();
      return {
        ...summary,
        contextGraphTerminals: contextGraphIds.map((id) => ({
          contextGraphId: id,
          lane: 'shared_memory' as const,
          disposition: 'settled' as const,
          result: { ...summary },
        })),
      };
    };

    await (agent as any).reconcileSyncFromConnectedPeers();
    await waitFor(() => (agent as any).lastSuccessfulSyncAt.has(PEER));

    expect(durableScopes).toEqual([[
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      rehydrated,
      runtimeSelected,
    ]]);
    expect(sharedMemoryScopes).toEqual([[rehydrated, runtimeSelected]]);
  });
});
