// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphIdV1, NetworkIdV1 } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import { isApprovedPrivateReplicaDelegationActive, resolveApprovedPrivateReplicaAuthority } from '../approved-private-replica.js';
import { loadRfc64OperationalAppliedHeadsV1 } from './catalog-operational-applied-heads-v1.js';
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
  replay: { revision: number };
  authorityRevision: number | undefined;
  targetFence: string;
}

/**
 * Hand a completed approved-replica root catalog to the daemon's readiness
 * owner. A completion event is only a wake-up: re-prove current membership,
 * finalized name absence and durable applied heads before its synchronous
 * commit. Never promote VM proof, named legacy scopes, or retained authority.
 */
export async function verifyPrivateCatalogSubscriptionReadinessV1(
  agent: DKGAgent,
  contextGraphId: string,
  commit: () => void,
  readState: () => PrivateCatalogReadinessStateV1,
): Promise<boolean> {
  const state = readState();
  const { service, persistence, networkId, approvedAgent } = state;
  if (
    service?.started !== true || persistence === undefined || networkId === undefined
    || approvedAgent === undefined
    || !agent.isRfc64JoinDerivedAcceptedAuthorityV1(contextGraphId)
    || state.subscription?.subscribed !== true
  ) return false;

  const applicability = await agent.resolveContextGraphSubscriptionBootstrapAuthority(
    contextGraphId,
    { callerAgentAddress: approvedAgent, allowSubscriptionFallback: false },
  );
  if (applicability.outcome !== 'allowed' || applicability.registration !== 'unregistered') return false;
  const accepted = service.acceptedPolicySnapshot(networkId as NetworkIdV1, contextGraphId as ContextGraphIdV1);
  if (accepted?.policy.accessPolicy !== 1 || accepted.policy.source.kind !== 'owner-signed-unregistered'
    || accepted.roster === null) return false;
  const admitted = readState();
  const { plan, authorityRevision, metadataRevision, replay } = admitted;
  const replayRevision = replay.revision;
  const inventorySnapshot = persistence.inventory.readAppliedCatalogHeadsSnapshotV1();
  const targetsBefore = admitted.targetFence;
  const current = () => {
    const live = readState();
    return live.service === service && service.started
    && live.persistence === persistence && live.networkId === networkId
    && live.plan === plan
    && service.acceptedPolicySnapshot(networkId as NetworkIdV1, contextGraphId as ContextGraphIdV1) === accepted
    && live.approvedAgent === approvedAgent
    && agent.listLocalAgents().some(({ agentAddress }) => agentAddress.toLowerCase() === approvedAgent.toLowerCase())
    && agent.isRfc64JoinDerivedAcceptedAuthorityV1(contextGraphId)
    && live.subscription?.subscribed === true
    && live.subscription?.onChainId === undefined
    && live.metadataRevision === metadataRevision
    && live.authorityRevision === authorityRevision
    && live.replay === replay && replay.revision === replayRevision
    && persistence.inventory.readAppliedCatalogHeadsSnapshotV1().token === inventorySnapshot.token
    && live.targetFence === targetsBefore
    && agent.isRfc64CatalogTransportAuthorityActiveV1(contextGraphId);
  };
  const proof = await resolveApprovedPrivateReplicaAuthority(
    agent, contextGraphId, approvedAgent,
    () => readState().approvedAgent === approvedAgent,
    () => readState().metadataRevision === metadataRevision,
  );
  if (proof?.kind !== 'unregistered-private-replica' || !current()) return false;
  if ((await agent.listSubGraphs(contextGraphId)).length > 0) return false;
  const heads = await loadRfc64OperationalAppliedHeadsV1(persistence);
  // The operator projection deliberately skips unreadable heads. That
  // diagnostic tolerance must never certify a smaller recovery denominator.
  const graphHeads = heads.filter((head) => head.contextGraphId === contextGraphId);
  if (heads.length !== inventorySnapshot.heads.length || graphHeads.length === 0
    || graphHeads.some((head) => {
      const scope = head.scopeKey.split('\0');
      return scope[0] !== networkId || scope[2] !== '' || scope[4] !== accepted.policy.era
        || !accepted.roster!.members.some(({ agentAddress }) => agentAddress === head.snapshot.authorAddress);
    })) return false;
  const status = (await agent.readRfc64CatalogOperationalStatusV1())
    .find((row) => row.contextGraphId === contextGraphId);
  const requester = await agent.readRequesterJoinRequestState(contextGraphId, approvedAgent);
  if (
    status?.effectiveMode !== 'catalog' || status.phase !== 'complete'
    || status.authorityState !== 'accepted' || status.authorityFreshness !== 'current'
    || status.policyDigest !== accepted.policyDigest || status.accessPolicy !== 1
    || !status.catalogServiceStarted || status.stableReason !== null
    || status.legacyReadOnlyCount !== 0 || status.authorHeadCount < 1
    || status.missingRowCount !== '0' || status.appliedRowCount === null
    || !/^[1-9][0-9]*$/.test(status.appliedRowCount)
    || status.expectedRowCount !== status.appliedRowCount
    || status.expectedCatalogHeadDigest === null
    || status.expectedCatalogHeadDigest !== status.appliedCatalogHeadDigest
    || status.expectedInventoryDigest === null
    || status.expectedInventoryDigest !== status.appliedInventoryDigest
    || requester?.status !== 'approved' || requester.requestGeneration !== proof.authority.requestGeneration
    || requester.curatorPeerId !== proof.authority.curatorPeerId
    || requester.curatorAgentAddress !== proof.authority.ownerAddress || requester.curatorAuthorityEra !== '0'
    || !isApprovedPrivateReplicaDelegationActive(proof.authority) || !current()
  ) return false;
  commit();
  return true;
}
