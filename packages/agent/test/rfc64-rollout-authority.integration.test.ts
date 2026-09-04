// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import type { Rfc64PublicCatalogActivationInputV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import { deriveRfc64PublicSwmGraphV1 } from
  '../src/rfc64/catalog-semantic-authority-transition-v1.js';
import {
  commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1,
  prepareRfc64AppliedCatalogAuthorityDeactivationV1,
} from '../src/rfc64/applied-catalog-authority-transition-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const MEMBER = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/rollout-authority'
) as ContextGraphIdV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    graph: '',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
]);
const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
  await Promise.all(tempDirs.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ));
  vi.restoreAllMocks();
});

describe('RFC-64 rollout authority integration', () => {
  it('derives clean-config responsibility from normal create and unsubscribe', async () => {
    const edge = await startAgent('default-responsibility', undefined);
    const requestReplays = vi.spyOn(
      edge,
      'requestRfc64CatalogHeadReplaysFromConnectedPeersV1',
    ).mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));

    await edge.createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Default RFC-64 responsibility',
    });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([{
      contextGraphId: CONTEXT_GRAPH_ID,
      responsible: true,
      responsibilityReason: 'edge-subscription',
      active: true,
      mode: 'catalog',
      selectionSource: 'default',
    }]);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID)).toMatchObject({
      eligible: true,
      active: true,
      mode: 'catalog',
      legacySyncAllowed: false,
      track2Enabled: true,
      reconciliationLane: 'catalog-apply',
    });
    expect(edge.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    requestReplays.mockClear();
    expect(await edge.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ source: 'owner-signed-unregistered' });
    expect(requestReplays).toHaveBeenCalledOnce();
    expect(requestReplays).toHaveBeenCalledWith(CONTEXT_GRAPH_ID);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(edge.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID)).toMatchObject({
      active: false,
      legacySyncAllowed: false,
      track2Enabled: false,
      reconciliationLane: 'disabled',
    });
  });

  it('reconciles default responsibility when a live subscription is bound late', async () => {
    const contextGraphId = `${AUTHOR}/late-verified-binding`;
    const edge = await startAgent('late-verified-binding', undefined);
    const requestReplays = vi.spyOn(
      edge,
      'requestRfc64CatalogHeadReplaysFromConnectedPeersV1',
    ).mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
    vi.spyOn(edge, 'getContextGraphOnChainPolicy').mockResolvedValue({
      accessPolicy: 0,
      publishPolicy: 0,
    });

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);

    const subscription = edge.getSubscribedContextGraphs().get(contextGraphId);
    expect(subscription).toBeDefined();
    (edge as any).bindSubscriptionOnChainId(contextGraphId, subscription, '3');
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'edge-subscription',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
    expect(requestReplays).toHaveBeenCalledWith(contextGraphId);
  });

  it('promotes a chain-discovered private wire placeholder to the admitted local identity', async () => {
    const contextGraphId = `${AUTHOR}/private-wire-promotion`;
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
    const edge = await startAgent('private-wire-promotion', undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1').mockResolvedValue(true);
    const internals = edge as any;

    // Mirror the private ContextGraphCreated path: before admission the Edge
    // knows only the curator-committed wire id and numeric chain id.
    internals.setContextGraphSubscription(wireId, {
      subscribed: false,
      synced: false,
      onChainHash: wireId,
      pendingMeta: true,
    }, { persist: false });
    expect(internals.bindOnChainContextGraphIdFromNameHash(
      wireId,
      '3',
      { persist: false },
    )).toBe(wireId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: wireId,
        responsibilityReason: 'private-membership',
      }),
    ]);

    // A trusted join approval supplies the matching human id. The canonical
    // setter must carry its chain binding forward and retire the placeholder,
    // including its RFC-64 responsibility.
    internals.setContextGraphSubscription(contextGraphId, {
      subscribed: true,
      synced: false,
      pendingMeta: true,
      metaSynced: false,
    }, { persist: false });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(edge.getSubscribedContextGraphs().has(wireId)).toBe(false);
    expect(edge.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '3',
      onChainHash: wireId,
    });
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
  });

  it('requires verified current membership for private responsibility', async () => {
    const privateContextGraphId = `${AUTHOR}/private-responsibility`;
    const edge = await startAgent('private-responsibility', undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const hasMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);

    edge.subscribeToContextGraph(privateContextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(hasMembership).toHaveBeenCalledWith(privateContextGraphId);

    hasMembership.mockResolvedValue(true);
    await edge.reconcileRfc64CatalogResponsibilityV1(privateContextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: privateContextGraphId,
        responsibilityReason: 'private-membership',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
  });

  it('derives private responsibility from authenticated DKG ACL state, not a stale RFC-64 roster', async () => {
    const contextGraphId = `${AUTHOR}/private-roster-bootstrap` as ContextGraphIdV1;
    const edge = await startAgent('private-roster-bootstrap', undefined);
    (edge as any).defaultAgentAddress = MEMBER;
    vi.spyOn(edge, 'resolveRfc64PrivateReadRosterV1').mockReturnValue([AUTHOR]);
    await expect(edge.canReadContextGraph(contextGraphId, {
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const confirmedMeta = vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(false);
    const recoveryGate = vi.spyOn(edge, 'getMemberRecoveryGate')
      .mockResolvedValue([AUTHOR, MEMBER]);
    await expect(edge.resolveRfc64VerifiedPrivateRosterV1(contextGraphId))
      .resolves.toBeNull();
    expect(recoveryGate).not.toHaveBeenCalled();

    confirmedMeta.mockResolvedValue(true);
    recoveryGate.mockResolvedValue([AUTHOR]);
    await expect(edge.hasRfc64VerifiedPrivateMembershipV1(contextGraphId))
      .resolves.toBe(false);
    recoveryGate.mockResolvedValue([AUTHOR, MEMBER]);
    await expect(edge.hasRfc64VerifiedPrivateMembershipV1(contextGraphId))
      .resolves.toBe(true);
    recoveryGate.mockClear();

    edge.subscribeToContextGraph(contextGraphId);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(recoveryGate).toHaveBeenCalledWith(contextGraphId);
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
      }),
    ]);
  });

  it('binds private catalog peers from verified join credentials without profile gossip', async () => {
    const contextGraphId = `${AUTHOR}/private-peer-binding` as ContextGraphIdV1;
    const curatorPeerId = '12D3KooWVerifiedPrivateCurator';
    const memberPeerId = '12D3KooWVerifiedPrivateMember';
    const edge = await startAgent('private-peer-binding', undefined);
    vi.spyOn(edge, 'findAgentByPeerId').mockResolvedValue(null);
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    const delegateePeers = vi.spyOn(edge, 'getContextGraphAllowedDelegateePeers')
      .mockResolvedValue(new Map([[MEMBER, [memberPeerId]]]));

    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      memberPeerId,
      contextGraphId,
    )).resolves.toBe(MEMBER);

    delegateePeers.mockResolvedValue(new Map());
    (edge as any).localApprovedAgentByCG.set(contextGraphId, MEMBER);
    const requesterState = vi.spyOn(edge, 'readRequesterJoinRequestState')
      .mockResolvedValue({
        status: 'approved',
        requestGeneration: `0x${'11'.repeat(32)}`,
        curatorPeerId,
      });
    vi.spyOn(edge, 'getContextGraphOwner')
      .mockResolvedValue(`did:dkg:agent:${AUTHOR}`);
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBe(AUTHOR);

    requesterState.mockResolvedValue({
      status: 'pending',
      requestGeneration: `0x${'11'.repeat(32)}`,
      curatorPeerId,
    });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBeNull();
    requesterState.mockResolvedValue({
      status: 'approved',
      requestGeneration: `0x${'11'.repeat(32)}`,
      curatorPeerId: '12D3KooWDifferentCurator',
    });
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      curatorPeerId,
      contextGraphId,
    )).resolves.toBeNull();

    delegateePeers.mockResolvedValue(new Map([
      [MEMBER, [memberPeerId]],
      [AUTHOR, [memberPeerId]],
    ]));
    await expect(edge.resolveRfc64CatalogRemoteAgentAddressV1(
      memberPeerId,
      contextGraphId,
    )).resolves.toBeNull();
  });

  it('merges an authenticated lifecycle roster into finalized registered authority', async () => {
    const contextGraphId = `${AUTHOR}/registered-private-roster` as ContextGraphIdV1;
    const edge = await startAgent(
      'registered-private-roster',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: MEMBER,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    );
    (edge as any).defaultAgentAddress = MEMBER;
    vi.spyOn(edge, 'getContextGraphOnChainId').mockResolvedValue('9');
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge, 'getMemberRecoveryGate').mockResolvedValue([AUTHOR, MEMBER]);
    vi.spyOn(edge, 'readRfc64PrivateRosterVersionV1').mockResolvedValue('1788482000000');
    vi.spyOn(edge, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
      .mockResolvedValue(Object.freeze({ requested: 0, failed: 0 }));
    (edge as any).chain.getContextGraphAuthoritySnapshot = vi.fn().mockResolvedValue({
      chainId: '20430',
      governanceContract: '0x3333333333333333333333333333333333333333',
      contextGraphId: '9',
      owner: AUTHOR,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHOR,
      publishAuthorityAccountId: '0',
      participantAgents: [AUTHOR],
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
      sourceBlockNumber: '42',
      sourceBlockHash: `0x${'44'.repeat(32)}`,
    });

    const authority = await edge.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId);

    expect(authority?.roster).toMatchObject({
      version: '1788482000000',
      members: [
        { agentAddress: MEMBER, roles: ['holder', 'provider'] },
        { agentAddress: AUTHOR, roles: ['holder', 'provider'] },
      ].sort((left, right) => left.agentAddress.localeCompare(right.agentAddress)),
    });
    expect(edge.resolveRfc64PrivateReadRosterV1(contextGraphId))
      .toEqual([MEMBER, AUTHOR].sort());
  });

  it('rotates the private authority generation on ordinary invite and removal', async () => {
    const contextGraphId = `${AUTHOR}/private-roster-rotation` as ContextGraphIdV1;
    const curator = await startAgent(
      'private-roster-rotation',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        rfc64CatalogAccessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => null,
        },
      },
    );
    (curator as any).defaultAgentAddress = AUTHOR;
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Private roster rotation',
      accessPolicy: 1,
      callerAgentAddress: AUTHOR,
    });
    expect(await curator.readRfc64PrivateRosterVersionV1(contextGraphId)).toBe('0');

    await curator.inviteAgentToContextGraph(contextGraphId, MEMBER, AUTHOR);
    const admittedVersion = BigInt(
      await curator.readRfc64PrivateRosterVersionV1(contextGraphId),
    );
    expect(admittedVersion).toBeGreaterThan(0n);
    expect(curator.resolveRfc64PrivateReadRosterV1(contextGraphId))
      .toEqual([MEMBER, AUTHOR].sort());

    await curator.removeAgentFromContextGraph(contextGraphId, MEMBER, AUTHOR);
    expect(BigInt(await curator.readRfc64PrivateRosterVersionV1(contextGraphId)))
      .toBeGreaterThan(admittedVersion);
    expect(curator.resolveRfc64PrivateReadRosterV1(contextGraphId)).toEqual([AUTHOR]);
  });

  it('reconciles private responsibility when refreshed ACL facts change without a subscription transition', async () => {
    const contextGraphId = `${AUTHOR}/private-acl-refresh`;
    const edge = await startAgent('private-acl-refresh', undefined);
    vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue('private');
    const hasMembership = vi.spyOn(edge, 'hasRfc64VerifiedPrivateMembershipV1')
      .mockResolvedValue(false);
    vi.spyOn(edge, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(edge.store, 'query').mockResolvedValue({
      type: 'bindings',
      bindings: [],
    });

    (edge as any).setContextGraphSubscription(contextGraphId, {
      subscribed: true,
      synced: true,
      metaSynced: true,
      onChainId: '3',
    }, { persist: false });
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([]);

    // The curator projection now admits this local agent, but every canonical
    // subscription field is unchanged. Metadata completion itself must own the
    // responsibility refresh.
    hasMembership.mockResolvedValue(true);
    await (edge as any).refreshMetaSyncedFlags([contextGraphId]);

    expect(edge.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsibilityReason: 'private-membership',
        active: true,
        mode: 'catalog',
      }),
    ]);
  });

  it('uses durable public hosting and preserves explicit disabled rollback', async () => {
    const coreContextGraphId = `${AUTHOR}/core-hosted-responsibility`;
    const core = await startAgent(
      'core-hosted-responsibility',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        nodeRole: 'core',
        rfc64CatalogActivation: { enabled: false },
      },
    );
    vi.spyOn(core, 'getExplicitAccessPolicy').mockResolvedValue('public');

    (core as any).setContextGraphSubscription(coreContextGraphId, {
      syncMode: 'always-on',
      subscribed: false,
      synced: false,
      coreHosted: true,
    });
    await core.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(core.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: coreContextGraphId,
        responsibilityReason: 'core-public',
        active: true,
        mode: 'legacy',
        selectionSource: 'operator-override',
      }),
    ]);
  });

  it('keeps an eligible edge CG dormant until subscribe and deactivates it on unsubscribe', async () => {
    const providerPeerId = '12D3KooWSubscriptionOwnedCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent(
      'subscription-owned-selection',
      {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      undefined,
      undefined,
      (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      { syncContextGraphs: [] },
    );
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: true,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [],
    });
    expect(edge.rfc64PublicCatalogStatsV1()).toMatchObject({
      started: true,
      acceptedPolicies: 1,
    });
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).not.toHaveBeenCalled();

    // Sync-scope bookkeeping is not a subscription and cannot independently
    // activate RFC-64 receiver work.
    expect(edge.trackSyncContextGraph(CONTEXT_GRAPH_ID)).toBe(false);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).not.toHaveBeenCalled();

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect((edge as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThan(initialPass);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'not-found',
      attempts: 1,
    });

    // An idempotent subscription cannot enqueue a duplicate invalidation.
    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(edge.deleteContextGraphSubscription(CONTEXT_GRAPH_ID)).toBe(true);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale in-flight bootstrap pass and waits through the inactive rerun', async () => {
    const providerPeerId = '12D3KooWBlockedSubscriptionCatalogProvider';
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let firstSignal: AbortSignal | undefined;
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent(
      'subscription-transition-during-bootstrap',
      {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      undefined,
      undefined,
      (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockImplementationOnce(async ({ signal }) => {
            firstSignal = signal;
            markEntered();
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return null;
          })
          .mockResolvedValue(null);
      },
      { syncContextGraphs: [] },
    );
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await entered;
    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(firstSignal?.aborted).toBe(true);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      running: false,
      pass: initialPass + 2,
      targets: [expect.objectContaining({
        outcome: 'inactive',
        attempts: 0,
      })],
    });
  });

  it('retains manifest-wide RFC-64 selection on core nodes', async () => {
    const providerPeerId = '12D3KooWCoreManifestWideCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const core = await startAgent(
      'core-manifest-selection',
      {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      undefined,
      undefined,
      (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      { nodeRole: 'core', syncContextGraphs: [] },
    );
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(core.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: false,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [CONTEXT_GRAPH_ID],
    });
    expect(synchronize).toHaveBeenCalledWith(expect.objectContaining({
      remotePeerIds: [providerPeerId],
      scope: expect.objectContaining({
        authorAddress: AUTHOR,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
    }));

    // An ordinary host-only transition cannot abort manifest-wide core work.
    const deactivate = vi.spyOn(
      (core as any).rfc64PublicCatalogServiceV1,
      'deactivateReceiverContextGraph',
    );
    core.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    core.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(deactivate).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('enforces legacy, shadow, catalog, and kill-switch authority at startup', async () => {
    const legacy = await startAgent('legacy', activation('legacy'));
    expect(legacy.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    // The process-wide service remains ready for later default-selected CGs;
    // this explicit graph itself is fenced to the legacy lane.
    expect(legacy.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(legacy.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID))
      .toMatchObject({ reconciliationLane: 'legacy', track2Enabled: false });

    const shadow = await startAgent('shadow', activation('shadow'));
    expect(shadow.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(shadow.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });

    const catalog = await startAgent('catalog', activation('catalog'));
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(catalog.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    const stopped = await startAgent('kill-switch', activation('catalog', true));
    expect(stopped.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
  });

  it('keeps authorized catalog-mode metadata refresh off member and host SWM gossip', async () => {
    const catalog = await startAgent('catalog-metadata-refresh-fence', activation('catalog'));
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);

    const internals = catalog as any;
    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
    });
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    // Exercise the exact post-catch-up transition from the review: metadata is
    // confirmed and local SWM membership would otherwise authorize the member
    // gossip consumer. queueSharedMemoryGossipSubscription remains
    // fire-and-forget, so capture the concrete reconciliation promise.
    vi.spyOn(catalog, 'hasConfirmedMetaState').mockResolvedValue(true);
    const memberAuthority = vi.spyOn(catalog, 'canUseSharedMemoryForContextGraph')
      .mockResolvedValue(true);
    const reconciliations: Promise<void>[] = [];
    const reconcile = catalog.reconcileSharedMemoryGossipSubscription.bind(catalog);
    vi.spyOn(catalog, 'reconcileSharedMemoryGossipSubscription').mockImplementation((cg) => {
      const pending = reconcile(cg);
      reconciliations.push(pending);
      return pending;
    });

    await internals.refreshMetaSyncedFlags([CONTEXT_GRAPH_ID]);
    await vi.waitFor(() => expect(reconciliations).toHaveLength(1));
    await Promise.all(reconciliations);

    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    expect(memberAuthority).not.toHaveBeenCalled();
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    // A core's ordinary host reconciliation is another legacy entry point.
    // Make every non-RFC prerequisite available so catalog authority is the
    // reason it stays unwired.
    internals.swmHostModeStore = {};
    const curated = vi.spyOn(catalog, 'isCuratedForHostMode').mockResolvedValue(true);
    await catalog.reconcileSwmHostModeSubscription(CONTEXT_GRAPH_ID);
    const hostKey = catalog.canonicalSwmHostModeKey(CONTEXT_GRAPH_ID);
    expect(curated).not.toHaveBeenCalled();
    expect(internals.swmHostModeSubscribed.has(hostKey)).toBe(false);
    expect(internals.swmHostModeHandlers.has(hostKey)).toBe(false);
  });

  it('rehydrates persisted edge intent through exclusive catalog authority', async () => {
    const persisted = new Map<string, any>([[CONTEXT_GRAPH_ID, {
      id: CONTEXT_GRAPH_ID,
      name: 'persisted-before-rfc64',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      coreHosted: false,
    }]]);
    const catalog = await startAgent(
      'catalog-rehydration-fence',
      activation('catalog'),
      undefined,
      undefined,
      undefined,
      {
        contextGraphSubscriptionStore: {
          loadAll: async () => [...persisted.values()],
          save: async (record) => { persisted.set(record.id, { ...record }); },
          delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
        },
      },
    );
    expect(catalog.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(catalog.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantIds: [],
    });
    expect(persisted.get(CONTEXT_GRAPH_ID)).toMatchObject({ subscribed: true });
  });

  it('keeps complete-provider recovery live when every selected CG is legacy-mode', async () => {
    const providerPeerId = '12D3KooWAllLegacyCompleteProvider';
    let connect!: ReturnType<typeof vi.spyOn>;
    let queue!: ReturnType<typeof vi.spyOn>;
    const legacy = await startAgent('all-legacy-provider', {
      ...activation('legacy'),
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(),
          targets: [],
          completeSwmProviders: [providerPeerId],
        }],
      },
    }, undefined, undefined, (agent) => {
      connect = vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
      queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
        .mockReturnValue(true);
    });
    await legacy.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(legacy.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      pass: expect.any(Number),
      targets: [],
    });
    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ providerPeerId }),
      expect.any(Function),
      0,
    );
  });

  it.each(['legacy', 'shadow'] as const)(
    'semantically deactivates durable catalog authority before a %s restart',
    async (nextMode) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-transition-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'catalog-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(81n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await seedCatalogSemanticClosure(author, seal, 'rollout-restart-guard');
    await expectCatalogSemanticClosure(
      author,
      seal,
      'rollout-restart-guard',
      true,
    );
    await author.stop();
    agents.splice(agents.indexOf(author), 1);
    const producer = vi.spyOn(
      Rfc64PublicCatalogSuccessorProducerV1.prototype,
      'produceAndStageExactSet',
    );
    const restarted = await startAgent(
      `${nextMode}-after-catalog`,
      activation(nextMode),
      dataDir,
      persistentStorePath,
    );
    expect(restarted.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-restart-guard',
      false,
    );
    expect(restarted.rfc64PublicCatalogStatsV1())
      .toEqual(expect.objectContaining({ started: true }));
    expect(producer).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('preserves locally authored shadow discovery state and legacy material on restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-shadow-author-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'shadow-author-restart',
      {
        ...activation('shadow'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(810n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'shadow-author-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    // Shadow catalog publication accompanies existing legacy material; it does
    // not grant catalog semantic authority over that material.
    await seedCatalogSemanticClosure(author, seal, 'shadow-author-restart-guard');
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const restarted = await startAgent(
      'shadow-author-restarted',
      activation('shadow'),
      dataDir,
      persistentStorePath,
    );
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'shadow-author-restart-guard',
      true,
    );
  }, 30_000);

  it('preserves later legacy semantic content while relinquishing stale catalog authority', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-divergent-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'catalog-divergent-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(85n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-divergent-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    await seedCatalogSemanticClosure(author, seal, 'rollout-divergent-preservation');
    const store = (author as unknown as { store: OxigraphStore }).store;
    const swmGraph = deriveRfc64PublicSwmGraphV1(CONTEXT_GRAPH_ID, seal.reservedKaId as never);
    await store.insert([{
      subject: 'https://example.org/later-legacy-write',
      predicate: 'https://schema.org/name',
      object: '"must survive"',
      graph: swmGraph,
    }]);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const restarted = await startAgent(
      'legacy-after-divergent-catalog',
      activation('legacy'),
      dataDir,
      persistentStorePath,
    );
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(applied).not.toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-divergent-preservation',
      true,
    );
    const preserved = await (restarted as unknown as { store: OxigraphStore }).store.query(
      `ASK { GRAPH <${swmGraph}> { <https://example.org/later-legacy-write> ?p ?o } }`,
    );
    expect(preserved).toEqual({ type: 'boolean', value: true });
  }, 30_000);

  it.each(['later semantic removal', 'inventory deletion'] as const)(
    'rolls back the whole CG after injected %s failure and retries cleanly',
    async (failureStage) => {
      const author = await startAgent('catalog-atomic-transition', {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      });
      vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
      const seals = [await authorSeal(86n), await authorSeal(87n)] as const;
      for (const [index, seal] of seals.entries()) {
        await author.recordRfc64PublicCatalogAssetV1({
          contextGraphId: CONTEXT_GRAPH_ID,
          assertionCoordinate: `rollout-atomic-${index}` as never,
          publicQuads: PROJECTION_QUADS,
          seal: assertionSealFromCanonical(seal),
        });
        await seedCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`);
      }
      const internals = author as unknown as {
        store: TripleStore;
        rfc64PersistenceV1: {
          controlObjects: Parameters<
            typeof prepareRfc64AppliedCatalogAuthorityDeactivationV1
          >[0]['controlObjects'];
          inventory: Parameters<
            typeof commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1
          >[0]['inventory'] & {
            listAppliedCatalogHeadsV1(): readonly any[];
          };
        };
      };
      const [appliedHead] = internals.rfc64PersistenceV1.inventory.listAppliedCatalogHeadsV1();
      expect(appliedHead).toBeDefined();
      const prepared = await prepareRfc64AppliedCatalogAuthorityDeactivationV1({
        store: internals.store,
        controlObjects: internals.rfc64PersistenceV1.controlObjects,
        appliedHead,
      });
      let semanticMutations = 0;
      const injectedStore = new Proxy(internals.store, {
        get(target, property, receiver) {
          if (property === 'replaceGraphAndSubject') {
            return async (...args: unknown[]) => {
              semanticMutations += 1;
              if (failureStage === 'later semantic removal' && semanticMutations === 2) {
                throw new Error('injected later semantic removal failure');
              }
              return (target.replaceGraphAndSubject as (...values: unknown[]) => unknown)
                .apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const injectedInventory = failureStage === 'inventory deletion'
        ? { deleteAppliedCatalogHeadsV1: () => { throw new Error('injected inventory failure'); } }
        : internals.rfc64PersistenceV1.inventory;

      await expect(commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: injectedStore,
        inventory: injectedInventory,
        prepared: [prepared],
      })).rejects.toThrow('catalog semantic authority deactivation failed');
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, true);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).not.toBeNull();

      await commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: internals.store,
        inventory: internals.rfc64PersistenceV1.inventory,
        prepared: [prepared],
      });
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, false);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).toBeNull();
    },
    30_000,
  );

  it('pauses and resumes existing catalog authority without deleting it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-kill-switch-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'kill-switch-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(84n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'kill-switch-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    await seedCatalogSemanticClosure(author, seal, 'kill-switch-preservation');
    await expectCatalogSemanticClosure(author, seal, 'kill-switch-preservation', true);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const stopped = await startAgent(
      'kill-switch-active',
      activation('catalog', true),
      dataDir,
      persistentStorePath,
    );
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
    expect(stopped.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(stopped.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(stopped, seal, 'kill-switch-preservation', true);
    await stopped.stop();
    agents.splice(agents.indexOf(stopped), 1);

    const resumed = await startAgent(
      'kill-switch-cleared',
      activation('catalog'),
      dataDir,
      persistentStorePath,
    );
    expect(resumed.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(resumed.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(resumed.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(resumed, seal, 'kill-switch-preservation', true);
  }, 30_000);

  it('retains durable catalog authority for pre-activation standalone controls', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-rollout-standalone-'));
    tempDirs.push(dataDir);
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent(
      'standalone-author',
      {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-standalone-compatibility' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(83n)),
    });
    expect(applied).not.toBeNull();
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const restarted = await startAgent(
      'standalone-compatibility',
      undefined,
      dataDir,
      persistentStorePath,
      undefined,
      {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
        },
      },
    );
    expect(restarted.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: applied?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 30_000);

  it('cold-bootstraps a valid shadow head as staged-only with no applied head', async () => {
    const author = await startAgent('shadow-author', {
      ...activation('catalog'),
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-shadow-bootstrap' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(82n)),
    });
    const shadow = await startAgent('shadow-receiver', {
      ...activation('shadow'),
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(),
          targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
        }],
      },
    });
    await connectBothWays(author, shadow);
    await vi.waitFor(() => {
      expect(shadow.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        mode: 'shadow',
        outcome: 'shadow-staged',
        stagedHeadDigest: published?.currentCatalogHeadDigest,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });
    expect(shadow.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 30_000);
});

function activation(
  mode: 'legacy' | 'shadow' | 'catalog',
  killSwitch = false,
): Rfc64PublicCatalogActivationInputV1 {
  return {
    deploymentProfile: DEPLOYMENT,
    rollout: { killSwitch, contextGraphModes: { [CONTEXT_GRAPH_ID]: mode } },
    bootstrap: {
      acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
      retryIntervalMs: 1_000,
    },
  };
}

function policyEnvelope() {
  return unsignedOpenContextGraphPolicyEnvelopeV1(buildOpenOwnerContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  }));
}

async function startAgent(
  name: string,
  activationInput: Rfc64PublicCatalogActivationInputV1 | undefined,
  existingDataDir?: string,
  persistentStorePath?: string,
  beforeStart?: (agent: DKGAgent) => void | Promise<void>,
  extraConfig: Partial<Parameters<typeof DKGAgent.create>[0]> = {},
): Promise<DKGAgent> {
  const dataDir = existingDataDir ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-${name}-`));
  if (existingDataDir === undefined) tempDirs.push(dataDir);
  const agent = await DKGAgent.create({
    name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(persistentStorePath),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    syncContextGraphs: activationInput?.bootstrap?.acceptedPublicPolicies.map(
      ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
    ) ?? [],
    networkIdentity: {
      networkId: await computeNetworkId(),
      chainId: NETWORK_ID,
    },
    rfc64PublicCatalogActivation: activationInput,
    ...extraConfig,
  });
  agents.push(agent);
  await beforeStart?.(agent);
  await agent.start();
  for (const contextGraphId of extraConfig.syncContextGraphs
    ?? activationInput?.bootstrap?.acceptedPublicPolicies.map(
      ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
    )
    ?? []) {
    agent.subscribeToContextGraph(contextGraphId);
  }
  return agent;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  const address = (agent: DKGAgent) => {
    const tcp = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (tcp === undefined) throw new Error('agent has no TCP multiaddr');
    return tcp;
  };
  await a.node.libp2p.dial(multiaddr(address(b)));
  await b.node.libp2p.dial(multiaddr(address(a)));
}

async function expectCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
  present: boolean,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    assertionCoordinate: assertionCoordinate as never,
  });
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await expect(store.hasGraph(swmGraph)).resolves.toBe(present);
  const sealRows = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${placement.metaGraph}> { `
      + `<${placement.subject}> ?p ?o } } LIMIT 1`,
  );
  expect(sealRows.type).toBe('bindings');
  if (sealRows.type !== 'bindings') throw new Error('expected seal bindings');
  expect(sealRows.bindings.length > 0).toBe(present);
}

async function seedCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await store.insert([
    ...PROJECTION_QUADS.map((quad) => ({ ...quad, graph: swmGraph })),
    ...projectCanonicalGraphScopedAuthorSealRowsV1(seal, {
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: assertionCoordinate as never,
    }),
  ]);
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
