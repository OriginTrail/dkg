// SPDX-License-Identifier: Apache-2.0
import { createContextGraphProjectionFenceFixture } from './_helpers/context-graph-projection-fence.js';

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

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';

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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => metadataRevision),
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
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
  });

  it('retries an unchanged recipient snapshot after an unrelated authority revision moves', async () => {
    const member = ethers.Wallet.createRandom();
    const peerId = '12D3KooWAcceptedPrivateStableRetryPeer';
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert(signedKeyQuads(member, peerId));

    let metadataRevision = 19;
    let transportReads = 0;
    const host = {
      store,
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => metadataRevision),
      resolveSwmTransportAuthority: vi.fn(async () => {
        transportReads += 1;
        if (transportReads === 2) metadataRevision += 1;
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
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
  });

  it('retries unchanged legacy plaintext after an unrelated authority revision moves', async () => {
    const store = new OxigraphStore();
    stores.push(store);

    let metadataRevision = 23;
    let transportReads = 0;
    const host = {
      store,
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => metadataRevision),
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
      (quads, targetGraph) => {
        if (targetGraph !== undefined) {
          projection.markDirtyForGraph(targetGraph);
          if (quads) projection.markDirtyFromQuads(quads);
        } else if (quads) projection.markDirtyFromQuads(quads);
        else projection.markAllDirty();
      },
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
      (quads, targetGraph) => {
        if (targetGraph !== undefined) {
          projection.markDirtyForGraph(targetGraph);
          if (quads) projection.markDirtyFromQuads(quads);
        } else if (quads) projection.markDirtyFromQuads(quads);
        else projection.markAllDirty();
      },
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => 3),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => metadataRevision),
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

  it('rejects an approved-private metadata gate revoked during its transport recheck', async () => {
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(() => metadataRevision),
      resolveSwmTransportAuthority,
      getCgMeta: vi.fn(async () => ({
        allowedAgents: [revokedMember.address],
        participantAgents: [],
        revokedAgents: [],
      })),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      host as never,
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({
      kind: 'unavailable',
      reason: 'local-existence-unavailable',
      detail: `Context graph "${CONTEXT_GRAPH_ID}" metadata authority changed while resolving its agent gate`,
    });
    expect(resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

  it('rechecks the SWM agent gate when private authority activates during metadata', async () => {
    const member = ethers.Wallet.createRandom();
    const removed = ethers.Wallet.createRandom();
    let privateAuthorityActive = false;
    const host = {
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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
      contextGraphMetaProjection: createContextGraphProjectionFenceFixture(),
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

  it.each([
    { method: 'getMemberRecoveryGate' as const, changedOwner: 'unrelated' },
    { method: 'getMemberRecoveryRosterSource' as const, changedOwner: 'unrelated' },
    { method: 'getMemberRecoveryGate' as const, changedOwner: 'target' },
    { method: 'getMemberRecoveryRosterSource' as const, changedOwner: 'target' },
  ])('$method fences $changedOwner writes through the real projection during metadata reads', async ({ method, changedOwner }) => {
    const member = ethers.Wallet.createRandom();
    const innerStore = new OxigraphStore();
    stores.push(innerStore);
    let projection!: ContextGraphMetaProjection;
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore, () => undefined,
      (quads, targetGraph) => {
        if (targetGraph !== undefined) {
          projection.markDirtyForGraph(targetGraph);
          if (quads) projection.markDirtyFromQuads(quads);
        } else if (quads) projection.markDirtyFromQuads(quads);
        else projection.markAllDirty();
      },
    );
    projection = new ContextGraphMetaProjection(store);
    let metadataEntered!: () => void;
    let releaseMetadata!: () => void;
    const entered = new Promise<void>((resolve) => { metadataEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const host = {
      contextGraphMetaProjection: projection,
      resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => approvedUnregisteredAuthority(member.address)),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => undefined,
      getLocalMetadataMemberRecoveryGate: vi.fn(async () => {
        metadataEntered();
        await release;
        return [member.address];
      }),
    };
    const resolution = WorkspaceCryptoMethods.prototype[method].call(host as never, CONTEXT_GRAPH_ID);
    await entered;
    const beforeGlobal = projection.readAuthorityFactsRevision;
    const beforeTarget = projection.captureContextGraphAuthorityFactsFence(CONTEXT_GRAPH_ID);
    const changedGraph = changedOwner === 'target' ? CONTEXT_GRAPH_ID : 'unrelated-recovery-graph';
    await store.insert([{
      subject: contextGraphDataUri(changedGraph),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `did:dkg:agent:${member.address}`,
      graph: contextGraphMetaUri(changedGraph),
    }]);
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(beforeGlobal);
    if (changedOwner === 'unrelated') {
      expect(beforeTarget.assertCurrent()).toBe(true);
    } else {
      expect(beforeTarget.assertCurrent()).toBe(false);
    }
    releaseMetadata();
    await expect(resolution).resolves.toEqual(changedOwner === 'target' ? null : [member.address]);
  });

  it('fails recovery closed when metadata authority facts change during the read', async () => {
    const removed = ethers.Wallet.createRandom();
    let metadataRevision = 4;
    const contextGraphMetaProjection = createContextGraphProjectionFenceFixture(() => metadataRevision);
    const host = {
      contextGraphMetaProjection,
      resolveRegisteredContextGraphAuthority: vi.fn(async () => (
        approvedUnregisteredAuthority(removed.address)
      )),
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
      resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1: () => undefined,
      getLocalMetadataMemberRecoveryGate: vi.fn(async () => {
        metadataRevision += 1;
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
