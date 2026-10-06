// SPDX-License-Identifier: Apache-2.0

import { computeAuthorCatalogScopeDigestV1, type AuthorCatalogScopeV1, type ContextGraphIdV1, type NetworkIdV1 } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { RequesterJoinRequestState } from '../dkg-agent-join.js';
import { isApprovedPrivateReplicaDelegationActive, resolveApprovedPrivateReplicaAuthority, type ApprovedPrivateReplicaAuthority } from '../approved-private-replica.js';
import { loadRfc64OperationalAppliedHeadsV1 } from './catalog-operational-applied-heads-v1.js';
import { loadRfc64OperationalPromisedHeadsV1 } from './catalog-operational-reads-v1.js';
import { evaluateRfc64CatalogCompletionV1 } from './catalog-completion-evidence-v1.js';
import { createAppliedCatalogHeadsSnapshotV1 } from './inventory-v1/index.js';
import type { Rfc64CatalogReplayRecoveryRuntimeV1 } from './catalog-replay-recovery-runtime-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';
import type { Rfc64PublicCatalogServiceV1 } from './public-catalog-service-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';

/** Live protected-state projection supplied only by the agent readiness owner. */
export interface PrivateCatalogReadinessStateV1 {
  service: Rfc64PublicCatalogServiceV1 | undefined;
  persistence: Rfc64PersistenceV1 | undefined;
  networkId: string | undefined;
  approvedAgent: string | undefined;
  subscription: { subscribed?: boolean; onChainId?: string } | undefined;
  plan: unknown;
  metadataRevision: unknown;
  replay: Rfc64CatalogReplayRecoveryRuntimeV1<Rfc64PublicCatalogHeadAnnouncementV1>;
  authorityRevision: number | undefined;
  authorityCurrent: boolean;
  legacyReadOnlyCount: number;
  targets: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
  targetCapacityExceeded: boolean;
  targetFailed: boolean;
  targetFence: string;
}

function matchesApprovedJoinRequest(requester: RequesterJoinRequestState | null, authority: ApprovedPrivateReplicaAuthority): boolean {
  return requester?.status === 'approved' && requester.requestGeneration === authority.requestGeneration
    && requester.curatorPeerId === authority.curatorPeerId && requester.curatorAgentAddress === authority.ownerAddress
    && requester.curatorAuthorityEra === '0';
}

/**
 * Re-prove authority, then compare durable rows with an independently obtained
 * replay manifest. Restored heads alone cannot certify a lost recovery plan.
 * A clean restart must corroborate its inventory with a provider again.
 */
export async function verifyPrivateCatalogSubscriptionReadinessV1(
  agent: DKGAgent, contextGraphId: string, commit: () => void,
  readState: () => PrivateCatalogReadinessStateV1,
): Promise<boolean> {
  const state = readState();
  const { service, persistence, networkId, approvedAgent } = state;
  if (service?.started !== true || persistence === undefined || networkId === undefined || approvedAgent === undefined
    || !agent.isRfc64JoinDerivedAcceptedAuthorityV1(contextGraphId) || state.subscription?.subscribed !== true) return false;

  const applicability = await agent.resolveContextGraphSubscriptionBootstrapAuthority(
    contextGraphId, { callerAgentAddress: approvedAgent, allowSubscriptionFallback: false },
  );
  if (applicability.outcome !== 'allowed' || applicability.registration !== 'unregistered') return false;
  const accepted = service.acceptedPolicySnapshot(networkId as NetworkIdV1, contextGraphId as ContextGraphIdV1);
  if (accepted?.policy.accessPolicy !== 1 || accepted.policy.source.kind !== 'owner-signed-unregistered' || accepted.roster === null) return false;
  const admitted = readState();
  const { plan, authorityRevision, metadataRevision, replay, targetFence } = admitted;
  const replayRevision = replay.revisionForContextGraph(contextGraphId);
  const promisedTargets = replay.promisedTargets(contextGraphId, accepted.policyDigest);
  // Null means no replay evidence survived this process/authority generation.
  if (promisedTargets === null || promisedTargets.length === 0) return false;
  const current = () => {
    const live = readState();
    const liveAccepted = service.acceptedPolicySnapshot(networkId as NetworkIdV1, contextGraphId as ContextGraphIdV1);
    // Registry lookup wraps each result afresh. The immutable policy/roster
    // references, not that wrapper, identify its accepted generation.
    if (live.service !== service || !service.started || live.persistence !== persistence
      || live.networkId !== networkId || live.plan !== plan
      || liveAccepted?.policy !== accepted.policy || liveAccepted.roster !== accepted.roster
      || liveAccepted.policyDigest !== accepted.policyDigest) return false;
    if (live.approvedAgent !== approvedAgent
      || !agent.listLocalAgents().some(({ agentAddress }) => agentAddress.toLowerCase() === approvedAgent.toLowerCase())
      || !agent.isRfc64JoinDerivedAcceptedAuthorityV1(contextGraphId)
      || live.subscription?.subscribed !== true || live.subscription.onChainId !== undefined) return false;
    if (live.metadataRevision !== metadataRevision || live.authorityRevision !== authorityRevision
      || live.replay !== replay || replay.revisionForContextGraph(contextGraphId) !== replayRevision
      || live.targetFence !== targetFence || !live.authorityCurrent || live.legacyReadOnlyCount !== 0
      || live.targetCapacityExceeded || live.targetFailed) return false;
    return agent.isRfc64CatalogTransportAuthorityActiveV1(contextGraphId);
  };
  const proof = await resolveApprovedPrivateReplicaAuthority(agent, contextGraphId, approvedAgent,
    () => readState().approvedAgent === approvedAgent, () => readState().metadataRevision === metadataRevision);
  if (proof?.kind !== 'unregistered-private-replica'
    || proof.authority.ownerAddress !== accepted.policy.source.ownerAddress || !current()) return false;
  if ((await agent.listSubGraphs(contextGraphId)).length > 0) return false;

  const scopeIsEligible = (scope: Readonly<AuthorCatalogScopeV1>) => scope.networkId === networkId
    && scope.contextGraphId === contextGraphId && scope.subGraphName === null && scope.era === accepted.policy.era
    && accepted.roster!.members.some(({ agentAddress }) => agentAddress === scope.authorAddress);
  const promises = await loadRfc64OperationalPromisedHeadsV1(persistence, [...promisedTargets, ...admitted.targets]);
  if ([...promises.values()].some((head) => head === null || !scopeIsEligible(head.scope))) return false;
  const scopes = new Set([...promises.values()].map((head) => computeAuthorCatalogScopeDigestV1(head!.scope)));
  // Scope identities come from verified promised heads, never from decoding an
  // index key or guessing which graph an unreadable global head belongs to.
  const readInventory = () => createAppliedCatalogHeadsSnapshotV1(
    persistence.inventory.readAppliedCatalogHeadsSnapshotV1().heads.filter((head) => scopes.has(head.catalogScopeDigest)),
  );
  const inventory = readInventory();
  const heads = await loadRfc64OperationalAppliedHeadsV1(persistence, inventory);
  if (heads.length !== inventory.heads.length || heads.some((head) => !scopeIsEligible(head.scope))) return false;
  const completion = evaluateRfc64CatalogCompletionV1({
    heads, targets: admitted.targets, promisedTargets,
    promisedRowCounts: new Map([...promises].map(([identity, head]) => [identity, head!.totalRows])),
    replay: replay.status(contextGraphId, accepted.policyDigest), targetCapacityExceeded: admitted.targetCapacityExceeded,
  });
  if (!completion.corroborated) return false;
  const requester = await agent.readRequesterJoinRequestState(contextGraphId, approvedAgent);
  if (!matchesApprovedJoinRequest(requester, proof.authority)) return false;
  if (!isApprovedPrivateReplicaDelegationActive(proof.authority) || !current()) return false;
  if (readInventory().token !== inventory.token) return false;
  // No await between the graph's final fences and its readiness commit.
  commit();
  return true;
}
