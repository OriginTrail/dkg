import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  PROTOCOL_SWM_SENDER_KEY,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  contextGraphDataUri,
  contextGraphMetaUri,
  decodeSwmSenderKeyMessage,
  decodeSwmSenderKeyPackage,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  generateWorkspaceRecipientEncryptionKey,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  type AgentKeyRecord,
} from '../src/index.js';
import {
  computeSwmSenderKeyRecipientRouteHash,
  swmSenderStateKey,
} from '../src/dkg-agent-swm-state.js';
import type { WorkspaceAgentRecipient } from '@origintrail-official/dkg-publisher';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

const SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PEER_A = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const PEER_B = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';

type SendState = {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  recipientRouteHash?: string;
  chainKey: Uint8Array;
  nextMessageIndex: number;
  senderSigningSecretKey: Uint8Array;
  senderSigningPublicKey: Uint8Array;
  createdAtMs: number;
};

interface SenderKeyInternals {
  node: { peerId: { toString(): string } };
  messenger: {
    sendReliable(
      peerId: string,
      protocolId: string,
      payload: Uint8Array,
      options?: { messageId?: string },
    ): Promise<ReliableSendResult>;
  };
  swmSenderKeyStateLoaded: boolean;
  swmSenderKeySendStates: Map<string, SendState>;
  defaultAgentAddress?: string;
  getLocalWorkspaceRecipientPrivateKeys(options?: {
    activeOnly?: boolean;
  }): WorkspaceRecipientEncryptionKey[];
  encryptWorkspacePayloadWithSenderKey(input: {
    contextGraphId: string;
    plaintext: Uint8Array;
    senderAgentAddress: string;
    operationId: string;
    shareOperationId: string;
    timestampMs: number;
    publisherPeerId: string;
    resolution: {
      requiresEncryption: true;
      recipients: readonly [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]];
    };
  }): Promise<Uint8Array>;
}

interface CuratedSenderKeyInternals extends SenderKeyInternals {
  resolveOnChainAccessPolicyState(contextGraphId: string): Promise<0 | 1 | 'unregistered' | 'unknown'>;
  loadSwmSenderKeyState(): Promise<void>;
  getLocalSigningAgentForAddress(
    agentAddress: string,
  ): (AgentKeyRecord & { privateKey: string }) | null;
  resolveWorkspaceAgentRecipientsForCurrentAuthority(input: { contextGraphId: string }): Promise<{
    requiresEncryption: true;
    recipients: readonly [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]];
  }>;
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly WorkspaceAgentRecipient[];
    membershipHash: string;
  }): Promise<SendState>;
  drainPendingSenderKeyForRecipients(recipients: readonly WorkspaceAgentRecipient[]): Promise<number>;
  prunePendingSenderKeysForEpochRotation(input: {
    contextGraphId: string;
    subGraphName?: string;
    senderAgentAddress: string;
  }): number;
  saveSwmSenderKeyState(): Promise<void>;
  _resolveCuratedChainKeyContext(
    contextGraphId: string,
    subGraphName: string | undefined,
    authorAgentAddress: string | undefined,
    explicitPolicyTargetContextGraphId: string | undefined,
    logPrefix: string,
  ): Promise<{ chainKey: Uint8Array; aeadCgId: string; senderAddress: string } | undefined>;
}

function recipientFromKey(
  agentAddress: string,
  key: WorkspaceRecipientEncryptionKey,
  peerId?: string,
): WorkspaceAgentRecipient {
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    recipientId: key.recipientId,
    recipientKeyId: key.recipientKeyId,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes,
    agentAddress: ethers.getAddress(agentAddress),
    peerId,
  };
}

async function allowAgent(agent: DKGAgent, contextGraphId: string, agentAddress: string): Promise<void> {
  await agent.store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${ethers.getAddress(agentAddress)}"`,
    graph: contextGraphMetaUri(contextGraphId),
  }]);
}

describe('SWM Sender Key peer-route epochs', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('hashes exact routes as an order-independent set separate from logical membership', () => {
    const agentA = '0x1111111111111111111111111111111111111111';
    const agentB = '0x2222222222222222222222222222222222222222';
    const base = computeSwmSenderKeyRecipientRouteHash({
      contextGraphId: 'peer-route-hash',
      recipients: [
        { agentAddress: agentA, recipientKeyId: 'key-a', peerId: PEER_A },
        { agentAddress: agentB, recipientKeyId: 'key-b' },
      ],
    });
    const reorderedWithDuplicate = computeSwmSenderKeyRecipientRouteHash({
      contextGraphId: 'peer-route-hash',
      recipients: [
        { agentAddress: agentB, recipientKeyId: 'key-b' },
        { agentAddress: agentA, recipientKeyId: 'key-a', peerId: PEER_A },
        { agentAddress: agentA, recipientKeyId: 'key-a', peerId: PEER_A },
      ],
    });
    const addedRoute = computeSwmSenderKeyRecipientRouteHash({
      contextGraphId: 'peer-route-hash',
      recipients: [
        { agentAddress: agentA, recipientKeyId: 'key-a', peerId: PEER_A },
        { agentAddress: agentA, recipientKeyId: 'key-a', peerId: PEER_B },
        { agentAddress: agentB, recipientKeyId: 'key-b' },
      ],
    });

    expect(reorderedWithDuplicate).toBe(base);
    expect(addedRoute).not.toBe(base);
  });

  it('rotates for a new peer variant and gives that peer setup for the next ciphertext', async () => {
    agent = await DKGAgent.create({
      name: 'SenderKeyPeerRouteRotation',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as SenderKeyInternals;
    Object.defineProperty(internals.node, 'peerId', {
      value: { toString: () => SELF_PEER },
      configurable: true,
    });
    internals.swmSenderKeyStateLoaded = true;

    const sender = await agent.registerAgent('peer-route-sender') as AgentKeyRecord;
    internals.defaultAgentAddress = sender.agentAddress;
    const localKey = internals.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true })
      .find((key) => key.recipientId.toLowerCase() === `did:dkg:agent:${sender.agentAddress}`.toLowerCase());
    if (!localKey) throw new Error('missing local workspace recipient key');

    const remoteWallet = ethers.Wallet.createRandom();
    const remoteRecipientId = `did:dkg:agent:${remoteWallet.address}`;
    const remoteKey = generateWorkspaceRecipientEncryptionKey(
      remoteRecipientId,
      `${remoteRecipientId}#peer-route-key`,
    );
    const senderRecipient = recipientFromKey(sender.agentAddress, localKey, SELF_PEER);
    const remoteAtA = recipientFromKey(remoteWallet.address, remoteKey, PEER_A);
    const remoteAtB = recipientFromKey(remoteWallet.address, remoteKey, PEER_B);
    const contextGraphId = 'test-cg/sender-key-peer-route-rotation';
    await allowAgent(agent, contextGraphId, sender.agentAddress);
    await allowAgent(agent, contextGraphId, remoteWallet.address);

    const setupByPeer = new Map<string, Uint8Array[]>();
    internals.messenger = {
      sendReliable: async (peerId, protocolId, payload): Promise<ReliableSendResult> => {
        expect(protocolId).toBe(PROTOCOL_SWM_SENDER_KEY);
        const sends = setupByPeer.get(peerId) ?? [];
        sends.push(Uint8Array.from(payload));
        setupByPeer.set(peerId, sends);
        return {
          delivered: true,
          response: encodeSwmSenderKeyPackageAck({
            version: SWM_SENDER_KEY_PACKAGE_VERSION,
            type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
            accepted: true,
          }),
          attempts: 1,
          messageId: `setup-${peerId}-${sends.length}`,
        };
      },
    };

    const encrypt = (plaintext: string, recipients: WorkspaceAgentRecipient[]) => (
      internals.encryptWorkspacePayloadWithSenderKey({
        contextGraphId,
        plaintext: new TextEncoder().encode(plaintext),
        senderAgentAddress: sender.agentAddress,
        operationId: `peer-route-${plaintext}`,
        shareOperationId: `peer-route-${plaintext}`,
        timestampMs: Date.now(),
        publisherPeerId: SELF_PEER,
        resolution: {
          requiresEncryption: true,
          recipients: recipients as [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]],
        },
      })
    );

    await encrypt('first', [senderRecipient, remoteAtA]);
    const stateKey = swmSenderStateKey(contextGraphId, undefined, sender.agentAddress);
    const firstState = internals.swmSenderKeySendStates.get(stateKey);
    if (!firstState) throw new Error('missing first sender-key state');
    const firstEpoch = firstState.epochId;
    const firstMembership = firstState.membershipHash;

    // Route order and an exact duplicate do not rotate.
    await encrypt('same-routes', [remoteAtA, senderRecipient, remoteAtA]);
    expect(internals.swmSenderKeySendStates.get(stateKey)?.epochId).toBe(firstEpoch);

    // A pre-route-fingerprint persisted sender state must rotate exactly once.
    delete firstState.recipientRouteHash;
    await encrypt('legacy-state', [senderRecipient, remoteAtA]);
    const migratedState = internals.swmSenderKeySendStates.get(stateKey);
    if (!migratedState) throw new Error('missing migrated sender-key state');
    expect(migratedState.epochId).not.toBe(firstEpoch);
    expect(migratedState.recipientRouteHash).toBeDefined();
    const migratedEpoch = migratedState.epochId;
    await encrypt('migrated-reuse', [remoteAtA, senderRecipient]);
    expect(internals.swmSenderKeySendStates.get(stateKey)?.epochId).toBe(migratedEpoch);

    const finalCiphertext = await encrypt('peer-b-can-decrypt', [senderRecipient, remoteAtA, remoteAtB]);
    const finalState = internals.swmSenderKeySendStates.get(stateKey);
    if (!finalState) throw new Error('missing final sender-key state');
    expect(finalState.membershipHash).toBe(firstMembership);
    expect(finalState.epochId).not.toBe(migratedEpoch);

    const peerBSetupBytes = setupByPeer.get(PEER_B)?.at(-1);
    if (!peerBSetupBytes) throw new Error('peer B did not receive sender-key setup');
    const peerBSetup = decodeSwmSenderKeyPackage(peerBSetupBytes);
    expect(peerBSetup.epochId).toBe(finalState.epochId);
    const peerBSecret = await decryptSwmSenderKeyPackage({
      package: peerBSetup,
      recipientKey: remoteKey,
    });
    const decrypted = await decryptSwmSenderKeyMessage({
      chainKey: peerBSecret.chainKey,
      message: decodeSwmSenderKeyMessage(finalCiphertext),
      senderSigningPublicKey: peerBSecret.senderSigningPublicKey,
    });
    expect(new TextDecoder().decode(decrypted.plaintext)).toBe('peer-b-can-decrypt');
  });

  it('sends a peer-bound variant remotely even when that agent is also local', async () => {
    agent = await DKGAgent.create({
      name: 'SenderKeyLocalAgentRemoteRoute',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as SenderKeyInternals;
    Object.defineProperty(internals.node, 'peerId', {
      value: { toString: () => SELF_PEER },
      configurable: true,
    });
    internals.swmSenderKeyStateLoaded = true;

    const sender = await agent.registerAgent('local-agent-remote-route') as AgentKeyRecord;
    const localKey = internals.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true })[0];
    if (!localKey) throw new Error('missing local workspace recipient key');
    const contextGraphId = 'test-cg/local-agent-remote-route';
    await allowAgent(agent, contextGraphId, sender.agentAddress);
    const remoteVariant = recipientFromKey(sender.agentAddress, localKey, PEER_B);

    const remotePeers: string[] = [];
    internals.messenger = {
      sendReliable: async (peerId): Promise<ReliableSendResult> => {
        remotePeers.push(peerId);
        return {
          delivered: true,
          response: encodeSwmSenderKeyPackageAck({
            version: SWM_SENDER_KEY_PACKAGE_VERSION,
            type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
            accepted: true,
          }),
          attempts: 1,
          messageId: `setup-${peerId}`,
        };
      },
    };

    await internals.encryptWorkspacePayloadWithSenderKey({
      contextGraphId,
      plaintext: new TextEncoder().encode('remote local-agent variant'),
      senderAgentAddress: sender.agentAddress,
      operationId: 'local-agent-remote-route',
      shareOperationId: 'local-agent-remote-route',
      timestampMs: Date.now(),
      publisherPeerId: SELF_PEER,
      resolution: { requiresEncryption: true, recipients: [remoteVariant] },
    });

    expect(remotePeers).toEqual([PEER_B]);
  });

  it('rotates the curated-inline epoch when its exact recipient routes change', async () => {
    agent = await DKGAgent.create({
      name: 'CuratedInlinePeerRouteRotation',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as CuratedSenderKeyInternals;
    internals.swmSenderKeyStateLoaded = true;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'curated-route-sender',
    ) as AgentKeyRecord & { privateKey: string };
    const senderKey = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${sender.agentAddress}`,
      `did:dkg:agent:${sender.agentAddress}#curated-route-key`,
    );
    const remoteWallet = ethers.Wallet.createRandom();
    const remoteKey = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${remoteWallet.address}`,
      `did:dkg:agent:${remoteWallet.address}#curated-route-key`,
    );
    const senderRecipient = recipientFromKey(sender.agentAddress, senderKey, SELF_PEER);
    const remoteAtA = recipientFromKey(remoteWallet.address, remoteKey, PEER_A);
    const remoteAtB = recipientFromKey(remoteWallet.address, remoteKey, PEER_B);
    let currentRecipients: [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]] = [
      senderRecipient,
      remoteAtA,
    ];
    const createdForRoutes: string[][] = [];

    internals.resolveOnChainAccessPolicyState = async () => 1;
    internals.loadSwmSenderKeyState = async () => {};
    internals.getLocalSigningAgentForAddress = () => sender;
    internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async () => ({
      requiresEncryption: true,
      recipients: currentRecipients,
    });
    internals.prunePendingSenderKeysForEpochRotation = () => 0;
    internals.saveSwmSenderKeyState = async () => {};
    internals.drainPendingSenderKeyForRecipients = async () => 0;
    internals.createAndDistributeSwmSenderKeyEpoch = async (input) => {
      createdForRoutes.push(input.recipients.map((recipient) => recipient.peerId ?? 'peerless'));
      const call = createdForRoutes.length;
      return {
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        senderAgentAddress: sender.agentAddress,
        epochId: `curated-route-epoch-${call}`,
        membershipHash: input.membershipHash,
        recipientRouteHash: computeSwmSenderKeyRecipientRouteHash({
          contextGraphId: input.contextGraphId,
          subGraphName: input.subGraphName,
          recipients: input.recipients,
        }),
        chainKey: new Uint8Array(32).fill(call),
        nextMessageIndex: 0,
        senderSigningSecretKey: new Uint8Array(32).fill(call + 1),
        senderSigningPublicKey: new Uint8Array(32).fill(call + 2),
        createdAtMs: Date.now(),
      };
    };

    const contextGraphId = 'test-cg/curated-inline-peer-route-rotation';
    await internals._resolveCuratedChainKeyContext(
      contextGraphId,
      undefined,
      sender.agentAddress,
      undefined,
      'peer-route-test',
    );
    const stateKey = swmSenderStateKey(contextGraphId, undefined, sender.agentAddress);
    expect(internals.swmSenderKeySendStates.get(stateKey)?.epochId).toBe('curated-route-epoch-1');

    currentRecipients = [remoteAtA, senderRecipient];
    await internals._resolveCuratedChainKeyContext(
      contextGraphId,
      undefined,
      sender.agentAddress,
      undefined,
      'peer-route-test',
    );
    expect(createdForRoutes).toHaveLength(1);

    currentRecipients = [senderRecipient, remoteAtA, remoteAtB];
    await internals._resolveCuratedChainKeyContext(
      contextGraphId,
      undefined,
      sender.agentAddress,
      undefined,
      'peer-route-test',
    );
    expect(createdForRoutes).toHaveLength(2);
    expect(createdForRoutes[1]).toContain(PEER_B);
    expect(internals.swmSenderKeySendStates.get(stateKey)?.epochId).toBe('curated-route-epoch-2');
  });
});
