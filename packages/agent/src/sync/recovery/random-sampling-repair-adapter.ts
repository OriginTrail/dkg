import {
  tripleContentV10,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { RandomSamplingRepairMaterial } from '@origintrail-official/dkg-random-sampling';
import type { ChallengePinnedGraphScopedAsset } from '../requester/graph-scoped-materialization.js';
import { createChallengePinnedExactAssetSelection } from '../exact-assets.js';
import {
  runRandomSamplingExactRepair,
  type RandomSamplingExactRepairInput,
} from './random-sampling-exact-repair.js';

interface PeerIdentityLike {
  toString(): string;
}

interface RandomSamplingRepairAgent {
  readonly started: boolean;
  readonly chain: {
    readonly chainId: string;
    getDKGKnowledgeAssetsAddress?(): Promise<string>;
    getKnowledgeAssetsLifecycleAddress(): Promise<string>;
  };
  readonly node: { readonly stopSignal?: AbortSignal };
  readonly log: { info(ctx: OperationContext, message: string): void };
  resolveLocalCgIdByOnChainId(cgId: bigint): string | null | undefined;
  vmReconcileObservedCandidatePeerIds(localContextGraphId: string): string[];
  selectCatchupPeerWindow(
    candidates: PeerIdentityLike[],
    options: { readonly maxPeers: number; readonly peerRotationKey: string },
  ): PeerIdentityLike[];
  ensurePeerAdmittedForRecovery(
    peerId: string,
    ctx: OperationContext,
    reason: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  ensurePeerConnected(peerId: string, options: { signal: AbortSignal }): Promise<void>;
  waitForSyncProtocol(peer: PeerIdentityLike, signal: AbortSignal): Promise<boolean>;
  syncExactKnowledgeAssetsFromPeerDetailed(
    peerId: string,
    localContextGraphId: string,
    selection: ReturnType<typeof createChallengePinnedExactAssetSelection>,
    options: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
  ): Promise<{
    readonly result: { readonly insertedTriples: number };
    readonly disposition: 'found' | 'clean-absent' | 'incomplete';
    readonly authenticatedAssets?: readonly ChallengePinnedGraphScopedAsset[];
  }>;
}

/** Feature adapter kept outside the lifecycle monolith. */
export function repairRandomSamplingKnowledgeAssetWithAgent(
  agentInput: unknown,
  ctx: OperationContext,
  input: RandomSamplingExactRepairInput,
  maxPeers: number,
): Promise<RandomSamplingRepairMaterial> {
  // This adapter is called only by the lifecycle class; keeping the structural
  // view here avoids exporting protected lifecycle internals as public API.
  const agent = agentInput as RandomSamplingRepairAgent;
  return runRandomSamplingExactRepair({
    chainId: agent.chain.chainId,
    maxPeers,
    stopSignal: agent.node.stopSignal,
    resolveStorageAddress: () => agent.chain.getDKGKnowledgeAssetsAddress
      ? agent.chain.getDKGKnowledgeAssetsAddress()
      : agent.chain.getKnowledgeAssetsLifecycleAddress(),
    resolveLocalContextGraphId: (cgId) =>
      agent.resolveLocalCgIdByOnChainId(cgId) ?? undefined,
    observedCandidatePeerIds: (localCgId) =>
      agent.vmReconcileObservedCandidatePeerIds(localCgId),
    selectPeerWindow: (peerIds, options) => agent.selectCatchupPeerWindow(
      peerIds.map((peerId) => ({ toString: () => peerId })),
      options,
    ).map((peer) => peer.toString()),
    ensurePeerAdmitted: (peerId, signal) => agent.ensurePeerAdmittedForRecovery(
      peerId,
      ctx,
      'Random Sampling exact repair peer',
      signal,
    ),
    ensurePeerConnected: (peerId, signal) => agent.ensurePeerConnected(peerId, { signal }),
    waitForSyncProtocol: (peerId, signal) =>
      agent.waitForSyncProtocol({ toString: () => peerId }, signal),
    fetchExactKnowledgeAsset: async (
      peerId,
      localCgId,
      _assetUal,
      expectedCommitment,
      signal,
    ) => {
      const result = await agent.syncExactKnowledgeAssetsFromPeerDetailed(
        peerId,
        localCgId,
        createChallengePinnedExactAssetSelection([expectedCommitment]),
        {
          signal,
          isCurrent: () => agent.started && !signal.aborted,
        },
      );
      const authenticated = result.authenticatedAssets?.find(
        ({ asset }) => asset.ual === expectedCommitment.assetUal,
      );
      const proofMaterial = authenticated === undefined
        ? undefined
        : Object.freeze({
            contents: Object.freeze(authenticated.asset.dataQuads.map((quad) => (
              tripleContentV10(quad.subject, quad.predicate, quad.object)
            ))),
            privateRoots: Object.freeze([...authenticated.privateRoots]),
          });
      return {
        disposition: result.disposition,
        insertedTriples: result.result.insertedTriples,
        ...(proofMaterial === undefined ? {} : { proofMaterial }),
      };
    },
    logInfo: (message) => agent.log.info(ctx, message),
  }, input);
}
