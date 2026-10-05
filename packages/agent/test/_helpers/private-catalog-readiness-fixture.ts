// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';
import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1, deriveAuthorCatalogScopeFromHeadV1, TypedEventBus,
  type AuthorCatalogHeadV1, type AuthorCatalogScopeV1, type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1, type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../../src/dkg-agent.js';
import { Rfc64CatalogMethods } from '../../src/dkg-agent-rfc64-catalog.js';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { loadRfc64OperationalAppliedHeadsV1, rfc64CatalogTargetScopeKeyV1 } from '../../src/rfc64/catalog-operational-applied-heads-v1.js';
import { createAppliedCatalogHeadsSnapshotV1, type AppliedCatalogHeadSnapshotV1 } from '../../src/rfc64/inventory-v1/index.js';
import { verifyPrivateCatalogSubscriptionReadinessV1, type PrivateCatalogReadinessStateV1 } from '../../src/rfc64/private-catalog-subscription-readiness-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1, type Rfc64PublicCatalogHeadAnnouncementV1 } from '../../src/rfc64/public-catalog-transport-v1.js';

export const OWNER = '0x1111111111111111111111111111111111111111';
export const MEMBER = '0x2222222222222222222222222222222222222222';
export const POLICY = `0x${'66'.repeat(32)}` as Digest32V1;
export const NETWORK = 'hardhat1';
export const CG = 'approved-private-ready';

export function readinessHead(options: Partial<AuthorCatalogScopeV1> & { version?: string; totalRows?: string } = {}) {
  const { version = '1', totalRows = '1', ...scopeOptions } = options;
  const scope = {
    networkId: NETWORK, contextGraphId: CG, governanceChainId: null, governanceContractAddress: null,
    ownershipTransitionDigest: null, subGraphName: null, authorAddress: OWNER, era: '0', bucketCount: '1',
    ...scopeOptions,
  } as AuthorCatalogScopeV1;
  const payload = {
    ...scope, catalogIssuerDelegationDigest: POLICY, version, previousHeadDigest: null,
    totalRows, directoryHeight: '0', directoryRootDigest: `0x${'22'.repeat(32)}`,
    issuedAt: '1773900000001',
  } as AuthorCatalogHeadV1;
  const unsigned = {
    issuer: scope.authorAddress, objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, payload,
    signatureEvidence: { kind: 'none' }, signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  return Object.freeze({ ...unsigned, objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned as never),
    signature: `0x${'77'.repeat(65)}`,
  }) as unknown as SignedAuthorCatalogHeadEnvelopeV1;
}

export function readinessApplied(head: SignedAuthorCatalogHeadEnvelopeV1): AppliedCatalogHeadSnapshotV1 {
  return Object.freeze({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(deriveAuthorCatalogScopeFromHeadV1(head.payload)),
    authorAddress: head.payload.authorAddress, currentCatalogHeadDigest: head.objectDigest,
    appliedInventoryDigest: `0x${'99'.repeat(32)}` as Digest32V1,
    catalogVersion: head.payload.version, inventoryRowCount: head.payload.totalRows,
  });
}

export function readinessTarget(head: SignedAuthorCatalogHeadEnvelopeV1): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1, networkId: head.payload.networkId,
    contextGraphId: head.payload.contextGraphId, subGraphName: head.payload.subGraphName,
    authorAddress: head.payload.authorAddress, catalogEra: head.payload.era, catalogVersion: head.payload.version,
    policyDigest: POLICY, catalogHeadObjectDigest: head.objectDigest, signatureVariantDigest: POLICY,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

/** Real replay, verified-head projection and readiness evaluator with in-memory storage ports. */
export async function privateCatalogReadinessFixture(options: { restored?: boolean } = {}) {
  const head = readinessHead();
  const objects = new Map([[head.objectDigest, head]]);
  const faults = new Set<string>();
  let inventory = createAppliedCatalogHeadsSnapshotV1([readinessApplied(head)]);
  const getVerifiedObjectByDigest = vi.fn(async ({ objectDigest }: { objectDigest: Digest32V1 }) => {
    const envelope = faults.has(objectDigest) ? undefined : objects.get(objectDigest);
    return envelope === undefined ? null : { envelope };
  });
  const persistence = {
    inventory: { readAppliedCatalogHeadsSnapshotV1: () => inventory },
    controlObjects: { getVerifiedObjectByDigest, getVerifiedObject: getVerifiedObjectByDigest },
  };
  let accepted = { policy: { accessPolicy: 1, era: '0', source: { kind: 'owner-signed-unregistered', ownerAddress: OWNER } },
    roster: { members: [{ agentAddress: OWNER }, { agentAddress: MEMBER }] }, policyDigest: POLICY };
  const freeze = (value: object): void => {
    Object.values(value).forEach((child) => { if (child !== null && typeof child === 'object') freeze(child); });
    Object.freeze(value);
  };
  freeze(accepted);
  const updateAccepted = (change: (value: typeof accepted) => void) => {
    accepted = structuredClone(accepted); change(accepted); freeze(accepted);
  };
  const service = { started: true, acceptedPolicySnapshot: () => Object.freeze({ ...accepted }) };
  const requester = { status: 'approved', requestGeneration: 'request-1', curatorPeerId: 'curator-peer',
    curatorAgentAddress: OWNER, curatorAuthorityEra: '0' };
  const subscription = { subscribed: true, onChainId: undefined as string | undefined };
  let providerTargets = [readinessTarget(head)];
  const requestPeer = vi.fn(async () => ({ status: 'completed' as const, targets: providerTargets }));
  const whenIdle = vi.fn(async () => undefined);
  const createReplay = () => new Rfc64CatalogReplayRecoveryRuntimeV1<Rfc64PublicCatalogHeadAnnouncementV1>({
    requestPeer, whenReceiverIdleForContextGraph: whenIdle,
    targetIdentity: (target) => target.catalogHeadObjectDigest,
    parityFailed: async (contextGraphId, targets) => {
      const heads = await loadRfc64OperationalAppliedHeadsV1(persistence as never);
      const byScope = new Map(heads.filter((item) => item.contextGraphId === contextGraphId).map((item) => [item.scopeKey, item]));
      return targets.some((target) => {
        const applied = byScope.get(rfc64CatalogTargetScopeKeyV1(target))?.snapshot;
        return applied === undefined || BigInt(applied.catalogVersion) < BigInt(target.catalogVersion)
          || (applied.catalogVersion === target.catalogVersion && applied.currentCatalogHeadDigest !== target.catalogHeadObjectDigest);
      });
    },
  });
  const state = {
    service, persistence, networkId: NETWORK, approvedAgent: MEMBER, subscription, plan: {}, metadataRevision: 0,
    replay: createReplay(), authorityRevision: 0, authorityCurrent: true, legacyReadOnlyCount: 0,
    targets: [] as Rfc64PublicCatalogHeadAnnouncementV1[], targetCapacityExceeded: false, targetFailed: false, targetFence: '',
  };
  const eventBus = new TypedEventBus();
  const agent = Object.setPrototypeOf({
    peerId: 'receiver-peer', config: { networkIdentity: { chainId: NETWORK } },
    rfc64PublicCatalogServiceV1: service, node: { libp2p: { getPeers: () => ['curator-peer'] } }, eventBus,
    isRfc64JoinDerivedAcceptedAuthorityV1: vi.fn(() => true),
    isRfc64CatalogTransportAuthorityActiveV1: vi.fn(() => true),
    resolveContextGraphSubscriptionBootstrapAuthority: vi.fn(async () => ({ outcome: 'allowed', registration: 'unregistered' })),
    rfc64CatalogReplayRecoveryRuntimeV1: () => state.replay,
    listLocalAgents: vi.fn(() => [{ agentAddress: MEMBER }]),
    readRequesterJoinRequestState: vi.fn(async () => requester),
    getOwnCgMetaFacts: async () => ({ accessPolicy: 'private', curators: [`did:dkg:agent:${OWNER}`], creators: ['did:dkg:agent:curator-peer'], allowedPeers: ['receiver-peer'] }),
    readLocalContextGraphRegistrationStatus: async () => 'unregistered',
    store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [{}] as Record<string, string>[] })) },
    listSubGraphs: vi.fn(async () => [] as unknown[]),
    readRfc64CatalogOperationalStatusV1: vi.fn(async () => { throw new Error('readiness must not consume operator status'); }),
  }, Rfc64CatalogMethods.prototype);
  agent.withVerifiedPrivateCatalogSubscriptionReadinessV1 = (cg: string, commit: () => void) =>
    verifyPrivateCatalogSubscriptionReadinessV1(agent as DKGAgent, cg, commit, () => state as unknown as PrivateCatalogReadinessStateV1);
  const replay = () => agent.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(CG) as Promise<unknown>;
  if (!options.restored) await replay();
  const commit = vi.fn();
  return { agent, state, head, service, requester, subscription, eventBus, commit, objects, faults, requestPeer, whenIdle,
    getVerifiedObjectByDigest, replay,
    run: () => agent.withVerifiedPrivateCatalogSubscriptionReadinessV1(CG, commit) as Promise<boolean>,
    setInventory: (heads: readonly AppliedCatalogHeadSnapshotV1[]) => { inventory = createAppliedCatalogHeadsSnapshotV1(heads); },
    readInventory: () => inventory,
    setProviderTargets: (targets: Rfc64PublicCatalogHeadAnnouncementV1[]) => { providerTargets = targets; },
    restartReplay: () => { state.replay = createReplay(); },
    updateAccepted,
    rotatePolicy: () => updateAccepted(() => undefined),
  };
}
