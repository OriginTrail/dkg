// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter, type ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY as D,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type {
  ContextGraphMembershipRecord,
  ContextGraphSubscriptionRecord,
} from '../src/index.js';
import { resolveRfc64WalletNamespaceOwnerV1 } from '../src/rfc64/unregistered-authority-seed-store-v1.js';
import { createRfc64RolloutAgentHarness, RFC64_ROLLOUT_DEPLOYMENT } from './_helpers/rfc64-rollout-agent-harness.js';

const OWNER = '0x4bf5c3c4b96894c7f1e7f7d625e4b48051b443b4';
const OUTSIDER = '0x1111111111111111111111111111111111111111';
const CONTEXT_GRAPH_ID = 'eu-open-calls';
const CURATOR_PEER = '12D3KooWHgiPDA9sub2NCvWnCM1hAgK6YcXZYBzi7hALYMHGtgxm';
const h = createRfc64RolloutAgentHarness();

function createApprovedReplicaPersistence() {
  type DurableMembership = ContextGraphMembershipRecord & {
    firstSeenAt?: number;
    updatedAt: number;
  };
  const subscriptions = new Map<string, ContextGraphSubscriptionRecord>();
  const memberships = new Map<string, DurableMembership>();
  const membershipKey = (
    contextGraphId: string,
    principalType: ContextGraphMembershipRecord['principalType'],
    principalId: string,
  ) => `${contextGraphId}\0${principalType}\0${principalId.toLowerCase()}`;

  return {
    subscriptions,
    memberships,
    subscriptionStore: {
      loadAll: async () => [...subscriptions.values()].map((row) => ({ ...row })),
      load: async (contextGraphId: string) => {
        const row = subscriptions.get(contextGraphId);
        return row === undefined ? null : { ...row };
      },
      save: async (record: ContextGraphSubscriptionRecord) => {
        subscriptions.set(record.id, { ...record });
      },
      delete: async (contextGraphId: string) => {
        subscriptions.delete(contextGraphId);
      },
    },
    membershipStore: {
      loadAll: async () => [...memberships.values()].map((row) => ({ ...row })),
      upsert: async (record: DurableMembership) => {
        memberships.set(
          membershipKey(record.contextGraphId, record.principalType, record.principalId),
          { ...record },
        );
      },
      delete: async (
        contextGraphId: string,
        principalType: ContextGraphMembershipRecord['principalType'],
        principalId: string,
      ) => {
        memberships.delete(membershipKey(contextGraphId, principalType, principalId));
      },
    },
  };
}

afterEach(async () => {
  await h.cleanup();
  vi.restoreAllMocks();
});

interface ApprovedReplicaFixtureOptions {
  readonly localApproval?: boolean;
  readonly approvedAddress?: string;
  readonly requesterStatus?: 'pending' | 'approved' | 'rejected';
  readonly requesterOwner?: string;
  readonly requesterPeer?: string;
  readonly requesterEra?: string;
  readonly accessPolicy?: string;
  readonly creators?: readonly string[];
  readonly curators?: readonly string[];
  readonly additionalAllowedAgents?: readonly string[];
  readonly registrationStatus?: string;
  readonly revokeApproved?: boolean;
  readonly delegationPeer?: string;
  readonly delegationIssuedAt?: number;
  readonly delegationExpiresAt?: number;
  readonly indexError?: Error;
  readonly installSubscription?: boolean;
  readonly nonDefaultMember?: boolean;
  readonly selfSovereignMember?: boolean;
}

async function approvedBareNameReplicaFixture(options: ApprovedReplicaFixtureOptions = {}) {
  const current = vi.fn(async (): Promise<bigint | null> => {
    throw new Error('legacy current-slot lookup must not run');
  });
  const finalized = vi.fn(async (): Promise<Map<string, ContextGraphAuthoritySnapshot>> => {
    if (options.indexError !== undefined) throw options.indexError;
    return new Map();
  });
  const chain = Object.assign(new NoChainAdapter(), {
    resolveContextGraphIdByNameHash: current,
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: finalized,
      whenIdle: async () => undefined,
      readContextGraphAuthorityIndexRevisions: async () => new Map(),
    },
  });
  const receiver = await h.startAgent({
    name: 'approved-private-bare-name-replica',
    config: {
      chainAdapter: chain,
      rfc64CatalogDeploymentProfile: RFC64_ROLLOUT_DEPLOYMENT,
    },
  });
  if (options.nonDefaultMember === true) {
    await receiver.registerAgent('unrelated default agent');
  }
  const externalMember = options.selfSovereignMember === true
    ? new ethers.Wallet(`0x${'42'.repeat(32)}`)
    : null;
  const member = await receiver.registerAgent(
    'eu-open-calls member',
    externalMember === null
      ? undefined
      : {
          publicKey: ethers.SigningKey.computePublicKey(
            externalMember.signingKey.publicKey,
            true,
          ),
        },
  );
  const memberAddress = member.agentAddress.toLowerCase();
  const approvedAddress = options.approvedAddress?.toLowerCase() ?? memberAddress;
  const approvals = Reflect.get(receiver, 'localApprovedAgentByCG') as Map<string, string>;
  if (options.localApproval !== false) {
    approvals.set(CONTEXT_GRAPH_ID, approvedAddress);
    await receiver.writeRequesterJoinRequestState(CONTEXT_GRAPH_ID, approvedAddress, {
      status: options.requesterStatus ?? 'approved',
      requestGeneration: `0x${'12'.repeat(32)}`,
      curatorPeerId: options.requesterPeer ?? CURATOR_PEER,
      curatorAgentAddress: options.requesterOwner ?? OWNER,
      curatorAuthorityEra: options.requesterEra ?? '0',
    });
  }

  const graph = contextGraphMetaGraphUri(CONTEXT_GRAPH_ID);
  const subject = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
  const root = (predicate: string, object: string) => ({ graph, subject, predicate, object });
  const creators = options.creators ?? [CURATOR_PEER];
  const curators = options.curators ?? [OWNER];
  const delegationSubject = `did:dkg:agent-delegation:${CONTEXT_GRAPH_ID}:${approvedAddress}`;
  await receiver.store.insert([
    root(D.RDF_TYPE, D.DKG_CONTEXT_GRAPH),
    root(D.DKG_ACCESS_POLICY, JSON.stringify(options.accessPolicy ?? 'private')),
    ...creators.map((peerId) => root(D.DKG_CREATOR, `did:dkg:agent:${peerId}`)),
    ...curators.map((address) => root(D.DKG_CURATOR, `did:dkg:agent:${address}`)),
    root(D.DKG_REGISTRATION_STATUS, JSON.stringify(options.registrationStatus ?? 'unregistered')),
    ...[
      OWNER,
      approvedAddress,
      ...(options.additionalAllowedAgents ?? []),
    ].map((address) => root(D.DKG_ALLOWED_AGENT, JSON.stringify(address))),
    ...(options.revokeApproved === true
      ? [root(D.DKG_REVOKED_AGENT, JSON.stringify(approvedAddress))]
      : []),
    ...[
      [D.DKG_DELEGATION_AGENT, JSON.stringify(approvedAddress)],
      [D.DKG_DELEGATION_ISSUED_AT, JSON.stringify(String(
        options.delegationIssuedAt ?? Date.now() - 1_000,
      ))],
      [D.DKG_ALLOWED_DELEGATEE_PEER, JSON.stringify(
        options.delegationPeer ?? receiver.peerId,
      )],
      ...(options.delegationExpiresAt === undefined
        ? []
        : [[D.DKG_DELEGATION_EXPIRES_AT, JSON.stringify(String(options.delegationExpiresAt))]]),
    ].map(([predicate, object]) => ({
      graph,
      subject: delegationSubject,
      predicate,
      object,
    })),
  ]);

  if (options.installSubscription !== false) {
    Reflect.get(receiver, 'subscribedContextGraphs').set(CONTEXT_GRAPH_ID, {
      subscribed: true,
      pendingMeta: true,
      metaSynced: true,
      synced: false,
      syncMode: 'always-on',
    });
  }
  return {
    receiver,
    memberAddress,
    approvedAddress,
    approvals,
    graph,
    subject,
    delegationSubject,
    current,
    finalized,
  };
}

function pauseApprovedPrivateProofOnce(
  fixture: Awaited<ReturnType<typeof approvedBareNameReplicaFixture>>,
) {
  let releaseProof!: () => void;
  let proofEntered!: () => void;
  const release = new Promise<void>((resolve) => { releaseProof = resolve; });
  const entered = new Promise<void>((resolve) => { proofEntered = resolve; });
  const originalQuery = fixture.receiver.store.query.bind(fixture.receiver.store);
  let paused = false;
  vi.spyOn(fixture.receiver.store, 'query').mockImplementation(async (query, options) => {
    if (!paused && options?.source === 'agent.contextGraph.approvedPrivateReplica') {
      paused = true;
      proofEntered();
      await release;
    }
    return originalQuery(query, options);
  });
  return { entered, release: releaseProof };
}

describe('approved private bare-name replica authorization', () => {
  it('admits eu-open-calls after approval without the wallet-namespaced seed path', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      // Participant approval must not promote the full RDF roster into a
      // generic owner policy. Only the curator and this approved local member
      // belong to the transaction-scoped replica authority.
      additionalAllowedAgents: [OUTSIDER],
    });
    const seedFetch = vi.spyOn(
      fixture.receiver,
      'fetchRfc64UnregisteredAuthoritySeedFromPeersV1',
    );

    expect(resolveRfc64WalletNamespaceOwnerV1(CONTEXT_GRAPH_ID)).toBeNull();
    // Generic registration and mutation consumers must remain fail-closed;
    // only read/sync callers explicitly opt into the participant proof.
    await expect(fixture.receiver.resolveContextGraphRegistrationBinding(
      CONTEXT_GRAPH_ID,
    )).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(fixture.receiver.resolveRegisteredContextGraphAuthority(
      CONTEXT_GRAPH_ID,
    )).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    const expectedAuthority = {
      outcome: 'allowed',
      source: 'rfc64-private',
      reason: 'rfc64-participant',
    } as const;
    await expect(fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    )).resolves.toMatchObject(expectedAuthority);

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject(expectedAuthority);
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
    await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: OUTSIDER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
    })).resolves.toBe(true);
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: OUTSIDER,
    })).resolves.toBe(false);
    await expect(fixture.receiver.canUseLegacyDurableSyncForContextGraphV1(CONTEXT_GRAPH_ID))
      .resolves.toBe(true);

    expect(seedFetch).not.toHaveBeenCalled();
    expect(fixture.finalized).toHaveBeenCalled();
    expect(fixture.current).not.toHaveBeenCalled();
  });

  it('rehydrates a persisted bare-name row before installing the subscription', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      installSubscription: false,
      nonDefaultMember: true,
    });
    expect(Reflect.get(fixture.receiver, 'defaultAgentAddress')?.toLowerCase())
      .not.toBe(fixture.memberAddress);

    await expect(fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        allowSubscriptionFallback: false,
        durableSubscriptionBinding: { contextGraphId: CONTEXT_GRAPH_ID },
      },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-private',
      reason: 'rfc64-participant',
    });
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID))
      .resolves.toBe(true);
    expect(fixture.current).not.toHaveBeenCalled();
  });

  it('admits an approved self-sovereign local member without a custodial signing key', async () => {
    const fixture = await approvedBareNameReplicaFixture({ selfSovereignMember: true });

    expect(fixture.receiver.getWorkspaceSigningAgentForAddress(fixture.memberAddress))
      .toBeNull();
    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-private',
      reason: 'rfc64-participant',
    });
  });

  it('reactivates an approved non-default private replica after restart and keeps a rejected approval dormant', async () => {
    const dataDir = await h.createDataDir('approved-private-replica-restart');
    const persistentStorePath = join(dataDir, 'store');
    const persistence = createApprovedReplicaPersistence();
    const finalizedReaders: Array<ReturnType<typeof vi.fn>> = [];
    const currentReaders: Array<ReturnType<typeof vi.fn>> = [];
    const chainAdapter = () => {
      const current = vi.fn(async (): Promise<bigint | null> => {
        throw new Error('legacy current-slot lookup must not run');
      });
      const finalized = vi.fn(async (): Promise<Map<string, ContextGraphAuthoritySnapshot>> => (
        new Map()
      ));
      currentReaders.push(current);
      finalizedReaders.push(finalized);
      return Object.assign(new NoChainAdapter(), {
        resolveContextGraphIdByNameHash: current,
        contextGraphAuthorityIndexRevisionReader: {
          resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: finalized,
          whenIdle: async () => undefined,
          readContextGraphAuthorityIndexRevisions: async () => new Map(),
        },
      });
    };
    const startOptions = (name: string) => ({
      name,
      dataDir,
      persistentStorePath,
      config: {
        chainAdapter: chainAdapter(),
        rfc64CatalogDeploymentProfile: RFC64_ROLLOUT_DEPLOYMENT,
        contextGraphSubscriptionStore: persistence.subscriptionStore,
        contextGraphMembershipStore: persistence.membershipStore,
      },
    });

    const first = await h.startAgent(startOptions('approved-private-replica-first'));
    const defaultAgent = await first.registerAgent('unrelated default agent');
    await first.markDefaultAgent(defaultAgent.agentAddress);
    const approvedMember = await first.registerAgent('approved non-default member');
    const approvedAddress = approvedMember.agentAddress.toLowerCase();
    Reflect.get(first, 'localApprovedAgentByCG').set(CONTEXT_GRAPH_ID, approvedAddress);
    const requestGeneration = `0x${'12'.repeat(32)}`;
    await first.writeRequesterJoinRequestState(CONTEXT_GRAPH_ID, approvedAddress, {
      status: 'approved',
      requestGeneration,
      curatorPeerId: CURATOR_PEER,
      curatorAgentAddress: OWNER,
      curatorAuthorityEra: '0',
    });

    const graph = contextGraphMetaGraphUri(CONTEXT_GRAPH_ID);
    const subject = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
    const delegationSubject = `did:dkg:agent-delegation:${CONTEXT_GRAPH_ID}:${approvedAddress}`;
    await first.store.insert([
      { graph, subject, predicate: D.RDF_TYPE, object: D.DKG_CONTEXT_GRAPH },
      { graph, subject, predicate: D.DKG_ACCESS_POLICY, object: JSON.stringify('private') },
      { graph, subject, predicate: D.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_PEER}` },
      { graph, subject, predicate: D.DKG_CURATOR, object: `did:dkg:agent:${OWNER}` },
      { graph, subject, predicate: D.DKG_REGISTRATION_STATUS, object: JSON.stringify('unregistered') },
      { graph, subject, predicate: D.DKG_ALLOWED_AGENT, object: JSON.stringify(OWNER) },
      { graph, subject, predicate: D.DKG_ALLOWED_AGENT, object: JSON.stringify(approvedAddress) },
      {
        graph,
        subject: delegationSubject,
        predicate: D.DKG_DELEGATION_AGENT,
        object: JSON.stringify(approvedAddress),
      },
      {
        graph,
        subject: delegationSubject,
        predicate: D.DKG_DELEGATION_ISSUED_AT,
        object: JSON.stringify(String(Date.now() - 1_000)),
      },
      {
        graph,
        subject: delegationSubject,
        predicate: D.DKG_ALLOWED_DELEGATEE_PEER,
        object: JSON.stringify(first.peerId),
      },
    ]);
    await first.persistJoinApprovalStateStrict(
      CONTEXT_GRAPH_ID,
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        principalType: 'agent',
        principalId: approvedAddress,
        role: 'participant',
        status: 'active',
        source: 'join-approved',
        metadata: { curatorPeerId: CURATOR_PEER },
      },
      {
        syncMode: 'always-on',
        subscribed: true,
        pendingMeta: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    );
    await expect(first.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: approvedAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-private',
      reason: 'rfc64-participant',
    });

    const receiverPeerId = first.peerId;
    const restarted = await h.restartAgent(
      first,
      startOptions('approved-private-replica-restarted'),
    );
    expect(restarted.peerId).toBe(receiverPeerId);
    expect(restarted.getDefaultAgentAddress()?.toLowerCase())
      .toBe(defaultAgent.agentAddress.toLowerCase());
    expect(restarted.getDefaultAgentAddress()?.toLowerCase()).not.toBe(approvedAddress);
    expect(restarted.listLocalAgents().map(({ agentAddress }) => agentAddress.toLowerCase()))
      .toContain(approvedAddress);
    expect(Reflect.get(restarted, 'localApprovedAgentByCG').get(CONTEXT_GRAPH_ID))
      .toBe(approvedAddress);
    expect(restarted.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
      syncMode: 'always-on',
      metaSynced: true,
    });
    expect(restarted.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 1,
      activated: 1,
      dormant: 0,
    });
    await expect(restarted.canReadContextGraph(CONTEXT_GRAPH_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);

    await restarted.writeRequesterJoinRequestState(CONTEXT_GRAPH_ID, approvedAddress, {
      status: 'rejected',
      requestGeneration,
      curatorPeerId: CURATOR_PEER,
      curatorAgentAddress: OWNER,
      curatorAuthorityEra: '0',
    });
    const rejectedRestart = await h.restartAgent(
      restarted,
      startOptions('approved-private-replica-rejected'),
    );
    expect(rejectedRestart.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(rejectedRestart.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 1,
      activated: 0,
      dormant: 1,
      dormantReasons: {
        authorityUnavailable: [CONTEXT_GRAPH_ID],
      },
    });
    await expect(rejectedRestart.canReadContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: approvedAddress,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    await expect(rejectedRestart.canReadContextGraph(CONTEXT_GRAPH_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(finalizedReaders).toHaveLength(3);
    expect(finalizedReaders.every((read) => read.mock.calls.length > 0)).toBe(true);
    expect(currentReaders.every((read) => read.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ['public', undefined, { source: 'rfc64-public', reason: 'accepted-public-policy' }],
    ['private', [OUTSIDER], { source: 'rfc64-private', reason: 'rfc64-participant' }],
  ] as const)(
    'preserves an accepted %s policy ahead of the local participant proof',
    async (_policy, privateRoster, expected) => {
      const fixture = await approvedBareNameReplicaFixture();
      vi.spyOn(fixture.receiver, 'hasAcceptedRfc64UnregisteredAuthorityV1')
        .mockReturnValue(true);
      vi.spyOn(fixture.receiver, 'hasAcceptedRfc64PublicUnregisteredAuthorityV1')
        .mockReturnValue(privateRoster === undefined);
      vi.spyOn(fixture.receiver, 'resolveRfc64PrivateReadRosterV1')
        .mockReturnValue(privateRoster);
      const query = vi.spyOn(fixture.receiver.store, 'query');

      await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
        callerAgentAddress: OUTSIDER,
        allowSubscriptionFallback: false,
      })).resolves.toMatchObject({ outcome: 'allowed', ...expected });
      expect(query.mock.calls.some(([, options]) => (
        options?.source === 'agent.contextGraph.approvedPrivateReplica'
      ))).toBe(false);
    },
  );

  it.each([
    ['missing local approval', { localApproval: false }],
    ['non-local approved signer', { approvedAddress: OUTSIDER }],
    ['pending approval', { requesterStatus: 'pending' }],
    ['rejected approval', { requesterStatus: 'rejected' }],
    ['wrong curator owner', { requesterOwner: OUTSIDER }],
    ['wrong curator peer', { requesterPeer: `${CURATOR_PEER}-other` }],
    ['wrong curator era', { requesterEra: '1' }],
    ['zero curator owner', {
      requesterOwner: `0x${'0'.repeat(40)}`,
      curators: [`0x${'0'.repeat(40)}`],
    }],
    ['public metadata', { accessPolicy: 'public' }],
    ['ambiguous curators', { curators: [OWNER, OUTSIDER] }],
    ['ambiguous creators', { creators: [CURATOR_PEER, `${CURATOR_PEER}-other`] }],
    ['pending registration', { registrationStatus: 'pending' }],
    ['revoked approved member', { revokeApproved: true }],
    ['future delegation', { delegationIssuedAt: Date.now() + 60_000 }],
    ['expired delegation', { delegationExpiresAt: Date.now() - 1_000 }],
    ['wrong delegatee peer', { delegationPeer: CURATOR_PEER }],
  ] satisfies ReadonlyArray<readonly [string, ApprovedReplicaFixtureOptions]>) (
    'fails closed for %s',
    async (_label, options) => {
      const fixture = await approvedBareNameReplicaFixture(options);
      await expect(fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
        CONTEXT_GRAPH_ID,
        {
          callerAgentAddress: fixture.memberAddress,
          allowSubscriptionFallback: false,
        },
      )).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason: 'finalized-name-absence-unaccepted',
      });
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
        .toBeNull();
      await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: fixture.memberAddress,
      })).resolves.toBe(false);
      expect(fixture.current).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the finalized name index is unavailable', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      indexError: new Error('finalized index unavailable'),
    });
    await expect(fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-name-binding-unavailable',
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
    expect(fixture.current).not.toHaveBeenCalled();
  });

  it('rejects an approval generation replaced while the metadata proof is in flight', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const proof = pauseApprovedPrivateProofOnce(fixture);
    const admission = fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    );
    await proof.entered;
    await fixture.receiver.writeRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
      {
        status: 'approved',
        requestGeneration: `0x${'34'.repeat(32)}`,
        curatorPeerId: CURATOR_PEER,
        curatorAgentAddress: OWNER,
        curatorAuthorityEra: '0',
      },
    );
    proof.release();

    await expect(admission).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

  it.each([
    ['curator', D.DKG_CURATOR, `did:dkg:agent:${OUTSIDER}`],
    ['creator', D.DKG_CREATOR, `did:dkg:agent:${CURATOR_PEER}-other`],
  ] as const)(
    'rejects a %s mutation while the metadata proof is in flight',
    async (_label, predicate, object) => {
      const fixture = await approvedBareNameReplicaFixture();
      const proof = pauseApprovedPrivateProofOnce(fixture);
      const admission = fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
        CONTEXT_GRAPH_ID,
        {
          callerAgentAddress: fixture.memberAddress,
          allowSubscriptionFallback: false,
        },
      );
      await proof.entered;
      await fixture.receiver.store.insert([{
        graph: fixture.graph,
        subject: fixture.subject,
        predicate,
        object,
      }]);
      Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
      proof.release();

      await expect(admission).resolves.toMatchObject({
        outcome: 'unavailable',
        reason: 'finalized-name-absence-unaccepted',
      });
    },
  );

  it('rejects registration that starts while the private proof is in flight', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const proof = pauseApprovedPrivateProofOnce(fixture);
    const admission = fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    );
    await proof.entered;
    const registrations = Reflect.get(
      fixture.receiver,
      'contextGraphRegistrationsInFlight',
    ) as Set<string>;
    registrations.add(CONTEXT_GRAPH_ID);
    proof.release();

    await expect(admission).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
    registrations.delete(CONTEXT_GRAPH_ID);
  });

  it('denies participant authority immediately after the approved member is revoked', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    await expect(fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-private' });

    await fixture.receiver.store.insert([{
      graph: fixture.graph,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(fixture.memberAddress),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
    })).resolves.toBe(false);
    await expect(fixture.receiver.getContextGraphAgentGateAddresses(CONTEXT_GRAPH_ID))
      .resolves.toEqual([]);

    // Participant approval never installs a reusable catalog policy snapshot.
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });
});
