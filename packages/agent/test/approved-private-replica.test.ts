// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter, type ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY as D,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  PROTOCOL_SWM_SENDER_KEY,
  PROTOCOL_SWM_UPDATE,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeGossipSigningPayload,
  computeSwmSenderKeyPackageAAD,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  decodeGossipEnvelope,
  decodeSwmSenderKeyMessage,
  decodeSwmSenderKeyPackageAck,
  decodeWorkspacePublishRequest,
  encodeGossipEnvelope,
  encodeSwmSenderKeyPackage,
  encodeWorkspacePublishRequest,
  encodeWorkspaceEncryptionKey,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  generateWorkspaceRecipientEncryptionKey,
  type SwmSenderKeyPackageMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  ContextGraphMembershipRecord,
  ContextGraphSubscriptionRecord,
} from '../src/index.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../scripts/testing/snapshot-storage.js';
import { isApprovedPrivateReplicaDelegationActive } from '../src/approved-private-replica.js';
import { resolveRfc64WalletNamespaceOwnerV1 } from '../src/rfc64/unregistered-authority-seed-store-v1.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { createRfc64RolloutAgentHarness, RFC64_ROLLOUT_DEPLOYMENT } from './_helpers/rfc64-rollout-agent-harness.js';

// Lets one test act at the await boundary of a successful join proof: after
// the proof's own final checks, and before its caller resumes.
const afterApprovedPrivateProof = vi.hoisted(() => ({
  run: null as null | (() => Promise<void>),
}));
vi.mock('../src/approved-private-replica.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/approved-private-replica.js')>();
  return {
    ...original,
    resolveApprovedPrivateReplicaAuthority: async (
      ...args: Parameters<typeof original.resolveApprovedPrivateReplicaAuthority>
    ) => {
      const result = await original.resolveApprovedPrivateReplicaAuthority(...args);
      const run = afterApprovedPrivateProof.run;
      if (run !== null && result?.kind === 'unregistered-private-replica') {
        afterApprovedPrivateProof.run = null;
        await run();
      }
      return result;
    },
  };
});

const OWNER = '0x4bf5c3c4b96894c7f1e7f7d625e4b48051b443b4';
const OUTSIDER = '0x1111111111111111111111111111111111111111';
const CONTEXT_GRAPH_ID = 'eu-open-calls';
const CURATOR_PEER = '12D3KooWHgiPDA9sub2NCvWnCM1hAgK6YcXZYBzi7hALYMHGtgxm';
const THIRD_ALLOWED_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const AGENT_PROFILE_GRAPH = 'did:dkg:system/agents';
const SECONDARY_META_GRAPH = contextGraphDataGraphUri('agents');
const h = createRfc64RolloutAgentHarness();

type TestSigningWallet = ethers.Wallet | ethers.HDNodeWallet;

function signedWorkspaceProfileKeyQuads(
  wallet: TestSigningWallet,
  peerId: string,
  keyLabel: string,
  graph = AGENT_PROFILE_GRAPH,
): Quad[] {
  const agentAddress = ethers.getAddress(wallet.address);
  const agentUri = `did:dkg:agent:${agentAddress}`;
  const key = generateWorkspaceRecipientEncryptionKey(
    agentUri,
    `${agentUri}#${keyLabel}`,
  );
  const publicKeyBytes = key.publicKeyBytes;
  if (publicKeyBytes === undefined) {
    throw new Error('test workspace recipient key is missing its public half');
  }
  const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const proof = wallet.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;
  return [
    {
      subject: agentUri,
      predicate: D.DKG_PUBLIC_ENCRYPTION_KEY,
      object: JSON.stringify(encodeWorkspaceEncryptionKey(publicKeyBytes)),
      graph,
    },
    {
      subject: agentUri,
      predicate: D.DKG_ENCRYPTION_KEY_ALGORITHM,
      object: JSON.stringify(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519),
      graph,
    },
    {
      subject: agentUri,
      predicate: D.DKG_ENCRYPTION_KEY_PROOF,
      object: JSON.stringify(proof),
      graph,
    },
    {
      subject: agentUri,
      predicate: D.DKG_PEER_ID,
      object: JSON.stringify(peerId),
      graph,
    },
  ];
}

async function signedSenderKeyPackage(
  senderWallet: TestSigningWallet,
  recipientAgentAddress: string,
  recipientKeyId: string,
): Promise<SwmSenderKeyPackageMsg> {
  const signingKeypair = await generateEd25519Keypair();
  const recipientPublicKey = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${recipientAgentAddress}`,
    recipientKeyId,
  ).publicKeyBytes;
  if (recipientPublicKey === undefined) {
    throw new Error('test sender-key recipient is missing its public key');
  }
  const pkg = await encryptSwmSenderKeyPackage({
    contextGraphId: CONTEXT_GRAPH_ID,
    senderAgentAddress: senderWallet.address,
    epochId: generateSwmSenderEpochId(),
    membershipHash: 'sha256:approved-private-peer-gate',
    recipientAgentAddress,
    recipientKeyId,
    createdAtMs: Date.now(),
    initialMessageIndex: 0,
    chainKey: generateSwmSenderChainKey(),
    senderSigningPublicKey: signingKeypair.publicKey,
    recipientPublicKey,
  });
  pkg.signature = ethers.getBytes(
    await senderWallet.signMessage(computeSwmSenderKeyPackageAAD(pkg)),
  );
  return pkg;
}

async function signedWorkspaceEnvelope(
  senderWallet: TestSigningWallet,
  publisherPeerId: string,
): Promise<Uint8Array> {
  const payload = encodeWorkspacePublishRequest({
    contextGraphId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<urn:test:approved-private-peer-gate> <http://schema.org/name> "peer gate" <${contextGraphDataGraphUri(CONTEXT_GRAPH_ID)}> .`,
    ),
    manifest: [{ rootEntity: 'urn:test:approved-private-peer-gate', privateTripleCount: 0 }],
    publisherPeerId,
    shareOperationId: 'approved-private-peer-gate',
    timestampMs: Date.now(),
  });
  const timestamp = new Date().toISOString();
  const signature = await senderWallet.signMessage(computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    CONTEXT_GRAPH_ID,
    timestamp,
    payload,
  ));
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: CONTEXT_GRAPH_ID,
    agentAddress: senderWallet.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

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
  readonly peerAllowlist?: 'receiver-only' | 'curator-only';
  readonly indexError?: Error;
  readonly installSubscription?: boolean;
  readonly nonDefaultMember?: boolean;
  readonly selfSovereignMember?: boolean;
  readonly legacyAdapter?: boolean;
  readonly registeredMetaOnChainIds?: readonly string[];
}

async function approvedBareNameReplicaFixture(options: ApprovedReplicaFixtureOptions = {}) {
  const current = vi.fn(async (): Promise<bigint | null> => {
    throw new Error('legacy current-slot lookup must not run');
  });
  const finalized = vi.fn(async (): Promise<Map<string, ContextGraphAuthoritySnapshot>> => {
    if (options.indexError !== undefined) throw options.indexError;
    return new Map();
  });
  const chain = options.legacyAdapter === true
    ? new NoChainAdapter()
    : Object.assign(new NoChainAdapter(), {
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
  const allowedPeers = options.peerAllowlist === 'receiver-only'
    ? [receiver.peerId]
    : options.peerAllowlist === 'curator-only'
      ? [CURATOR_PEER]
      : [];
  const delegationSubject = `did:dkg:agent-delegation:${CONTEXT_GRAPH_ID}:${approvedAddress}`;
  await receiver.store.insert([
    root(D.RDF_TYPE, D.DKG_CONTEXT_GRAPH),
    root(D.DKG_ACCESS_POLICY, JSON.stringify(options.accessPolicy ?? 'private')),
    ...creators.map((peerId) => root(D.DKG_CREATOR, `did:dkg:agent:${peerId}`)),
    ...curators.map((address) => root(D.DKG_CURATOR, `did:dkg:agent:${address}`)),
    root(D.DKG_REGISTRATION_STATUS, JSON.stringify(options.registrationStatus ?? 'unregistered')),
    ...(options.registeredMetaOnChainIds ?? []).map((onChainId) => root(
      `${D.DKG_CONTEXT_GRAPH}OnChainId`,
      JSON.stringify(onChainId),
    )),
    ...allowedPeers.map((peerId) => root(D.DKG_ALLOWED_PEER, JSON.stringify(peerId))),
    ...[
      options.requesterOwner ?? OWNER,
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
    member,
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

function pauseSuccessfulApprovedPrivateProofOnce(
  fixture: Awaited<ReturnType<typeof approvedBareNameReplicaFixture>>,
) {
  let releaseProof!: () => void;
  let proofReturned!: () => void;
  const release = new Promise<void>((resolve) => { releaseProof = resolve; });
  const returned = new Promise<void>((resolve) => { proofReturned = resolve; });
  const originalQuery = fixture.receiver.store.query.bind(fixture.receiver.store);
  let paused = false;
  vi.spyOn(fixture.receiver.store, 'query').mockImplementation(async (query, options) => {
    const result = await originalQuery(query, options);
    if (
      !paused
      && options?.source === 'agent.contextGraph.approvedPrivateReplica'
      && result.type === 'bindings'
      && result.bindings.length > 0
    ) {
      paused = true;
      proofReturned();
      await release;
    }
    return result;
  });
  return { returned, release: releaseProof };
}

/** Hold the first call of one receiver method until released; later calls run through. */
function pauseReceiverMethodOnce(
  fixture: Awaited<ReturnType<typeof approvedBareNameReplicaFixture>>,
  method: string,
) {
  let releaseCall!: () => void;
  let callEntered!: () => void;
  const release = new Promise<void>((resolve) => { releaseCall = resolve; });
  const entered = new Promise<void>((resolve) => { callEntered = resolve; });
  const receiver = fixture.receiver as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const original = receiver[method]!.bind(fixture.receiver);
  let paused = false;
  vi.spyOn(receiver, method).mockImplementation(async (...args: unknown[]) => {
    if (!paused) {
      paused = true;
      callEntered();
      await release;
    }
    return original(...args);
  });
  return { entered, release: releaseCall };
}

/**
 * Ways the approved join request stops holding while nothing in the context
 * graph's own metadata changes: the member asks again (the approved generation
 * is replaced by a pending one), on a store with and without SPARQL UPDATE, or
 * the requester state is cleared.
 */
const REQUESTER_STATE_CHANGES = [
  'replaced',
  'replaced on a store without update support',
  'cleared',
] as const;

async function changeApprovedJoinRequest(
  fixture: Awaited<ReturnType<typeof approvedBareNameReplicaFixture>>,
  change: (typeof REQUESTER_STATE_CHANGES)[number],
) {
  if (change === 'cleared') {
    await fixture.receiver.clearRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
    );
    return;
  }
  const store = fixture.receiver.store as { update?: unknown };
  const update = store.update;
  if (change === 'replaced on a store without update support') store.update = undefined;
  try {
    await fixture.receiver.writeRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
      {
        status: 'pending',
        requestGeneration: `0x${'34'.repeat(32)}`,
        curatorPeerId: CURATOR_PEER,
      },
    );
  } finally {
    store.update = update;
  }
}

describe('approved private replica delegation deadline', () => {
  const authority = {
    approvedAgentAddress: `0x${'11'.repeat(20)}`,
    ownerAddress: `0x${'22'.repeat(20)}`,
    requestGeneration: `0x${'12'.repeat(32)}`,
    curatorPeerId: 'curator-peer',
    memberAddresses: [`0x${'11'.repeat(20)}`],
  };

  it.each([
    { deadline: 'before now', delegationExpiresAtMs: 999, active: false },
    { deadline: 'exactly now', delegationExpiresAtMs: 1_000, active: false },
    { deadline: 'after now', delegationExpiresAtMs: 1_001, active: true },
    { deadline: 'none (unbounded delegation)', delegationExpiresAtMs: null, active: true },
  ])('is active only before its deadline (deadline: $deadline)', ({ delegationExpiresAtMs, active }) => {
    expect(isApprovedPrivateReplicaDelegationActive({ ...authority, delegationExpiresAtMs }, 1_000))
      .toBe(active);
  });

  it('does not extend an authority that records no deadline', () => {
    expect(isApprovedPrivateReplicaDelegationActive(authority, 1_000)).toBe(false);
  });
});

describe('approved private bare-name replica authorization', () => {
  it('retains the proved private authority for a legacy adapter registered-metadata shape', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      legacyAdapter: true,
      installSubscription: false,
      registeredMetaOnChainIds: ['106'],
    });

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-private',
      reason: 'rfc64-participant',
    });
    // The compatibility read fallback is allowed even though authenticated
    // metadata says registered. It is NOT evidence that VM is inapplicable.
    const bootstrap = await fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { callerAgentAddress: fixture.memberAddress, allowSubscriptionFallback: false },
    );
    expect(bootstrap).toMatchObject({ outcome: 'allowed', source: 'rfc64-private' });
    expect(bootstrap).not.toHaveProperty('registration');
  });

  it('does not downgrade registered metadata before a finalized-capable adapter checks its name index', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      registrationStatus: 'registered',
      registeredMetaOnChainIds: ['106'],
    });
    Reflect.get(fixture.receiver, 'subscribedContextGraphs').set(CONTEXT_GRAPH_ID, {
      subscribed: false,
      coreHosted: false,
      pendingMeta: true,
      metaSynced: true,
      synced: false,
      syncMode: 'always-on',
    });

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fixture.finalized).toHaveBeenCalled();
    expect(fixture.current).not.toHaveBeenCalled();
  });

  it('rejects ambiguous registered-metadata ids instead of taking the legacy compatibility lane', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      legacyAdapter: true,
      installSubscription: false,
      registeredMetaOnChainIds: ['106', '107'],
    });

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
  });

  it('catches up an existing private catalog head on a cold connected requester after real join approval', async () => {
    const config = {
      ...TEST_SNAPSHOT_CONFIG,
      // Local seal-domain reads are deterministic; registry reads remain the
      // genuine NoChainAdapter finalized-absence path and no mint is invoked.
      chainAdapter: Object.assign(new NoChainAdapter(), {
        chainId: 'otp:20430',
        getEvmChainId: async () => BigInt(RFC64_ROLLOUT_DEPLOYMENT.assertedAtChainId),
        getKnowledgeAssetsLifecycleAddress: async () => RFC64_ROLLOUT_DEPLOYMENT.assertedAtKav10Address,
      }),
      kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogDeploymentProfile: RFC64_ROLLOUT_DEPLOYMENT,
    };
    const curator = await h.startAgent({ name: 'catalog-join-curator', config });
    const member = await h.startAgent({ name: 'catalog-join-requester', config: {
      ...config, chainAdapter: new NoChainAdapter(), kaNumberAllocator: makeTestKaNumberAllocator(),
    } });
    for (const agent of [curator, member]) {
      const admission = Reflect.get(agent, 'networkAdmissionCoordinator');
      admission.isAcceptedPeer = () => true;
      admission.isRejectedPeer = () => false;
      admission.ensureAdmitted = async () => true;
    }
    const address = curator.multiaddrs.find((value) => value.includes('/tcp/'));
    if (address === undefined) throw new Error('curator has no TCP address');
    await member.node.libp2p.dial(multiaddr(address));
    const existingConnection = member.node.libp2p.getConnections().find(
      (connection) => connection.remotePeer.toString() === curator.peerId,
    );
    expect(existingConnection).toBeDefined();
    const owner = await curator.registerAgent('catalog curator');
    const requester = await member.registerAgent('cold requester');
    Reflect.set(curator, 'defaultAgentAddress', owner.agentAddress);
    await curator.markDefaultAgent(owner.agentAddress);
    Reflect.set(member, 'defaultAgentAddress', requester.agentAddress);
    await member.markDefaultAgent(requester.agentAddress);
    await curator.store.insert([{
      subject: `did:dkg:agent:${owner.agentAddress}`, predicate: D.DKG_PEER_ID,
      object: JSON.stringify(curator.peerId), graph: AGENT_PROFILE_GRAPH,
    }]);
    const contextGraphId = 'private-catalog-before-approval';
    await curator.createContextGraph({
      id: contextGraphId, name: 'Private catalog before approval', accessPolicy: 1,
      callerAgentAddress: owner.agentAddress,
    });
    // Provider recovery deliberately stays live while this connected requester
    // has no join approval. Wait for the local authority needed by promotion,
    // rather than draining that recovery demand before the test can approve it.
    await vi.waitFor(() => {
      expect(curator.readRfc64CatalogResponsibilityV1(contextGraphId)).toMatchObject({
        active: true, mode: 'catalog',
      });
      expect(curator.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId))
        .not.toBeNull();
    }, { timeout: 20_000, interval: 100 });
    await curator.assertion.create(contextGraphId, 'preexisting-private-row', { agentAddress: owner.agentAddress });
    await curator.assertion.write(contextGraphId, 'preexisting-private-row', [{
      subject: 'urn:test:private-catalog-row', predicate: 'https://schema.org/name',
      object: '"private catalog catch-up payload"',
    }], { agentAddress: owner.agentAddress });
    await curator.assertion.promote(contextGraphId, 'preexisting-private-row', { agentAddress: owner.agentAddress, authorAgentAddress: owner.agentAddress });
    await curator.awaitInFlightRfc64SwmInventoryObserversV1();
    await curator.whenRfc64CatalogSupervisorsIdleV1();
    expect((await curator.readRfc64CatalogOperationalStatusV1()).find(
      (row) => row.contextGraphId === contextGraphId,
    )?.appliedRowCount).toBe('1');
    expect(member.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId)).toBeNull();
    const delegation = await member.signJoinRequest(contextGraphId, requester.agentAddress);
    expect((await member.forwardJoinRequest(
      contextGraphId, delegation, 'cold catalog requester', curator.peerId,
    )).delivered).toBeGreaterThanOrEqual(1);
    await vi.waitFor(async () => {
      expect((await curator.listPendingJoinRequests(contextGraphId, owner.agentAddress)).some(
        ({ agentAddress }) => agentAddress.toLowerCase() === requester.agentAddress.toLowerCase(),
      )).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    await curator.approveJoinRequest(contextGraphId, requester.agentAddress, owner.agentAddress);
    await vi.waitFor(async () => {
      expect((await member.readRfc64CatalogOperationalStatusV1()).find(
        (row) => row.contextGraphId === contextGraphId,
      )?.appliedRowCount).toBe('1');
      const result = await member.query('SELECT ?name WHERE { <urn:test:private-catalog-row> <https://schema.org/name> ?name }', {
        contextGraphId, view: 'shared-working-memory', callerAgentAddress: requester.agentAddress,
      });
      expect(JSON.stringify(result)).toContain('private catalog catch-up payload');
    }, { timeout: 30_000, interval: 100 });
    expect(member.node.libp2p.getConnections().some(
      (connection) => connection.id === existingConnection!.id,
    )).toBe(true);
  }, 90_000);

  it('keeps a completed NoChainAdapter private join live for sender-key setup and encrypted SWM', async () => {
    const curator = await h.startAgent({
      name: 'legacy-private-join-curator',
      config: { ...TEST_SNAPSHOT_CONFIG, chainAdapter: new NoChainAdapter() },
    });
    const member = await h.startAgent({
      name: 'legacy-private-join-member',
      config: { ...TEST_SNAPSHOT_CONFIG, chainAdapter: new NoChainAdapter() },
    });
    for (const agent of [curator, member]) {
      const admission = Reflect.get(agent, 'networkAdmissionCoordinator');
      admission.isAcceptedPeer = () => true;
      admission.isRejectedPeer = () => false;
      admission.ensureAdmitted = async () => true;
    }
    const curatorAddress = curator.multiaddrs.find((address) => address.includes('/tcp/'));
    if (curatorAddress === undefined) throw new Error('curator has no TCP multiaddr');
    await member.node.libp2p.dial(multiaddr(curatorAddress));

    const curatorAgent = await curator.registerAgent('legacy private curator');
    const memberAgent = await member.registerAgent('legacy private member');
    await curator.store.insert([{
      subject: `did:dkg:agent:${curatorAgent.agentAddress}`,
      predicate: D.DKG_PEER_ID,
      object: JSON.stringify(curator.peerId),
      graph: AGENT_PROFILE_GRAPH,
    }]);
    const contextGraphId = 'legacy-private-join';
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Legacy private join',
      accessPolicy: 1,
      allowedPeers: [member.peerId],
      callerAgentAddress: curatorAgent.agentAddress,
    });

    const delegation = await member.signJoinRequest(contextGraphId, memberAgent.agentAddress);
    const forwarded = await member.forwardJoinRequest(
      contextGraphId,
      delegation,
      'legacy-private-member',
      curator.peerId,
    );
    expect(forwarded.delivered).toBeGreaterThanOrEqual(1);
    await vi.waitFor(async () => {
      const pending = await curator.listPendingJoinRequests(
        contextGraphId,
        curatorAgent.agentAddress,
      );
      expect(pending.some(({ agentAddress }) => (
        agentAddress.toLowerCase() === memberAgent.agentAddress.toLowerCase()
      ))).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    await curator.approveJoinRequest(
      contextGraphId,
      memberAgent.agentAddress,
      curatorAgent.agentAddress,
    );
    await vi.waitFor(async () => {
      await expect(member.getJoinRequestStatus(contextGraphId, memberAgent.agentAddress))
        .resolves.toBe('approved');
      const allowedAgents = (await member.getContextGraphAllowedAgents(contextGraphId))
        .map((address) => address.toLowerCase());
      expect(allowedAgents).toEqual(expect.arrayContaining([
        curatorAgent.agentAddress.toLowerCase(),
        memberAgent.agentAddress.toLowerCase(),
      ]));
    }, { timeout: 30_000, interval: 100 });

    const transportAuthority = await member.resolveSwmTransportAuthority(
      contextGraphId,
      { authorityReadMode: 'finalized-index-or-live' },
    );
    if (transportAuthority.kind === 'private-roster') {
      // The real post-approval replay may already have delivered the owner's
      // authenticated policy. That independent source legitimately upgrades
      // the live join proof; a join-derived snapshot alone must never do so.
      expect(member.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId, 'reads')?.provenance)
        .toBe('authenticated');
      expect(transportAuthority.participantAgents).toEqual(expect.arrayContaining([
        curatorAgent.agentAddress.toLowerCase(), memberAgent.agentAddress.toLowerCase(),
      ]));
    } else {
      expect(transportAuthority).toEqual({
        kind: 'approved-private-replica',
        allowedPeers: expect.arrayContaining([curator.peerId, member.peerId]),
      });
    }

    const sendReliable = vi.spyOn(
      Reflect.get(curator, 'messenger'),
      'sendReliable',
    );
    const decryptWorkspacePayloadWithSenderKey = vi.spyOn(
      member,
      'decryptWorkspacePayloadWithSenderKey',
    );
    const secret = 'legacy adapter private payload';
    const subject = 'urn:test:legacy-private-join';
    const shareOperationId = 'legacy-private-encrypted-swm';
    const kaUal = `did:dkg:20430/${curatorAgent.agentAddress.toLowerCase()}/1`;
    if (curatorAgent.privateKey === undefined) {
      throw new Error('curator must have a local signing key');
    }
    const timestampMs = Date.now();
    const plaintext = encodeWorkspacePublishRequest({
      contextGraphId,
      nquads: new TextEncoder().encode(
        `<${subject}> <http://schema.org/name> ${JSON.stringify(secret)} <${contextGraphDataGraphUri(contextGraphId)}> .`,
      ),
      manifest: [],
      publisherPeerId: curator.peerId,
      shareOperationId,
      timestampMs,
      subGraphName: 'updates',
      agentAddress: curatorAgent.agentAddress,
      kaNumber: '1',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      accessPolicy: 'public',
      allowedPeers: [],
    });
    const resolution = await curator.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId,
    });
    if (!resolution.requiresEncryption) {
      throw new Error('approved private graph must require encrypted SWM');
    }
    const encryptedPayload = await curator.encryptWorkspacePayloadWithSenderKey({
      contextGraphId,
      subGraphName: 'updates',
      plaintext,
      senderAgentAddress: curatorAgent.agentAddress,
      operationId: shareOperationId,
      shareOperationId,
      timestampMs,
      publisherPeerId: curator.peerId,
      resolution,
    });
    await curator.publishWorkspaceGossip(
      contextGraphId,
      encryptedPayload,
      createOperationContext('share'),
      { ...curatorAgent, privateKey: curatorAgent.privateKey },
      shareOperationId,
    );
    await curator.awaitInFlightSubstrateFanOuts();

    const senderKeyCallIndex = sendReliable.mock.calls.findIndex(([peerId, protocol]) => (
      peerId === member.peerId && protocol === PROTOCOL_SWM_SENDER_KEY
    ));
    expect(senderKeyCallIndex).toBeGreaterThanOrEqual(0);
    const senderKeyResult = await sendReliable.mock.results[senderKeyCallIndex]!.value;
    expect(senderKeyResult.delivered).toBe(true);
    if (!senderKeyResult.delivered) throw new Error('sender-key setup was not delivered');
    expect(decodeSwmSenderKeyPackageAck(senderKeyResult.response)).toMatchObject({
      accepted: true,
    });

    const updateCallIndex = sendReliable.mock.calls.findIndex(([peerId, protocol]) => (
      peerId === member.peerId && protocol === PROTOCOL_SWM_UPDATE
    ));
    expect(updateCallIndex).toBeGreaterThanOrEqual(0);
    const updateCall = sendReliable.mock.calls[updateCallIndex]!;
    const envelope = decodeGossipEnvelope(updateCall[2] as Uint8Array);
    const encrypted = decodeSwmSenderKeyMessage(envelope.payload);
    expect(encrypted).toMatchObject({
      type: SWM_SENDER_KEY_MESSAGE_TYPE,
      contextGraphId,
      senderAgentAddress: curatorAgent.agentAddress,
    });
    expect(Buffer.from(envelope.payload).toString('utf8')).not.toContain(secret);

    expect(decryptWorkspacePayloadWithSenderKey).toHaveBeenCalledOnce();
    const decrypted = await decryptWorkspacePayloadWithSenderKey.mock.results[0]!.value;
    const request = decodeWorkspacePublishRequest(decrypted);
    expect(new TextDecoder().decode(request.nquads)).toContain(secret);
    const updateResult = await sendReliable.mock.results[updateCallIndex]!.value;
    expect(updateResult).toMatchObject({
      delivered: true,
      response: new Uint8Array(),
    });
  }, 90_000);

  it('admits eu-open-calls after approval without the wallet-namespaced seed path', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      // Participant approval must not promote the full RDF roster into a
      // generic owner policy. Only the curator and this approved local member
      // belong to the transaction-scoped replica authority.
      additionalAllowedAgents: [OUTSIDER],
      delegationExpiresAt: Date.now() + 3_600_000,
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
    )).resolves.toMatchObject({ ...expectedAuthority, registration: 'unregistered' });

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
      registration: 'unregistered',
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

  it.each([
    ['includes', 'receiver-only', true],
    ['excludes', 'curator-only', false],
  ] as const)(
    '%s this receiver according to the graph peer allowlist',
    async (_label, peerAllowlist, expected) => {
      const fixture = await approvedBareNameReplicaFixture({ peerAllowlist });

      await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      })).resolves.toBe(expected);
      await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: fixture.memberAddress,
      })).resolves.toBe(expected);
    },
  );

  it('fails closed when the source-qualified graph peer metadata cannot be read', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    vi.spyOn(fixture.receiver, 'getOwnCgMetaFacts')
      .mockRejectedValue(new Error('peer allowlist unavailable'));

    await expect(fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
    })).resolves.toBe(false);
    await expect(fixture.receiver.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: CONTEXT_GRAPH_ID,
    })).rejects.toThrow(/authority is unavailable/u);
  });

  it('keeps approved-replica SWM encrypted to the full private metadata roster', async () => {
    const curator = new ethers.Wallet(`0x${'31'.repeat(32)}`);
    const thirdAllowed = new ethers.Wallet(`0x${'32'.repeat(32)}`);
    const curatorAddress = curator.address.toLowerCase();
    const thirdAllowedAddress = thirdAllowed.address.toLowerCase();
    const fixture = await approvedBareNameReplicaFixture({
      requesterOwner: curatorAddress,
      curators: [curatorAddress],
      additionalAllowedAgents: [thirdAllowedAddress],
    });
    if (fixture.member.privateKey === undefined) {
      throw new Error('approved fixture member must be custodial');
    }
    const memberWallet = new ethers.Wallet(fixture.member.privateKey);
    await fixture.receiver.store.insert([
      ...signedWorkspaceProfileKeyQuads(curator, CURATOR_PEER, 'curator-x25519'),
      ...signedWorkspaceProfileKeyQuads(
        memberWallet,
        fixture.receiver.peerId,
        'approved-member-x25519',
      ),
      ...signedWorkspaceProfileKeyQuads(
        thirdAllowed,
        THIRD_ALLOWED_PEER,
        'third-member-x25519',
      ),
    ]);

    const resolveTransport = () => fixture.receiver.resolveSwmTransportAuthority(
      CONTEXT_GRAPH_ID,
      { authorityReadMode: 'finalized-index-or-live' },
    );
    const resolveRecipients = () => fixture.receiver
      .resolveWorkspaceAgentRecipientsForCurrentAuthority({ contextGraphId: CONTEXT_GRAPH_ID });

    await expect(resolveTransport()).resolves.toEqual({
      kind: 'approved-private-replica',
      allowedPeers: [],
    });
    await expect(fixture.receiver.isContextGraphSwmPublic(CONTEXT_GRAPH_ID))
      .resolves.toBe(false);
    const resolution = await resolveRecipients();
    expect(resolution.requiresEncryption).toBe(true);
    if (!resolution.requiresEncryption) throw new Error('private SWM unexpectedly resolved plaintext');
    const recipientAddresses = new Set(
      resolution.recipients.map(({ agentAddress }) => agentAddress.toLowerCase()),
    );
    expect(recipientAddresses).toEqual(new Set([
      curatorAddress,
      fixture.memberAddress,
      thirdAllowedAddress,
    ]));
    expect(recipientAddresses.size).toBeGreaterThan(1);

    const requestGeneration = `0x${'12'.repeat(32)}`;
    await fixture.receiver.writeRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
      {
        status: 'rejected',
        requestGeneration,
        curatorPeerId: CURATOR_PEER,
        curatorAgentAddress: curatorAddress,
        curatorAuthorityEra: '0',
      },
    );
    await expect(resolveTransport()).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(resolveRecipients()).rejects.toThrow(/authority is unavailable/u);

    await fixture.receiver.writeRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
      {
        status: 'approved',
        requestGeneration,
        curatorPeerId: CURATOR_PEER,
        curatorAgentAddress: curatorAddress,
        curatorAuthorityEra: '0',
      },
    );
    await expect(resolveTransport()).resolves.toEqual({
      kind: 'approved-private-replica',
      allowedPeers: [],
    });

    await fixture.receiver.store.insert([{
      graph: fixture.graph,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(fixture.memberAddress),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    await expect(resolveTransport()).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(resolveRecipients()).rejects.toThrow(/authority is unavailable/u);
  });

  it('keeps every approved-replica roster agent on the explicit receiver peer allowlist', async () => {
    const curator = new ethers.Wallet(`0x${'33'.repeat(32)}`);
    const thirdAllowed = new ethers.Wallet(`0x${'34'.repeat(32)}`);
    const curatorAddress = curator.address.toLowerCase();
    const thirdAllowedAddress = thirdAllowed.address.toLowerCase();
    const fixture = await approvedBareNameReplicaFixture({
      requesterOwner: curatorAddress,
      curators: [curatorAddress],
      additionalAllowedAgents: [thirdAllowedAddress],
      peerAllowlist: 'receiver-only',
    });
    if (fixture.member.privateKey === undefined) {
      throw new Error('approved fixture member must be custodial');
    }
    const memberWallet = new ethers.Wallet(fixture.member.privateKey);
    const allowedPeer = fixture.receiver.peerId;
    const thirdAllowedPeerQuads = signedWorkspaceProfileKeyQuads(
      thirdAllowed,
      allowedPeer,
      'third-allowed-peer-x25519',
      `${AGENT_PROFILE_GRAPH}/third-allowed-peer`,
    );
    await fixture.receiver.store.insert([
      ...signedWorkspaceProfileKeyQuads(
        curator,
        allowedPeer,
        'curator-allowed-peer-x25519',
        `${AGENT_PROFILE_GRAPH}/curator-allowed-peer`,
      ),
      ...signedWorkspaceProfileKeyQuads(
        curator,
        CURATOR_PEER,
        'curator-excluded-peer-x25519',
        `${AGENT_PROFILE_GRAPH}/curator-excluded-peer`,
      ),
      ...signedWorkspaceProfileKeyQuads(
        memberWallet,
        allowedPeer,
        'member-allowed-peer-x25519',
        `${AGENT_PROFILE_GRAPH}/member-allowed-peer`,
      ),
      ...signedWorkspaceProfileKeyQuads(
        memberWallet,
        THIRD_ALLOWED_PEER,
        'member-excluded-peer-x25519',
        `${AGENT_PROFILE_GRAPH}/member-excluded-peer`,
      ),
      ...thirdAllowedPeerQuads,
      ...signedWorkspaceProfileKeyQuads(
        thirdAllowed,
        THIRD_ALLOWED_PEER,
        'third-excluded-peer-x25519',
        `${AGENT_PROFILE_GRAPH}/third-excluded-peer`,
      ),
    ]);

    await expect(fixture.receiver.resolveSwmTransportAuthority(
      CONTEXT_GRAPH_ID,
      { authorityReadMode: 'finalized-index-or-live' },
    )).resolves.toEqual({
      kind: 'approved-private-replica',
      allowedPeers: [allowedPeer],
    });
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
    })).resolves.toBe(true);

    const resolution = await fixture.receiver
      .resolveWorkspaceAgentRecipientsForCurrentAuthority({ contextGraphId: CONTEXT_GRAPH_ID });
    expect(resolution.requiresEncryption).toBe(true);
    if (!resolution.requiresEncryption) throw new Error('private SWM unexpectedly resolved plaintext');
    expect(new Set(resolution.recipients.map(({ agentAddress }) => agentAddress.toLowerCase())))
      .toEqual(new Set([curatorAddress, fixture.memberAddress, thirdAllowedAddress]));
    expect(new Set(resolution.recipients.map(({ peerId }) => peerId)))
      .toEqual(new Set([allowedPeer]));
    expect(resolution.recipients.some(({ peerId }) => (
      peerId === CURATOR_PEER || peerId === THIRD_ALLOWED_PEER
    ))).toBe(false);

    // Removing the only allowlisted key for one effective roster member must
    // close the whole share; silently dropping that agent would create an
    // unreadable private write for an otherwise authorized member.
    await fixture.receiver.store.delete(thirdAllowedPeerQuads);
    await expect(fixture.receiver
      .resolveWorkspaceAgentRecipientsForCurrentAuthority({ contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/effective DKG agent .* has no recipient key advertised by a peer/u);
  });

  it('rejects approved-private recipient keys when another member is revoked during lookup', async () => {
    const curator = new ethers.Wallet(`0x${'37'.repeat(32)}`);
    const revokedMember = new ethers.Wallet(`0x${'38'.repeat(32)}`);
    const curatorAddress = curator.address.toLowerCase();
    const revokedMemberAddress = revokedMember.address.toLowerCase();
    const fixture = await approvedBareNameReplicaFixture({
      requesterOwner: curatorAddress,
      curators: [curatorAddress],
      additionalAllowedAgents: [revokedMemberAddress],
    });
    if (fixture.member.privateKey === undefined) {
      throw new Error('approved fixture member must be custodial');
    }
    const memberWallet = new ethers.Wallet(fixture.member.privateKey);
    await fixture.receiver.store.insert([
      ...signedWorkspaceProfileKeyQuads(curator, CURATOR_PEER, 'race-curator-x25519'),
      ...signedWorkspaceProfileKeyQuads(
        memberWallet,
        fixture.receiver.peerId,
        'race-approved-member-x25519',
      ),
      ...signedWorkspaceProfileKeyQuads(
        revokedMember,
        THIRD_ALLOWED_PEER,
        'race-revoked-member-x25519',
      ),
    ]);

    const query = fixture.receiver.store.query.bind(fixture.receiver.store);
    let releaseKeyLookup!: () => void;
    let keyLookupEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseKeyLookup = resolve; });
    const entered = new Promise<void>((resolve) => { keyLookupEntered = resolve; });
    let paused = false;
    vi.spyOn(fixture.receiver.store, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (
        !paused
        && typeof args[0] === 'string'
        && args[0].includes('SELECT DISTINCT ?key WHERE')
        && args[0].toLowerCase().includes(revokedMemberAddress)
      ) {
        paused = true;
        keyLookupEntered();
        await release;
      }
      return result;
    });

    const resolution = fixture.receiver.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    await entered;
    await fixture.receiver.store.insert([{
      graph: fixture.graph,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(revokedMemberAddress),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    releaseKeyLookup();

    await expect(resolution).rejects.toMatchObject({
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('returns an approved-private SWM gate when its metadata revision stays stable', async () => {
    const additionalMember = new ethers.Wallet(`0x${'35'.repeat(32)}`);
    const fixture = await approvedBareNameReplicaFixture({
      additionalAllowedAgents: [additionalMember.address],
      peerAllowlist: 'receiver-only',
    });
    const handler = fixture.receiver.getOrCreateSharedMemoryHandler();
    const oracle = Reflect.get(handler, 'contextGraphMetaOracle') as undefined | ((
      contextGraphId: string,
    ) => Promise<{
      allowedAgents?: readonly string[];
      revokedAgents?: readonly string[];
      allowedPeers?: readonly string[];
    } | null>);
    if (oracle === undefined) throw new Error('shared-memory metadata oracle is not configured');

    const projected = await oracle(CONTEXT_GRAPH_ID);

    expect(projected?.allowedAgents?.map((address) => address.toLowerCase()))
      .toContain(additionalMember.address.toLowerCase());
    expect(projected?.revokedAgents?.map((address) => address.toLowerCase()))
      .not.toContain(additionalMember.address.toLowerCase());
    expect(projected?.allowedPeers).toEqual([fixture.receiver.peerId]);
  });

  it('retries the approved-private SWM metadata snapshot when another member is revoked', async () => {
    const revokedMember = new ethers.Wallet(`0x${'36'.repeat(32)}`);
    const fixture = await approvedBareNameReplicaFixture({
      additionalAllowedAgents: [revokedMember.address],
      peerAllowlist: 'receiver-only',
    });
    const handler = fixture.receiver.getOrCreateSharedMemoryHandler();
    const oracle = Reflect.get(handler, 'contextGraphMetaOracle') as undefined | ((
      contextGraphId: string,
    ) => Promise<{
      allowedAgents?: readonly string[];
      revokedAgents?: readonly string[];
      allowedPeers?: readonly string[];
    } | null>);
    if (oracle === undefined) throw new Error('shared-memory metadata oracle is not configured');

    const originalOverride = fixture.receiver
      .resolveApprovedPrivateReplicaSwmAllowedPeersOverride.bind(fixture.receiver);
    let releaseFirstOverride!: () => void;
    let firstOverrideEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirstOverride = resolve; });
    const entered = new Promise<void>((resolve) => { firstOverrideEntered = resolve; });
    let calls = 0;
    vi.spyOn(fixture.receiver, 'resolveApprovedPrivateReplicaSwmAllowedPeersOverride')
      .mockImplementation(async (contextGraphId) => {
        calls += 1;
        if (calls === 1) {
          firstOverrideEntered();
          await release;
        }
        return originalOverride(contextGraphId);
      });

    const projectedPromise = oracle(CONTEXT_GRAPH_ID);
    await entered;
    await fixture.receiver.store.insert([{
      graph: fixture.graph,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(revokedMember.address),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    releaseFirstOverride();

    const projected = await projectedPromise;
    expect(calls).toBe(2);
    expect(projected?.allowedAgents?.map((address) => address.toLowerCase()))
      .toContain(revokedMember.address.toLowerCase());
    expect(projected?.revokedAgents?.map((address) => address.toLowerCase()))
      .toContain(revokedMember.address.toLowerCase());
    expect(projected?.allowedPeers).toEqual([fixture.receiver.peerId]);
  });

  it('does not let secondary peer metadata widen approved-replica sender-key or host ingest authority', async () => {
    const curator = new ethers.Wallet(`0x${'35'.repeat(32)}`);
    const curatorAddress = curator.address.toLowerCase();
    const fixture = await approvedBareNameReplicaFixture({
      requesterOwner: curatorAddress,
      curators: [curatorAddress],
      peerAllowlist: 'receiver-only',
    });
    await fixture.receiver.store.insert([{
      graph: SECONDARY_META_GRAPH,
      subject: fixture.subject,
      predicate: D.DKG_ALLOWED_PEER,
      object: JSON.stringify(CURATOR_PEER),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);

    await expect(fixture.receiver.resolveApprovedPrivateReplicaSwmAllowedPeersOverride(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([fixture.receiver.peerId]);
    await expect(fixture.receiver.resolveSwmAllowedPeersForCurrentAuthority(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([fixture.receiver.peerId]);
    // The compatibility projection is intentionally broad and demonstrates
    // the exact widening input. SWM authority must ignore the secondary row
    // while this graph is governed by the approved-private replica proof.
    await expect(fixture.receiver.getContextGraphAllowedPeers(CONTEXT_GRAPH_ID))
      .resolves.toEqual(expect.arrayContaining([fixture.receiver.peerId, CURATOR_PEER]));

    const recipientKeyId = fixture.member.workspaceEncryptionKeys[0]?.encryptionKeyId;
    if (recipientKeyId === undefined) {
      throw new Error('approved fixture member must have an active recipient key');
    }
    const senderKeyAck = decodeSwmSenderKeyPackageAck(
      await fixture.receiver.handleSwmSenderKeyPackage(
        encodeSwmSenderKeyPackage(await signedSenderKeyPackage(
          curator,
          fixture.member.agentAddress,
          recipientKeyId,
        )),
        CURATOR_PEER,
      ),
    );
    expect(senderKeyAck).toMatchObject({
      accepted: false,
      reasonCode: 'sender-not-allowed',
    });
    expect(senderKeyAck.reason).toContain(`Sender peer ${CURATOR_PEER} is not allowed`);

    const handler = fixture.receiver.getOrCreateSharedMemoryHandler();
    const hostVerdict = await handler.verifyHostModeEnvelopeAuthority(
      await signedWorkspaceEnvelope(curator, CURATOR_PEER),
      CONTEXT_GRAPH_ID,
      CURATOR_PEER,
    );
    expect(hostVerdict).toMatchObject({
      accepted: false,
      reasonCode: 'PEER_NOT_IN_ALLOWLIST',
    });
  });

  it('preserves the merged legacy peer gate when no local approval marker exists', async () => {
    const fixture = await approvedBareNameReplicaFixture({
      localApproval: false,
      peerAllowlist: 'receiver-only',
    });
    await fixture.receiver.store.insert([{
      graph: SECONDARY_META_GRAPH,
      subject: fixture.subject,
      predicate: D.DKG_ALLOWED_PEER,
      object: JSON.stringify(CURATOR_PEER),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    const legacyPeers = await fixture.receiver.getContextGraphAllowedPeers(CONTEXT_GRAPH_ID);
    const transport = vi.spyOn(fixture.receiver, 'resolveSwmTransportAuthority');

    await expect(fixture.receiver.resolveApprovedPrivateReplicaSwmAllowedPeersOverride(
      CONTEXT_GRAPH_ID,
    )).resolves.toBeUndefined();
    await expect(fixture.receiver.resolveSwmAllowedPeersForCurrentAuthority(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual(legacyPeers);
    expect(legacyPeers).toEqual(expect.arrayContaining([fixture.receiver.peerId, CURATOR_PEER]));
    expect(transport).not.toHaveBeenCalled();
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
      vi.spyOn(fixture.receiver, 'hasAcceptedRfc64UnregisteredReadAuthorityV1')
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
    ['future delegation', () => ({ delegationIssuedAt: Date.now() + 60_000 })],
    ['expired delegation', () => ({ delegationExpiresAt: Date.now() - 1_000 })],
    ['wrong delegatee peer', { delegationPeer: CURATOR_PEER }],
  ] satisfies ReadonlyArray<readonly [string, ApprovedReplicaFixtureOptions | (() => ApprovedReplicaFixtureOptions)]>) (
    'fails closed for %s',
    async (_label, options) => {
      // Relative deadlines are created when this case starts, after earlier
      // integration scenarios have completed.
      const fixture = await approvedBareNameReplicaFixture(
        typeof options === 'function' ? options() : options,
      );
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

  it('rejects a delegation that expires while its private proof read is in flight', async () => {
    const proofStartedAt = 2_000_000_000_000;
    const delegationExpiresAt = proofStartedAt + 1;
    const fixture = await approvedBareNameReplicaFixture({
      delegationIssuedAt: proofStartedAt - 1_000,
      delegationExpiresAt,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(proofStartedAt);
    const proof = pauseApprovedPrivateProofOnce(fixture);
    const admission = fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    );
    await proof.entered;
    now.mockReturnValue(delegationExpiresAt);
    proof.release();

    await expect(admission).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
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

  it.each(REQUESTER_STATE_CHANGES.flatMap((change) => [
    { change, read: 'getContextGraphOwner' },
    { change, read: 'getStoredContextGraphRegistrationOptions' },
    { change, read: 'readRfc64PrivateRosterVersionV1' },
  ]))('accepts no catalog authority when the join request is $change during $read', async ({ change, read }) => {
    const fixture = await approvedBareNameReplicaFixture();
    const proofReturned = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const paused = pauseReceiverMethodOnce(fixture, read);
    const reconciliation = fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    // The composition has its proof before any of these reads starts.
    await proofReturned.returned;
    proofReturned.release();
    await paused.entered;
    await changeApprovedJoinRequest(fixture, change);
    paused.release();

    await expect(reconciliation).rejects.toThrow('no authenticated owner authority');
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

  it.each([
    // The roster read that follows the owner read refuses an expired
    // delegation itself; after the last read only the acceptance pass can.
    { read: 'getContextGraphOwner', message: 'no authenticated lifecycle roster' },
    { read: 'readRfc64PrivateRosterVersionV1', message: 'delegation expired' },
  ])('accepts no catalog authority when the delegation expires during $read', async ({ read, message }) => {
    const startedAt = 2_000_000_000_000;
    const delegationExpiresAt = startedAt + 60_000;
    const fixture = await approvedBareNameReplicaFixture({
      delegationIssuedAt: startedAt - 1_000,
      delegationExpiresAt,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const proofReturned = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const paused = pauseReceiverMethodOnce(fixture, read);
    const reconciliation = fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await proofReturned.returned;
    proofReturned.release();
    await paused.entered;
    now.mockReturnValue(delegationExpiresAt);
    paused.release();

    await expect(reconciliation).rejects.toThrow(message);
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

  it.each([
    {
      mismatch: 'the lifecycle owner is not the proved curator',
      message: 'does not match lifecycle metadata',
    },
    {
      mismatch: 'the confirmation of the private definition cannot be read',
      message: 'no authenticated lifecycle roster',
    },
    {
      mismatch: 'the roster does not contain the approved member',
      message: 'absent from the authenticated roster',
    },
  ] as const)('accepts no catalog authority when $mismatch', async ({ mismatch, message }) => {
    const fixture = await approvedBareNameReplicaFixture();
    const receiver = fixture.receiver as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    if (mismatch === 'the lifecycle owner is not the proved curator') {
      vi.spyOn(receiver, 'getContextGraphOwner')
        .mockResolvedValue(`did:dkg:agent:0x${'ab'.repeat(20)}`);
    } else if (mismatch === 'the confirmation of the private definition cannot be read') {
      vi.spyOn(receiver, 'hasConfirmedMetaState').mockRejectedValue(new Error('store read failed'));
    } else {
      vi.spyOn(receiver, 'getLocalMetadataMemberRecoveryGate').mockResolvedValue([OWNER]);
    }

    await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).rejects.toThrow(message);
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

  it.each(REQUESTER_STATE_CHANGES)(
    'accepts no catalog authority when the join request is %s as its successful proof returns',
    async (change) => {
      const fixture = await approvedBareNameReplicaFixture();
      // The proof has passed its own final checks; the composition that
      // awaits it has not resumed yet. A revision captured after this point
      // would already contain the change and could not see it any more.
      afterApprovedPrivateProof.run = () => changeApprovedJoinRequest(fixture, change);
      try {
        await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
          CONTEXT_GRAPH_ID,
          undefined,
          { kind: 'finalized-absence' },
        )).rejects.toThrow('no authenticated owner authority');
      } finally {
        afterApprovedPrivateProof.run = null;
      }
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
        .toBeNull();
    },
  );

  it('retains an approved private proof when only another graph changes', async () => {
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
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty('unrelated-graph');
    proof.release();

    await expect(admission).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-private',
      registration: 'unregistered',
    });
  });

  it('accepts catalog authority for a finalized-absent, join-approved private replica', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({
      source: 'owner-signed-unregistered',
      policy: { accessPolicy: 1 },
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBe('private');
  });

  it('asks for the catalog as a replica whose providers may not be authorized yet', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const schedule = vi.spyOn(
      fixture.receiver as unknown as Record<string, (...args: unknown[]) => void>,
      'scheduleRfc64AuthorityAcceptedCatalogRecoveryV1',
    ).mockImplementation(() => undefined);

    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );

    // Only a join-derived acceptance keeps the zero-provider demand alive.
    expect(schedule).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      { awaitsProviderAuthorization: true },
    );
  });

  it('refuses unsigned ontology-only public authority through the default auto discovery path', async () => {
    const fixture = await approvedBareNameReplicaFixture({ localApproval: false, accessPolicy: 'public' });
    const accepted = vi.spyOn(Reflect.get(fixture.receiver, 'rfc64PublicCatalogServiceV1'), 'acceptAuthoritativePolicySnapshot');
    await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID))
      .rejects.toThrow(/no authenticated owner authority/);
    expect(accepted).not.toHaveBeenCalled();
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)).toBeNull();
  });

  it('refreshes an approved private catalog without depending on its own active recovery gate', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const recoveryGate = vi.spyOn(fixture.receiver, 'getMemberRecoveryRosterSource')
      .mockResolvedValue(null);

    await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({
      source: 'owner-signed-unregistered',
      policy: { accessPolicy: 1 },
    });
    expect(recoveryGate).not.toHaveBeenCalled();
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBe('private');
  });

  it('retries an approved private catalog proof when its metadata revision moves', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const proof = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const reconciliation = fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await proof.returned;
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    proof.release();

    await expect(reconciliation).resolves.toMatchObject({
      source: 'owner-signed-unregistered',
      policy: { accessPolicy: 1 },
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBe('private');
  });

  it('authorizes an approved private catalog peer from the live join proof without a circular recovery read', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    const recoveryGate = vi.spyOn(fixture.receiver, 'getMemberRecoveryRosterSource')
      .mockResolvedValue(null);

    await expect(fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID))
      .resolves.toEqual([OWNER, fixture.memberAddress].sort());
    await expect(fixture.receiver.resolveRfc64CatalogLocalAgentAddressV1(CONTEXT_GRAPH_ID))
      .resolves.toBe(fixture.memberAddress);
    expect(recoveryGate).not.toHaveBeenCalled();

    await fixture.receiver.store.insert([{
      graph: fixture.graph,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(fixture.memberAddress),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
    await expect(fixture.receiver.resolveRfc64CatalogLocalAgentAddressV1(CONTEXT_GRAPH_ID))
      .resolves.toBeNull();
  });

  it.each(REQUESTER_STATE_CHANGES.flatMap((change) => [
    { change, read: 'readRfc64RegisteredAuthoritySnapshotV1' },
    { change, read: 'getLocalMetadataMemberRecoveryGate' },
  ]))('returns no catalog peer roster when the join request is $change during $read', async ({ change, read }) => {
    const fixture = await approvedBareNameReplicaFixture();
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await expect(fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID))
      .resolves.toEqual([OWNER, fixture.memberAddress].sort());

    // A change of the requester state moves this graph's facts revision,
    // which is what lets the lookup discard a proof that was valid when it
    // started. The roster reads below run after that proof has returned.
    const proofReturned = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const paused = pauseReceiverMethodOnce(fixture, read);
    const roster = fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID);
    await proofReturned.returned;
    proofReturned.release();
    await paused.entered;
    await changeApprovedJoinRequest(fixture, change);
    paused.release();

    await expect(roster).resolves.toBeNull();
    await expect(fixture.receiver.resolveRfc64CatalogLocalAgentAddressV1(CONTEXT_GRAPH_ID))
      .resolves.toBeNull();
  });

  it.each([
    { read: 'readRfc64RegisteredAuthoritySnapshotV1' },
    { read: 'getLocalMetadataMemberRecoveryGate' },
  ])('returns no catalog peer roster when the delegation expires during $read', async ({ read }) => {
    const startedAt = 2_000_000_000_000;
    const delegationExpiresAt = startedAt + 60_000;
    const fixture = await approvedBareNameReplicaFixture({
      delegationIssuedAt: startedAt - 1_000,
      delegationExpiresAt,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await expect(fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID))
      .resolves.toEqual([OWNER, fixture.memberAddress].sort());

    const proofReturned = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const paused = pauseReceiverMethodOnce(fixture, read);
    const roster = fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID);
    await proofReturned.returned;
    proofReturned.release();
    await paused.entered;
    // Nothing in the store changes, so no revision moves: only the clock
    // passes the deadline the proof rested on.
    now.mockReturnValue(delegationExpiresAt);
    paused.release();

    await expect(roster).resolves.toBeNull();
  });

  it.each([
    'the join proof',
    'the first registration read',
    'the roster read',
    'the own-metadata read',
    'the second registration read',
  ] as const)('returns no catalog peer roster when %s fails', async (failing) => {
    const fixture = await approvedBareNameReplicaFixture();
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    await expect(fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID))
      .resolves.toEqual([OWNER, fixture.memberAddress].sort());

    const receiver = fixture.receiver as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const failure = new Error('store read failed');
    if (failing === 'the join proof') {
      const originalQuery = fixture.receiver.store.query.bind(fixture.receiver.store);
      vi.spyOn(fixture.receiver.store, 'query').mockImplementation(async (query, options) => {
        if (options?.source === 'agent.contextGraph.approvedPrivateReplica') throw failure;
        return originalQuery(query, options);
      });
    } else if (failing === 'the first registration read') {
      vi.spyOn(receiver, 'readRfc64RegisteredAuthoritySnapshotV1').mockRejectedValue(failure);
    } else if (failing === 'the roster read') {
      vi.spyOn(receiver, 'getLocalMetadataMemberRecoveryGate').mockRejectedValue(failure);
    } else if (failing === 'the own-metadata read') {
      // The proof reads the graph's own metadata too; fail only the read
      // that follows the roster read.
      const rosterRead = receiver.getLocalMetadataMemberRecoveryGate!.bind(fixture.receiver);
      const ownRead = receiver.getOwnCgMetaFacts!.bind(fixture.receiver);
      let rosterWasRead = false;
      vi.spyOn(receiver, 'getLocalMetadataMemberRecoveryGate').mockImplementation(async (...args) => {
        rosterWasRead = true;
        return rosterRead(...args);
      });
      vi.spyOn(receiver, 'getOwnCgMetaFacts').mockImplementation(async (...args) => {
        if (rosterWasRead) throw failure;
        return ownRead(...args);
      });
    } else {
      const registrationRead = receiver.readRfc64RegisteredAuthoritySnapshotV1!
        .bind(fixture.receiver);
      vi.spyOn(receiver, 'readRfc64RegisteredAuthoritySnapshotV1')
        .mockImplementationOnce(registrationRead)
        .mockRejectedValue(failure);
    }

    await expect(fixture.receiver.resolveRfc64VerifiedPrivateRosterV1(CONTEXT_GRAPH_ID))
      .resolves.toBeNull();
    await expect(fixture.receiver.resolveRfc64CatalogLocalAgentAddressV1(CONTEXT_GRAPH_ID))
      .resolves.toBeNull();
  });

  it('does not use an unconfirmed private definition as a catalog roster', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    vi.spyOn(fixture.receiver, 'hasConfirmedMetaState').mockResolvedValue(false);
    const localGate = vi.spyOn(fixture.receiver, 'getLocalMetadataMemberRecoveryGate');

    await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).rejects.toThrow(/no authenticated lifecycle roster/u);
    expect(localGate).not.toHaveBeenCalled();
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

  it.each([
    ['the shared agents graph', SECONDARY_META_GRAPH],
    ['the shared ontology graph', contextGraphDataGraphUri('ontology')],
  ] as const)(
    'keeps an agent asserted only in %s out of the accepted private roster',
    async (_label, graph) => {
      const fixture = await approvedBareNameReplicaFixture();
      await fixture.receiver.store.insert([{
        graph,
        subject: fixture.subject,
        predicate: D.DKG_ALLOWED_AGENT,
        object: JSON.stringify(OUTSIDER),
      }]);
      Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);
      // The merged projection carries the assertion: this is the widening input.
      expect((await fixture.receiver.getLocalMetadataMemberRecoveryGate(CONTEXT_GRAPH_ID))
        ?.map((address) => address.toLowerCase())).toContain(OUTSIDER);

      const authority = await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
        CONTEXT_GRAPH_ID,
        undefined,
        { kind: 'finalized-absence' },
      );

      expect(authority?.roster?.members.map(({ agentAddress }) => agentAddress).sort())
        .toEqual([OWNER, fixture.memberAddress].sort());
      await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: OUTSIDER,
        allowSubscriptionFallback: false,
      })).resolves.toBe(false);
      await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: OUTSIDER,
      })).resolves.toBe(false);
      await expect(fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      })).resolves.toBe(true);
    },
  );

  it.each([
    ['an allowed agent', D.DKG_ALLOWED_AGENT],
    ['a participant agent', D.DKG_PARTICIPANT_AGENT],
  ] as const)(
    'keeps %s named in the graph\'s own metadata in the accepted private roster',
    async (_label, predicate) => {
      const secondMember = OUTSIDER;
      const fixture = await approvedBareNameReplicaFixture();
      await fixture.receiver.store.insert([{
        graph: fixture.graph,
        subject: fixture.subject,
        predicate,
        object: JSON.stringify(secondMember),
      }]);
      Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);

      const authority = await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
        CONTEXT_GRAPH_ID,
        undefined,
        { kind: 'finalized-absence' },
      );

      expect(authority?.roster?.members.map(({ agentAddress }) => agentAddress).sort())
        .toEqual([OWNER, fixture.memberAddress, secondMember].sort());
    },
  );

  it('applies a revocation from shared metadata to a member named in the graph\'s own metadata', async () => {
    const secondMember = OUTSIDER;
    const fixture = await approvedBareNameReplicaFixture({
      additionalAllowedAgents: [secondMember],
    });
    await fixture.receiver.store.insert([{
      graph: SECONDARY_META_GRAPH,
      subject: fixture.subject,
      predicate: D.DKG_REVOKED_AGENT,
      object: JSON.stringify(secondMember),
    }]);
    Reflect.get(fixture.receiver, 'contextGraphMetaProjection').markDirty(CONTEXT_GRAPH_ID);

    const authority = await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );

    // Shared metadata may only narrow the roster, never widen it.
    expect(authority?.roster?.members.map(({ agentAddress }) => agentAddress).sort())
      .toEqual([OWNER, fixture.memberAddress].sort());
  });

  it.each(['request-replaced', 'owner-mismatch', 'member-missing', 'metadata-moved'] as const)(
    'refuses approved-private catalog acceptance when %s after the proof succeeds', async (change) => {
      const fixture = await approvedBareNameReplicaFixture();
      let releaseRead!: () => void; let enteredRead!: () => void;
      const release = new Promise<void>((resolve) => { releaseRead = resolve; });
      const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
      const original = fixture.receiver.getStoredContextGraphRegistrationOptions.bind(fixture.receiver);
      vi.spyOn(fixture.receiver, 'getStoredContextGraphRegistrationOptions').mockImplementationOnce(async (id) => {
        enteredRead(); await release; return original(id);
      });
      if (change === 'owner-mismatch') vi.spyOn(fixture.receiver, 'getContextGraphOwner').mockResolvedValue(`did:dkg:agent:${OUTSIDER}`);
      if (change === 'member-missing') vi.spyOn(fixture.receiver, 'resolveRfc64ConfirmedOwnMetaRosterV1').mockResolvedValue([OWNER]);
      const composition = fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID, undefined, { kind: 'finalized-absence' })
        .catch((cause: unknown) => cause);
      if (change === 'owner-mismatch') {
        expect(await composition).toBeInstanceOf(Error);
      } else {
        await entered;
        if (change === 'request-replaced') await fixture.receiver.writeRequesterJoinRequestState(CONTEXT_GRAPH_ID, fixture.approvedAddress, {
          status: 'rejected', requestGeneration: `0x${'34'.repeat(32)}`, curatorPeerId: CURATOR_PEER,
          curatorAgentAddress: OWNER, curatorAuthorityEra: '0',
        });
        if (change === 'metadata-moved') await fixture.receiver.store.insert([{
          graph: fixture.graph, subject: fixture.subject, predicate: D.DKG_REVOKED_AGENT, object: JSON.stringify(fixture.approvedAddress),
        }]);
        releaseRead();
        expect(await composition).toBeInstanceOf(Error);
      }
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)).toBeNull();
    },
  );

  it.each(['already-active', 'during-proof'] as const)(
    'withholds approved authority for an %s requester mutation and recovers after its failed write', async (timing) => {
      const fixture = await approvedBareNameReplicaFixture();
      await fixture.receiver.whenRfc64CatalogResponsibilitiesIdleV1();
      const accepted = vi.spyOn(Reflect.get(fixture.receiver, 'rfc64PublicCatalogServiceV1'), 'acceptAuthoritativePolicySnapshot');
      let enter!: () => void; let rejectWrite!: (error: Error) => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const backend = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
      const update = fixture.receiver.store.update!.bind(fixture.receiver.store);
      let held = false;
      vi.spyOn(fixture.receiver.store, 'update').mockImplementation(async (sparql, options) => {
        if (!held && options?.touchedGraphs?.includes('urn:dkg:local:requester-join-state')) {
          held = true; enter(); await backend;
        }
        await update(sparql, options);
      });
      const mutate = () => fixture.receiver.writeRequesterJoinRequestState(CONTEXT_GRAPH_ID, fixture.approvedAddress, {
        status: 'rejected', requestGeneration: `0x${'34'.repeat(32)}`, curatorPeerId: CURATOR_PEER,
        curatorAgentAddress: OWNER, curatorAuthorityEra: '0',
      }).catch((error: unknown) => error);
      const proof = timing === 'during-proof' ? pauseSuccessfulApprovedPrivateProofOnce(fixture) : undefined;
      vi.useFakeTimers();
      let mutation: Promise<unknown> | undefined;
      try {
        if (timing === 'already-active') { mutation = mutate(); await entered; }
        const composition = fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID, undefined, { kind: 'finalized-absence' });
        if (proof !== undefined) {
          await proof.returned;
          mutation = mutate(); await entered; proof.release();
        }
        const oldRows = await fixture.receiver.store.query('SELECT ?status WHERE { GRAPH <urn:dkg:local:requester-join-state> { ?s <urn:dkg:local:requester-join-state:status> ?status } } LIMIT 2');
        expect(oldRows).toMatchObject({ type: 'bindings', bindings: [{ status: '"approved"' }] });
        // Every retry still sees the old real row while the backend write is held.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(await composition).toBeNull();
        expect(accepted).not.toHaveBeenCalled();
        expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)).toBeNull();
        const failure = new Error('requester backend refused replacement');
        rejectWrite(failure);
        expect(await mutation).toBe(failure);
        const locks = Reflect.get(fixture.receiver, 'contextGraphJoinAdmissionLockManager');
        expect(locks.requesterMutationActive(CONTEXT_GRAPH_ID)).toBe(false);
        await expect(fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(CONTEXT_GRAPH_ID, undefined, { kind: 'finalized-absence' }))
          .resolves.toMatchObject({ source: 'owner-signed-unregistered', policy: { accessPolicy: 1 } });
        expect(accepted).toHaveBeenCalledOnce();
      } finally {
        proof?.release(); rejectWrite(new Error('test cleanup')); await mutation;
        vi.useRealTimers();
      }
    },
  );

  it('activates a scheduled private-join retry after the authenticated metadata and delegation arrive', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const held = await fixture.receiver.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${fixture.graph}> { ?s ?p ?o } }`);
    if (held.type !== 'quads') throw new Error('fixture metadata is missing');
    await fixture.receiver.store.dropGraph(fixture.graph);
    const subscription = Reflect.get(fixture.receiver, 'subscribedContextGraphs').get(CONTEXT_GRAPH_ID);
    Reflect.get(fixture.receiver, 'subscribedContextGraphs').set(CONTEXT_GRAPH_ID, {
      ...subscription, pendingMeta: false, onChainHash: fixture.receiver.contextGraphNameCommitment(CONTEXT_GRAPH_ID),
    });
    await fixture.receiver.whenRfc64CatalogResponsibilitiesIdleV1();
    vi.useFakeTimers();
    try {
      fixture.receiver.scheduleRfc64CatalogResponsibilityReconciliationV1(CONTEXT_GRAPH_ID);
      await vi.advanceTimersByTimeAsync(100);
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)).toBeNull();
      await fixture.receiver.store.insert(held.quads.map((quad) => ({ ...quad, graph: fixture.graph })));
      await vi.advanceTimersByTimeAsync(30_100);
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance).toBe('join-approval');
      expect(fixture.receiver.readRfc64CatalogResponsibilitiesV1()).toContainEqual(expect.objectContaining({ contextGraphId: CONTEXT_GRAPH_ID, active: true }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps reads and shared memory on the live join proof after catalog authority is accepted', async () => {
    const startedAt = 2_000_000_000_000;
    const delegationExpiresAt = startedAt + 60_000;
    const secondMember = OUTSIDER;
    const fixture = await approvedBareNameReplicaFixture({
      additionalAllowedAgents: [secondMember],
      delegationIssuedAt: startedAt - 1_000,
      delegationExpiresAt,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const reconcile = () => fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    const readAuthority = (callerAgentAddress: string) => (
      fixture.receiver.resolveContextGraphReadAuthority(CONTEXT_GRAPH_ID, {
        callerAgentAddress,
        allowSubscriptionFallback: false,
      })
    );
    const canRead = (callerAgentAddress: string) => (
      fixture.receiver.canReadContextGraph(CONTEXT_GRAPH_ID, {
        callerAgentAddress,
        allowSubscriptionFallback: false,
      })
    );
    const canUseSharedMemory = (callerAgentAddress: string) => (
      fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, { callerAgentAddress })
    );
    try {
      const accepted = await reconcile();
      expect(accepted?.roster?.members.map(({ agentAddress }) => agentAddress).sort())
        .toEqual([OWNER, fixture.memberAddress, secondMember].sort());
      expect((fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance === 'join-approval')).toBe(true);

      // The accepted roster is not what authorizes: the proof still does, and
      // it covers this receiver's approved member only.
      expect(fixture.receiver.resolveRfc64PrivateReadRosterV1(CONTEXT_GRAPH_ID)).toBeUndefined();
      expect(fixture.receiver.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1(
        CONTEXT_GRAPH_ID,
      )).toBeUndefined();
      await expect(readAuthority(fixture.memberAddress)).resolves.toMatchObject({
        outcome: 'allowed',
        source: 'rfc64-private',
        reason: 'rfc64-participant',
      });
      await expect(canUseSharedMemory(fixture.memberAddress)).resolves.toBe(true);
      await expect(canRead(secondMember)).resolves.toBe(false);
      await expect(canUseSharedMemory(secondMember)).resolves.toBe(false);

      // The delegation expires. The policy stays accepted; access does not.
      now.mockReturnValue(delegationExpiresAt + 1_000);
      await expect(readAuthority(fixture.memberAddress)).resolves.toMatchObject({
        outcome: 'unavailable',
        reason: 'finalized-name-absence-unaccepted',
      });
      await expect(canRead(fixture.memberAddress)).resolves.toBe(false);
      await expect(canUseSharedMemory(fixture.memberAddress)).resolves.toBe(false);

      // A refresh that fails retains the snapshot, and still grants nothing.
      await expect(reconcile()).rejects.toThrow(/no authenticated owner authority/u);
      expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
        .toBe('private');
      await expect(readAuthority(fixture.memberAddress)).resolves.toMatchObject({
        outcome: 'unavailable',
        reason: 'finalized-name-absence-unaccepted',
      });
      await expect(canUseSharedMemory(fixture.memberAddress)).resolves.toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('does not let a join-derived roster govern shared memory while the catalog lane is active', async () => {
    const secondMember = OUTSIDER;
    const fixture = await approvedBareNameReplicaFixture({
      additionalAllowedAgents: [secondMember],
    });
    const joinDerived = await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    const lane = fixture.receiver.resolveRfc64CatalogReceiverAuthorityV1(CONTEXT_GRAPH_ID);
    vi.spyOn(fixture.receiver, 'resolveRfc64CatalogReceiverAuthorityV1').mockReturnValue({
      ...lane,
      killSwitchActive: false,
      mode: 'catalog',
      active: true,
      reconciliationLane: 'catalog-apply',
    });
    expect(fixture.receiver.isRfc64CatalogTransportAuthorityActiveV1(CONTEXT_GRAPH_ID)).toBe(true);
    const admission = (callerAgentAddress: string) => (
      fixture.receiver.resolveAcceptedRfc64SharedMemoryAuthorityV1(
        CONTEXT_GRAPH_ID,
        { callerAgentAddress },
      )
    );
    const canUseSharedMemory = (callerAgentAddress: string) => (
      fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, { callerAgentAddress })
    );

    // The accepted roster names the second member, but neither transport nor
    // admission takes it as authority: both are left to the join proof.
    expect(fixture.receiver.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1(
      CONTEXT_GRAPH_ID,
    )).toBeUndefined();
    expect(admission(secondMember)).toBeUndefined();
    await expect(canUseSharedMemory(secondMember)).resolves.toBe(false);
    await expect(canUseSharedMemory(fixture.memberAddress)).resolves.toBe(true);

    // The same snapshot does govern once an authenticated path has accepted it.
    fixture.receiver.acceptRfc64CatalogAccessSnapshotV1({
      policy: joinDerived!.policy,
      policyDigest: joinDerived!.policyDigest,
      roster: joinDerived!.roster,
    });
    expect(fixture.receiver.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1(
      CONTEXT_GRAPH_ID,
    )?.slice().sort()).toEqual([OWNER, fixture.memberAddress, secondMember].sort());
    expect(admission(secondMember)).toBe(true);
  });

  it('stops reading through accepted catalog authority once the join request is replaced', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    const readAuthority = () => fixture.receiver.resolveContextGraphReadAuthority(
      CONTEXT_GRAPH_ID,
      { callerAgentAddress: fixture.memberAddress, allowSubscriptionFallback: false },
    );
    await expect(readAuthority()).resolves.toMatchObject({ outcome: 'allowed' });

    // A newer request for the same member is waiting for the curator.
    await fixture.receiver.writeRequesterJoinRequestState(
      CONTEXT_GRAPH_ID,
      fixture.approvedAddress,
      {
        status: 'pending',
        requestGeneration: `0x${'34'.repeat(32)}`,
        curatorPeerId: CURATOR_PEER,
        curatorAgentAddress: OWNER,
        curatorAuthorityEra: '0',
      },
    );

    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBe('private');
    await expect(readAuthority()).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    await expect(fixture.receiver.canUseSharedMemoryForContextGraph(CONTEXT_GRAPH_ID, {
      callerAgentAddress: fixture.memberAddress,
    })).resolves.toBe(false);
  });

  it('treats the policy as owner authority again once it is accepted from another source', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    const joinDerived = await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    expect((fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance === 'join-approval')).toBe(true);

    // The same policy and roster arrive through an independently verified path.
    fixture.receiver.acceptRfc64CatalogAccessSnapshotV1({
      policy: joinDerived!.policy,
      policyDigest: joinDerived!.policyDigest,
      roster: joinDerived!.roster,
    });

    expect((fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance === 'join-approval')).toBe(false);
    expect(fixture.receiver.resolveRfc64PrivateReadRosterV1(CONTEXT_GRAPH_ID)?.slice().sort())
      .toEqual([OWNER, fixture.memberAddress].sort());
  });

  it('forgets the join-derived mark when the catalog runtime closes', async () => {
    const fixture = await approvedBareNameReplicaFixture();
    await fixture.receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    );
    expect((fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance === 'join-approval')).toBe(true);

    await fixture.receiver.stop();

    expect((fixture.receiver.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.provenance === 'join-approval')).toBe(false);
  });

  it.each([
    ['curator', D.DKG_CURATOR, `did:dkg:agent:${OUTSIDER}`],
    ['creator', D.DKG_CREATOR, `did:dkg:agent:${CURATOR_PEER}-other`],
    ['peer allowlist', D.DKG_ALLOWED_PEER, JSON.stringify(CURATOR_PEER)],
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

  it('rejects an exact delegation-issued-at delete after its private proof succeeds in flight', async () => {
    const delegationIssuedAt = Date.now() - 1_000;
    const fixture = await approvedBareNameReplicaFixture({ delegationIssuedAt });
    const proof = pauseSuccessfulApprovedPrivateProofOnce(fixture);
    const admission = fixture.receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      {
        callerAgentAddress: fixture.memberAddress,
        allowSubscriptionFallback: false,
      },
    );
    await proof.returned;

    const projection = Reflect.get(fixture.receiver, 'contextGraphMetaProjection') as {
      readonly readAuthorityFactsRevision: number;
    };
    const revisionBeforeDelete = projection.readAuthorityFactsRevision;
    await fixture.receiver.store.delete([{
      graph: fixture.graph,
      subject: fixture.delegationSubject,
      predicate: D.DKG_DELEGATION_ISSUED_AT,
      object: JSON.stringify(String(delegationIssuedAt)),
    }]);
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(revisionBeforeDelete);
    proof.release();

    await expect(admission).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fixture.receiver.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID))
      .toBeNull();
  });

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
    )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-private', registration: 'unregistered' });

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
