// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { SwmSubstrateMethods } from '../src/dkg-agent-swm-substrate.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionWriteHooks } from '../src/internal/projection-write-hooks.js';
import { stubFence } from './_helpers/recipient-fence-stub.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/accepted-private';
const PROFILE_GRAPH = 'did:dkg:context-graph:agents';
const CURATOR_PEER_ID = '12D3KooWAcceptedPrivateCurator';

function signedKeyFixture(wallet: ethers.HDNodeWallet, peerId?: string): {
  quads: Quad[];
  publicKeyBytes: Uint8Array;
  recipientKeyId: string;
} {
  const agentUri = `did:dkg:agent:${ethers.getAddress(wallet.address)}`;
  const key = generateWorkspaceRecipientEncryptionKey(
    agentUri,
    `${agentUri}#accepted-private-x25519`,
  );
  const publicKeyBytes = key.publicKeyBytes!;
  const proof = wallet.signingKey.sign(ethers.hashMessage(
    computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: wallet.address,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    }),
  )).serialized;
  return {
    publicKeyBytes,
    recipientKeyId: workspaceAgentEncryptionKeyId(wallet.address, publicKeyBytes),
    quads: [
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
        object: `"${encodeWorkspaceEncryptionKey(publicKeyBytes)}"`,
        graph: PROFILE_GRAPH,
      },
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
        object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
        graph: PROFILE_GRAPH,
      },
      {
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
        object: `"${proof}"`,
        graph: PROFILE_GRAPH,
      },
      ...(peerId === undefined ? [] : [{
        subject: agentUri,
        predicate: DKG_ONTOLOGY.DKG_PEER_ID,
        object: `"${peerId}"`,
        graph: PROFILE_GRAPH,
      }]),
    ],
  };
}

function signedKeyQuads(wallet: ethers.HDNodeWallet, peerId?: string): Quad[] {
  return signedKeyFixture(wallet, peerId).quads;
}

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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
    metadataRevision += 1;
    releaseFinalRead();

    await expect(resolution).rejects.toThrow(
      /has no recipient key advertised by a peer in the context graph allowlist/,
    );
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    // Collect, confirm (the gate differs), collect again (which refuses).
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(3);
  });

  describe.each([
    {
      moved: 'a recipient key or route fact',
      expectedReads: 3,
      expectedPeerGateReads: 4,
      move: (host: { fence: ReturnType<typeof stubFence>; node: { revision: number } }) => { host.fence.revision += 1; },
    },
    {
      moved: 'only unrelated authority facts',
      expectedReads: 2,
      expectedPeerGateReads: 2,
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
        recipientKeyRouteFence: stubFence(),
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
    const hooks = createProjectionWriteHooks(() => projection);
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      hooks.markDirty,
      hooks.anticipate,
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
    const hooks = createProjectionWriteHooks(() => projection);
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      hooks.markDirty,
      hooks.anticipate,
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
    const hooks = createProjectionWriteHooks(() => projection);
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      hooks.markDirty,
      hooks.anticipate,
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
    // The peer gate is read to collect and read again to confirm.
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
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
  const TRANSPORT_CHANGED = {
    reason: 'chain-participant-authority-unavailable',
    detail: 'retry recipient resolution against the current private authority',
    site: 'transport-changed',
  };
  /** The resolved (agent, key, peer) set differed after a revision moved. */
  const ROUTES_CHANGED = {
    reason: 'chain-participant-authority-unavailable',
    detail: 'recipient routes changed while retrying against current private authority',
    site: 'recipient-set-changed',
  };

  const JOIN_KEY_CACHE_GRAPH = 'urn:dkg:local:join-encryption-key-cache';

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
        recipientKeyRouteFence: stubFence(),
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
      contextGraphMetaProjection: { readAuthorityFactsRevision: 3, recipientKeyRouteFence: stubFence() },
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
        recipientKeyRouteFence: stubFence(),
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
      recipientKeyRouteFence: stubFence(),
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

  /**
   * GH#3067. A private roster's snapshot checks what it depends on: the roster
   * by the transport re-read, the peer gate by its content, and the members'
   * keys and routes by a revision that only a write to such a fact moves. On a
   * node whose queues, publishers and catalog lane keep writing, the node-wide
   * authority revision moves in every window. That must not fail a share, and a
   * key or route change in any window, the last one included, must.
   */
  describe('recipient stability loop under sustained authority churn (GH#3067)', () => {
    type ChurnTransport =
      | { kind: 'private-roster'; participantAgents: readonly string[] }
      | { kind: 'legacy-unregistered' }
      | { kind: 'approved-private-replica'; allowedPeers: string[] }
      | { kind: 'unavailable'; reason: string };

    /** The decorated store and projection exactly as the agent wires them. */
    function createChurnStack() {
      const innerStore = new OxigraphStore();
      stores.push(innerStore);
      let projection!: ContextGraphMetaProjection;
      const hooks = createProjectionWriteHooks(() => projection);
      const store = createListContextGraphsCacheInvalidatingStore(
        innerStore,
        () => undefined,
        hooks.markDirty,
        hooks.anticipate,
      );
      projection = new ContextGraphMetaProjection(store);
      return { store, innerStore, projection };
    }
    type ChurnStack = ReturnType<typeof createChurnStack>;

    interface ChurnContext {
      readonly stack: ChurnStack;
      readonly store: ChurnStack['store'];
      readonly member: ethers.HDNodeWallet;
      readonly memberUri: string;
      readonly memberKey: ReturnType<typeof signedKeyFixture>;
      readonly peerId: string;
      readonly other: ethers.HDNodeWallet;
      readonly otherPeerId: string;
      readonly state: {
        roster: string[];
        allowedPeers: string[] | null;
        transport: ChurnTransport | null;
      };
    }

    /** A key fact of an agent outside the roster: moves the key and route revision, changes nothing resolved. */
    const bystanderRoute = (): Quad => ({
      subject: `did:dkg:agent:${ethers.Wallet.createRandom().address}`,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: '"12D3KooWChurnBystander"',
      graph: PROFILE_GRAPH,
    });

    let bookkeeping = 0;
    /**
     * What a busy node writes while a share resolves its recipients: queue job
     * transitions, share and knowledge-asset metadata, and working-memory
     * cleanup. Each one moves the node-wide revision; none can change a key.
     */
    async function unrelatedWrites({ store }: ChurnStack): Promise<void> {
      bookkeeping += 1;
      const job = `urn:dkg:promote-queue:job:churn-${bookkeeping}`;
      const wmGraph = `${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_working_memory/churn-${bookkeeping}`;
      await store.replaceSubject!('urn:dkg:promote-queue:control-plane', job, [{
        subject: job,
        predicate: 'urn:dkg:promote-queue:state',
        object: `"running-${bookkeeping}"`,
        graph: 'urn:dkg:promote-queue:control-plane',
      }]);
      await store.deleteByPatternWithoutCount!({
        graph: 'urn:dkg:promote-queue:control-plane',
        subject: job,
        predicate: 'urn:dkg:promote-queue:state',
      });
      await store.deleteByPatternWithoutCount!({
        graph: `${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_shared_memory_meta`,
        subject: `urn:dkg:share:churn-${bookkeeping}`,
      });
      await store.deleteByPatternWithoutCount!({
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
        subject: `did:dkg:base:84532/0x1234567890123456789012345678901234567890/${bookkeeping}`,
      });
      await store.replaceGraph!(wmGraph, [{
        subject: `urn:dkg:churn:doc-${bookkeeping}`,
        predicate: 'urn:dkg:churn:predicate',
        object: '"x"',
        graph: wmGraph,
      }]);
      await store.dropGraph(wmGraph);
    }

    /**
     * A private-roster graph of two members. Read 1 of the transport classifies
     * the graph, read 2 is the confirmation after the first collect, read 3 after
     * the second and read 4 after the third, the last. `unrelated` runs the writes
     * above during every read after the first; `churn` names the reads during
     * which a key fact of an agent outside the roster is written, which moves the
     * key and route revision but cannot change the resolved set;
     * `during(read, context)` applies one real change at a chosen read.
     */
    function churningHost(options: {
      seed: (context: ChurnContext) => Quad[];
      allowedPeers?: 'both' | null;
      unrelated?: boolean;
      churn?: readonly number[];
      during?: (read: number, context: ChurnContext) => Promise<unknown> | void;
      transport?: ChurnTransport;
      withStack?: ChurnStack;
    }) {
      const member = ethers.Wallet.createRandom();
      const other = ethers.Wallet.createRandom();
      const peerId = '12D3KooWChurnMemberPeer';
      const otherPeerId = '12D3KooWChurnOtherPeer';
      const stack = options.withStack ?? createChurnStack();
      const state: ChurnContext['state'] = {
        roster: [member.address, other.address],
        allowedPeers: options.allowedPeers === null ? null : [peerId, otherPeerId],
        transport: options.transport ?? null,
      };
      const context: ChurnContext = {
        stack,
        store: stack.store,
        member,
        memberUri: `did:dkg:agent:${ethers.getAddress(member.address)}`,
        memberKey: signedKeyFixture(member, peerId),
        peerId,
        other,
        otherPeerId,
        state,
      };
      let reads = 0;
      const host = {
        store: stack.store,
        contextGraphMetaProjection: stack.projection,
        resolveSwmTransportAuthority: vi.fn(async (): Promise<ChurnTransport> => {
          reads += 1;
          if (reads > 1 && options.unrelated) await unrelatedWrites(stack);
          if (options.churn?.includes(reads)) await stack.store.insert([bystanderRoute()]);
          await options.during?.(reads, context);
          return state.transport ?? { kind: 'private-roster', participantAgents: [...state.roster] };
        }),
        getContextGraphAllowedPeers: vi.fn(async () => (
          state.allowedPeers === null ? null : [...state.allowedPeers]
        )),
        ensureAgentsInOnDemandPhonebook: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      };
      const ready = stack.store.insert(options.seed(context));
      return { host, context, ready, projection: stack.projection };
    }

    const resolve = (host: unknown) => WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
        contextGraphId: CONTEXT_GRAPH_ID,
      });

    const profileKeys = (context: ChurnContext): Quad[] => [
      ...context.memberKey.quads,
      ...signedKeyQuads(context.other, context.otherPeerId),
    ];

    const revokeMemberKey = ({ store, member, memberUri, memberKey }: ChurnContext) => {
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
    };

    /** The member's key lives in the join key cache and the peer gate is open. */
    const joinCacheKeys = ({ memberKey, other, otherPeerId }: ChurnContext): Quad[] => [
      ...memberKey.quads.map((quad) => ({ ...quad, graph: JOIN_KEY_CACHE_GRAPH })),
      ...signedKeyQuads(other, otherPeerId),
    ];

    const replaceMemberRoute = ({ store, memberKey, memberUri }: ChurnContext) => store.replaceSubject!(
      JOIN_KEY_CACHE_GRAPH,
      memberUri,
      memberKey.quads.map((quad) => ({
        ...quad,
        graph: JOIN_KEY_CACHE_GRAPH,
        ...(quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID
          ? { object: '"12D3KooWChurnReplacedRoute"' }
          : {}),
      })),
    );

    const expectRecipients = (resolution: Awaited<ReturnType<typeof resolve>>, count: number) => {
      expect(resolution.requiresEncryption).toBe(true);
      expect(resolution.recipients).toHaveLength(count);
    };

    const REVISION_MOVED = { ...TRANSPORT_CHANGED, site: 'revision-moved' };

    it('resolves in the first window while unrelated writes move the node-wide revision in every read', async () => {
      const { host, ready, projection } = churningHost({ seed: profileKeys, unrelated: true });
      await ready;
      const nodeWide = projection.readAuthorityFactsRevision;
      const keyRoute = projection.recipientKeyRouteFence.revision;

      expectRecipients(await resolve(host), 2);

      // The classification read and the confirmation of the one collect; the
      // peer gate is read to collect and read again to confirm.
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
      expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
      expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWide);
      expect(projection.recipientKeyRouteFence.revision).toBe(keyRoute);
    });

    it('keeps the quiet path at two authority reads and one collect', async () => {
      const { host, ready } = churningHost({ seed: profileKeys });
      await ready;

      expectRecipients(await resolve(host), 2);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
      expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
    });

    it('names the throw site of an authority that is unavailable at the first read', async () => {
      const { host, ready } = churningHost({
        seed: profileKeys,
        transport: { kind: 'unavailable', reason: 'chain-name-binding-unavailable' },
      });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject({
        reason: 'chain-name-binding-unavailable',
        site: 'transport-unavailable',
      });
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(1);
    });

    it('collects again, and again learns the key graphs, when a key fact is written during a window', async () => {
      const { host, ready, projection } = churningHost({ seed: profileKeys, churn: [2] });
      await ready;
      const ensureReady = vi.spyOn(projection.recipientKeyRouteFence, 'ensureReady');

      expectRecipients(await resolve(host), 2);

      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
      expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(4);
      expect(ensureReady).toHaveBeenCalledTimes(2);
    });

    // A change lands during read N. Reads 2 and 3 are followed by a collect that
    // reads it. Read 4 follows the last collect: only the snapshot's own check
    // can see it, and it must.
    interface WindowChange {
      readonly change: string;
      readonly seed: (context: ChurnContext) => Quad[];
      readonly allowedPeers?: 'both' | null;
      readonly apply: (context: ChurnContext) => Promise<unknown> | void;
      /** What a collect that reads the change refuses with. */
      readonly early: RegExp | { reason: string; detail: string; site: string };
    }

    const windowChanges: WindowChange[] = [
      {
        change: 'a recipient key is revoked',
        seed: profileKeys,
        apply: revokeMemberKey,
        early: /public encryption keys.*revoked/,
      },
      {
        change: 'a peer route is replaced in the join key cache',
        seed: joinCacheKeys,
        allowedPeers: null,
        apply: replaceMemberRoute,
        early: { ...ROUTES_CHANGED, site: 'recipient-set-changed' },
      },
      {
        change: 'a peer leaves the allowlist',
        seed: profileKeys,
        apply: ({ state, peerId }) => { state.allowedPeers = [peerId]; },
        early: /has no recipient key advertised by a peer in the context graph allowlist/,
      },
      {
        // Same length, different members: only a content comparison sees it.
        change: 'a peer is swapped in the allowlist',
        seed: profileKeys,
        apply: ({ state, peerId }) => { state.allowedPeers = [peerId, '12D3KooWChurnSwappedPeer']; },
        early: /has no recipient key advertised by a peer in the context graph allowlist/,
      },
      {
        change: 'the graph gains a peer allowlist',
        seed: joinCacheKeys,
        allowedPeers: null,
        apply: ({ state, peerId }) => { state.allowedPeers = [peerId]; },
        early: /has no recipient key advertised by a peer in the context graph allowlist/,
      },
    ];

    it.each(windowChanges.flatMap((scenario) => [2, 3].map((read) => ({ ...scenario, read }))))(
      'fails closed when $change during authority read $read',
      async (scenario) => {
        const { host, ready } = churningHost({
          seed: scenario.seed,
          allowedPeers: scenario.allowedPeers,
          // Read 3 only happens when the first window moved.
          churn: scenario.read === 3 ? [2] : [],
          during: (read, context) => (read === scenario.read ? scenario.apply(context) : undefined),
        });
        await ready;

        await (scenario.early instanceof RegExp
          ? expect(resolve(host)).rejects.toThrow(scenario.early)
          : expect(resolve(host)).rejects.toMatchObject(scenario.early));
      },
    );

    it.each(windowChanges)('refuses in the last window when $change after the last collect', async (scenario) => {
      const { host, ready } = churningHost({
        seed: scenario.seed,
        allowedPeers: scenario.allowedPeers,
        // Reads 2 and 3 move the key revision without changing the set, so the
        // loop reaches its last window; the change lands during read 4.
        churn: [2, 3],
        during: (read, context) => (read === 4 ? scenario.apply(context) : undefined),
      });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
    });

    it('never returns the revoked key when it is revoked while the last window is read', async () => {
      const { host, ready, context } = churningHost({
        seed: profileKeys,
        churn: [2, 3],
        during: (read, ctx) => (read === 4 ? revokeMemberKey(ctx) : undefined),
      });
      await ready;
      const encrypt = vi.fn();

      await expect(resolve(host).then(encrypt)).rejects.toMatchObject(REVISION_MOVED);
      expect(encrypt).not.toHaveBeenCalled();
      expect(context.state.roster).toHaveLength(2);
    });

    it.each([
      {
        change: 'a member leaves the roster',
        apply: ({ state, member }: ChurnContext) => { state.roster = [member.address]; },
        rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
      },
      {
        change: 'a member joins the roster',
        apply: ({ state }: ChurnContext) => { state.roster.push(ethers.Wallet.createRandom().address); },
        rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
      },
      {
        change: 'the graph stops being a private roster',
        apply: ({ state }: ChurnContext) => { state.transport = { kind: 'legacy-unregistered' }; },
        rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
      },
      {
        change: 'the graph becomes an approved private replica',
        apply: ({ state }: ChurnContext) => {
          state.transport = { kind: 'approved-private-replica', allowedPeers: [] };
        },
        rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
      },
      {
        change: 'its authority becomes unavailable',
        apply: ({ state }: ChurnContext) => {
          state.transport = { kind: 'unavailable', reason: 'chain-name-binding-unavailable' };
        },
        rejects: { reason: 'chain-name-binding-unavailable', site: 'transport-unavailable' },
      },
    ])('fails closed in the last window when $change', async (scenario) => {
      const { host, ready } = churningHost({
        seed: profileKeys,
        churn: [2, 3],
        during: (read, context) => (read === 4 ? scenario.apply(context) : undefined),
      });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject(scenario.rejects);
    });

    it('refuses once the key revision has moved in every window, after exactly three collects', async () => {
      const { host, ready } = churningHost({ seed: profileKeys, churn: [2, 3, 4] });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
      // Never a fourth collect: three collects, each followed by its confirmation.
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
      expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(6);
    });

    it('keeps legacy unregistered authority strict when the node-wide revision moves in every window', async () => {
      const { host, ready } = churningHost({
        seed: () => [],
        transport: { kind: 'legacy-unregistered' },
        unrelated: true,
      });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
    });

    it('keeps an approved private replica strict when the node-wide revision moves in every window', async () => {
      const owner = ethers.Wallet.createRandom();
      const { host, ready } = churningHost({
        seed: () => [
          ...signedKeyQuads(owner),
          {
            subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
            predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
            object: `"${owner.address}"`,
            graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
          },
        ],
        transport: { kind: 'approved-private-replica', allowedPeers: [] },
        unrelated: true,
      });
      await ready;

      await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
    });

    it('stays fail-closed when the key graphs cannot be scanned, and converges once the writes stop', async () => {
      const stack = createChurnStack();
      const query = stack.innerStore.query.bind(stack.innerStore);
      vi.spyOn(stack.innerStore, 'query').mockImplementation(async (sparql, options) => {
        if (options?.source === 'agent.recipientKeyRouteFence.scan') throw new Error('store busy');
        return query(sparql, options);
      });
      let wildcard = 0;
      const { host, ready } = churningHost({
        seed: profileKeys,
        withStack: stack,
        // A drop of a graph nobody knows to be key-free is not harmless while the scan is unavailable.
        during: async (read) => {
          if (read === 2) await stack.store.dropGraph(`${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_working_memory/wildcard-${wildcard += 1}`);
        },
      });
      await ready;

      expectRecipients(await resolve(host), 2);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
    });

    it('lets the VM publish key context resolve its recipients while unrelated writes move the node-wide revision', async () => {
      // `_resolveCuratedChainKeyContext` runs the same resolver, twice per
      // publish attempt, with no bounded repeat. The sender is deliberately not
      // a member, so a successful resolution ends in the recipient-set check
      // that follows it.
      const { host, ready } = churningHost({ seed: profileKeys, unrelated: true });
      await ready;
      const outsider = ethers.Wallet.createRandom();
      const agentLike = Object.assign(host, {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        defaultAgentAddress: outsider.address,
        peerId: '12D3KooWChurnPublisherPeer',
        resolveOnChainAccessPolicyState: vi.fn(async () => 1),
        isPrivateContextGraph: vi.fn(async () => true),
        loadSwmSenderKeyState: vi.fn(async () => undefined),
        getLocalSigningAgentForAddress: vi.fn((address: string) => ({ agentAddress: address })),
        resolveWorkspaceAgentRecipientsForCurrentAuthority: WorkspaceCryptoMethods.prototype
          .resolveWorkspaceAgentRecipientsForCurrentAuthority,
      });

      await expect(PublishMethods.prototype._resolveCuratedChainKeyContext.call(
        agentLike as never,
        CONTEXT_GRAPH_ID,
        undefined,
        undefined,
        undefined,
        'churn',
      )).rejects.toThrow(/is not in the recipient set/);
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    });

    it('does not move the node-wide revision for a plain insert into an unrelated graph', async () => {
      const real = createChurnStack();
      const before = real.projection.readAuthorityFactsRevision;
      await real.store.insert([{
        subject: 'urn:dkg:churn:unrelated',
        predicate: 'urn:dkg:churn:predicate',
        object: '"x"',
        graph: 'urn:dkg:churn:graph',
      }]);
      expect(real.projection.readAuthorityFactsRevision).toBe(before);
    });

    it('lets four concurrent resolutions succeed while a real promote queue churns the store', async () => {
      const real = createChurnStack();
      const queue = new TripleStoreAsyncPromoteQueue(real.store, {});
      let transition = 0;
      const jobsAreDriven = async () => {
        // One real job lifecycle: the control-plane writes of enqueue, claim,
        // commit markers and success, through the decorated store.
        transition += 1;
        await queue.enqueue({
          contextGraphId: 'graphify',
          subGraphName: 'code',
          assertionName: `churn-${transition}`,
          entities: 'all',
        });
        const claimed = await queue.claimNext(`worker-${transition}`);
        if (claimed?.lease === undefined) return;
        const token = claimed.lease.claimToken;
        await queue.recordCommitMarker(claimed.jobId, token, 'swmInserted');
        await queue.succeed(claimed.jobId, token, { promotedCount: 1, succeededAt: Date.now() });
      };
      const hosts = Array.from({ length: 4 }, () => churningHost({
        seed: () => [],
        withStack: real,
        during: (read) => (read >= 2 ? jobsAreDriven() : undefined),
      }));
      // All four hosts share one store; give them the same two members' keys.
      const member = ethers.Wallet.createRandom();
      const other = ethers.Wallet.createRandom();
      await real.store.insert([
        ...signedKeyQuads(member, '12D3KooWChurnSharedMemberPeer'),
        ...signedKeyQuads(other, '12D3KooWChurnSharedOtherPeer'),
      ]);
      for (const { context } of hosts) {
        context.state.roster = [member.address, other.address];
        context.state.allowedPeers = ['12D3KooWChurnSharedMemberPeer', '12D3KooWChurnSharedOtherPeer'];
      }
      const nodeWide = real.projection.readAuthorityFactsRevision;
      const keyRoute = real.projection.recipientKeyRouteFence.revision;

      const resolutions = await Promise.all(hosts.map(({ host }) => resolve(host)));

      for (const resolution of resolutions) expectRecipients(resolution, 2);
      for (const { host } of hosts) {
        expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
      }
      expect(real.projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWide);
      expect(real.projection.recipientKeyRouteFence.revision).toBe(keyRoute);
    });
  });
});
