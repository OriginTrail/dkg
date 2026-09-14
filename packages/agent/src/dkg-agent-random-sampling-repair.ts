// SPDX-License-Identifier: Apache-2.0

/**
 * Random Sampling proof-time repair, assembled as its own mixin holder so the
 * feature is not composed inside the lifecycle/sync mixin.
 *
 * The policy itself lives in `sync/recovery/random-sampling-peer-source.ts`
 * (candidate ordering, bounded Core fallback discovery, membership and
 * authentication) and in `sync/recovery/random-sampling-exact-repair.ts` (the
 * deadline-sharing traversal). What this module owns is the integration: which
 * agent capability answers each port, grouped by the owner that already holds
 * it — Core directory eligibility, the peer runtime, and the challenge-pinned
 * exact fetch — so changing one group does not mean reading the whole feature.
 *
 * `repairRandomSamplingKnowledgeAsset` stays the single public entry point the
 * prover binds to.
 */

import { createOperationContext, tripleContentV10, type OperationContext } from '@origintrail-official/dkg-core';
import type { RandomSamplingRepairOperation } from '@origintrail-official/dkg-random-sampling';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { CorePeerDirectoryEntry } from './p2p/core-peer-discovery.js';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from './sync/catchup-concurrency.js';
import { createChallengePinnedExactAssetSelection } from './sync/exact-assets.js';
import {
  startRandomSamplingExactRepair,
  type RandomSamplingExactRepairDependencies,
  type RandomSamplingExactRepairInput,
} from './sync/recovery/random-sampling-exact-repair.js';
import {
  createRandomSamplingPeerSource,
  RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS,
  type RandomSamplingPeerSource,
  type RandomSamplingPeerSourcePorts,
} from './sync/recovery/random-sampling-peer-source.js';

/** Ports answered by the Agent Registry directory and the on-chain Core roster. */
type CoreEligibilityPorts = Pick<
  RandomSamplingPeerSourcePorts,
  'selfPeerId'
  | 'maxRosterPeerIds'
  | 'coreEligibilityConcurrency'
  | 'coreDiscoveryBudgetMs'
  | 'findCoreAgents'
  | 'authenticateCorePeerAddress'
  | 'classifyCoreMembership'
>;

/** Ports answered by graph-specific provider evidence and the live peer runtime. */
type PeerRuntimePorts = Pick<
  RandomSamplingPeerSourcePorts,
  'isStarted'
  | 'resolveCuratorPeerIds'
  | 'observedCandidatePeerIds'
  | 'preferredPeerId'
  | 'connectedPeerIds'
  | 'ensurePeerAdmitted'
  | 'ensurePeerConnected'
  | 'hasSyncProtocol'
>;

/**
 * The protected agent state this feature reads. `started` and
 * `preferredSyncPeers` are only reachable from inside a `DKGAgentBase`
 * subclass, so the repair method captures them once and hands them to the
 * grouping functions below, which otherwise depend on public capabilities only.
 */
interface RandomSamplingRepairAgentState {
  isStarted(): boolean;
  preferredPeerId(localContextGraphId: string): string | undefined;
}

/**
 * Who may serve a proof-time repair: the bounded directory roster plus the two
 * gates every discovered profile must pass — a signed peer/wallet binding and a
 * positive ShardingTable read.
 */
function coreEligibilityPorts(agent: DKGAgent): CoreEligibilityPorts {
  return {
    selfPeerId: agent.peerId,
    maxRosterPeerIds: DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
    coreEligibilityConcurrency: CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
    coreDiscoveryBudgetMs: RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS,
    findCoreAgents: (options) => agent.discovery.findAgents(options),
    authenticateCorePeerAddress: (candidate, signal) =>
      agent.authenticateCorePeerAddress(candidate, signal),
    classifyCoreMembership: (candidate) =>
      agent.classifyShardingTableCore(candidate.agentAddress),
  };
}

/**
 * Which peers this node already associates with the graph, and what it takes to
 * make one of them usable for a fetch (admission, connection, sync protocol).
 */
function peerRuntimePorts(
  agent: DKGAgent,
  ctx: OperationContext,
  state: RandomSamplingRepairAgentState,
): PeerRuntimePorts {
  return {
    ...state,
    resolveCuratorPeerIds: (localContextGraphId, options) =>
      agent.resolveCuratorPeerIdsForCg(localContextGraphId, options),
    observedCandidatePeerIds: (localContextGraphId) =>
      agent.vmReconcileObservedCandidatePeerIds(localContextGraphId),
    connectedPeerIds: () => agent.node.libp2p.getConnections()
      .map((connection) => connection.remotePeer.toString()),
    ensurePeerAdmitted: (peerId, signal) => agent.ensurePeerAdmittedForRecovery(
      peerId,
      ctx,
      'Random Sampling exact repair peer',
      signal,
    ),
    ensurePeerConnected: (peerId, signal) => agent.ensurePeerConnected(peerId, { signal }),
    hasSyncProtocol: (peerId, signal) => agent.waitForSyncProtocol(peerId, signal),
  };
}

/**
 * The only fetch that can produce proof material: the challenge commitment is
 * pinned into the exact selection before any peer payload is accepted.
 */
function exactFetchDependency(
  agent: DKGAgent,
  state: RandomSamplingRepairAgentState,
): RandomSamplingExactRepairDependencies['fetchExactKnowledgeAsset'] {
  return async (peerId, localContextGraphId, expectedCommitment, signal) => {
    const result = await agent.syncExactKnowledgeAssetsFromPeerDetailed(
      peerId,
      localContextGraphId,
      createChallengePinnedExactAssetSelection([expectedCommitment]),
      {
        signal,
        isCurrent: () => state.isStarted() && !signal.aborted,
      },
    );
    const authenticated = result.authenticatedAssets?.find(
      ({ asset }) => asset.ual === expectedCommitment.assetUal,
    );
    if (authenticated !== undefined) {
      return {
        kind: 'found' as const,
        material: Object.freeze({
          contents: Object.freeze(authenticated.asset.dataQuads.map((quad) => (
            tripleContentV10(quad.subject, quad.predicate, quad.object)
          ))),
          privateRoots: Object.freeze([...authenticated.privateRoots]),
        }),
      };
    }
    return {
      kind: 'miss' as const,
      // A durable fetch can report `found` based on storage progress even
      // when it produced no challenge-authenticated material. At this
      // proof boundary that is necessarily an incomplete miss.
      disposition: result.disposition === 'clean-absent'
        ? 'clean-absent' as const
        : 'incomplete' as const,
    };
  };
}

export class RandomSamplingRepairMethods extends DKGAgentBase {
  /**
   * Require the candidate's live network-identity handshake to contain a
   * wallet signature binding the advertised address to this exact peer ID.
   * A staked address copied into another peer's registry row therefore cannot
   * enter the proof-time repair roster.
   */
  async authenticateCorePeerAddress(
    this: DKGAgent,
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!agent.agentAddress) return false;
    try {
      return await this.networkAdmissionCoordinator.ensurePeerAgentBinding(
        agent.peerId,
        agent.agentAddress,
        createOperationContext('sync'),
        { signal },
      );
    } catch {
      return false;
    }
  }

  /** Start one bounded proof-time exact repair for the Random Sampling prover. */
  repairRandomSamplingKnowledgeAsset(
    this: DKGAgent,
    input: RandomSamplingExactRepairInput,
  ): RandomSamplingRepairOperation {
    const ctx = createOperationContext('sync');
    const logInfo = (message: string) => this.log.info(ctx, message);
    const state: RandomSamplingRepairAgentState = {
      isStarted: () => this.started,
      preferredPeerId: (localContextGraphId) => this.preferredSyncPeers.get(localContextGraphId),
    };
    const peerSource: RandomSamplingPeerSource = createRandomSamplingPeerSource({
      ...coreEligibilityPorts(this),
      ...peerRuntimePorts(this, ctx, state),
      logInfo,
    });
    return startRandomSamplingExactRepair({
      chainId: this.chain.chainId,
      // Proof-time repair gets one challenge deadline. Deferring a later Core
      // to another bounded window would lose this proof, so traverse the full
      // already-bounded discovered candidate set in this operation.
      maxPeers: 'all',
      stopSignal: this.node.stopSignal,
      resolveStorageAddress: (_signal) => this.chain.getDKGKnowledgeAssetsAddress
        ? this.chain.getDKGKnowledgeAssetsAddress()
        : this.chain.getKnowledgeAssetsLifecycleAddress(),
      resolveLocalContextGraphId: (cgId, signal) =>
        this.resolveRandomSamplingLocalContextGraphId(cgId, signal),
      resolveCandidatePeerIds: (localContextGraphId, signal) =>
        peerSource.resolveCandidatePeerIds(localContextGraphId, signal),
      selectPeerWindow: (peerIds, options) => this.selectCatchupPeerWindow(
        peerIds.map((peerId) => ({ toString: () => peerId })),
        options,
      ).map((peer) => peer.toString()),
      preparePeer: (peerId, signal) => peerSource.preparePeer(peerId, signal),
      fetchExactKnowledgeAsset: exactFetchDependency(this, state),
      logInfo,
    } satisfies RandomSamplingExactRepairDependencies, input);
  }
}
