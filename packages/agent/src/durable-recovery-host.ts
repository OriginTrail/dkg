// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from './dkg-agent.js';

/** Explicit, lazily bound dependencies; the owner preserves shared admission and capability identity. */
export function createDurableRecoveryHost(agent: DKGAgent) {
  const owner: object = agent;
  return {
    owner,
    get bindSubscriptionOnChainId() { return agent['bindSubscriptionOnChainId'].bind(agent); },
    get captureExperimentalExactBatchRefusalScope() { return agent['captureExperimentalExactBatchRefusalScope'].bind(agent); },
    get chain() { return agent['chain']; },
    get computeSyncDigest() { return agent['computeSyncDigest'].bind(agent); },
    get config() { return agent['config']; },
    get contextGraphBindingState() { return agent['contextGraphBindingState']; },
    get ensurePeerConnected() { return agent['ensurePeerConnected'].bind(agent); },
    get fetchSyncPages() { return agent['fetchSyncPages'].bind(agent); },
    get getOrCreateSyncVerifyWorker() { return agent['getOrCreateSyncVerifyWorker'].bind(agent); },
    get getPeerProtocols() { return agent['getPeerProtocols'].bind(agent); },
    get getSyncReconcilerConnectionKey() { return agent['getSyncReconcilerConnectionKey'].bind(agent); },
    get graphScopedStoreClosed() { return agent['graphScopedStoreClosed']; },
    get graphScopedStorePhysicalRuns() { return agent['graphScopedStorePhysicalRuns']; },
    get insertSyncedQuadsAndInvalidateListCache() { return agent['insertSyncedQuadsAndInvalidateListCache'].bind(agent); },
    get invalidateListContextGraphsCache() { return agent['invalidateListContextGraphsCache'].bind(agent); },
    get log() { return agent['log']; },
    get node() { return agent['node']; },
    get oversizeTombstoneLog() { return agent['oversizeTombstoneLog']; },
    get peerId() { return agent['peerId']; },
    get persistContextGraphSyncStateStrict() { return agent['persistContextGraphSyncStateStrict'].bind(agent); },
    get processDurableBatchInWorker() { return agent['processDurableBatchInWorker'].bind(agent); },
    get requireLocalCgMatchesOnChainSlot() { return agent['requireLocalCgMatchesOnChainSlot'].bind(agent); },
    get retireFinalizedSwmTwinCandidate() { return agent['retireFinalizedSwmTwinCandidate'].bind(agent); },
    get retireLegacySwmAfterVerifiedVmTwin() { return agent['retireLegacySwmAfterVerifiedVmTwin'].bind(agent); },
    get router() { return agent['router']; },
    get store() { return agent['store']; },
    get subscribedContextGraphs() { return agent['subscribedContextGraphs']; },
    get syncCheckpoints() { return agent['syncCheckpoints']; },
    get writeLocks() { return agent['writeLocks']; },
    runContextGraphSyncWithBackpressure<T>(
      ...args: Parameters<typeof agent.runContextGraphSyncWithBackpressure<T>>
    ): Promise<T> {
      return agent.runContextGraphSyncWithBackpressure<T>(...args);
    },
    get resolveRegisteredContextGraphAuthority() { return agent['resolveRegisteredContextGraphAuthority'].bind(agent); },
  };
}

export type DurableRecoveryHost = ReturnType<typeof createDurableRecoveryHost>;
