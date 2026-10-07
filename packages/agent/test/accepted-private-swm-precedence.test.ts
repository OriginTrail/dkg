// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceAgentRecipientKeys } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { SwmSubstrateMethods } from '../src/dkg-agent-swm-substrate.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { CONTEXT_GRAPH_ID, JOIN_KEY_CACHE_GRAPH, PROFILE_GRAPH, ROUTES_CHANGED, TRANSPORT_CHANGED, signedKeyFixture, signedKeyQuads } from './_helpers/signed-private-keys.js';
import { stubFence, stubRecipientRevisions } from './_helpers/recipient-fence-stub.js';

const CURATOR_PEER_ID = '12D3KooWAcceptedPrivateCurator';

function approvedUnregisteredAuthority(approvedAgentAddress: string) {
  return {
    kind: 'unregistered' as const,
    approvedPrivateReplicaAuthority: {
      approvedAgentAddress,
      ownerAddress: approvedAgentAddress,
      requestGeneration: 'accepted-private-generation',
      curatorPeerId: CURATOR_PEER_ID,
      memberAddresses: [approvedAgentAddress],
      allowedPeers: [] as string[],
    },
  };
}

describe('accepted private RFC-64 SWM authority precedence', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('ignores a retained private roster when catalog transport authority is inactive', () => {
    const readAcceptedRfc64CatalogAccessSnapshotV1 = vi.fn(() => ({
      policy: {
        source: { kind: 'owner-signed-unregistered' as const },
        accessPolicy: 1 as const,
      },
      roster: { members: [] },
    }));
    const host = {
      isRfc64CatalogTransportAuthorityActiveV1: () => false,
      config: { rfc64CatalogBootstrap: { acceptedPolicies: [] } },
      readAcceptedRfc64CatalogAccessSnapshotV1,
    };

    expect(Rfc64CatalogMethods.prototype
      .resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1.call(
        host as never,
        CONTEXT_GRAPH_ID,
      )).toBeUndefined();
    expect(readAcceptedRfc64CatalogAccessSnapshotV1).not.toHaveBeenCalled();
  });

  it('keeps active configured private authority fail-closed before a snapshot is accepted', () => {
    const host = {
      isRfc64CatalogTransportAuthorityActiveV1: () => true,
      config: {
        rfc64CatalogBootstrap: {
          acceptedPolicies: [{
            policyEnvelope: {
              payload: {
                contextGraphId: CONTEXT_GRAPH_ID,
                accessPolicy: 1,
              },
            },
          }],
        },
      },
      readAcceptedRfc64CatalogAccessSnapshotV1: () => null,
    };

    expect(Rfc64CatalogMethods.prototype
      .resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1.call(
        host as never,
        CONTEXT_GRAPH_ID,
      )).toBeNull();
  });

  it('encrypts only to the accepted private roster, never a stale metadata member', async () => {
    const owner = ethers.Wallet.createRandom();
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([
      ...signedKeyQuads(owner),
      ...signedKeyQuads(member),
      ...signedKeyQuads(removed),
      ...[owner, member, removed].map((wallet) => ({
        subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${wallet.address}"`,
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      })),
    ]);

    const resolveRegisteredContextGraphAuthority = vi.fn(async (
      _contextGraphId: string,
      options: { allowAcceptedRfc64FinalizedAbsence?: boolean },
    ) => {
      expect(options.allowAcceptedRfc64FinalizedAbsence).toBe(true);
      return approvedUnregisteredAuthority(member.address);
    });
    const host = {
      store,
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(store),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        [owner.address, member.address]
      ),
      getContextGraphAllowedPeers: vi.fn(async () => null),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    const resolution = await WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients.map(({ agentAddress }) => agentAddress).sort())
      .toEqual([owner.address, member.address].map(ethers.getAddress).sort());
    expect(resolution.recipients.map(({ agentAddress }) => agentAddress.toLowerCase()))
      .not.toContain(removed.address.toLowerCase());
    expect(host.ensureAgentsInOnDemandPhonebook).not.toHaveBeenCalled();
  });

  it('rejects recipient keys when the accepted private roster rotates during lookup', async () => {
    const owner = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([
      ...signedKeyQuads(owner),
      ...signedKeyQuads(removed),
    ]);
    let currentRoster = [owner.address, removed.address];
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      currentRoster = [owner.address];
      return result;
    });
    const host = {
      store,
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(store),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(owner.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => currentRoster,
      getContextGraphAllowedPeers: vi.fn(async () => null),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    await expect(WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      })).rejects.toMatchObject({
        reason: 'chain-participant-authority-unavailable',
      });
  });

  it('rejects private-roster peer routes removed during the final authority read', async () => {
    const agentA = ethers.Wallet.createRandom();
    const agentB = ethers.Wallet.createRandom();
    const peerA = '12D3KooWAcceptedPrivatePeerA';
    const peerB = '12D3KooWAcceptedPrivatePeerB';
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([
      ...signedKeyQuads(agentA, peerA),
      ...signedKeyQuads(agentB, peerB),
    ]);

    let metadataRevision = 7;
    let peerGateRevision = '0:0';
    let allowedPeers = [peerA, peerB];
    let transportReads = 0;
    let finalReadEntered!: () => void;
    let releaseFinalRead!: () => void;
    const entered = new Promise<void>((resolve) => { finalReadEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
    const participantAgents = [agentA.address, agentB.address];
    const host = {
      store,
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(store),
        peerGateRevision: { read: () => peerGateRevision },
        readContextGraphAuthorityFactsRevision: () => '0:0',
        get readAuthorityFactsRevision() { return metadataRevision; },
      },
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads === 2) {
          finalReadEntered();
          await release;
        }
        return { kind: 'private-roster' as const, participantAgents };
      }),
      getContextGraphAllowedPeers: vi.fn(async () => [...allowedPeers]),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    const resolution = WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });
    await entered;
    allowedPeers = [peerA];
    peerGateRevision = '0:1';
    metadataRevision += 1;
    releaseFinalRead();

    await expect(resolution).rejects.toThrow(
      /has no recipient key advertised by a peer in the context graph allowlist/,
    );
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    // The collect, then the one the moved gate revision asks for, which refuses.
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
  });

  describe.each([
    {
      moved: 'a recipient key or route fact',
      expectedReads: 3,
      expectedPeerGateReads: 2,
      move: (host: { fence: ReturnType<typeof stubFence>; node: { revision: number } }) => { host.fence.revision += 1; },
    },
    {
      moved: 'only unrelated authority facts',
      expectedReads: 2,
      expectedPeerGateReads: 1,
      move: (host: { fence: ReturnType<typeof stubFence>; node: { revision: number } }) => { host.node.revision += 1; },
    },
  ])('a private roster whose snapshot sees $moved move during the first confirmation', (scenario) => {
    it(`collects ${scenario.expectedReads - 1} time(s) and resolves the same recipients`, async () => {
      const member = ethers.Wallet.createRandom();
      const peerId = '12D3KooWAcceptedPrivateStableRetryPeer';
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(signedKeyQuads(member, peerId));

      const moves = { fence: stubFence(), node: { revision: 19 } };
      let transportReads = 0;
      const host = {
        store,
        contextGraphMetaProjection: {
          recipientKeyRouteFence: moves.fence,
          recipientKeyCollect: { resolve: (agent: string) => resolveWorkspaceAgentRecipientKeys(store, agent) },
          peerGateRevision: { read: () => '0:0' },
          readContextGraphAuthorityFactsRevision: () => '0:0',
          get readAuthorityFactsRevision() { return moves.node.revision; },
        },
        resolveSwmTransportAuthority: vi.fn(async () => {
          transportReads += 1;
          if (transportReads === 2) scenario.move(moves);
          return {
            kind: 'private-roster' as const,
            participantAgents: [member.address],
          };
        }),
        getContextGraphAllowedPeers: vi.fn(async () => [peerId]),
        ensureAgentsInOnDemandPhonebook: vi.fn(),
      };

      await expect(WorkspaceCryptoMethods.prototype
        .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
          contextGraphId: CONTEXT_GRAPH_ID,
        })).resolves.toMatchObject({
          requiresEncryption: true,
          recipients: [expect.objectContaining({
            agentAddress: ethers.getAddress(member.address),
            peerId,
          })],
        });
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(scenario.expectedReads);
      expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(scenario.expectedPeerGateReads);
      expect(moves.fence.ensureReady).toHaveBeenCalledTimes(scenario.expectedReads - 1);
    });
  });

  it('retries unchanged legacy plaintext after an unrelated authority revision moves', async () => {
    const store = new OxigraphStore();
    stores.push(store);

    let metadataRevision = 23;
    let transportReads = 0;
    const host = {
      store,
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(store),
        get readAuthorityFactsRevision() { return metadataRevision; },
      },
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads === 2) metadataRevision += 1;
        return { kind: 'legacy-unregistered' as const };
      }),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    await expect(WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      })).resolves.toEqual({
        requiresEncryption: false,
        recipients: [],
      });
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
  });

  it('rejects a key revoked through the real store wrapper during the final authority read', async () => {
    const member = ethers.Wallet.createRandom();
    const peerId = '12D3KooWAcceptedPrivateRevokedKeyPeer';
    const key = signedKeyFixture(member, peerId);
    const innerStore = new OxigraphStore();
    stores.push(innerStore);
    let projection!: ContextGraphMetaProjection;
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    projection = new ContextGraphMetaProjection(store);
    await store.insert(key.quads);

    let transportReads = 0;
    let finalReadEntered!: () => void;
    let releaseFinalRead!: () => void;
    const entered = new Promise<void>((resolve) => { finalReadEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
    const host = {
      store,
      contextGraphMetaProjection: projection,
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads === 2) {
          finalReadEntered();
          await release;
        }
        return {
          kind: 'private-roster' as const,
          participantAgents: [member.address],
        };
      }),
      getContextGraphAllowedPeers: vi.fn(async () => [peerId]),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    const resolution = WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });
    await entered;
    const beforeRevocation = projection.readAuthorityFactsRevision;
    const revokedAt = new Date().toISOString();
    const revocationProof = member.signingKey.sign(ethers.hashMessage(
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: member.address,
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes: key.publicKeyBytes,
        revokedAt,
      }),
    )).serialized;
    const agentUri = `did:dkg:agent:${ethers.getAddress(member.address)}`;
    await store.insert([
      {
        subject: key.recipientKeyId,
        predicate: DKG_ONTOLOGY.DKG_REVOKED_AT,
        object: `"${revokedAt}"`,
        graph: PROFILE_GRAPH,
      },
      {
        subject: key.recipientKeyId,
        predicate: DKG_ONTOLOGY.DKG_REVOKED_BY,
        object: agentUri,
        graph: PROFILE_GRAPH,
      },
      {
        subject: key.recipientKeyId,
        predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
        object: `"${revocationProof}"`,
        graph: PROFILE_GRAPH,
      },
    ]);
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(beforeRevocation);
    releaseFinalRead();

    await expect(resolution).rejects.toThrow(/public encryption keys.*revoked/);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

  it('rejects a join-cache key route atomically replaced during the final authority read', async () => {
    const member = ethers.Wallet.createRandom();
    const oldKey = signedKeyFixture(member, '12D3KooWAcceptedPrivateOldJoinRoute');
    const newKey = signedKeyFixture(member, '12D3KooWAcceptedPrivateNewJoinRoute');
    const joinCacheGraph = 'urn:dkg:local:join-encryption-key-cache';
    const inJoinCache = (quads: readonly Quad[]): Quad[] => quads.map((quad) => ({
      ...quad,
      graph: joinCacheGraph,
    }));
    const innerStore = new OxigraphStore();
    stores.push(innerStore);
    let projection!: ContextGraphMetaProjection;
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    projection = new ContextGraphMetaProjection(store);
    await store.insert(inJoinCache(oldKey.quads));

    let transportReads = 0;
    let finalReadEntered!: () => void;
    let releaseFinalRead!: () => void;
    const entered = new Promise<void>((resolve) => { finalReadEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
    const host = {
      store,
      contextGraphMetaProjection: projection,
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads === 2) {
          finalReadEntered();
          await release;
        }
        return {
          kind: 'private-roster' as const,
          participantAgents: [member.address],
        };
      }),
      getContextGraphAllowedPeers: vi.fn(async () => null),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    const resolution = WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });
    await entered;
    const beforeReplacement = projection.readAuthorityFactsRevision;
    const agentUri = `did:dkg:agent:${ethers.getAddress(member.address)}`;
    await store.replaceSubject!(
      joinCacheGraph,
      agentUri,
      inJoinCache(newKey.quads),
    );
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(beforeReplacement);
    releaseFinalRead();

    await expect(resolution).rejects.toMatchObject({
      reason: 'chain-participant-authority-unavailable',
    });
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

  /**
   * The recipient resolver over the real store wrapper and metadata
   * projection, with the real SWM gossip reconcile of the same graph running
   * before and after the work of every authority read that follows the first.
   * Each stability attempt of the resolver therefore has reconciles inside
   * its window; `duringFinalAuthorityRead` adds a real change to the first.
   */
  function recipientHostUnderGossipReconciles(options: {
    transport: () =>
      | { kind: 'private-roster'; participantAgents: readonly string[] }
      | { kind: 'legacy-unregistered' };
    duringFinalAuthorityRead?: () => Promise<unknown>;
  }) {
    const innerStore = new OxigraphStore();
    stores.push(innerStore);
    let projection!: ContextGraphMetaProjection;
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    projection = new ContextGraphMetaProjection(store);
    // A live session whose member subscription for the graph is installed:
    // the reconcile refreshes the policy view, re-checks access and returns.
    const reconcileHost = {
      gossipSession: {
        active: true,
        live: () => ({ manager: {} }),
        sharedMemoryGossipRegistered: new Set([CONTEXT_GRAPH_ID]),
      },
      contextGraphMetaProjection: projection,
      gossipWireIdFor: (contextGraphId: string) => contextGraphId,
      rfc64LegacySwmMemberTransportAllowedForContextGraph: () => true,
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
    };
    const reconciles: Promise<void>[] = [];
    const reconcile = (): void => {
      reconciles.push(SwmSubstrateMethods.prototype.reconcileSharedMemoryGossipSubscription
        .call(reconcileHost as never, CONTEXT_GRAPH_ID));
    };
    let transportReads = 0;
    const host = {
      store,
      contextGraphMetaProjection: projection,
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads > 1) {
          reconcile();
          if (transportReads === 2) await options.duringFinalAuthorityRead?.();
          reconcile();
        }
        return options.transport();
      }),
      // As the agent's own lookup: the peer gate of the cached policy view.
      getContextGraphAllowedPeers: vi.fn(async () => {
        const peers = (await projection.get(CONTEXT_GRAPH_ID)).allowedPeers;
        return peers.length > 0 ? peers : null;
      }),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };
    return { store, projection, host, reconcileHost, reconciles };
  }

  function allowedPeerQuad(peerId: string): Quad {
    return {
      subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${peerId}"`,
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    };
  }

  it('does not spend stability attempts on gossip reconciles of the graph', async () => {
    const member = ethers.Wallet.createRandom();
    const peerId = '12D3KooWAcceptedPrivateReconcilePeer';
    const { store, projection, host, reconcileHost, reconciles } =
      recipientHostUnderGossipReconciles({
        transport: () => ({ kind: 'private-roster', participantAgents: [member.address] }),
      });
    await store.insert([...signedKeyQuads(member, peerId), allowedPeerQuad(peerId)]);
    const nodeWide = projection.readAuthorityFactsRevision;
    const perGraph = projection.readContextGraphAuthorityFactsRevision(CONTEXT_GRAPH_ID);

    await expect(WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      })).resolves.toMatchObject({
        requiresEncryption: true,
        recipients: [expect.objectContaining({
          agentAddress: ethers.getAddress(member.address),
          peerId,
        })],
      });
    await Promise.all(reconciles);

    // One authority read to classify the graph and one to confirm it: the
    // reconciles changed no fact, so nothing was resolved a second time.
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(1);
    expect(reconciles).toHaveLength(2);
    expect(reconcileHost.canUseSharedMemoryForContextGraph).toHaveBeenCalledTimes(2);
    expect(projection.readAuthorityFactsRevision).toBe(nodeWide);
    expect(projection.readContextGraphAuthorityFactsRevision(CONTEXT_GRAPH_ID)).toBe(perGraph);
  });

  /** What one scenario may read and change while the recipients resolve. */
  interface RecipientChangeContext {
    readonly store: ReturnType<typeof recipientHostUnderGossipReconciles>['store'];
    readonly member: ethers.HDNodeWallet;
    readonly memberUri: string;
    readonly memberKey: ReturnType<typeof signedKeyFixture>;
    readonly peerId: string;
    readonly other: ethers.HDNodeWallet;
    readonly otherPeerId: string;
    /** What the authority reads return. */
    readonly authority: { roster: string[]; rosterGoverns: boolean };
  }

  interface RecipientChangeScenario {
    readonly change: string;
    /** The facts the store holds before the recipients resolve. */
    readonly seed: (context: RecipientChangeContext) => Quad[];
    /** The change, applied during the first confirmation read. */
    readonly apply: (context: RecipientChangeContext) => Promise<unknown>;
    /** The authority-facts revisions the change itself moves. */
    readonly moves: 'neither' | 'node-wide' | 'both';
    /** A message pattern, or the authority error's reason and the check that raised it. */
    readonly rejects: RegExp | { reason: string; detail: string };
  }

  /** The confirmation read no longer matched the roster the keys were resolved for. */
  /** Both members' keys in the profile graph, and a peer gate that names both peers. */
  const profileKeysBehindPeerGate = (context: RecipientChangeContext): Quad[] => [
    ...context.memberKey.quads,
    ...signedKeyQuads(context.other, context.otherPeerId),
    allowedPeerQuad(context.peerId),
    allowedPeerQuad(context.otherPeerId),
  ];

  const recipientChangeScenarios: RecipientChangeScenario[] = [
    {
      change: 'a member leaves the roster',
      seed: profileKeysBehindPeerGate,
      apply: async ({ authority, member }) => { authority.roster = [member.address]; },
      moves: 'neither',
      rejects: TRANSPORT_CHANGED,
    },
    {
      // What a receiver selection transition does to an accepted private
      // graph: its reconcile runs, and the roster stops governing transport.
      change: 'the accepted roster stops governing transport',
      seed: profileKeysBehindPeerGate,
      apply: async ({ authority }) => { authority.rosterGoverns = false; },
      moves: 'neither',
      rejects: TRANSPORT_CHANGED,
    },
    {
      change: 'a recipient key is revoked in the profile graph',
      seed: profileKeysBehindPeerGate,
      apply: ({ store, member, memberUri, memberKey }) => {
        const revokedAt = new Date().toISOString();
        const proof = member.signingKey.sign(ethers.hashMessage(
          computeWorkspaceAgentEncryptionKeyRevocationPayload({
            agentAddress: member.address,
            encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicKeyBytes: memberKey.publicKeyBytes,
            revokedAt,
          }),
        )).serialized;
        return store.insert([
          [DKG_ONTOLOGY.DKG_REVOKED_AT, `"${revokedAt}"`],
          [DKG_ONTOLOGY.DKG_REVOKED_BY, memberUri],
          [DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF, `"${proof}"`],
        ].map(([predicate, object]) => ({
          subject: memberKey.recipientKeyId,
          predicate,
          object,
          graph: PROFILE_GRAPH,
        })));
      },
      moves: 'node-wide',
      rejects: /public encryption keys.*revoked/,
    },
    {
      change: 'a peer route is removed in the profile graph',
      seed: profileKeysBehindPeerGate,
      apply: ({ store, memberUri }) => store.deleteByPattern({
        graph: PROFILE_GRAPH,
        subject: memberUri,
        predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      }),
      moves: 'both',
      rejects: /has no recipient key advertised by a peer in the context graph allowlist/,
    },
    {
      change: 'a peer route is replaced in the join key cache',
      // The member's key lives in the join key cache and the peer gate is
      // open. The replacement keeps the key, its algorithm and its proof and
      // changes the peer route alone, so only the comparison of the resolved
      // routes can refuse the recipients.
      seed: ({ memberKey, other, otherPeerId }) => [
        ...memberKey.quads.map((quad) => ({ ...quad, graph: JOIN_KEY_CACHE_GRAPH })),
        ...signedKeyQuads(other, otherPeerId),
      ],
      apply: ({ store, memberKey, memberUri }) => store.replaceSubject!(
        JOIN_KEY_CACHE_GRAPH,
        memberUri,
        memberKey.quads.map((quad) => ({
          ...quad,
          graph: JOIN_KEY_CACHE_GRAPH,
          ...(quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID
            ? { object: '"12D3KooWAcceptedPrivateReconcileNewRoute"' }
            : {}),
        })),
      ),
      moves: 'node-wide',
      rejects: ROUTES_CHANGED,
    },
    {
      change: 'a peer leaves the allowlist of the graph',
      seed: profileKeysBehindPeerGate,
      apply: ({ store, peerId }) => store.deleteByPattern({
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
        subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${peerId}"`,
      }),
      moves: 'both',
      rejects: /has no recipient key advertised by a peer in the context graph allowlist/,
    },
  ];

  it.each(recipientChangeScenarios)('still fails closed when $change between gossip reconciles', async (scenario) => {
    const member = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const peerId = '12D3KooWAcceptedPrivateReconcileMemberPeer';
    const authority = { roster: [member.address, other.address], rosterGoverns: true };
    let context!: RecipientChangeContext;
    const { store, projection, host, reconciles } = recipientHostUnderGossipReconciles({
      transport: () => (authority.rosterGoverns
        ? { kind: 'private-roster', participantAgents: [...authority.roster] }
        : { kind: 'legacy-unregistered' }),
      duringFinalAuthorityRead: () => scenario.apply(context),
    });
    context = {
      store,
      member,
      memberUri: `did:dkg:agent:${ethers.getAddress(member.address)}`,
      memberKey: signedKeyFixture(member, peerId),
      peerId,
      other,
      otherPeerId: '12D3KooWAcceptedPrivateReconcileOtherPeer',
      authority,
    };
    await store.insert(scenario.seed(context));
    const nodeWide = projection.readAuthorityFactsRevision;
    const perGraph = projection.readContextGraphAuthorityFactsRevision(CONTEXT_GRAPH_ID);

    const resolution = WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });
    await (scenario.rejects instanceof RegExp
      ? expect(resolution).rejects.toThrow(scenario.rejects)
      : expect(resolution).rejects.toMatchObject(scenario.rejects));
    await Promise.all(reconciles);

    // Refused on the first confirmation read, as without the reconciles.
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    expect(reconciles).toHaveLength(2);
    // Only the change itself moved a revision, and only the ones it belongs to.
    expect(projection.readAuthorityFactsRevision !== nodeWide).toBe(scenario.moves !== 'neither');
    expect(projection.readContextGraphAuthorityFactsRevision(CONTEXT_GRAPH_ID) !== perGraph)
      .toBe(scenario.moves === 'both');
  });

  it.each([
    { nextKind: 'legacy-unregistered' as const },
    { nextKind: 'approved-private-replica' as const },
  ])('rejects accepted-private recipients when authority becomes $nextKind during lookup', async ({ nextKind }) => {
    const owner = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([
      ...signedKeyQuads(owner),
      ...signedKeyQuads(removed),
    ]);
    const nextTransport = nextKind === 'legacy-unregistered'
      ? { kind: nextKind }
      : { kind: nextKind, allowedPeers: [] as string[] };
    const host = {
      store,
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(store),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmTransportAuthority: vi.fn()
        .mockResolvedValueOnce({
          kind: 'private-roster' as const,
          participantAgents: [owner.address, removed.address],
        })
        .mockResolvedValueOnce(nextTransport),
      getContextGraphAllowedPeers: vi.fn(async () => null),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    await expect(WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      })).rejects.toMatchObject({
        reason: 'chain-participant-authority-unavailable',
      });
  });

  it('rejects legacy metadata recipients when approved-private authority activates during lookup', async () => {
    const owner = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([
      ...signedKeyQuads(owner),
      ...signedKeyQuads(removed),
      ...[owner, removed].map((wallet) => ({
        subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${wallet.address}"`,
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      })),
    ]);
    const host = {
      store,
      contextGraphMetaProjection: { readAuthorityFactsRevision: 3, ...stubRecipientRevisions(store) },
      resolveSwmTransportAuthority: vi.fn()
        .mockResolvedValueOnce({ kind: 'legacy-unregistered' as const })
        .mockResolvedValueOnce({
          kind: 'approved-private-replica' as const,
          allowedPeers: [] as string[],
        }),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
    };

    await expect(WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      })).rejects.toMatchObject({
        reason: 'chain-participant-authority-unavailable',
      });
  });

  it('rejects a recipient snapshot that becomes stale while sender-key state loads', async () => {
    const owner = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    let currentRoster = [owner.address, removed.address];
    const host = {
      swmSenderKeyStateLoaded: false,
      loadSwmSenderKeyState: vi.fn(async () => {
        currentRoster = [owner.address];
      }),
      resolveWorkspaceAgentRecipientsForCurrentAuthority: vi.fn(async () => ({
        requiresEncryption: true as const,
        recipients: currentRoster.map((agentAddress) => ({
          agentAddress,
          recipientKeyId: `${agentAddress}-key`,
        })),
      })),
      getLocalSigningAgentForAddress: vi.fn(() => ({
        agentAddress: owner.address,
        privateKey: owner.privateKey,
      })),
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(owner.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => currentRoster,
    };

    await expect(WorkspaceCryptoMethods.prototype.encryptWorkspacePayloadWithSenderKey.call(
      host as never,
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        plaintext: new Uint8Array([1]),
        senderAgentAddress: owner.address,
        operationId: 'accepted-private-final-recheck',
        shareOperationId: 'accepted-private-final-recheck',
        timestampMs: Date.now(),
        publisherPeerId: CURATOR_PEER_ID,
        resolution: {
          requiresEncryption: true,
          recipients: [
            { agentAddress: owner.address, recipientKeyId: `${owner.address}-key` },
            { agentAddress: removed.address, recipientKeyId: `${removed.address}-key` },
          ],
        },
      } as never,
    )).rejects.toMatchObject({
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('uses the accepted private roster for recovery instead of stale metadata', async () => {
    const owner = ethers.Wallet.createRandom();
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const getCgMeta = vi.fn(async () => ({
      allowedAgents: [owner.address, member.address, removed.address],
      participantAgents: [],
      revokedAgents: [],
    }));
    const host = {
      resolveRegisteredContextGraphAuthority: async () => (
        approvedUnregisteredAuthority(member.address)
      ),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        [owner.address, member.address]
      ),
      getCgMeta,
    };

    const recovery = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      host as never,
      CONTEXT_GRAPH_ID,
    );

    expect(recovery).toEqual([owner.address, member.address]);
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it('uses only the active accepted private roster for the SWM agent gate', async () => {
    const approvedMember = ethers.Wallet.createRandom();
    const retainedRemovedMember = ethers.Wallet.createRandom();
    const getCgMeta = vi.fn(async () => ({
      allowedAgents: [approvedMember.address],
      participantAgents: [],
      revokedAgents: [],
    }));
    const retainedRoster = vi.fn(() => [retainedRemovedMember.address]);
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(approvedMember.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => undefined,
      resolveRfc64PrivateReadRosterV1: retainedRoster,
      getCgMeta,
      subscribedContextGraphs: new Map(),
    };

    const gate = await WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    );

    expect(gate).toEqual({ kind: 'available', agentAddresses: [approvedMember.address] });
    expect(gate).not.toEqual(expect.objectContaining({
      agentAddresses: expect.arrayContaining([retainedRemovedMember.address]),
    }));
    expect(retainedRoster).not.toHaveBeenCalled();
  });

  it('keeps a stable approved-private metadata agent gate', async () => {
    const member = ethers.Wallet.createRandom();
    const metadataRevision = 7;
    const resolveSwmTransportAuthority = vi.fn(async () => ({
      kind: 'approved-private-replica' as const,
      allowedPeers: [] as string[],
    }));
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        get readAuthorityFactsRevision() { return metadataRevision; },
      },
      resolveSwmTransportAuthority,
      getCgMeta: vi.fn(async () => ({
        allowedAgents: [member.address],
        participantAgents: [],
        revokedAgents: [],
      })),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ kind: 'available', agentAddresses: [member.address] });
    expect(metadataRevision).toBe(7);
    expect(resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

  it('re-reads an approved-private metadata gate revoked during its transport recheck', async () => {
    const revokedMember = ethers.Wallet.createRandom();
    let metadataRevision = 11;
    let transportReads = 0;
    const resolveSwmTransportAuthority = vi.fn(async () => {
      transportReads += 1;
      if (transportReads === 2) metadataRevision += 1;
      return {
        kind: 'approved-private-replica' as const,
        allowedPeers: [] as string[],
      };
    });
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        get readAuthorityFactsRevision() { return metadataRevision; },
      },
      resolveSwmTransportAuthority,
      getCgMeta: vi.fn(async () => ({
        allowedAgents: [revokedMember.address],
        participantAgents: [],
        revokedAgents: metadataRevision > 11 ? [revokedMember.address] : [],
      })),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ kind: 'available', agentAddresses: [] });
    expect(resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
    expect(host.getCgMeta).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the metadata authority keeps changing during gate reads', async () => {
    const member = ethers.Wallet.createRandom();
    let metadataRevision = 11;
    const resolveSwmTransportAuthority = vi.fn(async () => {
      metadataRevision += 1;
      return { kind: 'approved-private-replica' as const, allowedPeers: [] as string[] };
    });
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        get readAuthorityFactsRevision() { return metadataRevision; },
      },
      resolveSwmTransportAuthority,
      getCgMeta: vi.fn(async () => ({
        allowedAgents: [member.address],
        participantAgents: [],
        revokedAgents: [],
      })),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'local-existence-unavailable',
    });
    expect(host.getCgMeta).toHaveBeenCalledTimes(3);
    expect(resolveSwmTransportAuthority).toHaveBeenCalledTimes(6);
  });

  it('rechecks the SWM agent gate when private authority activates during metadata', async () => {
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    let privateAuthorityActive = false;
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(member.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        privateAuthorityActive ? [member.address] : undefined
      ),
      getCgMeta: vi.fn(async () => {
        privateAuthorityActive = true;
        return {
          allowedAgents: [removed.address],
          participantAgents: [],
          revokedAgents: [],
        };
      }),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ kind: 'available', agentAddresses: [member.address] });
  });

  it('rechecks recovery authority after metadata and rejects a newly stale member', async () => {
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    let privateAuthorityActive = false;
    const getLocalMetadataMemberRecoveryGate = vi.fn(async () => {
      privateAuthorityActive = true;
      return [removed.address];
    });
    const resolveRegisteredContextGraphAuthority = vi.fn(async () => (
      approvedUnregisteredAuthority(member.address)
    ));
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        privateAuthorityActive ? [member.address] : undefined
      ),
      getLocalMetadataMemberRecoveryGate,
    };

    const recovery = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      host as never,
      CONTEXT_GRAPH_ID,
    );

    expect(recovery).toEqual([member.address]);
    expect(recovery).not.toContain(removed.address);
    expect(getLocalMetadataMemberRecoveryGate).toHaveBeenCalledOnce();
    expect(resolveRegisteredContextGraphAuthority).toHaveBeenCalledTimes(2);
  });

  it('keeps the registered private chain roster as the mutation source', async () => {
    const member = ethers.Wallet.createRandom();
    const staleOverlayMember = ethers.Wallet.createRandom();
    const getLocalMetadataMemberRecoveryGate = vi.fn(async () => [staleOverlayMember.address]);
    const host = {
      resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => ({
        kind: 'private' as const,
        onChainId: 7n,
        participantAgents: [member.address],
      })),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        [staleOverlayMember.address]
      ),
      getLocalMetadataMemberRecoveryGate,
    };

    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryRosterSource.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([member.address]);
    expect(getLocalMetadataMemberRecoveryGate).not.toHaveBeenCalled();
  });

  it('uses fresh metadata, not the accepted overlay, as an unregistered mutation source', async () => {
    const previousMember = ethers.Wallet.createRandom();
    const invitedMember = ethers.Wallet.createRandom();
    const getLocalMetadataMemberRecoveryGate = vi.fn(async () => [invitedMember.address]);
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(previousMember.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => (
        [previousMember.address]
      ),
      getLocalMetadataMemberRecoveryGate,
    };

    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryRosterSource.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([invitedMember.address]);
    expect(getLocalMetadataMemberRecoveryGate).toHaveBeenCalledOnce();
  });

  it('switches a mutation source to the chain roster when registration commits during metadata', async () => {
    const chainMember = ethers.Wallet.createRandom();
    const staleLocalMember = ethers.Wallet.createRandom();
    let registered = false;
    const getLocalMetadataMemberRecoveryGate = vi.fn(async () => {
      registered = true;
      return [staleLocalMember.address];
    });
    const resolveRegisteredContextGraphAuthority = vi.fn(async () => registered
      ? {
          kind: 'private' as const,
          onChainId: 7n,
          participantAgents: [chainMember.address],
        }
      : approvedUnregisteredAuthority(staleLocalMember.address));
    const host = {
      contextGraphMetaProjection: {
        ...stubRecipientRevisions(),
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
      },
      resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => undefined,
      getLocalMetadataMemberRecoveryGate,
    };

    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryRosterSource.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([chainMember.address]);
    expect(resolveRegisteredContextGraphAuthority).toHaveBeenCalledTimes(2);
  });

  it('fails recovery closed when metadata authority facts change during the read', async () => {
    const removed = ethers.Wallet.createRandom();
    const contextGraphMetaProjection = {
      ...stubRecipientRevisions(),
      readAuthorityFactsRevision: 4,
      readContextGraphAuthorityFactsRevision() {
        return `0:${this.readAuthorityFactsRevision}`;
      },
    };
    const host = {
      contextGraphMetaProjection,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(removed.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => undefined,
      getLocalMetadataMemberRecoveryGate: vi.fn(async () => {
        contextGraphMetaProjection.readAuthorityFactsRevision += 1;
        return [removed.address];
      }),
    };

    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toBeNull();
  });

  it('drops a private accepted-policy allowance that deactivates during the registry read', async () => {
    const member = ethers.Wallet.createRandom();
    const resolveRegisteredContextGraphAuthority = vi.fn(async (
      _contextGraphId: string,
      options: { allowAcceptedRfc64FinalizedAbsence?: boolean },
    ) => options.allowAcceptedRfc64FinalizedAbsence === true
      ? approvedUnregisteredAuthority(member.address)
      : {
          kind: 'unavailable' as const,
          reason: 'finalized-name-absence-unaccepted' as const,
        });
    const privateRoster = vi.fn()
      .mockReturnValueOnce([member.address])
      .mockReturnValueOnce(undefined);
    const host = {
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: privateRoster,
    };

    await expect(host.resolveSwmTransportAuthority.call(host as never, CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'finalized-name-absence-unaccepted',
      });
    expect(resolveRegisteredContextGraphAuthority.mock.calls.map(([, options]) => (
      options.allowAcceptedRfc64FinalizedAbsence
    ))).toEqual([true, false]);
  });

  it('lets registered public and private authority override an accepted private roster', async () => {
    const acceptedMember = ethers.Wallet.createRandom();
    const chainMember = ethers.Wallet.createRandom();
    const authorityHost = (registered: unknown) => ({
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => registered),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => [acceptedMember.address],
    });

    const publicHost = authorityHost({ kind: 'public' as const, onChainId: 7n });
    await expect(publicHost.resolveSwmTransportAuthority.call(
      publicHost as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ kind: 'plaintext' });
    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      publicHost as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toBeNull();

    const privateHost = authorityHost({
      kind: 'private' as const,
      onChainId: 7n,
      participantAgents: [chainMember.address],
    });
    await expect(privateHost.resolveSwmTransportAuthority.call(
      privateHost as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({
      kind: 'private-roster',
      participantAgents: [chainMember.address],
    });
    await expect(WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      privateHost as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual([chainMember.address]);
  });

  it('falls back to approved-private authority when accepted private deactivates', async () => {
    const member = ethers.Wallet.createRandom();
    const resolveRegisteredContextGraphAuthority = vi.fn(async () => (
      approvedUnregisteredAuthority(member.address)
    ));
    const privateRoster = vi.fn()
      .mockReturnValueOnce([member.address])
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined);
    const host = {
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: privateRoster,
    };

    await expect(host.resolveSwmTransportAuthority.call(host as never, CONTEXT_GRAPH_ID))
      .resolves.toEqual({ kind: 'approved-private-replica', allowedPeers: [] });
    expect(resolveRegisteredContextGraphAuthority.mock.calls.map(([, options]) => (
      options.allowAcceptedRfc64FinalizedAbsence
    ))).toEqual([true, false]);
  });

  it('uses a private roster rotation observed after the registry read', async () => {
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const privateRoster = vi.fn()
      .mockReturnValueOnce([member.address, removed.address])
      .mockReturnValueOnce([member.address]);
    const host = {
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(member.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: privateRoster,
    };

    await expect(host.resolveSwmTransportAuthority.call(host as never, CONTEXT_GRAPH_ID))
      .resolves.toEqual({
        kind: 'private-roster',
        participantAgents: [member.address],
      });
    expect(privateRoster).toHaveBeenCalledTimes(2);
  });

  it('honors private authority that reactivates during the no-allowance reread', async () => {
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    const privateRoster = vi.fn()
      .mockReturnValueOnce([member.address, removed.address])
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce([member.address]);
    const resolveRegisteredContextGraphAuthority = vi.fn(async () => (
      approvedUnregisteredAuthority(member.address)
    ));
    const host = {
      resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
      resolveRegisteredContextGraphAuthority,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: privateRoster,
    };

    await expect(host.resolveSwmTransportAuthority.call(host as never, CONTEXT_GRAPH_ID))
      .resolves.toEqual({
        kind: 'private-roster',
        participantAgents: [member.address],
      });
    expect(resolveRegisteredContextGraphAuthority.mock.calls.map(([, options]) => (
      options.allowAcceptedRfc64FinalizedAbsence
    ))).toEqual([true, false]);
    expect(privateRoster).toHaveBeenCalledTimes(3);
  });
});
