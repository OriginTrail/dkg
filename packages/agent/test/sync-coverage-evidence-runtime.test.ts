import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

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

function withSettledSharedMemoryTerminals(
  summary: ReturnType<typeof cleanSharedMemorySyncResult>,
  contextGraphIds: readonly string[],
) {
  return {
    ...summary,
    contextGraphTerminals: Object.freeze(contextGraphIds.map((contextGraphId) => Object.freeze({
      contextGraphId,
      lane: 'shared_memory' as const,
      disposition: 'settled' as const,
      result: Object.freeze({ ...summary }),
    }))),
  };
}

async function createEvidenceAgent(
  nodeRole: 'edge' | 'core',
  selected: string[],
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `SyncEvidence${nodeRole}`,
    listenHost: '127.0.0.1',
    nodeRole,
    syncContextGraphs: selected,
    chainAdapter: new MockChainAdapter(),
  });
  (agent as any).started = true;
  (agent as any).networkAdmissionCoordinator.isAcceptedPeer = () => true;
  (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
  (agent as any).syncFromPeerDetailed = async () => cleanDurableSyncResult();
  (agent as any).syncSharedMemoryFromPeerDetailed = async (
    _peerId: string,
    contextGraphIds: string[],
  ) => {
    const summary = cleanSharedMemorySyncResult();
    return withSettledSharedMemoryTerminals(summary, contextGraphIds);
  };
  (agent as any).discoverContextGraphsFromStore = async () => 0;
  (agent as any).planSharedMemorySyncContextGraphs = async (
    _peerId: string,
    contextGraphIds: string[],
  ) => ({
    publicContextGraphIds: [...contextGraphIds],
    privateRecoverFromCurator: [],
    eligibleContextGraphIds: [...contextGraphIds],
  });
  (agent as any).refreshMetaSyncedFlags = async (contextGraphIds: string[]) => {
    const confirmed = new Set<string>();
    for (const contextGraphId of contextGraphIds) {
      const existing = (agent as any).subscribedContextGraphs.get(contextGraphId);
      if (existing) {
        existing.metaSynced = true;
        confirmed.add(contextGraphId);
      }
    }
    return confirmed;
  };
  (agent as any).hasConfirmedMetaState = async () => true;
  return agent;
}

async function runConnectionOpenSync(agent: DKGAgent): Promise<void> {
  (agent as any).getSyncReconcilerProbe = async () => ({
    protocolsKey: PROTOCOL_SYNC,
    connectionKey: PEER,
  });
  const errors: unknown[] = [];
  await (agent as any).runSyncFromPeerOnConnect(
    PEER,
    (_peerId: string, error: unknown) => errors.push(error),
  );
  expect(errors).toEqual([]);
}

describe('automatic sync coverage runtime evidence', () => {
  it('does not let direct library calls manufacture an internal trigger source', async () => {
    const agent = await createEvidenceAgent('core', []);
    (agent as any).subscribedContextGraphs.set('cg-automatic', {
      subscribed: false,
      metaSynced: false,
    });
    (agent as any).registerCorePublicSyncContextGraph('cg-automatic');

    await (agent as any).trySyncFromPeer(PEER);

    expect(agent.getSyncCoverageEvidence().entries).toEqual([]);
  });

  it('records actual terminal Core automatic-round work with per-CG job evidence', async () => {
    const selected = 'cg-selected';
    const automatic = 'cg-automatic';
    const agent = await createEvidenceAgent('core', [selected]);
    (agent as any).subscribedContextGraphs.set(selected, { subscribed: true, metaSynced: false });
    (agent as any).subscribedContextGraphs.set(automatic, { subscribed: false, metaSynced: false });
    (agent as any).registerCorePublicSyncContextGraph(automatic);

    await runConnectionOpenSync(agent);
    const snapshot = agent.getSyncCoverageEvidence();

    expect(snapshot.processStartedAt).toBe(Math.floor(performance.timeOrigin));
    expect(snapshot.entries).toHaveLength(2);
    const [running, complete] = snapshot.entries;
    expect(running).toMatchObject({
      kind: 'core-automatic-round',
      source: 'automatic-core-public',
      trigger: 'connection-open',
      planningLane: PEER,
      explicitSelectedContextGraphIds: [selected],
      automaticContextGraphIds: [automatic],
      automaticContextGraphCount: 1,
      evidenceTruncated: false,
      state: 'running',
      completions: [{ contextGraphId: automatic, state: 'running' }],
    });
    expect((running as any).completions[0].jobId).toBe(running!.jobId);
    expect(complete).toMatchObject({
      kind: 'core-automatic-round',
      jobId: running!.jobId,
      state: 'complete',
      completions: [{
        jobId: (running as any).completions[0].jobId,
        contextGraphId: automatic,
        state: 'complete',
        verified: { metadata: true, durable: true, sharedMemory: true },
      }],
    });
    expect(complete!.sequence).toBe(running!.sequence + 1);
  });

  it('records only startup-rehydrated always-on Edge selections on periodic work', async () => {
    const rehydrated = 'cg-rehydrated';
    const runtimeSelected = 'cg-runtime-selected';
    const agent = await createEvidenceAgent('edge', [rehydrated, runtimeSelected]);
    for (const contextGraphId of [rehydrated, runtimeSelected]) {
      (agent as any).subscribedContextGraphs.set(contextGraphId, {
        subscribed: true,
        syncMode: 'always-on',
        metaSynced: false,
      });
    }
    (agent as any).rehydratedAlwaysOnSyncContextGraphs.add(rehydrated);

    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER }],
      getConnections: () => [],
    };
    (agent as any).getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: PEER,
    });
    await (agent as any).reconcileSyncFromConnectedPeers();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (agent.getSyncCoverageEvidence().entries.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const entries = agent.getSyncCoverageEvidence().entries;

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.contextGraphId)).toEqual([rehydrated, rehydrated]);
    expect(entries[0]).toMatchObject({
      kind: 'edge-reconciler-job',
      source: 'reconciler',
      trigger: 'periodic-reconciler',
      syncMode: 'always-on',
      rehydratedSelectionCount: 1,
      evidenceTruncated: false,
      state: 'running',
    });
    expect(entries[1]).toMatchObject({
      jobId: entries[0]!.jobId,
      state: 'complete',
      verified: { metadata: true, durable: true, sharedMemory: true },
    });
  });

  it('fails closed when an observed plane does not reach a clean terminal result', async () => {
    const automatic = 'cg-automatic';
    const agent = await createEvidenceAgent('core', []);
    (agent as any).subscribedContextGraphs.set(automatic, { subscribed: false, metaSynced: false });
    (agent as any).registerCorePublicSyncContextGraph(automatic);
    (agent as any).syncSharedMemoryFromPeerDetailed = async (
      _peerId: string,
      contextGraphIds: string[],
    ) => {
      const failed = {
        ...cleanSharedMemorySyncResult(),
        failedPhases: 1,
        backoffWorthyFailures: 1,
      };
      return withSettledSharedMemoryTerminals(failed, contextGraphIds);
    };

    await runConnectionOpenSync(agent);
    const terminal = agent.getSyncCoverageEvidence().entries.at(-1);

    expect(terminal).toMatchObject({
      kind: 'core-automatic-round',
      state: 'failed',
      completions: [{
        contextGraphId: automatic,
        state: 'failed',
        verified: { metadata: true, durable: true, sharedMemory: false },
      }],
    });
  });

  it('does not verify shared memory when received triples were dropped', async () => {
    const automatic = 'cg-automatic';
    const agent = await createEvidenceAgent('core', []);
    (agent as any).subscribedContextGraphs.set(automatic, { subscribed: false, metaSynced: false });
    (agent as any).registerCorePublicSyncContextGraph(automatic);
    (agent as any).syncSharedMemoryFromPeerDetailed = async (
      _peerId: string,
      contextGraphIds: string[],
    ) => {
      const incomplete = {
        ...cleanSharedMemorySyncResult(),
        droppedDataTriples: 1,
      };
      return withSettledSharedMemoryTerminals(incomplete, contextGraphIds);
    };

    await runConnectionOpenSync(agent);
    const terminal = agent.getSyncCoverageEvidence().entries.at(-1);

    expect(terminal).toMatchObject({
      kind: 'core-automatic-round',
      state: 'failed',
      completions: [{
        contextGraphId: automatic,
        state: 'failed',
        verified: { metadata: true, durable: true, sharedMemory: false },
      }],
    });
  });
});
